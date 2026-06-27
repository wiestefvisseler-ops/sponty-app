'use strict';

/* ------------------------------------------------------------------ *
 *  store.js — in-memory state + the rules around the engine.
 *
 *  Holds users, groups, "down" signals and live hangs (events), handles
 *  signal expiry, and — crucially — exposes a per-user status that NEVER
 *  leaks who else is currently down while a match is still pending.
 *
 *  It's intentionally a plain in-memory store so the whole thing runs with
 *  `node src/server.js` and zero install. Swapping these Maps for SQLite or
 *  Postgres is a self-contained change (see README -> "Add a database").
 * ------------------------------------------------------------------ */

const { randomUUID } = require('crypto');
const { resolveSignals } = require('./engine');

const EVENT_TTL_MS = 6 * 60 * 60 * 1000; // a triggered hang stays live for 6h

function midnightTonight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

const users = new Map(); // id -> { id, name, pushToken }
const groups = new Map(); // id -> { id, name, memberIds: Set }
const signals = new Map(); // id -> signal
const events = new Map(); // groupId -> event (at most one live hang per group)

const now = () => Date.now();

/* ----------------------------- users ----------------------------- */
function createUser({ name, pushToken = null }) {
  const u = { id: randomUUID(), name: String(name || 'Friend'), pushToken };
  users.set(u.id, u);
  return u;
}
const getUser = (id) => users.get(id) || null;
function setPushToken(userId, pushToken) {
  const u = users.get(userId);
  if (!u) return null;
  u.pushToken = pushToken;
  return u;
}

/* ----------------------------- groups ---------------------------- */
function createGroup({ name, memberIds = [] }) {
  const g = { id: randomUUID(), name: String(name || 'Group'), memberIds: new Set(memberIds) };
  groups.set(g.id, g);
  return g;
}
const getGroup = (id) => groups.get(id) || null;
function addMember(groupId, userId) {
  const g = groups.get(groupId);
  if (!g) return null;
  g.memberIds.add(userId);
  return g;
}
const listGroupsForUser = (userId) =>
  [...groups.values()].filter((g) => g.memberIds.has(userId));

/* --------------------------- internals --------------------------- */
function activeSignals(groupId) {
  const t = now();
  return [...signals.values()].filter(
    (s) => s.groupId === groupId && !s.cancelled && s.expiresAt > t
  );
}

function activeEvent(groupId) {
  const e = events.get(groupId);
  if (!e || e.expiresAt <= now()) return null;
  return e;
}

// best-effort "soonest" for display; understands "HH:MM", ignores the rest
function earliestFrom(times) {
  const toMin = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
    return m ? Number(m[1]) * 60 + Number(m[2]) : Infinity;
  };
  return [...times].sort((a, b) => toMin(a) - toMin(b))[0];
}

function participantsView(event, groupId) {
  const active = activeSignals(groupId);
  const activeIds = new Set(active.map((s) => s.userId));
  const timeFor = (uid) => (active.find((s) => s.userId === uid) || {}).fromTime || null;
  // only show people who are still actually down (handles someone bailing)
  return [...event.participantUserIds]
    .filter((uid) => activeIds.has(uid))
    .map((uid) => ({ userId: uid, name: (users.get(uid) || {}).name || 'Friend', fromTime: timeFor(uid) }));
}

/**
 * Re-evaluate a group after any change. Creates or grows a live hang and
 * returns the brand-new notifications to send (deduped per person/event).
 */
function recompute(groupId) {
  const g = groups.get(groupId);
  if (!g) return { event: null, notifications: [] };

  const active = activeSignals(groupId);
  const decision = resolveSignals(active.map((s) => ({ userId: s.userId, oneOnOneOk: s.oneOnOneOk })));
  const notifications = [];

  if (!decision.triggered) {
    // nothing crosses the line -> signals stay pending and invisible
    return { event: activeEvent(groupId), notifications };
  }

  let event = activeEvent(groupId);
  if (!event) {
    event = {
      id: randomUUID(),
      groupId,
      mode: decision.mode,
      participantUserIds: new Set(decision.participantUserIds),
      createdAt: now(),
      expiresAt: now() + EVENT_TTL_MS,
      sent: new Map(), // userId -> 'its_on' | 'heads_up' (dedupe)
    };
    events.set(groupId, event);
  } else {
    decision.participantUserIds.forEach((id) => event.participantUserIds.add(id));
    if (decision.mode === 'group') event.mode = 'group'; // a pair can grow into a group
  }

  const view = participantsView(event, groupId);
  const soon = earliestFrom(view.map((p) => p.fromTime).filter(Boolean));
  const nameOf = (uid) => (users.get(uid) || {}).name || 'a friend';

  // people who are in -> "it's on" (once each)
  for (const uid of event.participantUserIds) {
    if (event.sent.get(uid) === 'its_on') continue;
    event.sent.set(uid, 'its_on');
    if (!users.get(uid)) continue;
    const others = view.filter((p) => p.userId !== uid).map((p) => p.name);
    notifications.push({
      userId: uid,
      kind: 'its_on',
      title: event.mode === 'pair' ? "Just you two — it's on" : "It's sponty time ✨",
      body:
        event.mode === 'pair'
          ? `You and ${others[0] || 'a friend'} both said a 1-on-1's fine.`
          : `${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} in${soon ? ` — from ${soon}` : ''}.`,
      data: { type: 'its_on', groupId, eventId: event.id },
    });
  }

  // everyone else in the group -> soft heads-up (once each)
  for (const uid of g.memberIds) {
    if (event.participantUserIds.has(uid) || event.sent.get(uid)) continue;
    event.sent.set(uid, 'heads_up');
    if (!users.get(uid)) continue;
    notifications.push({
      userId: uid,
      kind: 'heads_up',
      title: 'Some of the squad are chilling',
      body: `Join if you're free${soon ? ` — from ${soon}` : ''}.`,
      data: { type: 'heads_up', groupId, eventId: event.id },
    });
  }

  return { event, notifications };
}

/* ---------------------------- signals ---------------------------- */
function createSignal({ groupId, userId, fromTime = null, oneOnOneOk = false }) {
  const g = groups.get(groupId);
  if (!g) throw new Error('group not found');
  if (!g.memberIds.has(userId)) throw new Error('user is not a member of this group');

  // re-pressing replaces your previous live signal (lets you change time / 1-on-1)
  for (const s of signals.values()) {
    if (s.groupId === groupId && s.userId === userId && !s.cancelled && s.expiresAt > now()) {
      s.cancelled = true;
    }
  }

  const sig = {
    id: randomUUID(),
    groupId,
    userId,
    fromTime,
    oneOnOneOk: !!oneOnOneOk,
    createdAt: now(),
    expiresAt: midnightTonight(),
    cancelled: false,
  };
  signals.set(sig.id, sig);

  const { notifications } = recompute(groupId);
  return { signal: sig, notifications };
}

function cancelSignal(signalId, userId = null) {
  const s = signals.get(signalId);
  if (!s) return { ok: false, error: 'signal not found' };
  if (userId && s.userId !== userId) return { ok: false, error: 'not your signal' };
  s.cancelled = true;
  // note: a hang that already fired is intentionally NOT torn down — once it's
  // on, plans are made. Bailing just removes you from the visible roster.
  return { ok: true };
}

/* -------------------- privacy-safe per-user view ------------------ */
function getUserStatus(groupId, userId) {
  const g = groups.get(groupId);
  if (!g) return { status: 'idle' };

  const event = activeEvent(groupId);
  const mySignal = activeSignals(groupId).find((s) => s.userId === userId);
  const stillIn = event && event.participantUserIds.has(userId) && !!mySignal;

  let out;
  if (event && stillIn) out = { status: 'on', ...eventPayload(event, groupId) };
  else if (event) out = { status: 'heads_up', ...eventPayload(event, groupId) };
  // No live hang. If you're down you're "pending" — and we reveal NOTHING
  // about anyone else. This is the whole privacy promise.
  else if (mySignal) out = { status: 'pending', since: mySignal.createdAt };
  else out = { status: 'idle' };

  // Your OWN signal id is safe to return (lets the client cancel it).
  if (mySignal) out.signalId = mySignal.id;
  return out;
}

function eventPayload(event, groupId) {
  const participants = participantsView(event, groupId);
  return {
    mode: event.mode,
    eventId: event.id,
    participants,
    earliestFrom: earliestFrom(participants.map((p) => p.fromTime).filter(Boolean)) || null,
  };
}

/* ----- debug-only full state (REMOVE before production) ---------- */
function debugGroupState(groupId) {
  const g = groups.get(groupId);
  if (!g) return null;
  const event = activeEvent(groupId);
  return {
    group: {
      id: g.id,
      name: g.name,
      members: [...g.memberIds].map((id) => ({ id, name: (users.get(id) || {}).name })),
    },
    activeSignals: activeSignals(groupId).map((s) => ({
      userId: s.userId,
      name: (users.get(s.userId) || {}).name,
      fromTime: s.fromTime,
      oneOnOneOk: s.oneOnOneOk,
    })),
    event: event
      ? { id: event.id, mode: event.mode, participants: [...event.participantUserIds].map((id) => (users.get(id) || {}).name) }
      : null,
  };
}

module.exports = {
  createUser, getUser, setPushToken,
  createGroup, getGroup, addMember, listGroupsForUser,
  createSignal, cancelSignal, getUserStatus, debugGroupState,
  SIGNAL_TTL_MS, EVENT_TTL_MS,
};

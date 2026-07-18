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
const { resolveSignals, DEFAULT_THRESHOLD } = require('./engine');

function midnightTonight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

const users = new Map();  // id -> { id, name, pushSubscription }
const groups = new Map(); // id -> { id, name, memberIds: Set }
const signals = new Map(); // id -> signal
const events = new Map(); // groupId -> event (at most one live hang per group)
const messages = new Map(); // `${groupId}:${dateKey}` -> [{ id, userId, name, text, createdAt }]
const friends = new Map();  // userId -> Set(friendId)  (symmetric: adding links both ways)
const oneOnOne = new Map(); // userId -> { selected: Set(friendId), createdAt, expiresAt }
const oneOnOneSent = new Set(); // `${aId}:${bId}:${dateKey}` pairs already notified today

const now = () => Date.now();

/* ----------------------------- users ----------------------------- */
function createUser({ name }) {
  if (!name || !String(name).trim()) throw new Error('name required');
  const u = { id: randomUUID(), name: String(name).trim() };
  users.set(u.id, u);
  return u;
}
const getUser = (id) => users.get(id) || null;
// Create-or-update a user with a KNOWN id — used for Supabase-authenticated users,
// whose id is their Supabase user id rather than a locally generated one.
function upsertUser({ id, name }) {
  if (!id) throw new Error('id required');
  let u = users.get(id);
  if (!u) { u = { id, name: name ? String(name).trim() : 'Friend' }; users.set(id, u); }
  else if (name) u.name = String(name).trim();
  return u;
}
function setPushSubscription(userId, subscription) {
  const u = users.get(userId);
  if (!u) return null;
  u.pushSubscription = subscription;
  return u;
}

/* ----------------------------- groups ---------------------------- */
function createGroup({ name, memberIds = [], minPeople = DEFAULT_THRESHOLD, ownerId = null }) {
  const min = Math.max(3, Math.min(10, Number(minPeople) || DEFAULT_THRESHOLD));
  const g = { id: randomUUID(), name: String(name || 'Group'), memberIds: new Set(memberIds), minPeople: min, ownerId };
  groups.set(g.id, g);
  return g;
}
const getGroup = (id) => groups.get(id) || null;
function removeMember(groupId, userId, requesterId) {
  const g = groups.get(groupId);
  if (!g) return { ok: false, error: 'group not found' };
  if (g.ownerId !== requesterId) return { ok: false, error: 'not the group owner' };
  if (userId === requesterId) return { ok: false, error: 'cannot remove yourself' };
  g.memberIds.delete(userId);
  return { ok: true };
}

// Leave a group yourself: drop your signal, remove you from any live hang,
// hand off ownership if you owned it, and delete the group if you were the last.
function leaveGroup(groupId, userId) {
  const g = groups.get(groupId);
  if (!g) return { ok: false, error: 'group not found' };
  if (!g.memberIds.has(userId)) return { ok: false, error: 'not a member' };

  g.memberIds.delete(userId);
  for (const s of signals.values()) {
    if (s.groupId === groupId && s.userId === userId && !s.cancelled) s.cancelled = true;
  }
  const ev = events.get(groupId);
  if (ev) ev.participantUserIds.delete(userId);

  if (g.memberIds.size === 0) {              // last one out -> delete the group
    groups.delete(groupId);
    events.delete(groupId);
    for (const id of [...signals.keys()]) if (signals.get(id).groupId === groupId) signals.delete(id);
    messages.delete(`${groupId}:${todayKey()}`);
    return { ok: true, deleted: true };
  }
  if (g.ownerId === userId) g.ownerId = [...g.memberIds][0];  // hand ownership over
  if (activeEvent(groupId) && activeSignals(groupId).length < 2) resetGroup(groupId);
  return { ok: true };
}
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
  const decision = resolveSignals(active.map((s) => ({ userId: s.userId, oneOnOneOk: s.oneOnOneOk })), g.minPeople);
  const notifications = [];

  let event = activeEvent(groupId);

  // No live hang yet AND nothing crosses the line -> signals stay pending and
  // invisible. (The threshold only gates STARTING a hang.)
  if (!event && !decision.triggered) {
    return { event: null, notifications };
  }

  if (!event) {
    // A fresh match just crossed the threshold.
    event = {
      id: randomUUID(),
      groupId,
      mode: decision.mode,
      participantUserIds: new Set(decision.participantUserIds),
      createdAt: now(),
      expiresAt: midnightTonight(),
      sent: new Map(), // userId -> 'its_on' | 'heads_up' (dedupe)
    };
    events.set(groupId, event);
  } else {
    // A hang is already live. Anyone currently down joins it — NO threshold
    // re-check, because the hang is already happening. This is what makes
    // "Join this hang" work even for min-people-4+ groups and pair matches.
    active.forEach((s) => event.participantUserIds.add(s.userId));
    if (active.length >= 3) event.mode = 'group'; // a pair grows into a group
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

  // A live hang needs at least 2 people. Once it's on, people who bail just
  // drop off the roster (plans are made) — UNLESS bailing collapses it to 1 or
  // 0 people still down. At that point the hang can't hold, so we wipe the whole
  // group clean — event, signals and chat — exactly like the 00:00 daily reset.
  const event = activeEvent(s.groupId);
  if (event && activeSignals(s.groupId).length < 2) {
    resetGroup(s.groupId);
  }
  return { ok: true };
}

/**
 * Reset a single group's day: drop its live hang, clear everyone's "down"
 * signals, and wipe today's chat. This is the same end-state a group reaches
 * naturally at midnight — we just do it on demand when a hang collapses.
 */
function resetGroup(groupId) {
  events.delete(groupId);
  for (const id of [...signals.keys()]) {
    if (signals.get(id).groupId === groupId) signals.delete(id);
  }
  messages.delete(`${groupId}:${todayKey()}`);
}

/* -------------------- privacy-safe per-user view ------------------ */
// A user's current live commitment, if any: a 1-on-1 match takes priority, else
// the first group where they're a live participant. Used to lock the "I'm down"
// buttons everywhere once someone is already out for the night.
function activeMatch(userId) {
  const oo = oneOnOneMatches(userId);
  if (oo.length) return { type: 'oneonone', friendName: (users.get(oo[0]) || {}).name || 'a friend' };
  for (const g of groups.values()) {
    if (!g.memberIds.has(userId)) continue;
    const ev = activeEvent(g.id);
    if (ev && ev.participantUserIds.has(userId) && activeSignals(g.id).some((s) => s.userId === userId)) {
      return { type: 'group', groupId: g.id, groupName: g.name };
    }
  }
  return null;
}

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

  // If you're already matched somewhere ELSE, tell the client so it can
  // deactivate the "I'm down" button here (you can't be in two hangs at once).
  const am = activeMatch(userId);
  if (am && out.status !== 'on') {
    out.lockedElsewhere = true;
    out.lockedLabel = am.type === 'oneonone' ? `with ${am.friendName}` : `in ${am.groupName}`;
  }
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

/* ----------- users who should receive chat notifications ---------- */
// Includes: people with active signals + all group members if a hang is live
// (heads_up members can see the chat and should stay in the loop)
function chatAudienceIds(groupId) {
  const ids = new Set(activeSignals(groupId).map((s) => s.userId));
  if (activeEvent(groupId)) {
    const g = groups.get(groupId);
    if (g) g.memberIds.forEach((id) => ids.add(id));
  }
  return ids;
}

/* ----------------------------- chat ----------------------------- */
function getMessages(groupId) {
  const key = `${groupId}:${todayKey()}`;
  return messages.get(key) || [];
}

function addMessage(groupId, userId, text) {
  const user = users.get(userId);
  if (!user) return null;
  const key = `${groupId}:${todayKey()}`;
  if (!messages.has(key)) messages.set(key, []);
  const msg = { id: randomUUID(), userId, name: user.name, text: String(text).slice(0, 500), createdAt: now() };
  messages.get(key).push(msg);
  return msg;
}

/* --------------------------- friends ---------------------------- */
// A private, symmetric friends list, separate from groups. Adding by code
// links both people so either can start a 1-on-1 with the other.
function addFriend(userId, friendId) {
  if (!userId || !friendId) return { ok: false, error: 'missing code' };
  if (userId === friendId) return { ok: false, error: "that's your own code" };
  const me = users.get(userId);
  const friend = users.get(friendId);
  if (!me) return { ok: false, error: 'user not found' };
  if (!friend) return { ok: false, error: 'no one has that code' };
  if (!friends.has(userId)) friends.set(userId, new Set());
  if (!friends.has(friendId)) friends.set(friendId, new Set());
  friends.get(userId).add(friendId);
  friends.get(friendId).add(userId); // mutual — you're now connected both ways
  return { ok: true, friend: { id: friend.id, name: friend.name } };
}

function listFriends(userId) {
  const set = friends.get(userId) || new Set();
  return [...set].filter((id) => users.has(id)).map((id) => ({ id, name: users.get(id).name }));
}

function removeFriend(userId, friendId) {
  friends.get(userId) && friends.get(userId).delete(friendId);
  friends.get(friendId) && friends.get(friendId).delete(userId);
  // also drop them from any live 1-on-1 selection
  const mine = oneOnOne.get(userId);
  if (mine) mine.selected.delete(friendId);
  const theirs = oneOnOne.get(friendId);
  if (theirs) theirs.selected.delete(userId);
  return { ok: true };
}

/* -------------------------- 1-on-1 hangs -------------------------- */
// You flip yourself "down for a 1-on-1" and pick which friends you're open to.
// A match happens ONLY when it's mutual: you picked them AND they picked you.
// Nobody is told you're down unless you both are (same privacy promise as groups).
function activeOneOnOne(userId) {
  const o = oneOnOne.get(userId);
  if (!o || o.expiresAt <= now()) return null;
  return o;
}

function oneOnOneMatches(userId) {
  const mine = activeOneOnOne(userId);
  if (!mine) return [];
  const out = [];
  for (const fid of mine.selected) {
    const theirs = activeOneOnOne(fid);
    if (theirs && theirs.selected.has(userId)) out.push(fid);
  }
  return out;
}

function getOneOnOneStatus(userId) {
  const mine = activeOneOnOne(userId);
  const am = activeMatch(userId);
  return {
    down: !!mine,
    selected: mine ? [...mine.selected] : [],
    matches: oneOnOneMatches(userId).map((id) => ({ id, name: (users.get(id) || {}).name || 'Friend' })),
    // committed via a GROUP hang -> lock the 1-on-1 "I'm down" button too
    lockedByGroup: am && am.type === 'group' ? am.groupName : null,
  };
}

const pairKey = (a, b) => `${[a, b].sort().join(':')}:${todayKey()}`;

function setOneOnOne(userId, selectedIds = []) {
  if (!users.get(userId)) throw new Error('user not found');
  const myFriends = friends.get(userId) || new Set();
  const selected = new Set((selectedIds || []).filter((id) => myFriends.has(id)));
  oneOnOne.set(userId, { selected, createdAt: now(), expiresAt: midnightTonight() });

  // notify each newly-mutual pair exactly once
  const notifications = [];
  for (const fid of oneOnOneMatches(userId)) {
    const key = pairKey(userId, fid);
    if (oneOnOneSent.has(key)) continue;
    oneOnOneSent.add(key);
    const me = users.get(userId);
    const friend = users.get(fid);
    if (!me || !friend) continue;
    notifications.push({ userId, title: "It's on — just you two ✨", body: `${friend.name} is also down for a 1-on-1.` });
    notifications.push({ userId: fid, title: "It's on — just you two ✨", body: `${me.name} is also down for a 1-on-1.` });
  }
  return { notifications, status: getOneOnOneStatus(userId) };
}

function cancelOneOnOne(userId) {
  oneOnOne.delete(userId);
  return { ok: true };
}

module.exports = {
  createUser, getUser, upsertUser, setPushSubscription,
  createGroup, getGroup, addMember, listGroupsForUser,
  createSignal, cancelSignal, getUserStatus, debugGroupState,
  getMessages, addMessage, chatAudienceIds, removeMember, leaveGroup, resetGroup,
  addFriend, listFriends, removeFriend,
  setOneOnOne, cancelOneOnOne, getOneOnOneStatus,
};

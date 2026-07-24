'use strict';

/* ------------------------------------------------------------------ *
 *  store.js — all data access + the rules around the matching engine.
 *  Backed by Postgres (via db.js). Same public API as the old in-memory
 *  store, but every function is now async.
 * ------------------------------------------------------------------ */

const { randomUUID } = require('crypto');
const { resolveSignals, DEFAULT_THRESHOLD } = require('./engine');
const db = require('./db');

const midnightTonight = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d; };
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/* ----------------------------- users ----------------------------- */
async function createUser({ name }) {
  if (!name || !String(name).trim()) throw new Error('name required');
  const id = randomUUID();
  const nm = String(name).trim();
  await db.query('insert into users (id, name) values ($1,$2)', [id, nm]);
  return { id, name: nm };
}

async function getUser(id, q = db.query) {
  const { rows } = await q('select id, name, push_subscription from users where id=$1', [id]);
  if (!rows[0]) return null;
  return { id: rows[0].id, name: rows[0].name, pushSubscription: rows[0].push_subscription || null };
}

async function upsertUser({ id, name }) {
  if (!id) throw new Error('id required');
  const nm = name ? String(name).trim() : null;
  await db.query(
    `insert into users (id, name) values ($1, coalesce($2,'Friend'))
     on conflict (id) do update set name = coalesce($2, users.name)`,
    [id, nm]
  );
  const { rows } = await db.query('select id, name from users where id=$1', [id]);
  return { id: rows[0].id, name: rows[0].name };
}

async function setPushSubscription(userId, subscription) {
  const { rowCount } = await db.query(
    'update users set push_subscription=$2 where id=$1',
    [userId, subscription ? JSON.stringify(subscription) : null]
  );
  return rowCount ? { id: userId } : null;
}

async function deleteUser(userId) {
  const { rows } = await db.query('select id from users where id=$1', [userId]);
  if (!rows[0]) return { ok: false, error: 'user not found' };
  const myGroups = await db.query('select group_id from group_members where user_id=$1', [userId]);
  for (const { group_id } of myGroups.rows) await leaveGroup(group_id, userId);
  await db.query('delete from users where id=$1', [userId]); // FKs cascade the rest
  return { ok: true };
}

/* ----------------------------- groups ---------------------------- */
async function createGroup({ name, memberIds = [], minPeople = DEFAULT_THRESHOLD, ownerId = null }) {
  const min = Math.max(3, Math.min(10, Number(minPeople) || DEFAULT_THRESHOLD));
  const id = randomUUID();
  const nm = String(name || 'Group');
  await db.query('insert into groups (id, name, min_people, owner_id) values ($1,$2,$3,$4)', [id, nm, min, ownerId]);
  for (const uid of new Set(memberIds)) {
    await db.query('insert into group_members (group_id, user_id) values ($1,$2) on conflict do nothing', [id, uid]);
  }
  return { id, name: nm, minPeople: min, ownerId, memberIds: [...new Set(memberIds)] };
}

async function getGroup(id) {
  const { rows } = await db.query('select id, name, min_people, owner_id from groups where id=$1', [id]);
  if (!rows[0]) return null;
  const mem = await db.query(
    'select gm.user_id, u.name from group_members gm left join users u on u.id=gm.user_id where gm.group_id=$1',
    [id]
  );
  return {
    id: rows[0].id, name: rows[0].name, minPeople: rows[0].min_people, ownerId: rows[0].owner_id,
    members: mem.rows.map((r) => ({ id: r.user_id, name: r.name })),
    memberIds: mem.rows.map((r) => r.user_id),
  };
}

async function addMember(groupId, userId) {
  const g = await db.query('select id from groups where id=$1', [groupId]);
  if (!g.rows[0]) return null;
  await db.query('insert into group_members (group_id, user_id) values ($1,$2) on conflict do nothing', [groupId, userId]);
  const mem = await db.query('select user_id from group_members where group_id=$1', [groupId]);
  return { id: groupId, memberIds: mem.rows.map((r) => r.user_id) };
}

async function removeMember(groupId, userId, requesterId) {
  const g = await db.query('select owner_id from groups where id=$1', [groupId]);
  if (!g.rows[0]) return { ok: false, error: 'group not found' };
  if (g.rows[0].owner_id !== requesterId) return { ok: false, error: 'not the group owner' };
  if (userId === requesterId) return { ok: false, error: 'cannot remove yourself' };
  await db.query('delete from group_members where group_id=$1 and user_id=$2', [groupId, userId]);
  return { ok: true };
}

async function leaveGroup(groupId, userId) {
  const g = await db.query('select owner_id from groups where id=$1', [groupId]);
  if (!g.rows[0]) return { ok: false, error: 'group not found' };
  const mem = await db.query('select 1 from group_members where group_id=$1 and user_id=$2', [groupId, userId]);
  if (!mem.rows[0]) return { ok: false, error: 'not a member' };

  await db.query('delete from group_members where group_id=$1 and user_id=$2', [groupId, userId]);
  await db.query('update signals set cancelled=true where group_id=$1 and user_id=$2 and not cancelled', [groupId, userId]);
  await db.query(
    'delete from event_participants ep using events e where ep.event_id=e.id and e.group_id=$1 and ep.user_id=$2',
    [groupId, userId]
  );

  const rest = await db.query('select user_id from group_members where group_id=$1', [groupId]);
  if (rest.rows.length === 0) {
    await db.query('delete from groups where id=$1', [groupId]); // cascade clears its signals/events/messages
    return { ok: true, deleted: true };
  }
  if (g.rows[0].owner_id === userId) {
    await db.query('update groups set owner_id=$2 where id=$1', [groupId, rest.rows[0].user_id]);
  }
  await maybeCollapse(groupId);
  return { ok: true };
}

async function listGroupsForUser(userId) {
  const { rows } = await db.query(
    `select g.id, g.name,
            (select count(*)::int from group_members m2 where m2.group_id=g.id) as member_count
     from groups g join group_members gm on gm.group_id=g.id
     where gm.user_id=$1 order by g.created_at`,
    [userId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, memberCount: r.member_count }));
}

/* --------------------------- internals --------------------------- */
async function activeSignals(groupId, q = db.query) {
  const { rows } = await q(
    'select id, user_id, from_time, one_on_one_ok from signals where group_id=$1 and not cancelled and expires_at > now()',
    [groupId]
  );
  return rows.map((r) => ({ id: r.id, userId: r.user_id, fromTime: r.from_time, oneOnOneOk: r.one_on_one_ok }));
}

async function activeSignalCount(groupId, q = db.query) {
  const { rows } = await q(
    'select count(*)::int as n from signals where group_id=$1 and not cancelled and expires_at > now()',
    [groupId]
  );
  return rows[0].n;
}

async function activeEventRow(groupId, q = db.query) {
  const { rows } = await q(
    'select id, group_id, mode from events where group_id=$1 and expires_at > now() order by created_at desc limit 1',
    [groupId]
  );
  return rows[0] || null;
}

function earliestFrom(times) {
  const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s)); return m ? Number(m[1]) * 60 + Number(m[2]) : Infinity; };
  return [...times].sort((a, b) => toMin(a) - toMin(b))[0];
}

// Participants who are STILL actively down, with name + fromTime.
async function participantsView(eventId, groupId, q = db.query) {
  const { rows } = await q(
    `select ep.user_id, coalesce(u.name,'Friend') as name,
            (select s.from_time from signals s
             where s.group_id=$2 and s.user_id=ep.user_id and not s.cancelled and s.expires_at > now()
             order by s.created_at desc limit 1) as from_time
     from event_participants ep left join users u on u.id=ep.user_id
     where ep.event_id=$1
       and exists (select 1 from signals s2
                   where s2.group_id=$2 and s2.user_id=ep.user_id and not s2.cancelled and s2.expires_at > now())`,
    [eventId, groupId]
  );
  return rows.map((r) => ({ userId: r.user_id, name: r.name, fromTime: r.from_time || null }));
}

// Re-evaluate a group after a change. Creates/grows a live hang, returns new pushes.
async function recompute(groupId, q = db.query) {
  const gq = await q('select min_people from groups where id=$1', [groupId]);
  if (!gq.rows[0]) return { event: null, notifications: [] };
  const min = gq.rows[0].min_people;

  const active = await activeSignals(groupId, q);
  const decision = resolveSignals(active.map((s) => ({ userId: s.userId, oneOnOneOk: s.oneOnOneOk })), min);
  const notifications = [];

  let event = await activeEventRow(groupId, q);
  if (!event && !decision.triggered) return { event: null, notifications };

  if (!event) {
    const evId = randomUUID();
    await q('insert into events (id, group_id, mode, expires_at) values ($1,$2,$3,$4)', [evId, groupId, decision.mode, midnightTonight()]);
    for (const uid of decision.participantUserIds) {
      await q('insert into event_participants (event_id, user_id) values ($1,$2) on conflict do nothing', [evId, uid]);
    }
    event = { id: evId, group_id: groupId, mode: decision.mode };
  } else {
    for (const s of active) {
      await q('insert into event_participants (event_id, user_id) values ($1,$2) on conflict do nothing', [event.id, s.userId]);
    }
    if (active.length >= 3 && event.mode !== 'group') {
      await q('update events set mode=$2 where id=$1', [event.id, 'group']);
      event.mode = 'group';
    }
  }

  const view = await participantsView(event.id, groupId, q);
  const soon = earliestFrom(view.map((p) => p.fromTime).filter(Boolean));

  const sentQ = await q('select user_id, kind from event_notifications where event_id=$1', [event.id]);
  const sent = new Map(sentQ.rows.map((r) => [r.user_id, r.kind]));
  const partQ = await q('select user_id from event_participants where event_id=$1', [event.id]);
  const participantIds = new Set(partQ.rows.map((r) => r.user_id));

  for (const uid of participantIds) {
    if (sent.get(uid) === 'its_on') continue;
    await q(
      `insert into event_notifications (event_id, user_id, kind) values ($1,$2,'its_on')
       on conflict (event_id, user_id) do update set kind='its_on'`,
      [event.id, uid]
    );
    const u = await getUser(uid, q);
    if (!u) continue;
    const others = view.filter((p) => p.userId !== uid).map((p) => p.name);
    notifications.push({
      userId: uid, kind: 'its_on',
      title: event.mode === 'pair' ? "Just you two — it's on" : "It's sponty time ✨",
      body: event.mode === 'pair'
        ? `You and ${others[0] || 'a friend'} both said a 1-on-1's fine.`
        : `${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} in${soon ? ` — from ${soon}` : ''}.`,
      data: { type: 'its_on', groupId, eventId: event.id },
    });
  }

  const memQ = await q('select user_id from group_members where group_id=$1', [groupId]);
  for (const { user_id: uid } of memQ.rows) {
    if (participantIds.has(uid) || sent.has(uid)) continue;
    await q(
      `insert into event_notifications (event_id, user_id, kind) values ($1,$2,'heads_up') on conflict do nothing`,
      [event.id, uid]
    );
    const u = await getUser(uid, q);
    if (!u) continue;
    notifications.push({
      userId: uid, kind: 'heads_up',
      title: 'Some of the squad are chilling',
      body: `Join if you're free${soon ? ` — from ${soon}` : ''}.`,
      data: { type: 'heads_up', groupId, eventId: event.id },
    });
  }

  return { event, notifications };
}

/* ---------------------------- signals ---------------------------- */
async function createSignal({ groupId, userId, fromTime = null, oneOnOneOk = false }) {
  return db.tx(async (q) => {
    // Lock the group row -> matching for THIS group is serialized, so two
    // simultaneous presses can't each create a separate hang or double-notify.
    const g = await q('select id from groups where id=$1 for update', [groupId]);
    if (!g.rows[0]) throw new Error('group not found');
    const mem = await q('select 1 from group_members where group_id=$1 and user_id=$2', [groupId, userId]);
    if (!mem.rows[0]) throw new Error('user is not a member of this group');

    await q(
      'update signals set cancelled=true where group_id=$1 and user_id=$2 and not cancelled and expires_at > now()',
      [groupId, userId]
    );
    const id = randomUUID();
    await q(
      'insert into signals (id, group_id, user_id, from_time, one_on_one_ok, expires_at) values ($1,$2,$3,$4,$5,$6)',
      [id, groupId, userId, fromTime, !!oneOnOneOk, midnightTonight()]
    );
    const { notifications } = await recompute(groupId, q);
    return { signal: { id, groupId, userId, fromTime, oneOnOneOk: !!oneOnOneOk }, notifications };
  });
}

async function cancelSignal(signalId, userId = null) {
  const { rows } = await db.query('select id, group_id, user_id from signals where id=$1', [signalId]);
  const s = rows[0];
  if (!s) return { ok: false, error: 'signal not found' };
  if (userId && s.user_id !== userId) return { ok: false, error: 'not your signal' };
  return db.tx(async (q) => {
    await q('select id from groups where id=$1 for update', [s.group_id]); // same per-group lock as matching
    await q('update signals set cancelled=true where id=$1', [signalId]);
    await maybeCollapse(s.group_id, q);
    return { ok: true };
  });
}

async function maybeCollapse(groupId, q = db.query) {
  const ev = await activeEventRow(groupId, q);
  if (ev && (await activeSignalCount(groupId, q)) < 2) await resetGroup(groupId, q);
}

async function resetGroup(groupId, q = db.query) {
  await q('delete from events where group_id=$1', [groupId]);
  await q('delete from signals where group_id=$1', [groupId]);
  await q('delete from messages where group_id=$1 and created_at >= $2', [groupId, startOfToday()]);
}

/* -------------------- privacy-safe per-user view ------------------ */
async function getUserStatus(groupId, userId) {
  const g = await db.query('select id from groups where id=$1', [groupId]);
  if (!g.rows[0]) return { status: 'idle' };

  const event = await activeEventRow(groupId);
  const mySigQ = await db.query(
    'select id from signals where group_id=$1 and user_id=$2 and not cancelled and expires_at > now() order by created_at desc limit 1',
    [groupId, userId]
  );
  const mySignal = mySigQ.rows[0] || null;

  let stillIn = false;
  if (event && mySignal) {
    const p = await db.query('select 1 from event_participants where event_id=$1 and user_id=$2', [event.id, userId]);
    stillIn = !!p.rows[0];
  }

  let out;
  if (event && stillIn) out = { status: 'on', ...(await eventPayload(event, groupId)) };
  else if (event) out = { status: 'heads_up', ...(await eventPayload(event, groupId)) };
  else if (mySignal) out = { status: 'pending' };
  else out = { status: 'idle' };

  if (mySignal) out.signalId = mySignal.id;

  const am = await activeMatch(userId);
  if (am && out.status !== 'on') {
    out.lockedElsewhere = true;
    out.lockedLabel = am.type === 'oneonone' ? `with ${am.friendName}` : `in ${am.groupName}`;
  }
  return out;
}

async function eventPayload(event, groupId) {
  const participants = await participantsView(event.id, groupId);
  return {
    mode: event.mode, eventId: event.id, participants,
    earliestFrom: earliestFrom(participants.map((p) => p.fromTime).filter(Boolean)) || null,
  };
}

// A user's current live commitment (1-on-1 first, else a live group participation).
async function activeMatch(userId) {
  const oo = await oneOnOneMatches(userId);
  if (oo.length) { const u = await getUser(oo[0]); return { type: 'oneonone', friendName: (u && u.name) || 'a friend' }; }
  const { rows } = await db.query(
    `select g.id, g.name from groups g
     join events e on e.group_id=g.id and e.expires_at > now()
     join event_participants ep on ep.event_id=e.id and ep.user_id=$1
     where exists (select 1 from signals s where s.group_id=g.id and s.user_id=$1 and not s.cancelled and s.expires_at > now())
     limit 1`,
    [userId]
  );
  if (rows[0]) return { type: 'group', groupId: rows[0].id, groupName: rows[0].name };
  return null;
}

/* ----------- users who should receive chat notifications ---------- */
async function chatAudienceIds(groupId) {
  const ids = new Set();
  const sig = await db.query('select distinct user_id from signals where group_id=$1 and not cancelled and expires_at > now()', [groupId]);
  sig.rows.forEach((r) => ids.add(r.user_id));
  if (await activeEventRow(groupId)) {
    const mem = await db.query('select user_id from group_members where group_id=$1', [groupId]);
    mem.rows.forEach((r) => ids.add(r.user_id));
  }
  return ids;
}

/* ----------------------------- chat ----------------------------- */
async function getMessages(groupId) {
  const { rows } = await db.query(
    'select id, user_id, name, text, created_at from messages where group_id=$1 and created_at >= $2 order by created_at',
    [groupId, startOfToday()]
  );
  return rows.map((r) => ({ id: r.id, userId: r.user_id, name: r.name, text: r.text, createdAt: r.created_at }));
}

async function addMessage(groupId, userId, text) {
  const u = await getUser(userId);
  if (!u) return null;
  const id = randomUUID();
  const t = String(text).slice(0, 500);
  await db.query('insert into messages (id, group_id, user_id, name, text) values ($1,$2,$3,$4,$5)', [id, groupId, userId, u.name, t]);
  return { id, userId, name: u.name, text: t };
}

/* --------------------------- friends ---------------------------- */
async function addFriend(userId, friendId) {
  if (!userId || !friendId) return { ok: false, error: 'missing code' };
  if (userId === friendId) return { ok: false, error: "that's your own code" };
  const me = await getUser(userId);
  const fr = await getUser(friendId);
  if (!me) return { ok: false, error: 'user not found' };
  if (!fr) return { ok: false, error: 'no one has that code' };
  await db.query('insert into friends (user_id, friend_id) values ($1,$2) on conflict do nothing', [userId, friendId]);
  await db.query('insert into friends (user_id, friend_id) values ($1,$2) on conflict do nothing', [friendId, userId]);
  return { ok: true, friend: { id: fr.id, name: fr.name } };
}

async function listFriends(userId) {
  const { rows } = await db.query(
    'select f.friend_id, u.name from friends f join users u on u.id=f.friend_id where f.user_id=$1',
    [userId]
  );
  return rows.map((r) => ({ id: r.friend_id, name: r.name }));
}

async function removeFriend(userId, friendId) {
  await db.query('delete from friends where (user_id=$1 and friend_id=$2) or (user_id=$2 and friend_id=$1)', [userId, friendId]);
  await db.query('delete from one_on_one_selected where (user_id=$1 and friend_id=$2) or (user_id=$2 and friend_id=$1)', [userId, friendId]);
  return { ok: true };
}

/* -------------------------- 1-on-1 hangs -------------------------- */
async function activeOneOnOne(userId) {
  const { rows } = await db.query('select user_id from one_on_one where user_id=$1 and expires_at > now()', [userId]);
  return rows[0] || null;
}

async function selectedOf(userId) {
  const { rows } = await db.query('select friend_id from one_on_one_selected where user_id=$1', [userId]);
  return rows.map((r) => r.friend_id);
}

async function oneOnOneMatches(userId) {
  if (!(await activeOneOnOne(userId))) return [];
  const { rows } = await db.query(
    `select s.friend_id from one_on_one_selected s
     where s.user_id=$1
       and exists (select 1 from one_on_one o where o.user_id=s.friend_id and o.expires_at > now())
       and exists (select 1 from one_on_one_selected s2 where s2.user_id=s.friend_id and s2.friend_id=$1)`,
    [userId]
  );
  return rows.map((r) => r.friend_id);
}

async function getOneOnOneStatus(userId) {
  const mine = await activeOneOnOne(userId);
  const matchIds = await oneOnOneMatches(userId);
  const matches = [];
  for (const id of matchIds) { const u = await getUser(id); matches.push({ id, name: (u && u.name) || 'Friend' }); }
  const am = await activeMatch(userId);
  return {
    down: !!mine,
    selected: mine ? await selectedOf(userId) : [],
    matches,
    lockedByGroup: am && am.type === 'group' ? am.groupName : null,
  };
}

async function setOneOnOne(userId, selectedIds = []) {
  if (!(await getUser(userId))) throw new Error('user not found');

  // Atomically replace my down-state + selection.
  await db.tx(async (q) => {
    const friendRows = await q('select friend_id from friends where user_id=$1', [userId]);
    const friendSet = new Set(friendRows.rows.map((r) => r.friend_id));
    const selected = [...new Set(selectedIds)].filter((id) => friendSet.has(id));
    await q(
      'insert into one_on_one (user_id, expires_at) values ($1,$2) on conflict (user_id) do update set expires_at=$2, created_at=now()',
      [userId, midnightTonight()]
    );
    await q('delete from one_on_one_selected where user_id=$1', [userId]);
    for (const fid of selected) {
      await q('insert into one_on_one_selected (user_id, friend_id) values ($1,$2) on conflict do nothing', [userId, fid]);
    }
  });

  // Notify newly-mutual pairs. The one_on_one_sent UNIQUE(a,b,day) makes
  // "notify once per pair per day" race-safe even under concurrency.
  const notifications = [];
  for (const fid of await oneOnOneMatches(userId)) {
    const [a, b] = [userId, fid].sort();
    const ins = await db.query(
      'insert into one_on_one_sent (a_id, b_id, day) values ($1,$2,current_date) on conflict do nothing',
      [a, b]
    );
    if (ins.rowCount === 0) continue; // already notified this pair today
    const me = await getUser(userId);
    const friend = await getUser(fid);
    if (!me || !friend) continue;
    notifications.push({ userId, title: "It's on — just you two ✨", body: `${friend.name} is also down for a 1-on-1.` });
    notifications.push({ userId: fid, title: "It's on — just you two ✨", body: `${me.name} is also down for a 1-on-1.` });
  }
  return { notifications, status: await getOneOnOneStatus(userId) };
}

async function cancelOneOnOne(userId) {
  await db.query('delete from one_on_one where user_id=$1', [userId]);
  await db.query('delete from one_on_one_selected where user_id=$1', [userId]);
  return { ok: true };
}

/* ----- debug-only full state (REMOVE before production) ---------- */
async function debugGroupState(groupId) {
  const g = await getGroup(groupId);
  if (!g) return null;
  const active = await activeSignals(groupId);
  const ev = await activeEventRow(groupId);
  let event = null;
  if (ev) {
    const parts = await db.query('select coalesce(u.name,$2) as name from event_participants ep left join users u on u.id=ep.user_id where ep.event_id=$1', [ev.id, 'Friend']);
    event = { id: ev.id, mode: ev.mode, participants: parts.rows.map((r) => r.name) };
  }
  const names = {};
  for (const s of active) { const u = await getUser(s.userId); names[s.userId] = u && u.name; }
  return {
    group: { id: g.id, name: g.name, members: g.members },
    activeSignals: active.map((s) => ({ userId: s.userId, name: names[s.userId], fromTime: s.fromTime, oneOnOneOk: s.oneOnOneOk })),
    event,
  };
}

module.exports = {
  createUser, getUser, upsertUser, setPushSubscription, deleteUser,
  createGroup, getGroup, addMember, listGroupsForUser,
  createSignal, cancelSignal, getUserStatus, debugGroupState,
  getMessages, addMessage, chatAudienceIds, removeMember, leaveGroup, resetGroup,
  addFriend, listFriends, removeFriend,
  setOneOnOne, cancelOneOnOne, getOneOnOneStatus,
};

'use strict';

/* ------------------------------------------------------------------ *
 *  server.js — a tiny zero-dependency HTTP API around the store.
 *
 *  No Express, no install: `node src/server.js` and open the URL it prints.
 *  Endpoints are deliberately privacy-safe — the only place you can see who
 *  is currently down is GET /status (and only for things you're allowed to
 *  see) plus the clearly-marked /debug route used by the demo client.
 * ------------------------------------------------------------------ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { WebPushNotifier, PUBLIC_VAPID_KEY } = require('./notifier');

const PORT = process.env.PORT || 4000;
const notifier = new WebPushNotifier();

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

async function dispatch(notifications) {
  for (const n of notifications) {
    const user = store.getUser(n.userId);
    if (user) await notifier.send(user, n);
  }
}

// [method, pathRegex, handler(req, res, params, query)]
const routes = [
  ['GET', /^\/api\/vapid-public-key$/, async (req, res) => {
    sendJson(res, 200, { key: PUBLIC_VAPID_KEY });
  }],

  ['POST', /^\/api\/users$/, async (req, res) => {
    const b = await readBody(req);
    try {
      sendJson(res, 201, store.createUser({ name: b.name }));
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
  }],

  // Register-or-update a Supabase-authenticated user (id = their Supabase user id).
  ['POST', /^\/api\/users\/upsert$/, async (req, res) => {
    const b = await readBody(req);
    try {
      sendJson(res, 200, store.upsertUser({ id: b.id, name: b.name }));
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
  }],

  ['POST', /^\/api\/users\/(?<id>[^/]+)\/push-subscription$/, async (req, res, p) => {
    const b = await readBody(req);
    console.log(`  📲 push-subscription for user ${p.id}: ${b.subscription ? 'received' : 'MISSING'}`);
    const u = store.setPushSubscription(p.id, b.subscription);
    console.log(`  📲 user found: ${u ? u.name : 'NO'}`);
    u ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'user not found' });
  }],

  ['GET', /^\/api\/users\/(?<id>[^/]+)\/groups$/, async (req, res, p) => {
    if (!store.getUser(p.id)) return sendJson(res, 404, { error: 'user not found' });
    sendJson(res, 200, store.listGroupsForUser(p.id).map((g) => ({ id: g.id, name: g.name, memberCount: g.memberIds.size })));
  }],

  /* ---- friends (private, separate from groups) ---- */
  ['GET', /^\/api\/users\/(?<id>[^/]+)\/friends$/, async (req, res, p) => {
    if (!store.getUser(p.id)) return sendJson(res, 404, { error: 'user not found' });
    sendJson(res, 200, store.listFriends(p.id));
  }],

  ['POST', /^\/api\/users\/(?<id>[^/]+)\/friends$/, async (req, res, p) => {
    const b = await readBody(req);
    const result = store.addFriend(p.id, (b.friendCode || '').trim());
    result.ok ? sendJson(res, 200, result) : sendJson(res, 400, result);
  }],

  ['DELETE', /^\/api\/users\/(?<id>[^/]+)\/friends\/(?<friendId>[^/]+)$/, async (req, res, p) => {
    sendJson(res, 200, store.removeFriend(p.id, p.friendId));
  }],

  /* ---- 1-on-1 hangs (mutual match, no chat) ---- */
  ['GET', /^\/api\/users\/(?<id>[^/]+)\/one-on-one$/, async (req, res, p) => {
    if (!store.getUser(p.id)) return sendJson(res, 404, { error: 'user not found' });
    sendJson(res, 200, store.getOneOnOneStatus(p.id));
  }],

  ['POST', /^\/api\/users\/(?<id>[^/]+)\/one-on-one$/, async (req, res, p) => {
    const b = await readBody(req);
    try {
      const { notifications, status } = store.setOneOnOne(p.id, b.selectedIds || []);
      await dispatch(notifications);
      sendJson(res, 200, status);
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
  }],

  ['DELETE', /^\/api\/users\/(?<id>[^/]+)\/one-on-one$/, async (req, res, p) => {
    sendJson(res, 200, store.cancelOneOnOne(p.id));
  }],

  ['POST', /^\/api\/groups$/, async (req, res) => {
    const b = await readBody(req);
    const g = store.createGroup({ name: b.name, memberIds: b.memberIds || [], minPeople: b.minPeople, ownerId: b.ownerId });
    sendJson(res, 201, { id: g.id, name: g.name, minPeople: g.minPeople, ownerId: g.ownerId, memberIds: [...g.memberIds] });
  }],

  ['GET', /^\/api\/groups\/(?<id>[^/]+)$/, async (req, res, p) => {
    const g = store.getGroup(p.id);
    if (!g) return sendJson(res, 404, { error: 'group not found' });
    sendJson(res, 200, { id: g.id, name: g.name, ownerId: g.ownerId, members: [...g.memberIds].map((id) => ({ id, name: (store.getUser(id) || {}).name })) });
  }],

  ['DELETE', /^\/api\/groups\/(?<id>[^/]+)\/members\/(?<userId>[^/]+)$/, async (req, res, p, q) => {
    const requesterId = q.get('requesterId');
    const result = (p.userId === requesterId)
      ? store.leaveGroup(p.id, p.userId)                  // leaving yourself
      : store.removeMember(p.id, p.userId, requesterId);  // owner removing someone else
    result.ok ? sendJson(res, 200, result) : sendJson(res, 400, result);
  }],

  ['POST', /^\/api\/groups\/(?<id>[^/]+)\/members$/, async (req, res, p) => {
    const b = await readBody(req);
    const g = store.addMember(p.id, b.userId);
    g ? sendJson(res, 200, { id: g.id, members: [...g.memberIds] }) : sendJson(res, 404, { error: 'group not found' });
  }],

  // Press the button. Returns ONLY the caller's resulting status (never the
  // pending state of others) and fires any push notifications.
  ['POST', /^\/api\/groups\/(?<id>[^/]+)\/signals$/, async (req, res, p) => {
    const b = await readBody(req);
    try {
      const { signal, notifications } = store.createSignal({
        groupId: p.id, userId: b.userId, fromTime: b.fromTime, oneOnOneOk: b.oneOnOneOk,
      });
      await dispatch(notifications);
      sendJson(res, 201, { signalId: signal.id, ...store.getUserStatus(p.id, b.userId) });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
  }],

  ['DELETE', /^\/api\/signals\/(?<id>[^/]+)$/, async (req, res, p, q) => {
    sendJson(res, 200, store.cancelSignal(p.id, q.get('userId')));
  }],

  // Poll this to know what to draw on a user's screen. Privacy-safe.
  ['GET', /^\/api\/groups\/(?<id>[^/]+)\/status$/, async (req, res, p, q) => {
    const userId = q.get('userId');
    if (!userId) return sendJson(res, 400, { error: 'userId required' });
    sendJson(res, 200, store.getUserStatus(p.id, userId));
  }],

  ['GET', /^\/api\/groups\/(?<id>[^/]+)\/chat$/, async (req, res, p) => {
    sendJson(res, 200, store.getMessages(p.id));
  }],

  ['POST', /^\/api\/groups\/(?<id>[^/]+)\/chat$/, async (req, res, p) => {
    const b = await readBody(req);
    const msg = store.addMessage(p.id, b.userId, b.text);
    if (!msg) return sendJson(res, 400, { error: 'user not found' });
    sendJson(res, 201, msg);
    // notify only people who are currently down in this group (active signal)
    const group = store.getGroup(p.id);
    const activeIds = store.chatAudienceIds(p.id);
    if (group) {
      for (const memberId of activeIds) {
        if (memberId === b.userId) continue;
        const member = store.getUser(memberId);
        if (member) {
          await notifier.send(member, {
            title: `${msg.name} in ${group.name}`,
            body: msg.text,
          });
        }
      }
    }
  }],

  // DEMO ONLY — full god-view of a group. Delete before shipping.
  ['GET', /^\/api\/debug\/groups\/(?<id>[^/]+)$/, async (req, res, p) => {
    const s = store.debugGroupState(p.id);
    s ? sendJson(res, 200, s) : sendJson(res, 404, { error: 'group not found' });
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  console.log(`${req.method} ${pathname}`);

  const staticFiles = {
    '/':             ['client.html', 'text/html'],
    '/client.html':  ['client.html', 'text/html'],
    '/manifest.json':['manifest.json', 'application/manifest+json'],
    '/sw.js':        ['sw.js', 'application/javascript'],
    '/icon.png':     ['icon.png', 'image/png'],
    '/icon-512.png': ['icon-512x512.png', 'image/png'],
    '/idle.png':     ['spontychill_swing_idle.png', 'image/png'],
    '/waiting.png':  ['spontychill_swing_wait.png', 'image/png'],
    '/match.gif':    ['spontychill_swing_cheer.gif', 'image/gif'],
  };
  if (req.method === 'GET' && staticFiles[pathname]) {
    const [file, mime] = staticFiles[pathname];
    try {
      const data = fs.readFileSync(path.join(__dirname, '..', 'public', file));
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(data);
    } catch {
      return sendJson(res, 404, { error: 'not found' });
    }
  }
  if (req.method === 'GET' && pathname === '/health') return sendJson(res, 200, { ok: true });

  for (const [method, pattern, handler] of routes) {
    if (req.method !== method) continue;
    const m = pattern.exec(pathname);
    if (m) return handler(req, res, m.groups || {}, url.searchParams);
  }

  sendJson(res, 404, { error: 'not found', path: pathname });
});

server.listen(PORT, () => {
  console.log(`\n  🛋  Sponty backend running -> http://localhost:${PORT}`);
  console.log(`      open that URL in a browser for the live demo\n`);
});

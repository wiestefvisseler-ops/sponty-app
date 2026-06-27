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
const { ConsoleNotifier } = require('./notifier');

const PORT = process.env.PORT || 4000;
const notifier = new ConsoleNotifier();

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
  ['POST', /^\/api\/users$/, async (req, res) => {
    const b = await readBody(req);
    sendJson(res, 201, store.createUser({ name: b.name, pushToken: b.pushToken }));
  }],

  ['POST', /^\/api\/users\/(?<id>[^/]+)\/push-token$/, async (req, res, p) => {
    const b = await readBody(req);
    const u = store.setPushToken(p.id, b.pushToken);
    u ? sendJson(res, 200, u) : sendJson(res, 404, { error: 'user not found' });
  }],

  ['GET', /^\/api\/users\/(?<id>[^/]+)\/groups$/, async (req, res, p) => {
    sendJson(res, 200, store.listGroupsForUser(p.id).map((g) => ({ id: g.id, name: g.name, memberCount: g.memberIds.size })));
  }],

  ['POST', /^\/api\/groups$/, async (req, res) => {
    const b = await readBody(req);
    const g = store.createGroup({ name: b.name, memberIds: b.memberIds || [] });
    sendJson(res, 201, { id: g.id, name: g.name, memberIds: [...g.memberIds] });
  }],

  ['GET', /^\/api\/groups\/(?<id>[^/]+)$/, async (req, res, p) => {
    const g = store.getGroup(p.id);
    if (!g) return sendJson(res, 404, { error: 'group not found' });
    sendJson(res, 200, { id: g.id, name: g.name, members: [...g.memberIds].map((id) => ({ id, name: (store.getUser(id) || {}).name })) });
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

  const staticFiles = {
    '/':             ['client.html', 'text/html'],
    '/client.html':  ['client.html', 'text/html'],
    '/manifest.json':['manifest.json', 'application/manifest+json'],
    '/sw.js':        ['sw.js', 'application/javascript'],
    '/icon.png':     ['icon.png', 'image/png'],
    '/icon-512.png': ['icon-512.png', 'image/png'],
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

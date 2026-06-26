# Sponty — backend & matching engine

Spontaneous, low-pressure group hangs. You quietly tap "I'm down to chill" in a
group of friends. **Nothing happens, and nobody ever learns you tapped**, unless
enough friends are independently in too:

- **3+ down** → it's a group hang. Everyone who's in is revealed to each other; the
  rest of the group gets a soft "join if you want."
- **exactly 2 down, and both ticked "1-on-1's fine"** → just those two are revealed.
  The rest still get a heads-up.
- **anything else** → silence. Signals stay invisible.

This repo is the part that's hard to get right: the matching brain running on a
server (so no phone can peek at who's secretly in), wrapped in a small API, with a
clickable demo. It runs with **zero dependencies**.

---

## Run it (30 seconds)

Needs Node 18+.

```bash
npm start
# -> open http://localhost:4000 in your browser for the live demo
```

The demo seeds a group ("the squad") and lets you play every member. Flip people on
in the right-hand panel and watch the phone (left) react. Each badge shows exactly
what that person's phone would receive. Watch your terminal too — that's where the
push notifications fire.

Run the tests for the matching rules:

```bash
npm test
```

---

## How it's built

Four small files, each with one job:

- **`src/engine.js`** — the pure rules. Input: who's currently down (+ their 1-on-1
  flag). Output: does it fire, and who's revealed. No dependencies, fully tested. If
  you change the product's matching logic, you change it here and nowhere else.
- **`src/store.js`** — state (users, groups, signals, live hangs), signal expiry, and
  the per-user status. This is where the **privacy guarantee** lives: while a match is
  pending, the status endpoint returns *nothing* about anyone else.
- **`src/notifier.js`** — where a push notification goes out. Swap `ConsoleNotifier`
  for Expo / APNs / FCM without touching any logic.
- **`src/server.js`** — a tiny HTTP API and the demo's static host.

### The privacy guarantee, concretely

A waiting user is never told a count or a name. `GET /status` returns `pending` with
no other detail until a threshold flips it to `on`/`heads_up`. The only endpoint that
can see the pending state is `GET /api/debug/...`, which exists purely for the demo —
**delete it before shipping.**

---

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/users` | create a user `{ name, pushToken? }` |
| POST | `/api/users/:id/push-token` | store/refresh a device's push token |
| POST | `/api/groups` | create a group `{ name, memberIds }` |
| GET | `/api/groups/:id` | group + member names (never who's down) |
| POST | `/api/groups/:id/members` | add a member `{ userId }` |
| GET | `/api/users/:id/groups` | a user's groups |
| POST | `/api/groups/:id/signals` | **press the button** `{ userId, fromTime, oneOnOneOk }` → returns *your own* resulting status only |
| DELETE | `/api/signals/:id?userId=` | un-press |
| GET | `/api/groups/:id/status?userId=` | **poll this** for what to draw: `idle` / `pending` / `on` / `heads_up` |
| GET | `/api/debug/groups/:id` | demo-only god view — **remove for production** |

Re-pressing replaces your previous signal, so changing your time or ticking 1-on-1 is
just another POST. Signals expire after 5h and a live hang after 6h (see the
constants at the top of `store.js`).

---

## Turn this into a real phone app — a Claude Code runbook

You've got the backend. Here's the rest, as prompts you can paste into Claude Code one
at a time. Do them in order; each builds on the last.

**1 — Build the mobile app.**
> "Using the API in this repo's README, create an Expo (React Native) app with one
> main screen: a group called 'the squad', a big round 'I'm down to chill' button that
> POSTs to `/api/groups/:id/signals`, a 'free from' time picker, and a '1-on-1's fine'
> toggle. Poll `/api/groups/:id/status` every few seconds and render the four states
> (idle / pending / on / heads_up). Match the cozy dark look from my web prototype."

**2 — Add real push notifications.**
> "Add Expo push notifications. On launch, register for a push token and send it to
> `POST /api/users/:id/push-token`. Then implement `ExpoNotifier` in `src/notifier.js`
> to POST to `https://exp.host/--/api/v2/push/send` so the 'it's on' and heads-up
> messages arrive as real notifications when the app is closed."

**3 — Make state survive a restart.**
> "Replace the in-memory Maps in `src/store.js` with SQLite (better-sqlite3). Keep the
> same exported function signatures so nothing else changes. Add tables for users,
> groups, group_members, signals, and events."

**4 — Add accounts + groups people can actually create.**
> "Add phone-number sign-in (or magic links), a real 'create group / invite friends'
> flow with invite links, and require auth on every endpoint so a user can only act as
> themselves."

**5 — Deploy.**
> "Help me deploy this backend (Railway/Render/Fly), point the Expo app at the
> deployed URL, and walk me through TestFlight so I can put it on friends' phones."

---

## Before you ship (production checklist)

- [ ] Delete the `/api/debug/...` route.
- [ ] Add authentication; never trust a `userId` from the request body.
- [ ] Move state to a real database (step 3 above).
- [ ] Run resolution inside a transaction / lock so two simultaneous presses can't
      double-create an event.
- [ ] Rate-limit the signals endpoint.
- [ ] Reconsider the expiry windows for your users (a Tuesday-night signal probably
      shouldn't survive to Wednesday).

The rules themselves — the thing most likely to get subtly wrong in a rebuild — are
already pinned down and tested in `engine.js`. Start there if you ever want to change
how matching works.

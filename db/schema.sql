-- ------------------------------------------------------------------
--  Sponty — Postgres schema (Step 2 of the migration off in-memory).
--  Paste this whole file into Supabase → SQL Editor → Run.
--  Each table maps 1:1 to an in-memory Map/Set in the old store.js.
-- ------------------------------------------------------------------

-- users  (was: users Map -> { id, name, pushSubscription })
-- id is TEXT because it's the Supabase auth user id (a uuid string).
create table if not exists users (
  id                text primary key,
  name              text not null,
  push_subscription jsonb,
  created_at        timestamptz not null default now()
);

-- groups  (was: groups Map -> { id, name, minPeople, ownerId, memberIds })
create table if not exists groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  min_people int  not null default 3,
  owner_id   text references users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- group memberships  (was: group.memberIds Set)
create table if not exists group_members (
  group_id  uuid references groups(id) on delete cascade,
  user_id   text references users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

-- signals ("I'm down")  (was: signals Map)
create table if not exists signals (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid references groups(id) on delete cascade,
  user_id       text references users(id) on delete cascade,
  from_time     text,
  one_on_one_ok boolean not null default false,
  cancelled     boolean not null default false,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index if not exists signals_active_idx on signals (group_id) where cancelled = false;

-- events (a live hang)  (was: events Map -> { mode, participantUserIds, sent })
create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid references groups(id) on delete cascade,
  mode       text not null,                       -- 'group' | 'pair'
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists events_group_idx on events (group_id);

-- who's in a live hang  (was: event.participantUserIds Set)
create table if not exists event_participants (
  event_id uuid references events(id) on delete cascade,
  user_id  text references users(id) on delete cascade,
  primary key (event_id, user_id)
);

-- notification de-dupe  (was: event.sent Map -> userId => 'its_on' | 'heads_up')
create table if not exists event_notifications (
  event_id uuid references events(id) on delete cascade,
  user_id  text references users(id) on delete cascade,
  kind     text not null,                          -- 'its_on' | 'heads_up'
  primary key (event_id, user_id)
);

-- chat  (was: messages Map keyed by group+day; here we just filter by created_at)
create table if not exists messages (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid references groups(id) on delete cascade,
  user_id    text references users(id) on delete cascade,
  name       text not null,
  text       text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_group_time_idx on messages (group_id, created_at);

-- friends (symmetric — one row per direction so lookups are trivial)
create table if not exists friends (
  user_id    text references users(id) on delete cascade,
  friend_id  text references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id)
);

-- 1-on-1 "down" state  (was: oneOnOne Map -> { selected, expiresAt })
create table if not exists one_on_one (
  user_id    text primary key references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- who each down-user has picked  (was: oneOnOne.selected Set)
create table if not exists one_on_one_selected (
  user_id   text references users(id) on delete cascade,
  friend_id text references users(id) on delete cascade,
  primary key (user_id, friend_id)
);

-- 1-on-1 match notification de-dupe  (was: oneOnOneSent Set, per day)
create table if not exists one_on_one_sent (
  a_id text references users(id) on delete cascade,   -- store the pair sorted (a < b)
  b_id text references users(id) on delete cascade,
  day  date not null,
  primary key (a_id, b_id, day)
);

-- The Node backend connects with the DB password (bypasses RLS), so no policies
-- are needed yet. RLS comes later, in the step where clients talk to Supabase
-- directly. For now we can leave RLS off on these tables.

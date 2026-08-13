create extension if not exists pgcrypto;

do $$
begin
  create type position_kind as enum ('stock', 'put', 'call', 'cash');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type position_side as enum ('long', 'short');
exception
  when duplicate_object then null;
end $$;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists account_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  account_value numeric not null default 0,
  floor numeric not null default 0,
  cash numeric,
  buying_power numeric,
  cash_secured_put_capacity numeric,
  source text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  ticker text not null,
  symbol text,
  kind position_kind not null,
  side position_side,
  quantity numeric not null default 0,
  strike numeric,
  expiry date,
  price numeric not null default 0,
  avg_cost numeric,
  current_value numeric,
  gain_usd numeric,
  gain_pct numeric,
  option_mark_verified boolean,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists watchlist (
  user_id uuid not null references app_users(id) on delete cascade,
  ticker text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, ticker)
);

create table if not exists screener_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  settings jsonb not null default '{}'::jsonb
);

create table if not exists screener_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references screener_runs(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  ticker text not null,
  price numeric,
  change_pct numeric,
  quote_quality text,
  strike numeric,
  expiry date,
  dte integer,
  bid numeric,
  roi_pct numeric,
  max_pain numeric,
  max_pain_gap_pct numeric,
  rule6 text,
  gate0 text,
  score numeric,
  decision_reason text,
  created_at timestamptz not null default now()
);

create index if not exists app_sessions_token_hash_idx on app_sessions(token_hash);
create index if not exists app_sessions_user_expires_idx on app_sessions(user_id, expires_at desc);
create index if not exists account_snapshots_user_synced_idx on account_snapshots(user_id, synced_at desc);
create index if not exists positions_user_ticker_idx on positions(user_id, ticker);
create index if not exists screener_candidates_user_score_idx on screener_candidates(user_id, score desc);

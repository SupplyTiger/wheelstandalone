create extension if not exists pgcrypto;

create type public.position_kind as enum ('stock', 'put', 'call', 'cash');
create type public.position_side as enum ('long', 'short');

create table public.account_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_value numeric not null default 0,
  floor numeric not null default 0,
  cash numeric,
  buying_power numeric,
  cash_secured_put_capacity numeric,
  source text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  symbol text,
  kind public.position_kind not null,
  side public.position_side,
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

create table public.watchlist (
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, ticker)
);

create table public.screener_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  settings jsonb not null default '{}'::jsonb
);

create table public.screener_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.screener_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
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

alter table public.account_snapshots enable row level security;
alter table public.positions enable row level security;
alter table public.watchlist enable row level security;
alter table public.screener_runs enable row level security;
alter table public.screener_candidates enable row level security;

create policy "Users can read own account snapshots"
  on public.account_snapshots for select
  using (auth.uid() = user_id);

create policy "Users can insert own account snapshots"
  on public.account_snapshots for insert
  with check (auth.uid() = user_id);

create policy "Users can read own positions"
  on public.positions for select
  using (auth.uid() = user_id);

create policy "Users can insert own positions"
  on public.positions for insert
  with check (auth.uid() = user_id);

create policy "Users can delete own positions"
  on public.positions for delete
  using (auth.uid() = user_id);

create policy "Users can read own watchlist"
  on public.watchlist for select
  using (auth.uid() = user_id);

create policy "Users can manage own watchlist"
  on public.watchlist for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can read own screener runs"
  on public.screener_runs for select
  using (auth.uid() = user_id);

create policy "Users can manage own screener runs"
  on public.screener_runs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can read own candidates"
  on public.screener_candidates for select
  using (auth.uid() = user_id);

create policy "Users can manage own candidates"
  on public.screener_candidates for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index account_snapshots_user_synced_idx on public.account_snapshots(user_id, synced_at desc);
create index positions_user_ticker_idx on public.positions(user_id, ticker);
create index screener_candidates_user_score_idx on public.screener_candidates(user_id, score desc);

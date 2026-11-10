-- TokenHub — Fatia 3: Carteira por usuário
-- Rode TUDO no SQL Editor do Supabase (Run). Idempotente.

-- 1) Catálogo de ativos (global, leitura pública)
create table if not exists public.wallet_assets (
  id          text primary key,
  symbol      text not null,
  network     text,
  decimals    integer not null,
  mark        text,
  tone        text,
  price_cents bigint not null,
  sort_order  integer not null default 0
);

alter table public.wallet_assets enable row level security;
drop policy if exists "wallet_assets leitura publica" on public.wallet_assets;
create policy "wallet_assets leitura publica"
  on public.wallet_assets for select to anon, authenticated using (true);

insert into public.wallet_assets (id, symbol, network, decimals, mark, tone, price_cents, sort_order) values
  ('tbrl',    'tBRL',    'Moonbeam',        2, 'T$', 'cyan',       100, 1),
  ('btc',     'BTC',     'Bitcoin',         8, '₿',  'gold',  40000000, 2),
  ('bscusdt', 'BSCUSDT', 'BNB Smart Chain', 2, 'T',  'green',      500, 3),
  ('brl',     'BRL',     'Saldo interno',   2, 'R$', 'navy',       100, 4),
  ('usdt',    'USDT',    'Ethereum',        2, 'T',  'green',      500, 5),
  ('eth',     'ETH',     'Ethereum',        8, 'Ξ',  'silver', 1500000, 6),
  ('usdc',    'USDC',    'Polygon',         2, '$',  'cyan',       500, 7),
  ('tusd',    'tUSD',    'Moonbeam',        2, 'T$', 'navy',       500, 8)
on conflict (id) do update set
  symbol=excluded.symbol, network=excluded.network, decimals=excluded.decimals,
  mark=excluded.mark, tone=excluded.tone, price_cents=excluded.price_cents, sort_order=excluded.sort_order;

-- 2) Movimentações da carteira (por usuário, RLS dono-only)
create table if not exists public.wallet_entries (
  row_id     uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_id   text not null,
  date       date not null,
  kind       text not null check (kind in ('deposit','withdrawal','investment','redemption','income')),
  asset_id   text not null references public.wallet_assets(id),
  units      bigint not null,
  project_id text,
  status     text not null default 'posted',
  name       text,
  created_at timestamptz not null default now(),
  unique (user_id, entry_id)
);

create index if not exists wallet_entries_user_idx on public.wallet_entries(user_id);

alter table public.wallet_entries enable row level security;

drop policy if exists "wallet_entries ler proprias"    on public.wallet_entries;
drop policy if exists "wallet_entries inserir proprias" on public.wallet_entries;
drop policy if exists "wallet_entries editar proprias"  on public.wallet_entries;
drop policy if exists "wallet_entries apagar proprias"  on public.wallet_entries;

create policy "wallet_entries ler proprias"
  on public.wallet_entries for select to authenticated using (user_id = auth.uid());
create policy "wallet_entries inserir proprias"
  on public.wallet_entries for insert to authenticated with check (user_id = auth.uid());
create policy "wallet_entries editar proprias"
  on public.wallet_entries for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "wallet_entries apagar proprias"
  on public.wallet_entries for delete to authenticated using (user_id = auth.uid());

-- TokenHub — Investimento manual (Fase 1: base/config)
-- Rode TUDO no SQL Editor do Supabase (Run). Idempotente.

-- 1) Preço do token por imóvel (em centavos). Default R$100,00.
alter table public.opportunities add column if not exists token_price integer not null default 10000;

-- 2) Configurações gerais do app (conta de depósito, contrato padrão, etc.)
--    Guardadas como chave/valor. Leitura autenticada; escrita só admin.
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

-- Investidor logado pode LER as configurações (conta de depósito, contrato).
drop policy if exists "settings: leitura autenticada" on public.app_settings;
create policy "settings: leitura autenticada"
  on public.app_settings for select to authenticated using (true);

-- Só admin ESCREVE.
drop policy if exists "settings: admin insere" on public.app_settings;
create policy "settings: admin insere"
  on public.app_settings for insert to authenticated with check (public.is_admin());
drop policy if exists "settings: admin edita" on public.app_settings;
create policy "settings: admin edita"
  on public.app_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Linhas iniciais (vazias) para o admin preencher depois.
insert into public.app_settings (key, value) values
  ('deposit_account', '{"banco":"","agencia":"","conta":"","titular":"","documento":"","pix":"","instrucoes":""}'::jsonb),
  ('contract_template', '{"texto":"CONTRATO DE PARTICIPAÇÃO\n\nPelo presente, {{nome}}, inscrito(a) no CPF {{cpf}}, adquire {{tokens}} token(s) do projeto {{projeto}}, no valor total de {{valor}}, em {{data}}.\n\nCada token representa uma fração de participação no referido projeto, conforme as condições aqui descritas."}'::jsonb)
on conflict (key) do nothing;

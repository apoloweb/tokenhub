-- TokenHub — Participações (Fase 1: base/config)
-- Rode TUDO no SQL Editor do Supabase (Run). Idempotente.

-- 1) Campos do projeto: preço do token (= valor da cota), estrutura e sociedade
alter table public.opportunities add column if not exists token_price     integer not null default 10000; -- centavos (R$100,00)
alter table public.opportunities add column if not exists legal_structure text default 'SPE';            -- 'SPE' | 'SCP'
alter table public.opportunities add column if not exists razao_social    text;
alter table public.opportunities add column if not exists cnpj            text;
alter table public.opportunities add column if not exists socio_ostensivo text;

-- 2) Configurações gerais (conta de depósito, contrato padrão). Chave/valor.
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

-- Participante logado LÊ as configurações (conta de depósito, contrato).
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

-- Linhas iniciais para o admin preencher.
insert into public.app_settings (key, value) values
  ('deposit_account', '{"banco":"","agencia":"","conta":"","titular":"","documento":"","pix":"","instrucoes":""}'::jsonb),
  ('contract_template', '{"texto":"TERMO DE ADESÃO E SUBSCRIÇÃO DE PARTICIPAÇÃO\n\nEstrutura: {{estrutura}} — {{sociedade}} (CNPJ {{cnpj}}), sócio ostensivo {{socio_ostensivo}}.\n\nPelo presente, {{nome}}, inscrito(a) no CPF {{cpf}}, subscreve {{tokens}} token(s)/cota(s) do projeto {{projeto}}, no valor total de {{valor}}, em {{data}}.\n\nCada token representa 1 (uma) cota, correspondente a uma fração de participação societária no referido projeto, conforme a estrutura {{estrutura}} e as condições aqui descritas. O(a) subscritor(a) passa à condição de sócio(a) cotista/participante.\n\n[Minuta sujeita à validação jurídica. Não constitui aconselhamento legal.]"}'::jsonb)
on conflict (key) do nothing;

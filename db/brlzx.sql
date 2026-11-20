-- TokenHub — Stablecoin BRLZX: backoffice (emissora + proprietária) e área do cliente
-- Rode TUDO no SQL Editor do Supabase (Run). Idempotente.
-- Depende de: db/admin-setup.sql (profiles, is_admin()).
-- NÃO altera nenhuma tabela, policy ou função existente: tudo aqui é novo e tem prefixo brlzx_.
--
-- Estrutura societária refletida aqui:
--   emissora      = TokenHub: emite, queima, bloqueia endereços.
--   proprietaria  = titular do token, da conta e dos títulos da reserva: atesta a reserva,
--                   paga os resgates e dá a 2ª assinatura nas emissões descobertas acima do limite.
--
-- Regras de acesso:
--   - Cliente só LÊ os próprios dados. Não há policy de insert/update/delete para ninguém:
--     toda escrita passa pelas funções abaixo (security definer), que conferem quem chama.
--   - Cada ato fica na trilha brlzx_audit, que ninguém edita nem apaga.
--   - Valores em centavos (bigint). 1 centavo = 10.000 unidades do token (6 casas decimais).
--   - O backoffice registra o hash das transações; a verdade sobre supply, reserva atestada e
--     bloqueios é o contrato na rede. O banco serve à operação e à conciliação.

-- =====================================================================
-- 1) Equipe: quem é da emissora e quem é da proprietária
-- =====================================================================
create table if not exists public.brlzx_members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  org        text not null check (org in ('emissora','proprietaria')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

alter table public.brlzx_members enable row level security;

-- Empresa (org) de quem está logado; null se for cliente.
create or replace function public.brlzx_org()
returns text language sql stable security definer set search_path = public as $$
  select org from public.brlzx_members where user_id = auth.uid() and active;
$$;

create or replace function public.brlzx_is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select public.brlzx_org() is not null;
$$;

drop policy if exists "brlzx_members: equipe le" on public.brlzx_members;
create policy "brlzx_members: equipe le"
  on public.brlzx_members for select to authenticated
  using (user_id = auth.uid() or public.brlzx_is_staff() or public.is_admin());

-- =====================================================================
-- 2) Trilha de auditoria (só leitura para a equipe; escrita só pelas funções)
-- =====================================================================
create table if not exists public.brlzx_audit (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid,
  actor_org  text,
  action     text not null,
  entity     text not null,
  entity_id  text,
  data       jsonb not null default '{}'::jsonb
);

create index if not exists brlzx_audit_entity_idx on public.brlzx_audit(entity, entity_id);

alter table public.brlzx_audit enable row level security;

drop policy if exists "brlzx_audit: equipe le" on public.brlzx_audit;
create policy "brlzx_audit: equipe le"
  on public.brlzx_audit for select to authenticated using (public.brlzx_is_staff());

create or replace function public.brlzx_log(p_action text, p_entity text, p_entity_id text, p_data jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.brlzx_audit (actor, actor_org, action, entity, entity_id, data)
  values (auth.uid(), public.brlzx_org(), p_action, p_entity, p_entity_id, coalesce(p_data, '{}'::jsonb));
end; $$;

-- Impede alterar ou apagar a trilha, mesmo por quem tem acesso direto à tabela.
create or replace function public.brlzx_audit_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'A trilha de auditoria não pode ser alterada nem apagada.';
end; $$;

drop trigger if exists brlzx_audit_no_change on public.brlzx_audit;
create trigger brlzx_audit_no_change
  before update or delete on public.brlzx_audit
  for each row execute function public.brlzx_audit_immutable();

-- =====================================================================
-- 3) Gestão da equipe
--    Emissora: quem inclui é o admin do TokenHub.
--    Proprietária: quem inclui é alguém da própria proprietária. O admin do TokenHub só
--    inclui o PRIMEIRO membro dela (para dar a partida); depois disso, não mais.
-- =====================================================================
create or replace function public.brlzx_set_member(p_user_id uuid, p_org text, p_active boolean default true)
returns public.brlzx_members
language plpgsql security definer set search_path = public as $$
declare
  m public.brlzx_members;
  has_owner boolean;
begin
  if p_org not in ('emissora','proprietaria') then raise exception 'Empresa inválida.'; end if;
  if not exists (select 1 from auth.users where id = p_user_id) then raise exception 'Usuário não encontrado.'; end if;

  if p_org = 'emissora' then
    if not public.is_admin() then raise exception 'Só o administrador do TokenHub gerencia a equipe da emissora.'; end if;
  else
    select exists (select 1 from public.brlzx_members where org = 'proprietaria' and active) into has_owner;
    if has_owner then
      if public.brlzx_org() is distinct from 'proprietaria' then
        raise exception 'Só a proprietária gerencia a própria equipe.';
      end if;
    elsif not public.is_admin() then
      raise exception 'O primeiro membro da proprietária é incluído pelo administrador do TokenHub.';
    end if;
  end if;

  select * into m from public.brlzx_members where user_id = p_user_id;
  if found and m.org <> p_org then
    raise exception 'Este usuário já pertence à outra empresa. Uma pessoa não atua pelas duas.';
  end if;

  insert into public.brlzx_members (user_id, org, active, created_by)
  values (p_user_id, p_org, p_active, auth.uid())
  on conflict (user_id) do update set active = excluded.active
  returning * into m;

  perform public.brlzx_log('equipe.definir', 'member', p_user_id::text, jsonb_build_object('org', p_org, 'active', p_active));
  return m;
end; $$;

-- =====================================================================
-- 4) Configurações (linha única)
-- =====================================================================
create table if not exists public.brlzx_settings (
  id               integer primary key default 1 check (id = 1),
  chain_id         integer not null default 137,          -- Polygon
  contract_address text check (contract_address is null or contract_address ~ '^0x[0-9a-fA-F]{40}$'),
  treasury_address text check (treasury_address is null or treasury_address ~ '^0x[0-9a-fA-F]{40}$'),
  owner_name       text,                                   -- razão social da proprietária
  -- Dados de depósito: conta da PROPRIETÁRIA, para onde o cliente paga a emissão.
  deposit_pix_key  text,
  deposit_holder   text,
  deposit_document text,
  deposit_bank     text,
  deposit_agency   text,
  deposit_account  text,
  deposit_notes    text,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id)
);

insert into public.brlzx_settings (id) values (1) on conflict (id) do nothing;

alter table public.brlzx_settings enable row level security;

drop policy if exists "brlzx_settings: logado le" on public.brlzx_settings;
create policy "brlzx_settings: logado le"
  on public.brlzx_settings for select to authenticated using (true);

-- Rede, contrato e tesouraria: proprietária ou admin do TokenHub.
create or replace function public.brlzx_save_network(p_chain_id integer, p_contract text, p_treasury text)
returns public.brlzx_settings
language plpgsql security definer set search_path = public as $$
declare s public.brlzx_settings;
begin
  if public.brlzx_org() is distinct from 'proprietaria' and not public.is_admin() then
    raise exception 'Sem permissão para alterar a configuração da rede.';
  end if;
  update public.brlzx_settings
     set chain_id = coalesce(p_chain_id, chain_id),
         contract_address = nullif(trim(p_contract), ''),
         treasury_address = nullif(trim(p_treasury), ''),
         updated_at = now(), updated_by = auth.uid()
   where id = 1 returning * into s;
  perform public.brlzx_log('config.rede', 'settings', '1',
    jsonb_build_object('chain_id', s.chain_id, 'contract', s.contract_address, 'treasury', s.treasury_address));
  return s;
end; $$;

-- Dados de depósito: SÓ a proprietária. Quem muda essa conta muda para onde vai o dinheiro do cliente.
create or replace function public.brlzx_save_deposit(p jsonb)
returns public.brlzx_settings
language plpgsql security definer set search_path = public as $$
declare s public.brlzx_settings;
begin
  if public.brlzx_org() is distinct from 'proprietaria' then
    raise exception 'Só a proprietária altera os dados de depósito.';
  end if;
  update public.brlzx_settings
     set owner_name       = nullif(trim(p->>'owner_name'), ''),
         deposit_pix_key  = nullif(trim(p->>'deposit_pix_key'), ''),
         deposit_holder   = nullif(trim(p->>'deposit_holder'), ''),
         deposit_document = nullif(trim(p->>'deposit_document'), ''),
         deposit_bank     = nullif(trim(p->>'deposit_bank'), ''),
         deposit_agency   = nullif(trim(p->>'deposit_agency'), ''),
         deposit_account  = nullif(trim(p->>'deposit_account'), ''),
         deposit_notes    = nullif(trim(p->>'deposit_notes'), ''),
         updated_at = now(), updated_by = auth.uid()
   where id = 1 returning * into s;
  perform public.brlzx_log('config.deposito', 'settings', '1', p);
  return s;
end; $$;

-- =====================================================================
-- 5) Carteiras (endereços) dos clientes
-- =====================================================================
create table if not exists public.brlzx_wallets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  address    text not null check (address ~ '^0x[0-9a-f]{40}$'),   -- sempre em minúsculas
  label      text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, address)
);

alter table public.brlzx_wallets enable row level security;

drop policy if exists "brlzx_wallets: dono ou equipe le" on public.brlzx_wallets;
create policy "brlzx_wallets: dono ou equipe le"
  on public.brlzx_wallets for select to authenticated
  using (user_id = auth.uid() or public.brlzx_is_staff());

-- O cliente cadastra endereço próprio; não edita nem apaga. A emissora pode desativar.
create or replace function public.brlzx_add_wallet(p_address text, p_label text default null)
returns public.brlzx_wallets
language plpgsql security definer set search_path = public as $$
declare w public.brlzx_wallets; a text := lower(trim(p_address));
begin
  if auth.uid() is null then raise exception 'Entre na sua conta.'; end if;
  if a !~ '^0x[0-9a-f]{40}$' then raise exception 'Endereço de carteira inválido.'; end if;
  insert into public.brlzx_wallets (user_id, address, label)
  values (auth.uid(), a, nullif(trim(p_label), ''))
  on conflict (user_id, address) do update set label = coalesce(excluded.label, public.brlzx_wallets.label)
  returning * into w;
  perform public.brlzx_log('carteira.cadastrar', 'wallet', w.id::text, jsonb_build_object('address', a));
  return w;
end; $$;

create or replace function public.brlzx_set_wallet_active(p_wallet_id uuid, p_active boolean)
returns public.brlzx_wallets
language plpgsql security definer set search_path = public as $$
declare w public.brlzx_wallets;
begin
  if public.brlzx_org() is distinct from 'emissora' then raise exception 'Só a emissora ativa ou desativa carteiras.'; end if;
  update public.brlzx_wallets set active = p_active where id = p_wallet_id returning * into w;
  if not found then raise exception 'Carteira não encontrada.'; end if;
  perform public.brlzx_log('carteira.ativar', 'wallet', w.id::text, jsonb_build_object('active', p_active));
  return w;
end; $$;

-- =====================================================================
-- 6) Ordens de emissão e de resgate
--
-- Emissão:  solicitada -> emitida                      (emissora emite direto)
--           solicitada -> proposta -> emitida          (total descoberto acima do limite:
--                                                       emissora propõe, proprietária aprova)
-- Resgate:  solicitada -> tokens_recebidos -> paga -> queimada
--                         (emissora)          (proprietária) (emissora)
-- Qualquer uma, antes de concluir: rejeitada (equipe) ou cancelada (cliente, só se 'solicitada').
-- =====================================================================
create table if not exists public.brlzx_orders (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('emissao','resgate')),
  user_id         uuid not null references auth.users(id),
  amount_cents    bigint not null check (amount_cents > 0),
  wallet_address  text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  payment_method  text check (payment_method in ('pix','ted','boleto','transferencia_interna','dinheiro')),
  payout_details  text,                 -- resgate: chave Pix ou dados bancários do cliente
  status          text not null default 'solicitada'
                    check (status in ('solicitada','proposta','emitida','tokens_recebidos','paga','queimada','rejeitada','cancelada')),
  ref             text not null unique check (ref ~ '^0x[0-9a-f]{64}$'),  -- referência única usada no contrato
  note            text,
  reject_reason   text,
  -- transações na rede
  proposal_tx     text check (proposal_tx is null or proposal_tx ~ '^0x[0-9a-f]{64}$'),
  mint_tx         text check (mint_tx     is null or mint_tx     ~ '^0x[0-9a-f]{64}$'),
  deposit_tx      text check (deposit_tx  is null or deposit_tx  ~ '^0x[0-9a-f]{64}$'),  -- cliente -> tesouraria
  burn_tx         text check (burn_tx     is null or burn_tx     ~ '^0x[0-9a-f]{64}$'),
  -- quem fez o quê
  created_by      uuid not null references auth.users(id),
  created_at      timestamptz not null default now(),
  proposed_by     uuid references auth.users(id),  proposed_at  timestamptz,
  minted_by       uuid references auth.users(id),  minted_at    timestamptz,
  received_by     uuid references auth.users(id),  received_at  timestamptz,
  paid_by         uuid references auth.users(id),  paid_at      timestamptz,
  burned_by       uuid references auth.users(id),  burned_at    timestamptz,
  closed_by       uuid references auth.users(id),  closed_at    timestamptz,   -- rejeição/cancelamento
  check ((kind = 'emissao' and payment_method is not null and status not in ('tokens_recebidos','paga','queimada'))
      or (kind = 'resgate' and status not in ('proposta','emitida')))
);

create index if not exists brlzx_orders_user_idx   on public.brlzx_orders(user_id);
create index if not exists brlzx_orders_status_idx on public.brlzx_orders(kind, status);

alter table public.brlzx_orders enable row level security;

drop policy if exists "brlzx_orders: dono ou equipe le" on public.brlzx_orders;
create policy "brlzx_orders: dono ou equipe le"
  on public.brlzx_orders for select to authenticated
  using (user_id = auth.uid() or public.brlzx_is_staff());

-- Referência única da ordem (32 bytes), usada como `ref` no contrato.
create or replace function public.brlzx_ref(p_id uuid)
returns text language sql immutable as $$
  select '0x' || encode(sha256(convert_to('brlzx:' || p_id::text, 'UTF8')), 'hex');
$$;

create or replace function public.brlzx_tx(p_tx text)
returns text language plpgsql immutable as $$
declare t text := lower(trim(coalesce(p_tx, '')));
begin
  if t !~ '^0x[0-9a-f]{64}$' then raise exception 'Hash de transação inválido.'; end if;
  return t;
end; $$;

-- Valida o hash e garante que a mesma transação da rede não seja usada em dois registros.
create or replace function public.brlzx_new_tx(p_tx text)
returns text language plpgsql security definer set search_path = public as $$
declare t text := public.brlzx_tx(p_tx);
begin
  if exists (select 1 from public.brlzx_orders where t in (proposal_tx, mint_tx, deposit_tx, burn_tx))
     or exists (select 1 from public.brlzx_reserve_attestations where tx = t)
     or exists (select 1 from public.brlzx_compliance_actions where tx = t) then
    raise exception 'Esta transação já foi usada em outro registro.';
  end if;
  return t;
end; $$;

-- Trava a ordem e confere tipo e status esperados.
create or replace function public.brlzx_lock_order(p_id uuid, p_kind text, p_status text[])
returns public.brlzx_orders
language plpgsql security definer set search_path = public as $$
declare o public.brlzx_orders;
begin
  select * into o from public.brlzx_orders where id = p_id for update;
  if not found then raise exception 'Ordem não encontrada.'; end if;
  if p_kind is not null and o.kind <> p_kind then raise exception 'Esta ordem não é de %.', p_kind; end if;
  if not (o.status = any (p_status)) then raise exception 'Ordem com status "%": ação não permitida.', o.status; end if;
  return o;
end; $$;

-- ---------- Abertura (cliente, ou emissora em nome do cliente) ----------
create or replace function public.brlzx_request_issue(
  p_amount_cents bigint, p_payment_method text, p_wallet_address text,
  p_user_id uuid default null, p_note text default null)
returns public.brlzx_orders
language plpgsql security definer set search_path = public as $$
declare
  o public.brlzx_orders;
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_id uuid := gen_random_uuid();
  a text := lower(trim(p_wallet_address));
begin
  if auth.uid() is null then raise exception 'Entre na sua conta.'; end if;
  if v_user <> auth.uid() and public.brlzx_org() is distinct from 'emissora' then
    raise exception 'Só a emissora abre ordem em nome de um cliente.';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Valor inválido.'; end if;
  if not exists (select 1 from public.brlzx_wallets where user_id = v_user and address = a and active) then
    raise exception 'A carteira de destino precisa estar cadastrada e ativa na conta do cliente.';
  end if;
  insert into public.brlzx_orders (id, kind, user_id, amount_cents, wallet_address, payment_method, ref, note, created_by)
  values (v_id, 'emissao', v_user, p_amount_cents, a, p_payment_method, public.brlzx_ref(v_id), nullif(trim(p_note), ''), auth.uid())
  returning * into o;
  perform public.brlzx_log('emissao.solicitar', 'order', o.id::text,
    jsonb_build_object('amount_cents', o.amount_cents, 'payment_method', o.payment_method, 'wallet', o.wallet_address, 'user_id', v_user));
  return o;
end; $$;

create or replace function public.brlzx_request_redeem(
  p_amount_cents bigint, p_wallet_address text, p_payout_details text,
  p_user_id uuid default null, p_note text default null)
returns public.brlzx_orders
language plpgsql security definer set search_path = public as $$
declare
  o public.brlzx_orders;
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_id uuid := gen_random_uuid();
  a text := lower(trim(p_wallet_address));
begin
  if auth.uid() is null then raise exception 'Entre na sua conta.'; end if;
  if v_user <> auth.uid() and public.brlzx_org() is distinct from 'emissora' then
    raise exception 'Só a emissora abre ordem em nome de um cliente.';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Valor inválido.'; end if;
  if nullif(trim(p_payout_details), '') is null then raise exception 'Informe a chave Pix ou os dados bancários para o pagamento.'; end if;
  if not exists (select 1 from public.brlzx_wallets where user_id = v_user and address = a and active) then
    raise exception 'A carteira de origem precisa estar cadastrada e ativa na conta do cliente.';
  end if;
  insert into public.brlzx_orders (id, kind, user_id, amount_cents, wallet_address, payout_details, ref, note, created_by)
  values (v_id, 'resgate', v_user, p_amount_cents, a, trim(p_payout_details), public.brlzx_ref(v_id), nullif(trim(p_note), ''), auth.uid())
  returning * into o;
  perform public.brlzx_log('resgate.solicitar', 'order', o.id::text,
    jsonb_build_object('amount_cents', o.amount_cents, 'wallet', o.wallet_address, 'user_id', v_user));
  return o;
end; $$;

-- ---------- Emissão ----------
-- Emissora registra a emissão direta (mint) já feita na rede.
create or replace function public.brlzx_issue_minted(p_order_id uuid, p_tx text)
returns public.brlzx_orders
language plpgsql security definer set search_path = public as $$
declare o public.brlzx_orders;
begin
  if public.brlzx_org() is distinct from 'emissora' then raise exception 'Só a emissora registra a emissão.'; end if;
  o := public.brlzx_lock_order(p_order_id, 'emissao', array['solicitada']);
  update public.brlzx_orders set status = 'emitida', mint_tx = public.brlzx_new_tx(p_tx), minted_by = auth.uid(), minted_at = now()
   where id = p_order_id returning * into o;
  perform public.brlzx_log('emissao.emitir', 'order', o.id::text, jsonb_build_object('tx', o.mint_tx, 'amount_cents', o.amount_cents));
  return o;
end; $$;

-- Emissora registra a proposta (proposeMint) quando o total descoberto passaria do limite.
create or replace function public.brlzx_issue_proposed(p_order_id uuid, p_tx text)
returns public.brlzx_orders
language plpgsql security definer set search_path = public as $$
declare o public.brlzx_orders;
begin
  if public.brlzx_org() is distinct from 'emissora' then raise exception 'Só a emissora propõe a emissão.'; end if;
  o := public.brlzx_lock_order(p_order_id, 'emissao', array['solicitada']);
  update public.brlzx_orders set status = 'proposta', proposal_tx = public.brlzx_new_tx(p_tx), proposed_by = auth.uid(), proposed_at = now()
   where id = p_order_id returning * into o;
  perform public.brlzx_log('emissao.propor', 'order', o.id::text, jsonb_build_object('tx', o.proposal_tx, 'amount_cents', o.amount_cents));
  return o;
end; $$;

-- Proprietária registra a aprovação (approveMint), que executa a emissão na rede.
create or replace function public.brlzx_issue_approved(p_order_id uuid, p_tx text)
returns public.brlzx_orders
language plpgsql security definer set search_path = public as $$
declare o public.brlzx_orders;
begin
  if public.brlzx_org() is distinct from 'proprietaria' then raise exception 'Só a proprietária dá a segunda aprovação.'; end if;
  o := public.brlzx_lock_order(p_order_id, 'emissao', array['proposta']);
  update public.brlzx_orders set status = 'emitida', mint_tx = public.brlzx_new_tx(p_tx), minted_by = auth.uid(), minted_at = now()
   where id = p_order_id returning * into o;
  perform public.brlzx_log('emissao.aprovar', 'order', o.id::text, jsonb_build_object('tx', o.mint_tx, 'amount_cents', o.amount_cents));
  return o;
end; $$;

-- ---------- Resgate ----------
-- Emissora confirma que os tokens do cliente chegaram na tesouraria.
create or replace function public.brlzx_redeem_received(p_order_id uuid, p_tx text)
returns public.brlzx_orders
language plpgsql security definer set search_path = public as $$
declare o public.brlzx_orders;
begin
  if public.brlzx_org() is distinct from 'emissora' then raise exception 'Só a emissora confirma o recebimento dos tokens.'; end if;
  o := public.brlzx_lock_order(p_order_id, 'resgate', array['solicitada']);
  update public.brlzx_orders set status = 'tokens_recebidos', deposit_tx = public.brlzx_new_tx(p_tx), received_by = auth.uid(), received_at = now()
   where id = p_order_id returning * into o;
  perform public.brlzx_log('resgate.tokens_recebidos', 'order', o.id::text, jsonb_build_object('tx', o.deposit_tx));
  return o;
end; $$;

-- Proprietária confirma o pagamento em reais ao cliente.
create or replace function public.brlzx_redeem_paid(p_order_id uuid, p_note text default null)
returns public.brlzx_orders
language plpgsql security definer set search_path = public as $$
declare o public.brlzx_orders;
begin
  if public.brlzx_org() is distinct from 'proprietaria' then raise exception 'Só a proprietária confirma o pagamento do resgate.'; end if;
  o := public.brlzx_lock_order(p_order_id, 'resgate', array['tokens_recebidos']);
  update public.brlzx_orders set status = 'paga', paid_by = auth.uid(), paid_at = now(),
         note = coalesce(nullif(trim(p_note), ''), note)
   where id = p_order_id returning * into o;
  perform public.brlzx_log('resgate.pagar', 'order', o.id::text, jsonb_build_object('amount_cents', o.amount_cents, 'note', p_note));
  return o;
end; $$;

-- Emissora registra a queima (redeem) feita na rede, depois do pagamento.
create or replace function public.brlzx_redeem_burned(p_order_id uuid, p_tx text)
returns public.brlzx_orders
language plpgsql security definer set search_path = public as $$
declare o public.brlzx_orders;
begin
  if public.brlzx_org() is distinct from 'emissora' then raise exception 'Só a emissora registra a queima.'; end if;
  o := public.brlzx_lock_order(p_order_id, 'resgate', array['paga']);
  update public.brlzx_orders set status = 'queimada', burn_tx = public.brlzx_new_tx(p_tx), burned_by = auth.uid(), burned_at = now()
   where id = p_order_id returning * into o;
  perform public.brlzx_log('resgate.queimar', 'order', o.id::text, jsonb_build_object('tx', o.burn_tx, 'amount_cents', o.amount_cents));
  return o;
end; $$;

-- ---------- Rejeição e cancelamento ----------
-- Equipe rejeita enquanto nada irreversível aconteceu.
-- Resgate com tokens já recebidos só é rejeitado pela emissora (que devolve os tokens ao cliente).
create or replace function public.brlzx_reject_order(p_order_id uuid, p_reason text)
returns public.brlzx_orders
language plpgsql security definer set search_path = public as $$
declare o public.brlzx_orders; v_org text := public.brlzx_org();
begin
  if v_org is null then raise exception 'Só a equipe rejeita ordens.'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Informe o motivo da rejeição.'; end if;
  o := public.brlzx_lock_order(p_order_id, null, array['solicitada','proposta','tokens_recebidos']);
  if o.status = 'tokens_recebidos' and v_org <> 'emissora' then
    raise exception 'Com os tokens já na tesouraria, só a emissora rejeita (e devolve os tokens).';
  end if;
  update public.brlzx_orders set status = 'rejeitada', reject_reason = trim(p_reason), closed_by = auth.uid(), closed_at = now()
   where id = p_order_id returning * into o;
  perform public.brlzx_log('ordem.rejeitar', 'order', o.id::text, jsonb_build_object('reason', o.reject_reason));
  return o;
end; $$;

-- Cliente cancela a própria ordem enquanto ainda está apenas solicitada (nada é apagado).
create or replace function public.brlzx_cancel_order(p_order_id uuid)
returns public.brlzx_orders
language plpgsql security definer set search_path = public as $$
declare o public.brlzx_orders;
begin
  o := public.brlzx_lock_order(p_order_id, null, array['solicitada']);
  if o.user_id <> auth.uid() then raise exception 'Você só cancela as próprias ordens.'; end if;
  update public.brlzx_orders set status = 'cancelada', closed_by = auth.uid(), closed_at = now()
   where id = p_order_id returning * into o;
  perform public.brlzx_log('ordem.cancelar', 'order', o.id::text, '{}'::jsonb);
  return o;
end; $$;

-- =====================================================================
-- 7) Reserva: atestações feitas pela proprietária
-- =====================================================================
create table if not exists public.brlzx_reserve_attestations (
  id           uuid primary key default gen_random_uuid(),
  cash_cents   bigint not null check (cash_cents  >= 0),   -- saldo em conta
  bonds_cents  bigint not null check (bonds_cents >= 0),   -- títulos públicos
  total_cents  bigint generated always as (cash_cents + bonds_cents) stored,
  note         text,
  tx           text not null unique check (tx ~ '^0x[0-9a-f]{64}$'),   -- attestReserve na rede
  created_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now()
);

alter table public.brlzx_reserve_attestations enable row level security;

drop policy if exists "brlzx_reserve: equipe le" on public.brlzx_reserve_attestations;
create policy "brlzx_reserve: equipe le"
  on public.brlzx_reserve_attestations for select to authenticated using (public.brlzx_is_staff());

create or replace function public.brlzx_attest_reserve(p_cash_cents bigint, p_bonds_cents bigint, p_tx text, p_note text default null)
returns public.brlzx_reserve_attestations
language plpgsql security definer set search_path = public as $$
declare r public.brlzx_reserve_attestations;
begin
  if public.brlzx_org() is distinct from 'proprietaria' then raise exception 'Só a proprietária atesta a reserva.'; end if;
  insert into public.brlzx_reserve_attestations (cash_cents, bonds_cents, note, tx, created_by)
  values (p_cash_cents, p_bonds_cents, nullif(trim(p_note), ''), public.brlzx_new_tx(p_tx), auth.uid())
  returning * into r;
  perform public.brlzx_log('reserva.atestar', 'reserve', r.id::text,
    jsonb_build_object('cash_cents', r.cash_cents, 'bonds_cents', r.bonds_cents, 'total_cents', r.total_cents, 'tx', r.tx));
  return r;
end; $$;

-- =====================================================================
-- 8) Compliance: registro de bloqueios feitos pela emissora
-- =====================================================================
create table if not exists public.brlzx_compliance_actions (
  id         uuid primary key default gen_random_uuid(),
  address    text not null check (address ~ '^0x[0-9a-f]{40}$'),
  action     text not null check (action in ('bloquear','desbloquear','destruir')),
  reason     text not null,
  tx         text not null unique check (tx ~ '^0x[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists brlzx_compliance_address_idx on public.brlzx_compliance_actions(address);

alter table public.brlzx_compliance_actions enable row level security;

drop policy if exists "brlzx_compliance: equipe le" on public.brlzx_compliance_actions;
create policy "brlzx_compliance: equipe le"
  on public.brlzx_compliance_actions for select to authenticated using (public.brlzx_is_staff());

create or replace function public.brlzx_compliance(p_address text, p_action text, p_reason text, p_tx text)
returns public.brlzx_compliance_actions
language plpgsql security definer set search_path = public as $$
declare c public.brlzx_compliance_actions; a text := lower(trim(p_address));
begin
  if public.brlzx_org() is distinct from 'emissora' then raise exception 'Só a emissora registra ações de compliance.'; end if;
  if a !~ '^0x[0-9a-f]{40}$' then raise exception 'Endereço inválido.'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Informe o motivo.'; end if;
  insert into public.brlzx_compliance_actions (address, action, reason, tx, created_by)
  values (a, p_action, trim(p_reason), public.brlzx_new_tx(p_tx), auth.uid())
  returning * into c;
  perform public.brlzx_log('compliance.' || c.action, 'address', a, jsonb_build_object('reason', c.reason, 'tx', c.tx));
  return c;
end; $$;

-- =====================================================================
-- 9) Totais para conciliação (segundo o backoffice; conferir com a rede)
-- =====================================================================
create or replace function public.brlzx_totals()
returns table (emitido_cents bigint, queimado_cents bigint, em_circulacao_cents bigint,
               reserva_cents bigint, reserva_em timestamptz,
               emissoes_pendentes bigint, propostas_pendentes bigint, resgates_a_pagar bigint, resgates_a_queimar bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.brlzx_is_staff() then raise exception 'Só a equipe consulta os totais.'; end if;
  return query
  with o as (select * from public.brlzx_orders),
       r as (select total_cents, created_at from public.brlzx_reserve_attestations order by created_at desc limit 1)
  select
    coalesce((select sum(amount_cents) from o where kind = 'emissao' and status = 'emitida'), 0)::bigint,
    coalesce((select sum(amount_cents) from o where kind = 'resgate' and status = 'queimada'), 0)::bigint,
    (coalesce((select sum(amount_cents) from o where kind = 'emissao' and status = 'emitida'), 0)
      - coalesce((select sum(amount_cents) from o where kind = 'resgate' and status = 'queimada'), 0))::bigint,
    coalesce((select total_cents from r), 0)::bigint,
    (select created_at from r),
    (select count(*) from o where kind = 'emissao' and status = 'solicitada'),
    (select count(*) from o where kind = 'emissao' and status = 'proposta'),
    (select count(*) from o where kind = 'resgate' and status = 'tokens_recebidos'),
    (select count(*) from o where kind = 'resgate' and status = 'paga');
end; $$;

-- =====================================================================
-- 10) Permissões: ninguém escreve direto nas tabelas; funções só para logados
-- =====================================================================
revoke insert, update, delete, truncate on
  public.brlzx_members, public.brlzx_audit, public.brlzx_settings, public.brlzx_wallets,
  public.brlzx_orders, public.brlzx_reserve_attestations, public.brlzx_compliance_actions
  from anon, authenticated;

revoke all on function
  public.brlzx_log(text, text, text, jsonb),
  public.brlzx_lock_order(uuid, text, text[]),
  public.brlzx_new_tx(text)
  from public, anon, authenticated;   -- uso interno das demais funções

revoke all on function
  public.brlzx_set_member(uuid, text, boolean),
  public.brlzx_save_network(integer, text, text),
  public.brlzx_save_deposit(jsonb),
  public.brlzx_add_wallet(text, text),
  public.brlzx_set_wallet_active(uuid, boolean),
  public.brlzx_request_issue(bigint, text, text, uuid, text),
  public.brlzx_request_redeem(bigint, text, text, uuid, text),
  public.brlzx_issue_minted(uuid, text),
  public.brlzx_issue_proposed(uuid, text),
  public.brlzx_issue_approved(uuid, text),
  public.brlzx_redeem_received(uuid, text),
  public.brlzx_redeem_paid(uuid, text),
  public.brlzx_redeem_burned(uuid, text),
  public.brlzx_reject_order(uuid, text),
  public.brlzx_cancel_order(uuid),
  public.brlzx_attest_reserve(bigint, bigint, text, text),
  public.brlzx_compliance(text, text, text, text),
  public.brlzx_totals()
  from public, anon;

grant execute on function
  public.brlzx_set_member(uuid, text, boolean),
  public.brlzx_save_network(integer, text, text),
  public.brlzx_save_deposit(jsonb),
  public.brlzx_add_wallet(text, text),
  public.brlzx_set_wallet_active(uuid, boolean),
  public.brlzx_request_issue(bigint, text, text, uuid, text),
  public.brlzx_request_redeem(bigint, text, text, uuid, text),
  public.brlzx_issue_minted(uuid, text),
  public.brlzx_issue_proposed(uuid, text),
  public.brlzx_issue_approved(uuid, text),
  public.brlzx_redeem_received(uuid, text),
  public.brlzx_redeem_paid(uuid, text),
  public.brlzx_redeem_burned(uuid, text),
  public.brlzx_reject_order(uuid, text),
  public.brlzx_cancel_order(uuid),
  public.brlzx_attest_reserve(bigint, bigint, text, text),
  public.brlzx_compliance(text, text, text, text),
  public.brlzx_totals()
  to authenticated;

-- =====================================================================
-- 11) Uma transação da rede só pode estar em uma ordem
-- =====================================================================
create unique index if not exists brlzx_orders_proposal_tx_uq on public.brlzx_orders(proposal_tx) where proposal_tx is not null;
create unique index if not exists brlzx_orders_mint_tx_uq     on public.brlzx_orders(mint_tx)     where mint_tx     is not null;
create unique index if not exists brlzx_orders_deposit_tx_uq  on public.brlzx_orders(deposit_tx)  where deposit_tx  is not null;
create unique index if not exists brlzx_orders_burn_tx_uq     on public.brlzx_orders(burn_tx)     where burn_tx     is not null;

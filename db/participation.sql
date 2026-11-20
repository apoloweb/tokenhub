-- TokenHub — Participações (Fase 2: pedidos do investidor)
-- Rode TUDO no SQL Editor do Supabase (Run). Idempotente.
-- Depende de: opportunities, profiles/is_admin(), wallet_entries, app_settings.

-- =====================================================================
-- 1) Tabela de pedidos de participação
-- =====================================================================
create table if not exists public.participation_requests (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  opportunity_id   text not null,                 -- id da oportunidade (sem FK: cobre o UP e flexibilidade)
  opportunity_name text,                           -- snapshot do nome do projeto
  legal_structure  text,                           -- snapshot 'SPE' | 'SCP'
  tokens           integer not null check (tokens > 0),      -- nº de cotas
  unit_price_cents integer not null check (unit_price_cents >= 0), -- valor da cota (centavos) no momento
  amount_cents     bigint  not null check (amount_cents >= 0),     -- valor total (centavos)
  investor_name    text,                           -- snapshot do nome do investidor
  cpf              text,                            -- CPF informado para o contrato
  accepted_terms   boolean not null default false,  -- aceite digital do contrato
  contract_text    text,                            -- snapshot do contrato preenchido e aceito
  comprovante_path text,                            -- caminho no Storage (bucket comprovantes)
  status           text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at       timestamptz not null default now(),
  approved_at      timestamptz,
  approved_by      uuid references auth.users(id)
);

create index if not exists participation_requests_user_idx    on public.participation_requests(user_id);
create index if not exists participation_requests_opp_idx     on public.participation_requests(opportunity_id);
create index if not exists participation_requests_status_idx  on public.participation_requests(status);

alter table public.participation_requests enable row level security;

-- Investidor: lê e cria os PRÓPRIOS pedidos (sempre como 'pending').
drop policy if exists "pr: investidor le os proprios"   on public.participation_requests;
create policy "pr: investidor le os proprios"
  on public.participation_requests for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "pr: investidor cria o proprio"   on public.participation_requests;
create policy "pr: investidor cria o proprio"
  on public.participation_requests for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending');

-- Admin: pode atualizar, MAS só para 'pending' ou 'rejected' (a APROVAÇÃO
-- é feita pela função approve_participation_request, que também credita a carteira).
drop policy if exists "pr: admin atualiza (rejeitar)" on public.participation_requests;
create policy "pr: admin atualiza (rejeitar)"
  on public.participation_requests for update to authenticated
  using (public.is_admin())
  with check (public.is_admin() and status in ('pending','rejected'));

-- Investidor pode cancelar (apagar) um pedido ainda PENDENTE seu.
drop policy if exists "pr: investidor cancela pendente" on public.participation_requests;
create policy "pr: investidor cancela pendente"
  on public.participation_requests for delete to authenticated
  using (user_id = auth.uid() and status = 'pending');

-- =====================================================================
-- 2) Bucket privado para os comprovantes de PIX
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('comprovantes', 'comprovantes', false)
on conflict (id) do update set public = false;

-- Caminho esperado: <user_id>/<request_id>.<ext>  (a 1ª pasta = dono)
drop policy if exists "comprovantes: dono le" on storage.objects;
create policy "comprovantes: dono le"
  on storage.objects for select to authenticated
  using (bucket_id = 'comprovantes'
         and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

drop policy if exists "comprovantes: dono envia" on storage.objects;
create policy "comprovantes: dono envia"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'comprovantes'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "comprovantes: dono atualiza" on storage.objects;
create policy "comprovantes: dono atualiza"
  on storage.objects for update to authenticated
  using (bucket_id = 'comprovantes'
         and (storage.foldername(name))[1] = auth.uid()::text);

-- =====================================================================
-- 3) Função de APROVAÇÃO (admin): credita a carteira + atualiza captado
--    SECURITY DEFINER: roda com privilégio, mas checa is_admin() primeiro.
--    Carteira: insere um par depósito(+) + investimento(-) em BRL, para
--    o saldo ficar consistente (o modelo rejeita saldo negativo) e a
--    posição do projeto aparecer na carteira do investidor.
-- =====================================================================
create or replace function public.approve_participation_request(p_request_id uuid)
returns public.participation_requests
language plpgsql security definer set search_path = public as $$
declare
  r    public.participation_requests;
  proj public.opportunities;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem aprovar pedidos.';
  end if;

  select * into r from public.participation_requests where id = p_request_id for update;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  if r.status <> 'pending' then raise exception 'Pedido não está pendente (status: %).', r.status; end if;

  select * into proj from public.opportunities where id = r.opportunity_id;

  -- Lançamentos na carteira do investidor (BRL: units = centavos).
  insert into public.wallet_entries (user_id, entry_id, date, kind, asset_id, units, project_id, status, name)
  values
    (r.user_id, 'part-dep-'||r.id::text, current_date, 'deposit',    'brl',  r.amount_cents, null, 'posted',
       'Depósito confirmado · '||coalesce(proj.name, r.opportunity_name, r.opportunity_id)),
    (r.user_id, 'part-inv-'||r.id::text, current_date, 'investment', 'brl', -r.amount_cents, r.opportunity_id, 'posted',
       'Participação · '||coalesce(proj.name, r.opportunity_name, r.opportunity_id))
  on conflict (user_id, entry_id) do nothing;

  -- Marca aprovado.
  update public.participation_requests
     set status = 'approved', approved_at = now(), approved_by = auth.uid()
   where id = r.id
   returning * into r;

  -- Atualiza o total captado do projeto (soma dos pedidos aprovados), se o projeto existir na tabela.
  if proj.id is not null then
    update public.opportunities o
       set raised   = (select coalesce(sum(pr.amount_cents),0) from public.participation_requests pr
                        where pr.opportunity_id = o.id and pr.status = 'approved') / 100.0,
           progress = case when coalesce(o.goal,0) > 0
                        then least(100, ((select coalesce(sum(pr.amount_cents),0) from public.participation_requests pr
                                          where pr.opportunity_id = o.id and pr.status = 'approved') / 100.0) / o.goal * 100)
                        else o.progress end
     where o.id = r.opportunity_id;
  end if;

  return r;
end; $$;

-- Relatório p/ o admin: captado + nº de participantes por projeto (pedidos aprovados).
create or replace view public.participation_totals with (security_invoker = true) as
  select opportunity_id,
         max(opportunity_name)              as opportunity_name,
         count(*)                           as pedidos,
         count(distinct user_id)            as participantes,
         coalesce(sum(tokens),0)            as cotas,
         coalesce(sum(amount_cents),0)      as captado_cents
    from public.participation_requests
   where status = 'approved'
   group by opportunity_id;

-- Observação: a leitura dessa view respeita a RLS da tabela (admin vê tudo).

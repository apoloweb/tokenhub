-- Testes de db/brlzx.sql. Rodar num Postgres local descartável (ver db/tests/README.md).
\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages = warning;

create schema if not exists t;
grant usage on schema t to authenticated, anon;

-- t.fails: o comando TEM de falhar com mensagem contendo o padrão.
create or replace function t.fails(p_sql text, p_pattern text) returns void language plpgsql as $$
declare failed boolean := false; msg text;
begin
  begin
    execute p_sql;
  exception when others then
    failed := true; msg := sqlerrm;
  end;
  if not failed then raise exception 'ERA PARA FALHAR: %', p_sql; end if;
  if msg not ilike '%' || p_pattern || '%' then raise exception 'Falhou com outra mensagem (%): %', msg, p_sql; end if;
end; $$;

create or replace function t.ok(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FALHOU: %', p_msg; end if;
end; $$;

-- Usuários
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@tokenhub'),      -- admin do TokenHub
  ('00000000-0000-0000-0000-0000000000e1', 'operador@tokenhub'),   -- emissora
  ('00000000-0000-0000-0000-0000000000b1', 'diretor@proprietaria'),-- proprietária
  ('00000000-0000-0000-0000-0000000000b2', 'tesouraria@proprietaria'),
  ('00000000-0000-0000-0000-0000000000c1', 'alice@cliente'),
  ('00000000-0000-0000-0000-0000000000c2', 'bob@cliente')
on conflict do nothing;
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-00000000000a';

\set admin '00000000-0000-0000-0000-00000000000a'
\set op    '00000000-0000-0000-0000-0000000000e1'
\set own   '00000000-0000-0000-0000-0000000000b1'
\set own2  '00000000-0000-0000-0000-0000000000b2'
\set alice '00000000-0000-0000-0000-0000000000c1'
\set bob   '00000000-0000-0000-0000-0000000000c2'
\set w_alice '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa'
\set w_bob   '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
\set tx1 '0x1111111111111111111111111111111111111111111111111111111111111111'
\set tx2 '0x2222222222222222222222222222222222222222222222222222222222222222'
\set tx3 '0x3333333333333333333333333333333333333333333333333333333333333333'
\set tx4 '0x4444444444444444444444444444444444444444444444444444444444444444'
\set tx5 '0x5555555555555555555555555555555555555555555555555555555555555555'
\set tx6 '0x6666666666666666666666666666666666666666666666666666666666666666'
\set tx7 '0x7777777777777777777777777777777777777777777777777777777777777777'

set role authenticated;

-- ============ Equipe ============
select set_config('request.jwt.claim.sub', :'alice', false) \g /dev/null
select t.fails(format('select public.brlzx_set_member(%L, ''emissora'')', :'alice'), 'administrador do TokenHub');
select t.fails(format('select public.brlzx_set_member(%L, ''proprietaria'')', :'alice'), 'primeiro membro');

select set_config('request.jwt.claim.sub', :'admin', false) \g /dev/null
select public.brlzx_set_member(:'op', 'emissora') \g /dev/null
select public.brlzx_set_member(:'own', 'proprietaria') \g /dev/null
-- depois do primeiro membro, o admin do TokenHub não mexe mais na equipe da proprietária
select t.fails(format('select public.brlzx_set_member(%L, ''proprietaria'')', :'own2'), 'Só a proprietária');
select t.fails(format('select public.brlzx_set_member(%L, ''proprietaria'')', :'op'), 'Só a proprietária');

select set_config('request.jwt.claim.sub', :'own', false) \g /dev/null
select public.brlzx_set_member(:'own2', 'proprietaria') \g /dev/null
select t.fails(format('select public.brlzx_set_member(%L, ''emissora'')', :'own2'), 'administrador do TokenHub');
select t.fails(format('select public.brlzx_set_member(%L, ''proprietaria'')', :'op'), 'outra empresa');

-- ============ Configurações ============
select set_config('request.jwt.claim.sub', :'op', false) \g /dev/null
select t.fails($$select public.brlzx_save_deposit('{"deposit_pix_key":"golpe@x"}')$$, 'Só a proprietária altera os dados de depósito');
select t.fails($$select public.brlzx_save_network(137, null, null)$$, 'Sem permissão');
select set_config('request.jwt.claim.sub', :'admin', false) \g /dev/null
select t.fails($$select public.brlzx_save_deposit('{"deposit_pix_key":"golpe@x"}')$$, 'Só a proprietária altera os dados de depósito');
select set_config('request.jwt.claim.sub', :'own', false) \g /dev/null
select public.brlzx_save_deposit('{"owner_name":"Proprietária S.A.","deposit_pix_key":"reserva@proprietaria"}') \g /dev/null
select public.brlzx_save_network(137, '0x00000000000000000000000000000000000000c0', '0x00000000000000000000000000000000000000d0') \g /dev/null
select set_config('request.jwt.claim.sub', :'alice', false) \g /dev/null
select t.ok((select deposit_pix_key from public.brlzx_settings) = 'reserva@proprietaria', 'cliente lê os dados de depósito');
select t.fails($$update public.brlzx_settings set deposit_pix_key = 'x'$$, 'permission denied');

-- ============ Carteiras ============
select t.fails($$select public.brlzx_add_wallet('0x123')$$, 'inválido');
select public.brlzx_add_wallet(:'w_alice', 'Minha carteira') \g /dev/null
select t.ok((select address from public.brlzx_wallets) = lower(:'w_alice'), 'endereço gravado em minúsculas');
select t.fails($$delete from public.brlzx_wallets$$, 'permission denied');
select t.fails($$update public.brlzx_wallets set label = 'x'$$, 'permission denied');
select t.fails(format('insert into public.brlzx_wallets (user_id, address) values (%L, %L)', :'alice', :'w_bob'), 'permission denied');
select t.fails(format('select public.brlzx_add_wallet(%L, null, %L)', :'w_bob', :'bob'), 'Só a emissora cadastra carteira em nome');
select t.fails($$select * from public.brlzx_find_user('bob@cliente')$$, 'Só a equipe');
select set_config('request.jwt.claim.sub', :'bob', false) \g /dev/null
select public.brlzx_add_wallet(:'w_bob') \g /dev/null
select t.ok((select count(*) from public.brlzx_wallets) = 1, 'bob só vê a própria carteira');

-- ============ Emissão direta ============
select set_config('request.jwt.claim.sub', :'alice', false) \g /dev/null
select t.fails(format('select public.brlzx_request_issue(10000, ''pix'', %L)', :'w_bob'), 'cadastrada e ativa');
select t.fails(format('select public.brlzx_request_issue(0, ''pix'', %L)', :'w_alice'), 'Valor inválido');
select t.fails(format('select public.brlzx_request_issue(10000, ''cheque'', %L)', :'w_alice'), 'payment_method');
select t.fails(format('select public.brlzx_request_issue(10000, ''pix'', %L, %L)', :'w_bob', :'bob'), 'Só a emissora abre ordem em nome');
select id as o1 from public.brlzx_request_issue(5000000, 'ted', :'w_alice') \gset
select t.ok((select ref from public.brlzx_orders where id = :'o1') ~ '^0x[0-9a-f]{64}$', 'ordem tem referência de 32 bytes');
-- cliente não escreve direto, não emite, não aprova
select t.fails($$update public.brlzx_orders set status = 'emitida'$$, 'permission denied');
select t.fails($$delete from public.brlzx_orders$$, 'permission denied');
select t.fails(format('select public.brlzx_issue_minted(%L, %L)', :'o1', :'tx1'), 'Só a emissora registra');
select t.fails($$select * from public.brlzx_totals()$$, 'Só a equipe');
select t.ok((select count(*) from public.brlzx_audit) = 0, 'cliente não lê a auditoria');
select t.fails($$select public.brlzx_log('x','y','z')$$, 'permission denied');

select set_config('request.jwt.claim.sub', :'bob', false) \g /dev/null
select t.ok((select count(*) from public.brlzx_orders) = 0, 'bob não vê ordem da alice');
select t.fails(format('select public.brlzx_cancel_order(%L)', :'o1'), 'próprias ordens');

select set_config('request.jwt.claim.sub', :'own', false) \g /dev/null
select t.fails(format('select public.brlzx_issue_minted(%L, %L)', :'o1', :'tx1'), 'Só a emissora registra');
select t.fails(format('select public.brlzx_issue_approved(%L, %L)', :'o1', :'tx1'), 'status "solicitada"');

select set_config('request.jwt.claim.sub', :'op', false) \g /dev/null
select t.fails(format('select public.brlzx_issue_minted(%L, ''0xabc'')', :'o1'), 'Hash de transação inválido');
select public.brlzx_issue_minted(:'o1', :'tx1') \g /dev/null
select t.fails(format('select public.brlzx_issue_minted(%L, %L)', :'o1', :'tx2'), 'status "emitida"');
select t.fails(format('select public.brlzx_reject_order(%L, ''x'')', :'o1'), 'status "emitida"');

-- ============ Emissão com dupla aprovação ============
-- emissora abre em nome do bob (pagamento em dinheiro)
select id as o2 from public.brlzx_request_issue(50000000, 'dinheiro', :'w_bob', :'bob') \gset
select t.fails(format('select public.brlzx_issue_proposed(%L, %L)', :'o2', :'tx1'), 'já foi usada');
select public.brlzx_issue_proposed(:'o2', :'tx2') \g /dev/null
select t.fails(format('select public.brlzx_issue_approved(%L, %L)', :'o2', :'tx3'), 'Só a proprietária dá a segunda aprovação');
select t.fails(format('select public.brlzx_issue_minted(%L, %L)', :'o2', :'tx3'), 'status "proposta"');
select set_config('request.jwt.claim.sub', :'own2', false) \g /dev/null
select public.brlzx_issue_approved(:'o2', :'tx3') \g /dev/null
select t.ok((select status from public.brlzx_orders where id = :'o2') = 'emitida', 'proposta aprovada vira emitida');

-- ============ Cancelamento e rejeição ============
select set_config('request.jwt.claim.sub', :'alice', false) \g /dev/null
select id as o3 from public.brlzx_request_issue(100, 'boleto', :'w_alice') \gset
select public.brlzx_cancel_order(:'o3') \g /dev/null
select t.fails(format('select public.brlzx_cancel_order(%L)', :'o3'), 'status "cancelada"');
select id as o4 from public.brlzx_request_issue(100, 'transferencia_interna', :'w_alice') \gset
select t.fails(format('select public.brlzx_reject_order(%L, ''x'')', :'o4'), 'Só a equipe');
select set_config('request.jwt.claim.sub', :'op', false) \g /dev/null
select t.fails(format('select public.brlzx_reject_order(%L, '' '')', :'o4'), 'motivo');
select public.brlzx_reject_order(:'o4', 'Pagamento não identificado') \g /dev/null

-- ============ Resgate ============
select set_config('request.jwt.claim.sub', :'alice', false) \g /dev/null
select t.fails(format('select public.brlzx_request_redeem(1000, %L, '' '')', :'w_alice'), 'chave Pix');
select id as r1 from public.brlzx_request_redeem(2000000, :'w_alice', 'Pix: alice@cliente') \gset
select public.brlzx_redeem_inform_tx(:'r1', :'tx4') \g /dev/null
select t.fails($$select * from public.brlzx_people(array[]::uuid[])$$, 'Só a equipe');
select set_config('request.jwt.claim.sub', :'bob', false) \g /dev/null
select t.fails(format('select public.brlzx_redeem_inform_tx(%L, %L)', :'r1', :'tx5'), 'próprias ordens');
select set_config('request.jwt.claim.sub', :'admin', false) \g /dev/null
select t.fails($$select public.brlzx_set_member_by_email('ninguem@x', 'emissora')$$, 'Não há conta');
select set_config('request.jwt.claim.sub', :'own', false) \g /dev/null
select t.fails(format('select public.brlzx_redeem_paid(%L)', :'r1'), 'status "solicitada"');        -- não paga antes dos tokens
select t.fails(format('select public.brlzx_redeem_received(%L, %L)', :'r1', :'tx4'), 'Só a emissora confirma');
select set_config('request.jwt.claim.sub', :'op', false) \g /dev/null
select t.fails(format('select public.brlzx_redeem_burned(%L, %L)', :'r1', :'tx5'), 'status "solicitada"');
select public.brlzx_redeem_received(:'r1', :'tx4') \g /dev/null
select t.fails(format('select public.brlzx_redeem_paid(%L)', :'r1'), 'Só a proprietária confirma o pagamento');
select t.fails(format('select public.brlzx_redeem_burned(%L, %L)', :'r1', :'tx5'), 'status "tokens_recebidos"');  -- não queima antes de pagar
select set_config('request.jwt.claim.sub', :'own', false) \g /dev/null
select t.fails(format('select public.brlzx_reject_order(%L, ''x'')', :'r1'), 'só a emissora rejeita');
select public.brlzx_redeem_paid(:'r1', 'Pix enviado') \g /dev/null
select t.fails(format('select public.brlzx_redeem_burned(%L, %L)', :'r1', :'tx5'), 'Só a emissora registra a queima');
select set_config('request.jwt.claim.sub', :'op', false) \g /dev/null
select public.brlzx_redeem_burned(:'r1', :'tx5') \g /dev/null
select t.fails(format('select public.brlzx_reject_order(%L, ''x'')', :'r1'), 'status "queimada"');
-- constraint: emissão nunca assume status de resgate
reset role;
select t.fails(format('update public.brlzx_orders set status = ''paga'' where id = %L', :'o1'), 'check');
set role authenticated;

-- ============ Reserva ============
select set_config('request.jwt.claim.sub', :'op', false) \g /dev/null
select t.fails(format('select public.brlzx_attest_reserve(1, 1, %L)', :'tx6'), 'Só a proprietária atesta');
select set_config('request.jwt.claim.sub', :'admin', false) \g /dev/null
select t.fails(format('select public.brlzx_attest_reserve(1, 1, %L)', :'tx6'), 'Só a proprietária atesta');
select set_config('request.jwt.claim.sub', :'own', false) \g /dev/null
select t.fails(format('select public.brlzx_attest_reserve(-1, 1, %L)', :'tx6'), 'check');
select t.fails(format('select public.brlzx_attest_reserve(1, 1, %L)', :'tx5'), 'já foi usada');
select public.brlzx_attest_reserve(30000000, 23000000, :'tx6', 'Extrato + Tesouro Selic') \g /dev/null
select t.ok((select total_cents from public.brlzx_reserve_attestations) = 53000000, 'total = conta + títulos');

-- ============ Compliance ============
select t.fails(format('select public.brlzx_compliance(%L, ''bloquear'', ''ordem judicial'', %L)', :'w_bob', :'tx7'), 'Só a emissora');
select set_config('request.jwt.claim.sub', :'op', false) \g /dev/null
select t.fails(format('select public.brlzx_compliance(%L, ''bloquear'', '''', %L)', :'w_bob', :'tx7'), 'motivo');
select t.fails(format('select public.brlzx_compliance(%L, ''congelar'', ''x'', %L)', :'w_bob', :'tx7'), 'check');
select public.brlzx_compliance(:'w_bob', 'bloquear', 'Ordem judicial 123', :'tx7') \g /dev/null
select public.brlzx_set_wallet_active((select id from public.brlzx_wallets where address = :'w_bob'), false) \g /dev/null
select set_config('request.jwt.claim.sub', :'bob', false) \g /dev/null
select t.fails(format('select public.brlzx_request_issue(100, ''pix'', %L)', :'w_bob'), 'cadastrada e ativa');

-- ============ Totais e auditoria ============
select set_config('request.jwt.claim.sub', :'own', false) \g /dev/null
select t.ok((select emitido_cents from public.brlzx_totals()) = 55000000, 'emitido = 50.000 + 500.000');
select t.ok((select queimado_cents from public.brlzx_totals()) = 2000000, 'queimado = 20.000');
select t.ok((select em_circulacao_cents from public.brlzx_totals()) = 53000000, 'em circulação');
select t.ok((select reserva_cents from public.brlzx_totals()) = 53000000, 'reserva');
select t.ok((select count(*) from public.brlzx_audit) >= 20, 'auditoria registra os atos');
select t.ok((select email from public.brlzx_people(array['00000000-0000-0000-0000-0000000000c1']::uuid[])) = 'alice@cliente', 'equipe vê o e-mail do cliente');
select t.ok((select count(*) from public.brlzx_audit where action = 'emissao.aprovar' and actor_org = 'proprietaria') = 1, 'auditoria guarda a empresa de quem agiu');
select t.fails($$delete from public.brlzx_audit$$, 'permission denied');
select t.fails($$update public.brlzx_audit set action = 'x'$$, 'permission denied');
reset role;
select t.fails($$delete from public.brlzx_audit$$, 'não pode ser alterada');
select t.fails($$update public.brlzx_audit set action = 'x'$$, 'não pode ser alterada');

-- ============ Visitante (anon) não vê nem executa nada ============
set role anon;
select set_config('request.jwt.claim.sub', '', false) \g /dev/null
select t.ok((select count(*) from public.brlzx_orders) = 0, 'anon não vê ordens');
select t.ok((select count(*) from public.brlzx_settings) = 0, 'anon não vê configurações');
select t.fails(format('select public.brlzx_request_issue(100, ''pix'', %L)', :'w_alice'), 'permission denied');
select t.fails($$select * from public.brlzx_totals()$$, 'permission denied');
reset role;

\echo 'brlzx: todos os testes passaram'

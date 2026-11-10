-- TokenHub — Fatia 1: Oportunidades
-- Como rodar: painel do Supabase > SQL Editor > cole TUDO isto > Run.
-- É idempotente: pode rodar de novo sem duplicar (faz upsert).

-- 1) Tabela
create table if not exists public.opportunities (
  id          text primary key,
  name        text not null,
  issuer      text,
  category    text,
  rate        numeric,
  term        integer,
  min         numeric,
  raised      numeric,
  goal        numeric,
  progress    numeric,
  remaining   integer,
  risk        text,
  art         text,
  description text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- 2) Segurança (RLS): leitura pública, sem escrita para o público
alter table public.opportunities enable row level security;

drop policy if exists "Oportunidades: leitura publica" on public.opportunities;
create policy "Oportunidades: leitura publica"
  on public.opportunities
  for select
  to anon, authenticated
  using (true);

-- 3) Dados iniciais (iguais aos fixtures de data.js)
insert into public.opportunities
  (id, name, issuer, category, rate, term, min, raised, goal, progress, remaining, risk, art, description, sort_order)
values
  ('reserva', 'Reserva Urbana', 'Projeto imobiliário demonstrativo', 'Imobiliário', 16.8, 24, 500, 1240000, 2000000, 62, 21, 'Alto', 'urban',
   $$Uma proposta de desenvolvimento residencial, apresentada aqui para demonstrar como avaliar uma oferta imobiliária. Os números são fictícios e não representam uma oferta de investimento.$$, 1),
  ('solar', 'Horizonte Solar', 'Projeto de energia demonstrativo', 'Energia', 15.2, 18, 250, 780000, 1000000, 78, 12, 'Alto', 'solar',
   $$Um projeto ilustrativo de geração de energia solar. Esta página demonstra a apresentação de indicadores, documentos e riscos de um ativo.$$, 2),
  ('agro', 'Ciclo do Campo', 'Projeto do agronegócio demonstrativo', 'Agronegócio', 14.4, 12, 100, 360000, 1500000, 24, 30, 'Alto', 'agro',
   $$Uma operação fictícia ligada à cadeia do agronegócio, criada exclusivamente para revisão da experiência TokenHub.$$, 3),
  ('recebiveis', 'Fluxo Empresas', 'Projeto de recebíveis demonstrativo', 'Recebíveis', 13.8, 9, 100, 690000, 1200000, 57.5, 18, 'Alto', 'flow',
   $$Uma estrutura demonstrativa de recebíveis empresariais. A análise real dependeria de contratos, garantias e capacidade de pagamento dos devedores.$$, 4)
on conflict (id) do update set
  name        = excluded.name,
  issuer      = excluded.issuer,
  category    = excluded.category,
  rate        = excluded.rate,
  term        = excluded.term,
  min         = excluded.min,
  raised      = excluded.raised,
  goal        = excluded.goal,
  progress    = excluded.progress,
  remaining   = excluded.remaining,
  risk        = excluded.risk,
  art         = excluded.art,
  description = excluded.description,
  sort_order  = excluded.sort_order;

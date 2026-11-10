-- TokenHub — Leads dos formulários de Contato / Para empresas
-- Rode TUDO no SQL Editor do Supabase (Run). Idempotente.

create table if not exists public.leads (
  id         uuid primary key default gen_random_uuid(),
  kind       text,                 -- 'contact' | 'company'
  email      text,
  payload    jsonb,                -- todos os campos do formulário
  created_at timestamptz not null default now()
);

alter table public.leads enable row level security;

-- Qualquer visitante pode ENVIAR um lead (formulário público)...
drop policy if exists "leads: enviar" on public.leads;
create policy "leads: enviar"
  on public.leads for insert to anon, authenticated with check (true);

-- ...mas só admin consegue LER os leads.
drop policy if exists "leads: admin le" on public.leads;
create policy "leads: admin le"
  on public.leads for select to authenticated using (public.is_admin());

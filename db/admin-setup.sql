-- TokenHub — Perfis e papéis (admin)
-- Rode TUDO no SQL Editor do Supabase (Run). Idempotente.
-- Ordem recomendada:
--   1) Rode este arquivo inteiro (cria a estrutura).
--   2) Crie o usuário admin no painel (Authentication > Users > Add user).
--   3) Rode de novo a ÚLTIMA instrução (PROMOVER) para marcar o Apolo como admin.

-- 1) Tabela de perfis (1 por usuário), com o papel (role)
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       text not null default 'user',   -- 'user' | 'admin' (mais papéis depois)
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Cada usuário lê apenas o próprio perfil (inclui o próprio papel).
-- Obs: NÃO há policy de UPDATE de propósito — o papel só muda via SQL (dashboard),
-- para ninguém conseguir se auto-promover a admin pelo front-end.
drop policy if exists "profiles: ler o proprio" on public.profiles;
create policy "profiles: ler o proprio"
  on public.profiles for select to authenticated using (id = auth.uid());

-- 2) Cria o perfil automaticamente quando um usuário é criado
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name'))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3) Backfill: cria perfis para usuários que já existem
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- 4) Helper opcional para usar em RLS futuras: public.is_admin()
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- =====================================================================
-- PROMOVER (rode esta linha DEPOIS de criar o usuário no painel):
update public.profiles
   set role = 'admin', full_name = coalesce(full_name, 'Apolo')
 where email = 'contato@apoloweb.net.br';
-- =====================================================================

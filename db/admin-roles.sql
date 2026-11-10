-- TokenHub — Papéis (roles) e permissões de admin sobre profiles
-- Rode TUDO no SQL Editor do Supabase (Run). Idempotente.
-- Pré-requisito: db/admin-setup.sql já rodado (tabela profiles + is_admin()).

-- 1) Papel padrão 'usuario' e migração do antigo 'user'
alter table public.profiles alter column role set default 'usuario';
update public.profiles set role = 'usuario' where role = 'user';

-- 2) Restringe aos papéis válidos do sistema
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','secretario','portaria','usuario','apostador'));

-- 3) RLS: além de ler o próprio perfil, admin lê TODOS e pode EDITAR qualquer um
drop policy if exists "profiles: admin le todos" on public.profiles;
create policy "profiles: admin le todos"
  on public.profiles for select to authenticated using (public.is_admin());

drop policy if exists "profiles: admin edita" on public.profiles;
create policy "profiles: admin edita"
  on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

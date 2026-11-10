-- TokenHub — Perfil editável pelo próprio usuário (sem poder mudar o próprio papel)
-- Rode TUDO no SQL Editor do Supabase (Run). Idempotente.

-- 1) Colunas que o formulário de perfil usa
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists phone text;

-- 2) O usuário pode editar o PRÓPRIO perfil
drop policy if exists "profiles: editar o proprio" on public.profiles;
create policy "profiles: editar o proprio"
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- 3) Trava anti-escalada: ninguém muda o próprio 'role' por aqui.
--    (admin muda papéis pela Edge Function, que usa service_role.)
create or replace function public.guard_profile_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    new.role := old.role; -- ignora a tentativa, mantém o papel atual
  end if;
  return new;
end; $$;

drop trigger if exists guard_profile_role on public.profiles;
create trigger guard_profile_role
  before update on public.profiles
  for each row execute function public.guard_profile_role();

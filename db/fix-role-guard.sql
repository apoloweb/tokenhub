-- TokenHub — Correção: a trava anti-auto-promoção estava bloqueando o admin
-- (via Edge Function / service_role) de atribuir papéis.
-- Rode no SQL Editor do Supabase (Run).

-- A trava agora ignora o service_role (a Edge Function de admin, que já confere
-- se quem chamou é admin) e os próprios admins; só bloqueia usuário comum.
create or replace function public.guard_profile_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role
     and coalesce(auth.role(), '') <> 'service_role'
     and not public.is_admin() then
    new.role := old.role;  -- usuário comum não muda o próprio papel
  end if;
  return new;
end; $$;

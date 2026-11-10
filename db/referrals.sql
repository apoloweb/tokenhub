-- TokenHub — Indicações (referral)
-- Rode TUDO no SQL Editor do Supabase (Run). Idempotente.
-- Pré-requisito: db/admin-setup.sql (profiles + handle_new_user).

-- 1) Colunas: código próprio e quem indicou
alter table public.profiles add column if not exists referral_code text unique;
alter table public.profiles add column if not exists referred_by uuid references public.profiles(id);

-- 2) Gerador de código curto único
create or replace function public.gen_referral_code()
returns text language plpgsql as $$
declare c text;
begin
  loop
    c := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 7));
    exit when not exists (select 1 from public.profiles where referral_code = c);
  end loop;
  return c;
end; $$;

-- 3) Backfill: dá código a quem ainda não tem
update public.profiles set referral_code = public.gen_referral_code() where referral_code is null;

-- 4) Novo trigger de criação: gera código e liga referred_by pelo metadata 'ref'
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare ref_code text; ref_id uuid;
begin
  ref_code := nullif(trim(new.raw_user_meta_data->>'ref'), '');
  if ref_code is not null then
    select id into ref_id from public.profiles where upper(referral_code) = upper(ref_code) limit 1;
  end if;
  insert into public.profiles (id, email, full_name, referral_code, referred_by)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name'),
    public.gen_referral_code(), ref_id
  )
  on conflict (id) do nothing;
  return new;
end; $$;

-- 5) RLS: cada um pode ver os perfis que ELE indicou
drop policy if exists "profiles: ver meus indicados" on public.profiles;
create policy "profiles: ver meus indicados"
  on public.profiles for select to authenticated using (referred_by = auth.uid());

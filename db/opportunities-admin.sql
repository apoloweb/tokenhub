-- TokenHub — Admin gerencia imóveis/anúncios (opportunities)
-- Rode TUDO no SQL Editor do Supabase (Run). Idempotente.
-- Mantém a leitura pública; adiciona escrita só para admin.

drop policy if exists "opp: admin insere" on public.opportunities;
create policy "opp: admin insere"
  on public.opportunities for insert to authenticated with check (public.is_admin());

drop policy if exists "opp: admin edita" on public.opportunities;
create policy "opp: admin edita"
  on public.opportunities for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "opp: admin apaga" on public.opportunities;
create policy "opp: admin apaga"
  on public.opportunities for delete to authenticated using (public.is_admin());

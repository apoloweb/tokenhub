-- TokenHub — Upload de imagem dos imóveis (Supabase Storage)
-- Rode TUDO no SQL Editor do Supabase (Run). Idempotente.

-- 1) Coluna da URL da imagem na tabela de imóveis
alter table public.opportunities add column if not exists image_url text;

-- 2) Bucket público para as fotos dos imóveis
insert into storage.buckets (id, name, public)
values ('imoveis', 'imoveis', true)
on conflict (id) do update set public = true;

-- 3) Políticas de acesso ao bucket:
--    leitura pública; upload/edição/remoção só para admin.
drop policy if exists "imoveis: leitura publica" on storage.objects;
create policy "imoveis: leitura publica"
  on storage.objects for select using (bucket_id = 'imoveis');

drop policy if exists "imoveis: admin envia" on storage.objects;
create policy "imoveis: admin envia"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'imoveis' and public.is_admin());

drop policy if exists "imoveis: admin atualiza" on storage.objects;
create policy "imoveis: admin atualiza"
  on storage.objects for update to authenticated
  using (bucket_id = 'imoveis' and public.is_admin());

drop policy if exists "imoveis: admin apaga" on storage.objects;
create policy "imoveis: admin apaga"
  on storage.objects for delete to authenticated
  using (bucket_id = 'imoveis' and public.is_admin());

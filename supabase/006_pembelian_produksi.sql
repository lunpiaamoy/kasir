-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 006
-- Jalankan SEKALI di Supabase setelah 005:
-- menu SQL Editor → New query → kosongkan → tempel SELURUH isi file ini →
-- klik di area kosong (jangan ada teks yang terpilih) → Run.
--
-- 1. Pembelian bahan baku & hasil produksi (khusus pemilik), untuk laba di Laporan:
--   purchases = [{ "item": "Ayam", "qty": 2, "unit": "kg", "price": 160000, "leftover": 0.5 }, ...]
--               price = harga total pembelian; leftover = sisa (nilainya tidak dihitung sebagai biaya)
--   outputs   = [{ "product_id": 1, "name": "Lunpia Basah Ayam", "qty": 120 }, ...]
-- 2. Pulihkan cadangan (khusus pemilik): data di file cadangan yang TIDAK ada di database
--    ditambahkan kembali. Data yang sudah ada tidak diubah dan tidak dihapus. Daftar staf tidak ikut.
-- =====================================================================

begin;

create table if not exists public.productions (
  id         bigint generated always as identity primary key,
  day        date not null,
  purchases  jsonb not null default '[]'::jsonb,
  outputs    jsonb not null default '[]'::jsonb,
  note       text not null default '',
  created_by text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);
create index if not exists productions_day_idx on public.productions (day);
alter table public.productions enable row level security;
drop policy if exists "pemilik kelola produksi" on public.productions;
create policy "pemilik kelola produksi" on public.productions for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
grant select, insert, update, delete on public.productions to authenticated;

-- ---------- 2. Pulihkan cadangan ----------
-- Tambah baris dari cadangan ke satu tabel; baris yang bentrok (id/tanggal sudah ada) dilewati.
-- Hanya kolom yang ada di file dan di tabel yang diisi, sisanya memakai nilai bawaan.
-- Hasil: daftar id yang benar-benar ditambahkan.
create or replace function public.restore_rows(t text, arr jsonb, cond text default 'true', ids bigint[] default null)
returns jsonb language plpgsql set search_path = public as $$
declare cols text; res jsonb;
begin
  if jsonb_typeof(arr) is distinct from 'array' or jsonb_array_length(arr) = 0 then return '[]'::jsonb; end if;
  select string_agg(quote_ident(a.attname), ',' order by a.attnum) into cols
    from pg_attribute a
   where a.attrelid = ('public.' || t)::regclass and a.attnum > 0 and not a.attisdropped
     and a.attgenerated = '' and (arr -> 0) ? a.attname;
  if cols is null then return '[]'::jsonb; end if;
  execute format('with ins as (insert into public.%I (%s) overriding system value
                    select %s from jsonb_populate_recordset(null::public.%I, $1) r where %s
                    on conflict do nothing returning *)
                  select coalesce(jsonb_agg(to_jsonb(ins) -> ''id''), ''[]''::jsonb) from ins',
                 t, cols, cols, t, cond)
    into res using arr, ids;
  return res;
end $$;
revoke execute on function public.restore_rows(text, jsonb, text, bigint[]) from public, anon, authenticated;

create or replace function public.restore_backup(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  res jsonb := '{}'::jsonb;
  r jsonb;
  new_orders bigint[];
  t text;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa memulihkan cadangan'; end if;
  if jsonb_typeof(d) is distinct from 'object' or jsonb_typeof(d -> 'orders') is distinct from 'array' then
    raise exception 'File ini bukan cadangan Kasir Lunpia Amoy';
  end if;

  r := public.restore_rows('products', d -> 'products');
  res := res || jsonb_build_object('produk', jsonb_array_length(r));

  r := public.restore_rows('orders', d -> 'orders');
  res := res || jsonb_build_object('nota', jsonb_array_length(r));
  select coalesce(array_agg(x::bigint), '{}') into new_orders from jsonb_array_elements_text(r) x;
  -- item hanya untuk nota yang baru ditambahkan (nota yang sudah ada tidak diubah)
  r := public.restore_rows('order_items',
         (select coalesce(jsonb_agg(i), '[]'::jsonb) from jsonb_array_elements(d -> 'orders') o,
                 jsonb_array_elements(case when jsonb_typeof(o -> 'order_items') = 'array' then o -> 'order_items' else '[]'::jsonb end) i),
         'r.order_id = any($2) and (r.product_id is null or exists (select 1 from public.products p where p.id = r.product_id))',
         new_orders);

  r := public.restore_rows('stock_moves', d -> 'stock_moves',
         'exists (select 1 from public.products p where p.id = r.product_id)');
  res := res || jsonb_build_object('riwayat_stok', jsonb_array_length(r));
  res := res || jsonb_build_object('kas_harian', jsonb_array_length(public.restore_rows('cash_days', d -> 'cash_days')));
  res := res || jsonb_build_object('kas_keluar', jsonb_array_length(public.restore_rows('cash_out', d -> 'cash_out')));
  res := res || jsonb_build_object('produksi', jsonb_array_length(public.restore_rows('productions', d -> 'productions')));
  perform public.restore_rows('hidden_contacts', d -> 'hidden_contacts');

  -- nomor berikutnya melanjutkan dari data terbesar
  foreach t in array array['products', 'orders', 'order_items', 'stock_moves', 'cash_out', 'productions'] loop
    execute format('select setval(pg_get_serial_sequence(%L, ''id''), greatest(coalesce(max(id), 0), 1), max(id) is not null) from public.%I',
                   'public.' || t, t);
  end loop;
  insert into public.nota_counters (year, last)
    select year, max(seq) from public.orders group by year
    on conflict (year) do update set last = greatest(public.nota_counters.last, excluded.last);
  return res;
end $$;
revoke execute on function public.restore_backup(jsonb) from public, anon;
grant execute on function public.restore_backup(jsonb) to authenticated;

commit;

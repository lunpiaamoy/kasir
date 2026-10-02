-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 013
-- Jalankan SEKALI di Supabase setelah 012:
-- menu SQL Editor → New query → kosongkan → tempel SELURUH isi file ini →
-- klik di area kosong (jangan ada teks yang terpilih) → Run.
--
-- Stok di dua tempat: TOKO dan RUMAH.
--   products.stock      = stok total (seperti sebelumnya)
--   products.stock_home = bagian yang ada di rumah; stok toko = stock − stock_home
--   Penjualan mengurangi stok toko. Stok yang sudah ada sekarang dianggap di toko.
--   Pindah stok rumah ↔ toko (wewenang baru "stok_pindah", bawaan boleh).
--   Tambah stok, stok opname, dan hasil produksi bisa memilih lokasi.
-- =====================================================================

begin;

alter table public.products    add column if not exists stock_home integer not null default 0;
alter table public.stock_moves add column if not exists home_delta integer not null default 0;
alter table public.productions add column if not exists location   text not null default 'toko';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'products_stock_home_check') then
    alter table public.products add constraint products_stock_home_check check (stock_home >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'productions_location_check') then
    alter table public.productions add constraint productions_location_check check (location in ('toko', 'rumah'));
  end if;
end $$;

-- ---------- Wewenang: pindah stok ----------
create or replace function public.perm_defaults() returns jsonb
language sql immutable set search_path = public as $$
  select '{
    "pesanan": true,  "batal": true, "ubah_nota": false, "hapus_nota": false,
    "stok": true,     "stok_masuk": true, "stok_pindah": true, "stok_kurang": false, "opname": false, "produk_tambah": false, "produk_ubah": false,
    "kas": true,      "kas_buka": true, "kas_tutup": true, "kas_keluar": true, "kas_ubah": false, "kas_hapus": false,
    "laporan": true,  "laporan_unduh": true,
    "pembelian": false, "pembelian_catat": false, "pembelian_hapus": false, "laba": false,
    "kontak": true,   "kontak_ubah": false, "kontak_hapus": false
  }'::jsonb;
$$;

create or replace function public.perm_parent(p text) returns text
language sql immutable set search_path = public as $$
  select '{
    "batal": "pesanan", "ubah_nota": "pesanan", "hapus_nota": "pesanan",
    "stok_masuk": "stok", "stok_pindah": "stok", "stok_kurang": "stok", "opname": "stok", "produk_tambah": "stok", "produk_ubah": "stok",
    "kas_buka": "kas", "kas_tutup": "kas", "kas_keluar": "kas", "kas_ubah": "kas", "kas_hapus": "kas",
    "laporan_unduh": "laporan", "laba": "laporan",
    "pembelian_catat": "pembelian", "pembelian_hapus": "pembelian",
    "kontak_ubah": "kontak", "kontak_hapus": "kontak"
  }'::jsonb ->> p;
$$;

-- ---------- Tambah / kurangi stok di lokasi tertentu ----------
drop function if exists public.add_stock(bigint, integer, text);
create or replace function public.add_stock(p_product bigint, p_delta integer, p_note text default '',
                                            p_location text default 'toko') returns void
language plpgsql security definer set search_path = public as $$
declare v_home boolean := p_location = 'rumah'; prod public.products;
begin
  if not public.is_staff() then raise exception 'Akun ini belum terdaftar sebagai staf'; end if;
  if coalesce(p_delta, 0) = 0 then raise exception 'Jumlah stok tidak valid'; end if;
  if p_delta > 0 and not public.can('stok_masuk') then raise exception 'Akun ini tidak punya wewenang menambah stok'; end if;
  if p_delta < 0 and not public.can('stok_kurang') then raise exception 'Akun ini tidak punya wewenang mengurangi stok'; end if;
  select * into prod from public.products where id = p_product for update;
  if not found then raise exception 'Produk tidak ditemukan'; end if;
  if v_home and prod.stock_home + p_delta < 0 then raise exception 'Stok di rumah hanya %', prod.stock_home; end if;
  update public.products set stock = stock + p_delta, stock_home = stock_home + case when v_home then p_delta else 0 end
   where id = p_product;
  insert into public.stock_moves (product_id, delta, home_delta, note, created_by)
  values (p_product, p_delta, case when v_home then p_delta else 0 end,
          coalesce(nullif(p_note, ''), case when p_delta > 0 then 'Tambah stok' else 'Koreksi stok' end)
            || case when v_home then ' (rumah)' else '' end,
          auth.jwt() ->> 'email');
end $$;
revoke execute on function public.add_stock(bigint, integer, text, text) from public, anon;
grant execute on function public.add_stock(bigint, integer, text, text) to authenticated;

-- ---------- Pindah stok rumah ↔ toko (stok total tidak berubah) ----------
create or replace function public.move_stock(p_product bigint, p_qty integer, p_to text) returns void
language plpgsql security definer set search_path = public as $$
declare prod public.products;
begin
  if not public.can('stok_pindah') then raise exception 'Akun ini tidak punya wewenang memindah stok'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'Jumlah tidak valid'; end if;
  if p_to not in ('toko', 'rumah') then raise exception 'Tujuan tidak valid'; end if;
  select * into prod from public.products where id = p_product for update;
  if not found then raise exception 'Produk tidak ditemukan'; end if;
  if p_to = 'toko' and prod.stock_home < p_qty then raise exception 'Stok di rumah hanya %', prod.stock_home; end if;
  if p_to = 'rumah' and prod.stock - prod.stock_home < p_qty then
    raise exception 'Stok di toko hanya %', greatest(prod.stock - prod.stock_home, 0);
  end if;
  update public.products set stock_home = stock_home + case when p_to = 'rumah' then p_qty else -p_qty end where id = p_product;
  insert into public.stock_moves (product_id, delta, home_delta, note, created_by)
  values (p_product, 0, case when p_to = 'rumah' then p_qty else -p_qty end,
          case when p_to = 'toko' then 'Pindah rumah → toko ' else 'Pindah toko → rumah ' end || p_qty,
          auth.jwt() ->> 'email');
end $$;
revoke execute on function public.move_stock(bigint, integer, text) from public, anon;
grant execute on function public.move_stock(bigint, integer, text) to authenticated;

-- ---------- Stok opname per lokasi ----------
-- p = [{ "product_id": 1, "toko": 20, "rumah": 50 }]  (atau cara lama: { "product_id": 1, "counted": 70 })
create or replace function public.stock_opname(p jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  it jsonb;
  prod public.products;
  v_total integer;
  v_home integer;
  n integer := 0;
begin
  if not public.can('opname') then raise exception 'Akun ini tidak punya wewenang stok opname'; end if;
  for it in select * from jsonb_array_elements(coalesce(p, '[]'::jsonb)) loop
    select * into prod from public.products where id = (it ->> 'product_id')::bigint for update;
    if not found then raise exception 'Produk tidak ditemukan'; end if;
    if it ? 'toko' or it ? 'rumah' then
      v_home := coalesce((it ->> 'rumah')::int, prod.stock_home);
      v_total := coalesce((it ->> 'toko')::int, prod.stock - prod.stock_home) + v_home;
      if v_home < 0 or v_total - v_home < 0 then raise exception 'Hitungan fisik tidak valid'; end if;
    else
      v_total := (it ->> 'counted')::int;
      if v_total is null or v_total < 0 then raise exception 'Hitungan fisik tidak valid'; end if;
      v_home := least(prod.stock_home, v_total);
    end if;
    if v_total <> prod.stock or v_home <> prod.stock_home then
      update public.products set stock = v_total, stock_home = v_home where id = prod.id;
      insert into public.stock_moves (product_id, delta, home_delta, note, created_by)
      values (prod.id, v_total - prod.stock, v_home - prod.stock_home,
              format('Stok opname · toko %s→%s, rumah %s→%s', prod.stock - prod.stock_home, v_total - v_home, prod.stock_home, v_home),
              auth.jwt() ->> 'email');
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------- Produksi: hasil masuk stok toko atau rumah ----------
create or replace function public.production_stock_loc(p_old jsonb, p_old_home boolean, p_new jsonb, p_new_home boolean, p_note text)
returns void language plpgsql set search_path = public as $$
declare r record;
begin
  for r in
    select x.product_id, sum(x.q)::int d, sum(x.h)::int h from (
      select (o ->> 'product_id')::bigint product_id, (o ->> 'qty')::int q,
             case when p_new_home then (o ->> 'qty')::int else 0 end h
        from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) o
      union all
      select (o ->> 'product_id')::bigint, -(o ->> 'qty')::int,
             case when p_old_home then -(o ->> 'qty')::int else 0 end
        from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) o
    ) x
    where exists (select 1 from public.products p where p.id = x.product_id)
    group by x.product_id having sum(x.q) <> 0 or sum(x.h) <> 0
  loop
    -- stok rumah tidak boleh minus (mis. hasil produksi rumah sudah dipindah ke toko lalu catatannya dihapus)
    update public.products set stock = stock + r.d, stock_home = greatest(0, stock_home + r.h) where id = r.product_id;
    insert into public.stock_moves (product_id, delta, home_delta, note) values (r.product_id, r.d, r.h, p_note);
  end loop;
end $$;
revoke execute on function public.production_stock_loc(jsonb, boolean, jsonb, boolean, text) from public, anon, authenticated;

create or replace function public.save_production(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id      bigint := nullif(p ->> 'id', '')::bigint;
  v_day     date := nullif(p ->> 'day', '')::date;
  v_stocked boolean := coalesce((p ->> 'stocked')::boolean, true);
  v_out     jsonb := coalesce(p -> 'outputs', '[]'::jsonb);
  v_loc     text := case when p ->> 'location' = 'rumah' then 'rumah' else 'toko' end;
  old       public.productions;
begin
  if not public.can('pembelian_catat') then raise exception 'Akun ini tidak punya wewenang mencatat pembelian & produksi'; end if;
  if v_day is null then raise exception 'Isi tanggal'; end if;
  if exists (select 1 from jsonb_array_elements(v_out) o where coalesce((o ->> 'qty')::int, 0) <= 0) then
    raise exception 'Jumlah hasil produksi tidak valid';
  end if;
  if v_id is null then
    insert into public.productions (day, purchases, outputs, note, stocked, location)
    values (v_day, coalesce(p -> 'purchases', '[]'::jsonb), v_out, coalesce(p ->> 'note', ''), v_stocked, v_loc)
    returning id into v_id;
    perform public.production_stock_loc(null, false, case when v_stocked then v_out end, v_loc = 'rumah',
      'Produksi ' || to_char(v_day, 'DD/MM/YYYY') || case when v_loc = 'rumah' then ' (rumah)' else '' end);
  else
    select * into old from public.productions where id = v_id for update;
    if not found then raise exception 'Catatan produksi tidak ditemukan'; end if;
    update public.productions
       set day = v_day, purchases = coalesce(p -> 'purchases', '[]'::jsonb), outputs = v_out,
           note = coalesce(p ->> 'note', ''), stocked = v_stocked, location = v_loc
     where id = v_id;
    perform public.production_stock_loc(case when old.stocked then old.outputs end, old.location = 'rumah',
      case when v_stocked then v_out end, v_loc = 'rumah', 'Produksi ' || to_char(v_day, 'DD/MM/YYYY') || ' (diubah)');
  end if;
  return v_id;
end $$;

create or replace function public.delete_production(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare old public.productions;
begin
  if not public.can('pembelian_hapus') then raise exception 'Akun ini tidak punya wewenang menghapus catatan pembelian & produksi'; end if;
  select * into old from public.productions where id = p_id for update;
  if not found then return; end if;
  if old.stocked then
    perform public.production_stock_loc(old.outputs, old.location = 'rumah', null, false,
      'Produksi ' || to_char(old.day, 'DD/MM/YYYY') || ' (dihapus)');
  end if;
  delete from public.productions where id = p_id;
end $$;

commit;

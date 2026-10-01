-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 009
-- Jalankan SEKALI di Supabase setelah 008:
-- menu SQL Editor → New query → kosongkan → tempel SELURUH isi file ini →
-- klik di area kosong (jangan ada teks yang terpilih) → Run.
--
-- 1. Wewenang staf lebih detail, per tab (Pengaturan → Staf → Wewenang).
--    Pilihan di dalam tab hanya berlaku kalau tabnya boleh dibuka. Pemilik selalu boleh semua.
--    Bawaan sama dengan sebelumnya; tab Pembelian (dulu khusus pemilik) bawaannya tidak boleh.
-- 2. Nomor nota: setelah nota dihapus, nota berikutnya melanjutkan dari nomor terakhir
--    yang masih tercatat. Saat mengubah nota, nomornya boleh diganti (mis. mengisi nomor terloncat).
-- =====================================================================

begin;

-- ---------- 1. Daftar wewenang ----------
create or replace function public.perm_defaults() returns jsonb
language sql immutable set search_path = public as $$
  select '{
    "pesanan": true,  "batal": true, "ubah_nota": false, "hapus_nota": false,
    "stok": true,     "stok_masuk": true, "stok_kurang": false, "opname": false, "produk_tambah": false, "produk_ubah": false,
    "kas": true,      "kas_buka": true, "kas_tutup": true, "kas_keluar": true, "kas_ubah": false, "kas_hapus": false,
    "laporan": true,  "laporan_unduh": true,
    "pembelian": false, "pembelian_catat": false, "pembelian_hapus": false, "laba": false,
    "kontak": true,   "kontak_ubah": false, "kontak_hapus": false
  }'::jsonb;
$$;

-- Tab tempat pilihan itu berada
create or replace function public.perm_parent(p text) returns text
language sql immutable set search_path = public as $$
  select '{
    "batal": "pesanan", "ubah_nota": "pesanan", "hapus_nota": "pesanan",
    "stok_masuk": "stok", "stok_kurang": "stok", "opname": "stok", "produk_tambah": "stok", "produk_ubah": "stok",
    "kas_buka": "kas", "kas_tutup": "kas", "kas_keluar": "kas", "kas_ubah": "kas", "kas_hapus": "kas",
    "laporan_unduh": "laporan",
    "pembelian_catat": "pembelian", "pembelian_hapus": "pembelian", "laba": "pembelian",
    "kontak_ubah": "kontak", "kontak_hapus": "kontak"
  }'::jsonb ->> p;
$$;

-- Nilai satu wewenang dari isian staf (yang belum diatur memakai bawaan)
create or replace function public.perm_on(p_perms jsonb, p text) returns boolean
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(p_perms -> p) = 'boolean' then (p_perms ->> p)::boolean
              else coalesce((public.perm_defaults() ->> p)::boolean, false) end;
$$;

create or replace function public.can(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select s.role = 'pemilik'
        or (public.perm_on(s.perms, p) and public.perm_on(s.perms, coalesce(public.perm_parent(p), p)))
      from public.staff s where lower(s.email) = lower(auth.jwt() ->> 'email')), false);
$$;

create or replace function public.set_staff_perms(p_email text, p_perms jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mengatur wewenang staf'; end if;
  select coalesce(jsonb_object_agg(k, public.perm_on(p_perms, k)), '{}'::jsonb) into v
    from jsonb_object_keys(public.perm_defaults()) k;
  update public.staff set perms = v where lower(email) = lower(p_email);
  if not found then raise exception 'Email ini tidak ada di daftar staf'; end if;
end $$;

-- ---------- 2. Nomor nota ----------
-- Penghitung nomor = nomor terbesar yang masih tercatat di tahun itu
create or replace function public.sync_nota_counter(p_year integer) returns void
language sql security definer set search_path = public as $$
  insert into public.nota_counters (year, last)
  values (p_year, coalesce((select max(seq) from public.orders where year = p_year), 0))
  on conflict (year) do update set last = excluded.last;
$$;
revoke execute on function public.sync_nota_counter(integer) from public, anon, authenticated;

create or replace function public.update_order(p_id bigint, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o      public.orders;
  it     jsonb;
  prod   public.products;
  v_qty  integer;
  v_price integer;
  v_items jsonb := '[]'::jsonb;
  v_total integer := 0;
  v_paid integer;
  v_ful  text := coalesce(nullif(p ->> 'fulfillment', ''), 'langsung');
  v_seq  integer := nullif(p ->> 'seq', '')::int;
begin
  if not public.can('ubah_nota') then raise exception 'Akun ini tidak punya wewenang mengubah nota'; end if;
  select * into o from public.orders where id = p_id for update;
  if not found then raise exception 'Nota tidak ditemukan'; end if;
  if o.status = 'batal' then raise exception 'Nota yang sudah dibatalkan tidak bisa diubah'; end if;
  -- Nomor nota boleh diganti (mis. mengisi nomor yang terloncat), asal belum dipakai di tahun yang sama
  v_seq := coalesce(v_seq, o.seq);
  if v_seq <= 0 then raise exception 'Nomor nota tidak valid'; end if;
  if v_seq <> o.seq and exists (select 1 from public.orders where year = o.year and seq = v_seq) then
    raise exception 'Nomor nota (%) % sudah dipakai', o.year, lpad(v_seq::text, 5, '0');
  end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]'::jsonb)) = 0 then
    raise exception 'Keranjang masih kosong';
  end if;

  -- Kembalikan stok item lama
  update public.products pr set stock = pr.stock + i.qty
    from public.order_items i where i.order_id = p_id and i.product_id = pr.id;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::int;
    if v_qty is null or v_qty <= 0 then raise exception 'Jumlah barang tidak valid'; end if;
    select * into prod from public.products where id = (it ->> 'product_id')::bigint for update;
    if not found then raise exception 'Produk tidak ditemukan'; end if;
    select price into v_price from public.order_items where order_id = p_id and product_id = prod.id limit 1;
    v_price := coalesce(v_price, prod.price);
    v_items := v_items || jsonb_build_object('product_id', prod.id, 'category', prod.category,
                                             'name', prod.name, 'qty', v_qty, 'price', v_price);
    v_total := v_total + v_price * v_qty;
  end loop;

  v_paid := case when p ->> 'pay_method' = 'qris' then v_total else coalesce((p ->> 'paid')::int, 0) end;
  if v_paid < v_total then raise exception 'Uang yang dibayar kurang dari total'; end if;

  delete from public.order_items where order_id = p_id;
  for it in select * from jsonb_array_elements(v_items) loop
    insert into public.order_items (order_id, product_id, category, name, qty, price, subtotal)
    values (p_id, (it ->> 'product_id')::bigint, it ->> 'category', it ->> 'name',
            (it ->> 'qty')::int, (it ->> 'price')::int, (it ->> 'price')::int * (it ->> 'qty')::int);
    update public.products set stock = stock - (it ->> 'qty')::int where id = (it ->> 'product_id')::bigint;
  end loop;

  update public.orders set
    customer_name = coalesce(p ->> 'customer_name', ''),
    customer_wa   = coalesce(p ->> 'customer_wa', ''),
    fulfillment   = v_ful,
    fulfill_date  = nullif(p ->> 'fulfill_date', '')::date,
    fulfill_time  = nullif(p ->> 'fulfill_time', '')::time,
    ongkir        = case when v_ful = 'kirim' then coalesce((p ->> 'ongkir')::int, 0) else 0 end,
    total         = v_total,
    pay_method    = p ->> 'pay_method',
    paid          = v_paid,
    change        = v_paid - v_total,
    note          = coalesce(p ->> 'note', ''),
    address       = case when v_ful = 'kirim' then coalesce(p ->> 'address', '') else '' end,
    status        = case when v_ful = 'langsung' then 'selesai'
                         when o.fulfillment = 'langsung' then 'menunggu'
                         else o.status end,
    seq           = v_seq,
    edited_at     = now(),
    edited_by     = auth.jwt() ->> 'email'
  where id = p_id
  returning * into o;
  perform public.sync_nota_counter(o.year);

  return (select to_jsonb(o) || jsonb_build_object('order_items',
            (select jsonb_agg(to_jsonb(i) order by i.id) from public.order_items i where i.order_id = o.id)));
end $$;

create or replace function public.delete_order(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_year integer;
begin
  if not public.can('hapus_nota') then raise exception 'Akun ini tidak punya wewenang menghapus nota'; end if;
  select year into v_year from public.orders where id = p_id for update;
  if not found then return; end if;
  if exists (select 1 from public.orders where id = p_id and status <> 'batal') then
    update public.products pr set stock = pr.stock + i.qty
      from public.order_items i where i.order_id = p_id and i.product_id = pr.id;
  end if;
  delete from public.orders where id = p_id;   -- item ikut terhapus (on delete cascade)
  perform public.sync_nota_counter(v_year);    -- nota berikutnya melanjutkan nomor terakhir yang tersisa
end $$;

-- ---------- 3. Stok & produk ----------
create or replace function public.add_stock(p_product bigint, p_delta integer, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Akun ini belum terdaftar sebagai staf'; end if;
  if coalesce(p_delta, 0) = 0 then raise exception 'Jumlah stok tidak valid'; end if;
  if p_delta > 0 and not public.can('stok_masuk') then raise exception 'Akun ini tidak punya wewenang menambah stok'; end if;
  if p_delta < 0 and not public.can('stok_kurang') then raise exception 'Akun ini tidak punya wewenang mengurangi stok'; end if;
  update public.products set stock = stock + p_delta where id = p_product;
  if not found then raise exception 'Produk tidak ditemukan'; end if;
  insert into public.stock_moves (product_id, delta, note, created_by)
  values (p_product, p_delta, coalesce(p_note, ''), auth.jwt() ->> 'email');
end $$;

create or replace function public.stock_opname(p jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  it jsonb;
  prod public.products;
  v_counted integer;
  n integer := 0;
begin
  if not public.can('opname') then raise exception 'Akun ini tidak punya wewenang stok opname'; end if;
  for it in select * from jsonb_array_elements(coalesce(p, '[]'::jsonb)) loop
    v_counted := (it ->> 'counted')::int;
    if v_counted is null or v_counted < 0 then raise exception 'Hitungan fisik tidak valid'; end if;
    select * into prod from public.products where id = (it ->> 'product_id')::bigint for update;
    if not found then raise exception 'Produk tidak ditemukan'; end if;
    if v_counted <> prod.stock then
      update public.products set stock = v_counted where id = prod.id;
      insert into public.stock_moves (product_id, delta, note, created_by)
      values (prod.id, v_counted - prod.stock,
              format('Stok opname · sistem %s, fisik %s', prod.stock, v_counted), auth.jwt() ->> 'email');
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

drop policy if exists "staf tambah produk" on public.products;
drop policy if exists "staf ubah produk"   on public.products;
create policy "staf tambah produk" on public.products for insert to authenticated with check (public.can('produk_tambah'));
create policy "staf ubah produk"   on public.products for update to authenticated
  using (public.can('produk_ubah')) with check (public.can('produk_ubah'));

-- ---------- 4. Kontak ----------
create or replace function public.update_contact(p_key text, p_name text, p_wa text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.can('kontak_ubah') then raise exception 'Akun ini tidak punya wewenang mengubah kontak'; end if;
  if coalesce(trim(p_name), '') = '' and coalesce(trim(p_wa), '') = '' then
    raise exception 'Isi nama atau nomor WA';
  end if;
  update public.orders
     set customer_name = trim(coalesce(p_name, '')), customer_wa = trim(coalesce(p_wa, ''))
   where public.contact_key(customer_name, customer_wa) = p_key;
  get diagnostics n = row_count;
  return n;
end $$;

drop policy if exists "staf sembunyikan kontak"      on public.hidden_contacts;
drop policy if exists "staf ubah kontak tersembunyi" on public.hidden_contacts;
drop policy if exists "staf tampilkan kontak"        on public.hidden_contacts;
create policy "staf sembunyikan kontak"      on public.hidden_contacts for insert to authenticated with check (public.can('kontak_hapus'));
create policy "staf ubah kontak tersembunyi" on public.hidden_contacts for update to authenticated
  using (public.can('kontak_hapus')) with check (public.can('kontak_hapus'));
create policy "staf tampilkan kontak"        on public.hidden_contacts for delete to authenticated using (public.can('kontak_hapus'));

-- ---------- 5. Kas ----------
drop policy if exists "staf buka kas"  on public.cash_days;
drop policy if exists "staf tutup kas" on public.cash_days;
drop policy if exists "staf hapus kas" on public.cash_days;
create policy "staf buka kas"  on public.cash_days for insert to authenticated with check (public.can('kas_buka'));
-- Kas hari yang belum ditutup: isi uang awal / tutup kasir. Kas yang sudah ditutup: hanya kas_ubah.
create policy "staf tutup kas" on public.cash_days for update to authenticated
  using ((closed_at is null and (public.can('kas_buka') or public.can('kas_tutup'))) or public.can('kas_ubah'))
  with check (public.can('kas_buka') or public.can('kas_tutup') or public.can('kas_ubah'));
create policy "staf hapus kas" on public.cash_days for delete to authenticated using (public.can('kas_hapus'));

drop policy if exists "staf catat kas keluar" on public.cash_out;
drop policy if exists "staf ubah kas keluar"  on public.cash_out;
drop policy if exists "staf hapus kas keluar" on public.cash_out;
create policy "staf catat kas keluar" on public.cash_out for insert to authenticated with check (public.can('kas_keluar'));
create policy "staf ubah kas keluar"  on public.cash_out for update to authenticated
  using (public.can('kas_ubah')) with check (public.can('kas_ubah'));
create policy "staf hapus kas keluar" on public.cash_out for delete to authenticated using (public.can('kas_hapus'));

-- ---------- 6. Pembelian & produksi ----------
drop policy if exists "pemilik kelola produksi" on public.productions;
drop policy if exists "staf lihat produksi"     on public.productions;
create policy "staf lihat produksi" on public.productions for select to authenticated using (public.can('pembelian'));

create or replace function public.save_production(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id      bigint := nullif(p ->> 'id', '')::bigint;
  v_day     date := nullif(p ->> 'day', '')::date;
  v_stocked boolean := coalesce((p ->> 'stocked')::boolean, true);
  v_out     jsonb := coalesce(p -> 'outputs', '[]'::jsonb);
  old       public.productions;
begin
  if not public.can('pembelian_catat') then raise exception 'Akun ini tidak punya wewenang mencatat pembelian & produksi'; end if;
  if v_day is null then raise exception 'Isi tanggal'; end if;
  if exists (select 1 from jsonb_array_elements(v_out) o where coalesce((o ->> 'qty')::int, 0) <= 0) then
    raise exception 'Jumlah hasil produksi tidak valid';
  end if;
  if v_id is null then
    insert into public.productions (day, purchases, outputs, note, stocked)
    values (v_day, coalesce(p -> 'purchases', '[]'::jsonb), v_out, coalesce(p ->> 'note', ''), v_stocked)
    returning id into v_id;
    perform public.production_stock(null, case when v_stocked then v_out end,
      'Produksi ' || to_char(v_day, 'DD/MM/YYYY'));
  else
    select * into old from public.productions where id = v_id for update;
    if not found then raise exception 'Catatan produksi tidak ditemukan'; end if;
    update public.productions
       set day = v_day, purchases = coalesce(p -> 'purchases', '[]'::jsonb), outputs = v_out,
           note = coalesce(p ->> 'note', ''), stocked = v_stocked
     where id = v_id;
    perform public.production_stock(case when old.stocked then old.outputs end, case when v_stocked then v_out end,
      'Produksi ' || to_char(v_day, 'DD/MM/YYYY') || ' (diubah)');
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
    perform public.production_stock(old.outputs, null, 'Produksi ' || to_char(old.day, 'DD/MM/YYYY') || ' (dihapus)');
  end if;
  delete from public.productions where id = p_id;
end $$;

revoke execute on function public.can(text), public.set_staff_perms(text, jsonb) from public, anon;
grant execute on function public.can(text), public.set_staff_perms(text, jsonb), public.perm_defaults(),
  public.perm_parent(text), public.perm_on(jsonb, text) to authenticated;

commit;

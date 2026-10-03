-- Perbaikan: pasang ulang SEMUA pembaruan 002–014 dalam satu kali jalan.
-- Gunanya untuk database yang dulu hanya sebagian file-nya terjalankan
-- (mis. kolom orders.address dari 005 belum ada). Aman dijalankan ulang:
-- data tidak diubah, hanya kolom/tabel/fungsi/aturan yang dilengkapi.
-- Semua dalam satu transaksi: kalau ada yang gagal, tidak ada yang berubah.
-- Isi file ini adalah gabungan 002–014 (tanpa begin/commit masing-masing).
begin;

-- ======================= 002_pembaruan.sql =======================
-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 002
-- Jalankan SEKALI di Supabase setelah schema.sql:
-- menu SQL Editor → New query → tempel seluruh isi file ini → Run.
--
-- Isi:
--  1. Peran staf: 'pemilik' dan 'kasir'. Semua staf yang sudah ada saat file
--     ini dijalankan menjadi pemilik; staf baru otomatis kasir.
--  2. Hanya pemilik yang bisa: mengubah & menghapus nota, menambah & mengubah
--     produk/harga, dan mengoreksi (mengurangi) stok.
--  3. Nomor nota tidak pernah dipakai ulang, walaupun nota dihapus.
--  4. Waktu pembatalan dicatat (untuk kartu stok).
--  5. Catatan per pesanan.
--  6. Hapus & ubah nota diproses sekaligus di database (tidak setengah jalan).
--  7. Kas harian: uang awal dan tutup kasir.
--  8. Stok opname: stok sistem disamakan dengan hitungan fisik (pemilik).
-- =====================================================================


-- ---------- 1. Peran ----------
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'staff' and column_name = 'role') then
    alter table public.staff add column role text not null default 'kasir'
      check (role in ('pemilik', 'kasir'));
    -- Staf yang sudah terdaftar sebelum pembaruan ini adalah pemilik
    update public.staff set role = 'pemilik';
  end if;
end $$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.staff where lower(email) = lower(auth.jwt() ->> 'email');
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'pemilik', false);
$$;

-- ---------- 3. Penghitung nomor nota per tahun ----------
create table if not exists public.nota_counters (
  year integer primary key,
  last integer not null
);
alter table public.nota_counters enable row level security;   -- hanya lewat fungsi di bawah
insert into public.nota_counters (year, last)
  select year, max(seq) from public.orders group by year
  on conflict (year) do update set last = greatest(public.nota_counters.last, excluded.last);

-- ---------- 4 & 5. Kolom baru di transaksi ----------
alter table public.orders add column if not exists note         text not null default '';
alter table public.orders add column if not exists cancelled_at timestamptz;
alter table public.orders add column if not exists edited_at    timestamptz;
alter table public.orders add column if not exists edited_by    text;

-- ---------- Simpan transaksi ----------
-- security definer: kasir tidak boleh mengubah tabel produk langsung,
-- jadi pengurangan stok dilakukan oleh fungsi ini atas nama database.
create or replace function public.create_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o      public.orders;
  it     jsonb;
  prod   public.products;
  v_qty  integer;
  v_total integer := 0;
  v_year integer := extract(year from (now() at time zone 'Asia/Jakarta'))::int;
  v_seq  integer;
  v_paid integer;
  v_ful  text := coalesce(nullif(p ->> 'fulfillment', ''), 'langsung');
begin
  if not public.is_staff() then raise exception 'Akun ini belum terdaftar sebagai staf'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]'::jsonb)) = 0 then
    raise exception 'Keranjang masih kosong';
  end if;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::int;
    if v_qty is null or v_qty <= 0 then raise exception 'Jumlah barang tidak valid'; end if;
    select * into prod from public.products where id = (it ->> 'product_id')::bigint for update;
    if not found then raise exception 'Produk tidak ditemukan'; end if;
    v_total := v_total + prod.price * v_qty;
  end loop;

  v_paid := case when p ->> 'pay_method' = 'qris' then v_total else coalesce((p ->> 'paid')::int, 0) end;
  if v_paid < v_total then raise exception 'Uang yang dibayar kurang dari total'; end if;

  -- Nomor nota berikutnya; baris penghitung dikunci sampai transaksi selesai
  insert into public.nota_counters (year, last) values (v_year, 1)
    on conflict (year) do update set last = public.nota_counters.last + 1
    returning last into v_seq;

  insert into public.orders (year, seq, customer_name, customer_wa, fulfillment, fulfill_date, fulfill_time,
                             ongkir, total, pay_method, paid, change, status, note, cashier)
  values (v_year, v_seq,
          coalesce(p ->> 'customer_name', ''), coalesce(p ->> 'customer_wa', ''),
          v_ful, nullif(p ->> 'fulfill_date', '')::date, nullif(p ->> 'fulfill_time', '')::time,
          case when v_ful = 'kirim' then coalesce((p ->> 'ongkir')::int, 0) else 0 end,
          v_total, p ->> 'pay_method', v_paid, v_paid - v_total,
          case when v_ful = 'langsung' then 'selesai' else 'menunggu' end,
          coalesce(p ->> 'note', ''), auth.jwt() ->> 'email')
  returning * into o;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::int;
    select * into prod from public.products where id = (it ->> 'product_id')::bigint;
    insert into public.order_items (order_id, product_id, category, name, qty, price, subtotal)
    values (o.id, prod.id, prod.category, prod.name, v_qty, prod.price, prod.price * v_qty);
    update public.products set stock = stock - v_qty where id = prod.id;
  end loop;

  return (select to_jsonb(o) || jsonb_build_object('order_items',
            (select jsonb_agg(to_jsonb(i) order by i.id) from public.order_items i where i.order_id = o.id)));
end $$;

-- ---------- 6. Ubah nota (pemilik) ----------
-- Stok item lama dikembalikan, lalu item baru dikurangi. Harga produk yang sudah
-- ada di nota tetap memakai harga lama; produk baru memakai harga sekarang.
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
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mengubah nota'; end if;
  select * into o from public.orders where id = p_id for update;
  if not found then raise exception 'Nota tidak ditemukan'; end if;
  if o.status = 'batal' then raise exception 'Nota yang sudah dibatalkan tidak bisa diubah'; end if;
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
    status        = case when v_ful = 'langsung' then 'selesai'
                         when o.fulfillment = 'langsung' then 'menunggu'
                         else o.status end,
    edited_at     = now(),
    edited_by     = auth.jwt() ->> 'email'
  where id = p_id
  returning * into o;

  return (select to_jsonb(o) || jsonb_build_object('order_items',
            (select jsonb_agg(to_jsonb(i) order by i.id) from public.order_items i where i.order_id = o.id)));
end $$;

-- ---------- Batalkan (semua staf): stok dikembalikan, waktu batal dicatat ----------
create or replace function public.cancel_order(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Akun ini belum terdaftar sebagai staf'; end if;
  if exists (select 1 from public.orders where id = p_id and status <> 'batal' for update) then
    update public.products pr set stock = pr.stock + i.qty
      from public.order_items i where i.order_id = p_id and i.product_id = pr.id;
    update public.orders set status = 'batal', cancelled_at = now() where id = p_id;
  end if;
end $$;

-- ---------- Hapus nota (pemilik): stok dikembalikan lalu nota dihapus, sekaligus ----------
create or replace function public.delete_order(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa menghapus nota'; end if;
  if exists (select 1 from public.orders where id = p_id and status <> 'batal' for update) then
    update public.products pr set stock = pr.stock + i.qty
      from public.order_items i where i.order_id = p_id and i.product_id = pr.id;
  end if;
  delete from public.orders where id = p_id;   -- item ikut terhapus (on delete cascade)
end $$;

-- ---------- Tandai pesanan selesai (semua staf) ----------
create or replace function public.mark_done(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Akun ini belum terdaftar sebagai staf'; end if;
  update public.orders set status = 'selesai' where id = p_id and status = 'menunggu';
end $$;

-- ---------- Tambah stok (semua staf) / koreksi stok minus (pemilik) ----------
create or replace function public.add_stock(p_product bigint, p_delta integer, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Akun ini belum terdaftar sebagai staf'; end if;
  if coalesce(p_delta, 0) = 0 then raise exception 'Jumlah stok tidak valid'; end if;
  if p_delta < 0 and not public.is_owner() then raise exception 'Hanya pemilik yang bisa mengurangi stok'; end if;
  update public.products set stock = stock + p_delta where id = p_product;
  if not found then raise exception 'Produk tidak ditemukan'; end if;
  insert into public.stock_moves (product_id, delta, note, created_by)
  values (p_product, p_delta, coalesce(p_note, ''), auth.jwt() ->> 'email');
end $$;

-- ---------- Stok opname (pemilik) ----------
-- p = [{ "product_id": 1, "counted": 28 }, ...]. Stok sistem disamakan dengan hitungan fisik;
-- selisihnya dicatat di riwayat stok. Stok dibaca saat disimpan (dikunci), jadi penjualan
-- yang terjadi selama menghitung tidak hilang.
create or replace function public.stock_opname(p jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  it jsonb;
  prod public.products;
  v_counted integer;
  n integer := 0;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa menyimpan stok opname'; end if;
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

-- ---------- 7. Kas harian ----------
create table if not exists public.cash_days (
  day        date primary key,               -- tanggal (WIB)
  opening    integer not null default 0 check (opening >= 0),   -- uang di laci saat buka
  expected   integer,                        -- uang awal + penjualan tunai, dihitung saat tutup
  counted    integer,                        -- uang yang benar-benar ada saat tutup
  note       text not null default '',
  opened_by  text default (auth.jwt() ->> 'email'),
  opened_at  timestamptz not null default now(),
  closed_by  text,
  closed_at  timestamptz
);
alter table public.cash_days enable row level security;

-- ---------- 2. Izin akses ----------
drop policy if exists "staf kelola produk"    on public.products;
drop policy if exists "staf kelola stok"      on public.stock_moves;
drop policy if exists "staf kelola transaksi" on public.orders;
drop policy if exists "staf kelola item"      on public.order_items;
drop policy if exists "staf lihat produk"      on public.products;
drop policy if exists "pemilik tambah produk"  on public.products;
drop policy if exists "pemilik ubah produk"    on public.products;
drop policy if exists "staf lihat stok"        on public.stock_moves;
drop policy if exists "staf lihat transaksi"   on public.orders;
drop policy if exists "staf lihat item"        on public.order_items;
drop policy if exists "staf lihat kas"         on public.cash_days;
drop policy if exists "staf buka kas"          on public.cash_days;
drop policy if exists "staf tutup kas"         on public.cash_days;

create policy "staf lihat produk"     on public.products    for select to authenticated using (public.is_staff());
create policy "pemilik tambah produk" on public.products    for insert to authenticated with check (public.is_owner());
create policy "pemilik ubah produk"   on public.products    for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy "staf lihat stok"       on public.stock_moves for select to authenticated using (public.is_staff());
create policy "staf lihat transaksi"  on public.orders      for select to authenticated using (public.is_staff());
create policy "staf lihat item"       on public.order_items for select to authenticated using (public.is_staff());
create policy "staf lihat kas"        on public.cash_days   for select to authenticated using (public.is_staff());
create policy "staf buka kas"         on public.cash_days   for insert to authenticated with check (public.is_staff());
-- Kas yang sudah ditutup hanya bisa diubah pemilik
create policy "staf tutup kas"        on public.cash_days   for update to authenticated
  using (public.is_staff() and (closed_at is null or public.is_owner())) with check (public.is_staff());

-- Transaksi, item, dan riwayat stok hanya bisa diubah lewat fungsi di atas
revoke insert, update, delete on public.orders, public.order_items, public.stock_moves from authenticated;
revoke delete on public.products from authenticated;
grant select on public.products, public.stock_moves, public.orders, public.order_items to authenticated;
grant insert, update on public.products to authenticated;
grant select, insert, update on public.cash_days to authenticated;

revoke execute on function public.my_role(), public.is_owner(), public.update_order(bigint, jsonb),
  public.delete_order(bigint), public.mark_done(bigint), public.stock_opname(jsonb) from public, anon;
revoke execute on function public.create_order(jsonb), public.cancel_order(bigint),
  public.add_stock(bigint, integer, text) from public, anon;
grant execute on function public.my_role(), public.is_owner(), public.create_order(jsonb),
  public.update_order(bigint, jsonb), public.cancel_order(bigint), public.delete_order(bigint),
  public.mark_done(bigint), public.stock_opname(jsonb), public.add_stock(bigint, integer, text) to authenticated;

-- ---------- Keamanan: rls_auto_enable() dari Supabase tidak perlu bisa dipanggil pengguna ----------
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'rls_auto_enable' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;


-- ======================= 003_pecahan_kas.sql =======================
-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 003
-- Jalankan SEKALI di Supabase setelah 002_pembaruan.sql:
-- menu SQL Editor → New query → tempel seluruh isi file ini → Run.
--
-- Menyimpan rincian pecahan uang (100.000, 50.000, …, 1.000) pada kas harian,
-- untuk uang awal dan hitungan saat tutup kasir. Contoh isi: {"100000": 3, "5000": 4}
-- =====================================================================

alter table public.cash_days add column if not exists opening_detail jsonb;
alter table public.cash_days add column if not exists counted_detail jsonb;

-- ======================= 004_ubah_hapus_kas_kontak.sql =======================
-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 004
-- Jalankan SEKALI di Supabase setelah 002 dan 003:
-- menu SQL Editor → New query → tempel seluruh isi file ini → Run.
--
-- Isi (semuanya khusus pemilik):
--  1. Hapus catatan kas harian dari riwayat.
--  2. Ubah kontak: nama & nomor WA diganti di semua transaksi kontak tersebut.
--  3. Hapus kontak dari daftar (transaksi tidak dihapus; kontak muncul lagi
--     kalau pembeli itu bertransaksi lagi setelah dihapus).
-- =====================================================================


-- ---------- 1. Hapus kas harian ----------
grant delete on public.cash_days to authenticated;
drop policy if exists "pemilik hapus kas" on public.cash_days;
create policy "pemilik hapus kas" on public.cash_days for delete to authenticated using (public.is_owner());

-- ---------- Kunci kontak ----------
-- Sama dengan aplikasi: nomor WA tanpa tanda baca, awalan 0 → 62; tanpa nomor → 'n:' + nama huruf kecil.
create or replace function public.contact_key(p_name text, p_wa text) returns text
language sql immutable set search_path = public as $$
  select case
    when regexp_replace(coalesce(p_wa, ''), '\D', '', 'g') <> ''
      then regexp_replace(regexp_replace(p_wa, '\D', '', 'g'), '^0', '62')
    else 'n:' || lower(trim(coalesce(p_name, '')))
  end;
$$;

-- ---------- 2. Ubah kontak ----------
create or replace function public.update_contact(p_key text, p_name text, p_wa text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mengubah kontak'; end if;
  if coalesce(trim(p_name), '') = '' and coalesce(trim(p_wa), '') = '' then
    raise exception 'Isi nama atau nomor WA';
  end if;
  update public.orders
     set customer_name = trim(coalesce(p_name, '')), customer_wa = trim(coalesce(p_wa, ''))
   where public.contact_key(customer_name, customer_wa) = p_key;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- 3. Sembunyikan kontak ----------
create table if not exists public.hidden_contacts (
  key       text primary key,
  hidden_at timestamptz not null default now(),
  hidden_by text default (auth.jwt() ->> 'email')
);
alter table public.hidden_contacts enable row level security;
drop policy if exists "staf lihat kontak tersembunyi" on public.hidden_contacts;
drop policy if exists "pemilik sembunyikan kontak"    on public.hidden_contacts;
drop policy if exists "pemilik ubah kontak tersembunyi" on public.hidden_contacts;
drop policy if exists "pemilik tampilkan kontak"      on public.hidden_contacts;
create policy "staf lihat kontak tersembunyi"   on public.hidden_contacts for select to authenticated using (public.is_staff());
create policy "pemilik sembunyikan kontak"      on public.hidden_contacts for insert to authenticated with check (public.is_owner());
create policy "pemilik ubah kontak tersembunyi" on public.hidden_contacts for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy "pemilik tampilkan kontak"        on public.hidden_contacts for delete to authenticated using (public.is_owner());
grant select, insert, update, delete on public.hidden_contacts to authenticated;

revoke execute on function public.update_contact(text, text, text) from public, anon;
grant execute on function public.update_contact(text, text, text) to authenticated;
grant execute on function public.contact_key(text, text) to authenticated;


-- ======================= 005_alamat_kas_keluar_staf_hpp.sql =======================
-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 005
-- Jalankan SEKALI di Supabase setelah 002, 003, 004:
-- menu SQL Editor → New query → kosongkan → tempel SELURUH isi file ini →
-- klik di area kosong (jangan ada teks yang terpilih) → Run.
--
-- Isi:
--  1. Alamat pengiriman untuk pesanan "Kirim".
--  2. Kas keluar (pengeluaran harian dari laci).
--  3. Kelola staf dari aplikasi (pemilik).
--  4. HPP: bahan baku, resep per produk, atau HPP manual per produk;
--     HPP saat penjualan disimpan di setiap item nota (untuk laba kotor).
-- =====================================================================


-- ---------- 1. Alamat pengiriman ----------
alter table public.orders add column if not exists address text not null default '';

create or replace function public.create_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o      public.orders;
  it     jsonb;
  prod   public.products;
  v_qty  integer;
  v_total integer := 0;
  v_year integer := extract(year from (now() at time zone 'Asia/Jakarta'))::int;
  v_seq  integer;
  v_paid integer;
  v_ful  text := coalesce(nullif(p ->> 'fulfillment', ''), 'langsung');
begin
  if not public.is_staff() then raise exception 'Akun ini belum terdaftar sebagai staf'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]'::jsonb)) = 0 then
    raise exception 'Keranjang masih kosong';
  end if;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::int;
    if v_qty is null or v_qty <= 0 then raise exception 'Jumlah barang tidak valid'; end if;
    select * into prod from public.products where id = (it ->> 'product_id')::bigint for update;
    if not found then raise exception 'Produk tidak ditemukan'; end if;
    v_total := v_total + prod.price * v_qty;
  end loop;

  v_paid := case when p ->> 'pay_method' = 'qris' then v_total else coalesce((p ->> 'paid')::int, 0) end;
  if v_paid < v_total then raise exception 'Uang yang dibayar kurang dari total'; end if;

  -- Nomor nota berikutnya; baris penghitung dikunci sampai transaksi selesai
  insert into public.nota_counters (year, last) values (v_year, 1)
    on conflict (year) do update set last = public.nota_counters.last + 1
    returning last into v_seq;

  insert into public.orders (year, seq, customer_name, customer_wa, fulfillment, fulfill_date, fulfill_time,
                             ongkir, total, pay_method, paid, change, status, note, cashier, address)
  values (v_year, v_seq,
          coalesce(p ->> 'customer_name', ''), coalesce(p ->> 'customer_wa', ''),
          v_ful, nullif(p ->> 'fulfill_date', '')::date, nullif(p ->> 'fulfill_time', '')::time,
          case when v_ful = 'kirim' then coalesce((p ->> 'ongkir')::int, 0) else 0 end,
          v_total, p ->> 'pay_method', v_paid, v_paid - v_total,
          case when v_ful = 'langsung' then 'selesai' else 'menunggu' end,
          coalesce(p ->> 'note', ''), auth.jwt() ->> 'email',
          case when v_ful = 'kirim' then coalesce(p ->> 'address', '') else '' end)
  returning * into o;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::int;
    select * into prod from public.products where id = (it ->> 'product_id')::bigint;
    insert into public.order_items (order_id, product_id, category, name, qty, price, subtotal)
    values (o.id, prod.id, prod.category, prod.name, v_qty, prod.price, prod.price * v_qty);
    update public.products set stock = stock - v_qty where id = prod.id;
  end loop;

  return (select to_jsonb(o) || jsonb_build_object('order_items',
            (select jsonb_agg(to_jsonb(i) order by i.id) from public.order_items i where i.order_id = o.id)));
end $$;

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
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mengubah nota'; end if;
  select * into o from public.orders where id = p_id for update;
  if not found then raise exception 'Nota tidak ditemukan'; end if;
  if o.status = 'batal' then raise exception 'Nota yang sudah dibatalkan tidak bisa diubah'; end if;
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
    edited_at     = now(),
    edited_by     = auth.jwt() ->> 'email'
  where id = p_id
  returning * into o;

  return (select to_jsonb(o) || jsonb_build_object('order_items',
            (select jsonb_agg(to_jsonb(i) order by i.id) from public.order_items i where i.order_id = o.id)));
end $$;

-- ---------- 2. Kas keluar ----------
create table if not exists public.cash_out (
  id         bigint generated always as identity primary key,
  day        date not null,                     -- tanggal kas (WIB)
  amount     integer not null check (amount > 0),
  note       text not null default '',
  created_by text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);
create index if not exists cash_out_day_idx on public.cash_out (day);
alter table public.cash_out enable row level security;
drop policy if exists "staf lihat kas keluar"    on public.cash_out;
drop policy if exists "staf catat kas keluar"    on public.cash_out;
drop policy if exists "pemilik ubah kas keluar"  on public.cash_out;
drop policy if exists "pemilik hapus kas keluar" on public.cash_out;
create policy "staf lihat kas keluar"    on public.cash_out for select to authenticated using (public.is_staff());
create policy "staf catat kas keluar"    on public.cash_out for insert to authenticated with check (public.is_staff());
create policy "pemilik ubah kas keluar"  on public.cash_out for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy "pemilik hapus kas keluar" on public.cash_out for delete to authenticated using (public.is_owner());
grant select, insert, update, delete on public.cash_out to authenticated;

-- ---------- 3. Kelola staf (pemilik) ----------
-- Pemilik terakhir tidak bisa dihapus atau dijadikan kasir; akun sendiri tidak bisa dihapus.
create or replace function public.save_staff(p_email text, p_name text, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(coalesce(p_email, ''))); v_old text;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mengatur staf'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Email tidak valid'; end if;
  if p_role not in ('pemilik', 'kasir') then raise exception 'Peran tidak valid'; end if;
  select role into v_old from public.staff where lower(email) = v_email;
  if v_old = 'pemilik' and p_role = 'kasir'
     and (select count(*) from public.staff where role = 'pemilik') <= 1 then
    raise exception 'Harus ada minimal satu pemilik';
  end if;
  if found then
    update public.staff set name = trim(coalesce(p_name, '')), role = p_role where lower(email) = v_email;
  else
    insert into public.staff (email, name, role) values (v_email, trim(coalesce(p_name, '')), p_role);
  end if;
end $$;

create or replace function public.delete_staff(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(coalesce(p_email, ''))); v_role text;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mengatur staf'; end if;
  if v_email = lower(auth.jwt() ->> 'email') then raise exception 'Tidak bisa menghapus akun sendiri'; end if;
  select role into v_role from public.staff where lower(email) = v_email;
  if v_role = 'pemilik' and (select count(*) from public.staff where role = 'pemilik') <= 1 then
    raise exception 'Harus ada minimal satu pemilik';
  end if;
  delete from public.staff where lower(email) = v_email;
end $$;

-- ---------- 4. HPP ----------
alter table public.products    add column if not exists cost integer check (cost >= 0);   -- HPP manual per pcs
alter table public.order_items add column if not exists cost integer;                     -- HPP per pcs saat terjual

create table if not exists public.ingredients (
  id         bigint generated always as identity primary key,
  name       text not null,
  unit       text not null default 'pcs',        -- mis. kg, gr, lembar, butir
  price      numeric(14,2) not null default 0 check (price >= 0),   -- harga per satuan
  updated_at timestamptz not null default now()
);
create table if not exists public.recipes (
  product_id    bigint not null references public.products(id) on delete cascade,
  ingredient_id bigint not null references public.ingredients(id) on delete cascade,
  qty           numeric(14,4) not null check (qty > 0),               -- jumlah bahan per 1 pcs produk
  primary key (product_id, ingredient_id)
);
alter table public.ingredients enable row level security;
alter table public.recipes     enable row level security;
drop policy if exists "pemilik kelola bahan" on public.ingredients;
drop policy if exists "pemilik kelola resep" on public.recipes;
create policy "pemilik kelola bahan" on public.ingredients for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy "pemilik kelola resep" on public.recipes     for all to authenticated using (public.is_owner()) with check (public.is_owner());
grant select, insert, update, delete on public.ingredients, public.recipes to authenticated;

-- HPP per pcs: dari resep kalau ada, kalau tidak dari HPP manual produk
create or replace function public.product_cost(p_product bigint) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select round(sum(r.qty * i.price))::int
       from public.recipes r join public.ingredients i on i.id = r.ingredient_id
      where r.product_id = p_product
     having count(*) > 0),
    (select cost from public.products where id = p_product));
$$;

-- Simpan HPP saat item nota dibuat (juga saat nota diubah)
create or replace function public.order_item_cost() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.cost is null and new.product_id is not null then new.cost := public.product_cost(new.product_id); end if;
  return new;
end $$;
drop trigger if exists order_items_cost on public.order_items;
create trigger order_items_cost before insert on public.order_items
  for each row execute function public.order_item_cost();

revoke execute on function public.save_staff(text, text, text), public.delete_staff(text), public.product_cost(bigint)
  from public, anon;
grant execute on function public.save_staff(text, text, text), public.delete_staff(text), public.product_cost(bigint)
  to authenticated;


-- ======================= 006_pembelian_produksi.sql =======================
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


-- ======================= 007_produksi_ke_stok.sql =======================
-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 007
-- Jalankan SEKALI di Supabase setelah 006:
-- menu SQL Editor → New query → kosongkan → tempel SELURUH isi file ini →
-- klik di area kosong (jangan ada teks yang terpilih) → Run.
--
-- Hasil produksi di Laporan langsung menambah stok produk (tercatat di kartu stok
-- sebagai "Produksi tgl"). Mengubah catatan menyesuaikan selisihnya; menghapus
-- catatan mengurangi kembali stoknya. Catatan lama (sebelum file ini) tidak mengubah stok.
-- Juga: pemilik bisa mengganti password akun staf (tombol Password di Pengaturan → Staf).
-- =====================================================================


alter table public.productions add column if not exists stocked boolean not null default false;

-- Catatan produksi hanya lewat fungsi di bawah, supaya stok selalu ikut
revoke insert, update, delete on public.productions from authenticated;

-- Tambah/kurangi stok sebesar selisih kontribusi lama → baru
create or replace function public.production_stock(p_old jsonb, p_new jsonb, p_note text)
returns void language plpgsql set search_path = public as $$
declare r record;
begin
  for r in
    select x.product_id, sum(x.q)::int d from (
      select (o ->> 'product_id')::bigint product_id, (o ->> 'qty')::int q from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) o
      union all
      select (o ->> 'product_id')::bigint, -(o ->> 'qty')::int from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) o
    ) x
    where exists (select 1 from public.products p where p.id = x.product_id)
    group by x.product_id having sum(x.q) <> 0
  loop
    update public.products set stock = stock + r.d where id = r.product_id;
    insert into public.stock_moves (product_id, delta, note) values (r.product_id, r.d, p_note);
  end loop;
end $$;
revoke execute on function public.production_stock(jsonb, jsonb, text) from public, anon, authenticated;

create or replace function public.save_production(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id      bigint := nullif(p ->> 'id', '')::bigint;
  v_day     date := nullif(p ->> 'day', '')::date;
  v_stocked boolean := coalesce((p ->> 'stocked')::boolean, true);
  v_out     jsonb := coalesce(p -> 'outputs', '[]'::jsonb);
  old       public.productions;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mencatat produksi'; end if;
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
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa menghapus catatan produksi'; end if;
  select * into old from public.productions where id = p_id for update;
  if not found then return; end if;
  if old.stocked then
    perform public.production_stock(old.outputs, null, 'Produksi ' || to_char(old.day, 'DD/MM/YYYY') || ' (dihapus)');
  end if;
  delete from public.productions where id = p_id;
end $$;

revoke execute on function public.save_production(jsonb), public.delete_production(bigint) from public, anon;
grant execute on function public.save_production(jsonb), public.delete_production(bigint) to authenticated;

-- ---------- Pemilik mengganti password akun staf ----------
-- Akun login harus sudah dibuat di Authentication → Users (email sama dengan daftar staf).
create or replace function public.set_staff_password(p_email text, p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mengganti password staf'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'Password minimal 6 karakter'; end if;
  if not exists (select 1 from public.staff where lower(email) = lower(p_email)) then
    raise exception 'Email ini tidak ada di daftar staf';
  end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
   where lower(email) = lower(p_email);
  if not found then
    raise exception 'Akun login untuk % belum dibuat. Buat dulu di Supabase: Authentication → Users → Add user.', p_email;
  end if;
end $$;
revoke execute on function public.set_staff_password(text, text) from public, anon;
grant execute on function public.set_staff_password(text, text) to authenticated;


-- ======================= 008_wewenang_staf.sql =======================
-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 008
-- Jalankan SEKALI di Supabase setelah 007:
-- menu SQL Editor → New query → kosongkan → tempel SELURUH isi file ini →
-- klik di area kosong (jangan ada teks yang terpilih) → Run.
--
-- Wewenang per staf (kasir). Pemilik mencentang wewenang tiap kasir di
-- Pengaturan → Staf → Wewenang. Pemilik selalu punya semua wewenang.
-- Bawaan (sebelum diatur) sama dengan sebelumnya:
--   boleh : laporan, kontak, batal, stok_masuk, kas
--   tidak : kontak_ubah, ubah_nota, hapus_nota, koreksi_stok, produk, kas_ubah
-- Laporan & kontak hanya disembunyikan di aplikasi (data nota tetap dibaca untuk tab Pesanan);
-- wewenang lain dijaga di database.
-- =====================================================================


alter table public.staff add column if not exists perms jsonb not null default '{}'::jsonb;

-- Daftar wewenang dan bawaannya untuk kasir
create or replace function public.perm_defaults() returns jsonb
language sql immutable set search_path = public as $$
  select '{"laporan": true, "kontak": true, "kontak_ubah": false, "batal": true, "ubah_nota": false,
           "hapus_nota": false, "stok_masuk": true, "koreksi_stok": false, "produk": false,
           "kas": true, "kas_ubah": false}'::jsonb;
$$;

-- Apakah akun yang sedang masuk boleh melakukan p?
create or replace function public.can(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select s.role = 'pemilik' or coalesce((s.perms ->> p)::boolean, (public.perm_defaults() ->> p)::boolean, false)
      from public.staff s where lower(s.email) = lower(auth.jwt() ->> 'email')), false);
$$;

-- Semua wewenang akun yang sedang masuk (untuk aplikasi)
create or replace function public.my_perms() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(k, public.can(k)), '{}'::jsonb) from jsonb_object_keys(public.perm_defaults()) k;
$$;

-- Pemilik menyimpan wewenang satu kasir; hanya kunci yang dikenal, nilai true/false
create or replace function public.set_staff_perms(p_email text, p_perms jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mengatur wewenang staf'; end if;
  select coalesce(jsonb_object_agg(k, case when jsonb_typeof(p_perms -> k) = 'boolean' then (p_perms ->> k)::boolean else (d ->> k)::boolean end), '{}'::jsonb) into v
    from public.perm_defaults() d, jsonb_object_keys(d) k;
  update public.staff set perms = v where lower(email) = lower(p_email);
  if not found then raise exception 'Email ini tidak ada di daftar staf'; end if;
end $$;

-- ---------- Nota ----------
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
begin
  if not public.can('ubah_nota') then raise exception 'Akun ini tidak punya wewenang mengubah nota'; end if;
  select * into o from public.orders where id = p_id for update;
  if not found then raise exception 'Nota tidak ditemukan'; end if;
  if o.status = 'batal' then raise exception 'Nota yang sudah dibatalkan tidak bisa diubah'; end if;
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
    edited_at     = now(),
    edited_by     = auth.jwt() ->> 'email'
  where id = p_id
  returning * into o;

  return (select to_jsonb(o) || jsonb_build_object('order_items',
            (select jsonb_agg(to_jsonb(i) order by i.id) from public.order_items i where i.order_id = o.id)));
end $$;

create or replace function public.delete_order(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can('hapus_nota') then raise exception 'Akun ini tidak punya wewenang menghapus nota'; end if;
  if exists (select 1 from public.orders where id = p_id and status <> 'batal' for update) then
    update public.products pr set stock = pr.stock + i.qty
      from public.order_items i where i.order_id = p_id and i.product_id = pr.id;
  end if;
  delete from public.orders where id = p_id;   -- item ikut terhapus (on delete cascade)
end $$;

create or replace function public.cancel_order(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can('batal') then raise exception 'Akun ini tidak punya wewenang membatalkan pesanan'; end if;
  if exists (select 1 from public.orders where id = p_id and status <> 'batal' for update) then
    update public.products pr set stock = pr.stock + i.qty
      from public.order_items i where i.order_id = p_id and i.product_id = pr.id;
    update public.orders set status = 'batal', cancelled_at = now() where id = p_id;
  end if;
end $$;

-- ---------- Stok ----------
create or replace function public.add_stock(p_product bigint, p_delta integer, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Akun ini belum terdaftar sebagai staf'; end if;
  if coalesce(p_delta, 0) = 0 then raise exception 'Jumlah stok tidak valid'; end if;
  if p_delta > 0 and not public.can('stok_masuk') then raise exception 'Akun ini tidak punya wewenang menambah stok'; end if;
  if p_delta < 0 and not public.can('koreksi_stok') then raise exception 'Akun ini tidak punya wewenang mengurangi stok'; end if;
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
  if not public.can('koreksi_stok') then raise exception 'Akun ini tidak punya wewenang stok opname'; end if;
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

drop policy if exists "pemilik tambah produk" on public.products;
drop policy if exists "pemilik ubah produk"   on public.products;
drop policy if exists "staf tambah produk"    on public.products;
drop policy if exists "staf ubah produk"      on public.products;
create policy "staf tambah produk" on public.products for insert to authenticated with check (public.can('produk'));
create policy "staf ubah produk"   on public.products for update to authenticated using (public.can('produk')) with check (public.can('produk'));

-- ---------- Kontak ----------
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

drop policy if exists "pemilik sembunyikan kontak"      on public.hidden_contacts;
drop policy if exists "pemilik ubah kontak tersembunyi" on public.hidden_contacts;
drop policy if exists "pemilik tampilkan kontak"        on public.hidden_contacts;
drop policy if exists "staf sembunyikan kontak"         on public.hidden_contacts;
drop policy if exists "staf ubah kontak tersembunyi"    on public.hidden_contacts;
drop policy if exists "staf tampilkan kontak"           on public.hidden_contacts;
create policy "staf sembunyikan kontak"      on public.hidden_contacts for insert to authenticated with check (public.can('kontak_ubah'));
create policy "staf ubah kontak tersembunyi" on public.hidden_contacts for update to authenticated using (public.can('kontak_ubah')) with check (public.can('kontak_ubah'));
create policy "staf tampilkan kontak"        on public.hidden_contacts for delete to authenticated using (public.can('kontak_ubah'));

-- ---------- Kas ----------
drop policy if exists "staf buka kas"            on public.cash_days;
drop policy if exists "staf tutup kas"           on public.cash_days;
drop policy if exists "pemilik hapus kas"        on public.cash_days;
drop policy if exists "staf hapus kas"           on public.cash_days;
create policy "staf buka kas"  on public.cash_days for insert to authenticated with check (public.can('kas'));
-- Kas yang sudah ditutup hanya bisa diubah akun dengan wewenang kas_ubah
create policy "staf tutup kas" on public.cash_days for update to authenticated
  using (public.can('kas') and (closed_at is null or public.can('kas_ubah'))) with check (public.can('kas'));
create policy "staf hapus kas" on public.cash_days for delete to authenticated using (public.can('kas_ubah'));

drop policy if exists "staf catat kas keluar"    on public.cash_out;
drop policy if exists "pemilik ubah kas keluar"  on public.cash_out;
drop policy if exists "pemilik hapus kas keluar" on public.cash_out;
drop policy if exists "staf ubah kas keluar"     on public.cash_out;
drop policy if exists "staf hapus kas keluar"    on public.cash_out;
create policy "staf catat kas keluar" on public.cash_out for insert to authenticated with check (public.can('kas'));
create policy "staf ubah kas keluar"  on public.cash_out for update to authenticated using (public.can('kas_ubah')) with check (public.can('kas_ubah'));
create policy "staf hapus kas keluar" on public.cash_out for delete to authenticated using (public.can('kas_ubah'));

revoke execute on function public.can(text), public.my_perms(), public.set_staff_perms(text, jsonb) from public, anon;
grant execute on function public.can(text), public.my_perms(), public.set_staff_perms(text, jsonb), public.perm_defaults() to authenticated;


-- ======================= 009_wewenang_detail_nomor_nota.sql =======================
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


-- ======================= 010_laba_di_laporan.sql =======================
-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 010
-- Jalankan SEKALI di Supabase setelah 009:
-- menu SQL Editor → New query → kosongkan → tempel SELURUH isi file ini →
-- klik di area kosong (jangan ada teks yang terpilih) → Run.
--
-- Laba pindah ke tab Laporan: wewenang "lihat laba" sekarang bagian dari tab Laporan,
-- dan Laporan mengambil total bahan terpakai lewat fungsi material_used (tanpa perlu
-- wewenang membuka tab Produksi).
-- =====================================================================


create or replace function public.perm_parent(p text) returns text
language sql immutable set search_path = public as $$
  select '{
    "batal": "pesanan", "ubah_nota": "pesanan", "hapus_nota": "pesanan",
    "stok_masuk": "stok", "stok_kurang": "stok", "opname": "stok", "produk_tambah": "stok", "produk_ubah": "stok",
    "kas_buka": "kas", "kas_tutup": "kas", "kas_keluar": "kas", "kas_ubah": "kas", "kas_hapus": "kas",
    "laporan_unduh": "laporan", "laba": "laporan",
    "pembelian_catat": "pembelian", "pembelian_hapus": "pembelian",
    "kontak_ubah": "kontak", "kontak_hapus": "kontak"
  }'::jsonb ->> p;
$$;

-- Total bahan terpakai di rentang tanggal (sama dengan hitungan di tab Produksi):
-- harga × (jumlah − sisa) / jumlah, termasuk baris "sisa lalu"
create or replace function public.material_used(p_from date, p_to date) returns bigint
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can('laba') then raise exception 'Akun ini tidak punya wewenang melihat laba'; end if;
  return coalesce((
    select round(sum(case when coalesce((b ->> 'qty')::numeric, 0) > 0
                          then coalesce((b ->> 'price')::numeric, 0)
                               * greatest(0, (b ->> 'qty')::numeric - coalesce((b ->> 'leftover')::numeric, 0)) / (b ->> 'qty')::numeric
                          else coalesce((b ->> 'price')::numeric, 0) end))
      from public.productions p, jsonb_array_elements(p.purchases) b
     where p.day between p_from and p_to), 0)::bigint;
end $$;
revoke execute on function public.material_used(date, date) from public, anon;
grant execute on function public.material_used(date, date) to authenticated;


-- ======================= 011_aktivitas_alasan_batas.sql =======================
-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 011
-- Jalankan SEKALI di Supabase setelah 010:
-- menu SQL Editor → New query → kosongkan → tempel SELURUH isi file ini →
-- klik di area kosong (jangan ada teks yang terpilih) → Run.
--
-- 1. Catatan aktivitas (hanya pemilik yang bisa membaca): batal/ubah/hapus nota (salinan nota
--    yang dihapus disimpan), kurangi stok & stok opname, produk & harga, ubah/hapus kas yang
--    sudah ditutup, hapus/ubah kas keluar. Dicatat otomatis oleh database: siapa, kapan, apa.
-- 2. Opsi per staf (Pengaturan → Staf → Wewenang):
--    - wajib isi alasan saat membatalkan pesanan (bawaan: wajib)
--    - batas kas keluar per catatan (bawaan: 0 = tanpa batas)
-- =====================================================================


-- ---------- Kolom baru ----------
alter table public.staff  add column if not exists cash_out_max integer not null default 0 check (cash_out_max >= 0);
alter table public.staff  add column if not exists cancel_reason_required boolean not null default true;
alter table public.orders add column if not exists cancel_reason text not null default '';

-- Opsi akun yang sedang masuk (pemilik: tanpa batas, alasan tidak wajib)
create or replace function public.my_options() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case when s.role = 'pemilik' then '{"cash_out_max": 0, "cancel_reason_required": false}'::jsonb
                else jsonb_build_object('cash_out_max', s.cash_out_max, 'cancel_reason_required', s.cancel_reason_required) end
      from public.staff s where lower(s.email) = lower(auth.jwt() ->> 'email')),
    '{"cash_out_max": 0, "cancel_reason_required": true}'::jsonb);
$$;

-- Wewenang + opsi satu staf (pemilik). Opsi yang tidak dikirim tidak diubah.
drop function if exists public.set_staff_perms(text, jsonb);
create or replace function public.set_staff_perms(p_email text, p_perms jsonb, p_cash_out_max integer default null,
                                                  p_cancel_reason_required boolean default null) returns void
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mengatur wewenang staf'; end if;
  if p_cash_out_max < 0 then raise exception 'Batas kas keluar tidak valid'; end if;
  select coalesce(jsonb_object_agg(k, public.perm_on(p_perms, k)), '{}'::jsonb) into v
    from jsonb_object_keys(public.perm_defaults()) k;
  update public.staff
     set perms = v,
         cash_out_max = coalesce(p_cash_out_max, cash_out_max),
         cancel_reason_required = coalesce(p_cancel_reason_required, cancel_reason_required)
   where lower(email) = lower(p_email);
  if not found then raise exception 'Email ini tidak ada di daftar staf'; end if;
end $$;

-- ---------- Batalkan pesanan dengan alasan ----------
drop function if exists public.cancel_order(bigint);
create or replace function public.cancel_order(p_id bigint, p_reason text default '') returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can('batal') then raise exception 'Akun ini tidak punya wewenang membatalkan pesanan'; end if;
  if coalesce(trim(p_reason), '') = '' and (public.my_options() ->> 'cancel_reason_required')::boolean then
    raise exception 'Isi alasan pembatalan';
  end if;
  if exists (select 1 from public.orders where id = p_id and status <> 'batal' for update) then
    update public.products pr set stock = pr.stock + i.qty
      from public.order_items i where i.order_id = p_id and i.product_id = pr.id;
    update public.orders set status = 'batal', cancelled_at = now(), cancel_reason = coalesce(trim(p_reason), '')
     where id = p_id;
  end if;
end $$;
revoke execute on function public.cancel_order(bigint, text) from public, anon;
grant execute on function public.cancel_order(bigint, text) to authenticated;

-- ---------- Batas kas keluar per catatan ----------
create or replace function public.cash_out_allowed(p_amount integer) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can('kas_keluar')
     and ((public.my_options() ->> 'cash_out_max')::int = 0 or p_amount <= (public.my_options() ->> 'cash_out_max')::int);
$$;
drop policy if exists "staf catat kas keluar" on public.cash_out;
create policy "staf catat kas keluar" on public.cash_out for insert to authenticated with check (public.cash_out_allowed(amount));

-- ---------- Catatan aktivitas ----------
create table if not exists public.activity_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  actor   text,
  action  text not null,          -- batal_nota, ubah_nota, hapus_nota, stok, produk, ubah_kas, hapus_kas, kas_keluar
  ref     text not null default '',
  detail  jsonb not null default '{}'::jsonb
);
create index if not exists activity_log_at_idx on public.activity_log (at desc);
alter table public.activity_log enable row level security;
drop policy if exists "pemilik lihat aktivitas" on public.activity_log;
create policy "pemilik lihat aktivitas" on public.activity_log for select to authenticated using (public.is_owner());
revoke insert, update, delete on public.activity_log from authenticated, anon;
grant select on public.activity_log to authenticated;

create or replace function public.log_activity(p_action text, p_ref text, p_detail jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.activity_log (actor, action, ref, detail)
  values (coalesce(auth.jwt() ->> 'email', 'sistem'), p_action, coalesce(p_ref, ''), coalesce(p_detail, '{}'::jsonb));
$$;
revoke execute on function public.log_activity(text, text, jsonb) from public, anon, authenticated;

create or replace function public.nota_label(p_year integer, p_seq integer) returns text
language sql immutable as $$ select format('(%s) %s', p_year, lpad(p_seq::text, 5, '0')); $$;

-- Nota: batal, ubah, hapus (salinan lengkap disimpan)
create or replace function public.trg_orders_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform public.log_activity('hapus_nota', public.nota_label(old.year, old.seq),
      to_jsonb(old) || jsonb_build_object('order_items',
        (select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]'::jsonb) from public.order_items i where i.order_id = old.id)));
    return old;
  end if;
  if new.status = 'batal' and old.status <> 'batal' then
    perform public.log_activity('batal_nota', public.nota_label(new.year, new.seq),
      jsonb_build_object('total', new.total, 'pay_method', new.pay_method, 'customer', new.customer_name, 'alasan', new.cancel_reason));
  elsif new.edited_at is distinct from old.edited_at then
    perform public.log_activity('ubah_nota', public.nota_label(new.year, new.seq),
      jsonb_build_object(
        'sebelum', jsonb_build_object('nota', public.nota_label(old.year, old.seq), 'total', old.total, 'pay_method', old.pay_method,
                                      'paid', old.paid, 'customer', old.customer_name),
        'sesudah', jsonb_build_object('nota', public.nota_label(new.year, new.seq), 'total', new.total, 'pay_method', new.pay_method,
                                      'paid', new.paid, 'customer', new.customer_name)));
  end if;
  return new;
end $$;
drop trigger if exists orders_log_upd on public.orders;
drop trigger if exists orders_log_del on public.orders;
create trigger orders_log_upd after update on public.orders for each row execute function public.trg_orders_log();
create trigger orders_log_del before delete on public.orders for each row execute function public.trg_orders_log();

-- Stok: pengurangan, stok opname, koreksi produksi
create or replace function public.trg_stock_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.delta < 0 or new.note like 'Stok opname%' then
    perform public.log_activity('stok', (select category || ' ' || name from public.products where id = new.product_id),
      jsonb_build_object('delta', new.delta, 'note', new.note));
  end if;
  return new;
end $$;
drop trigger if exists stock_moves_log on public.stock_moves;
create trigger stock_moves_log after insert on public.stock_moves for each row execute function public.trg_stock_log();

-- Produk: baru, ubah harga/nama/disembunyikan
create or replace function public.trg_products_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_activity('produk', new.category || ' ' || new.name, jsonb_build_object('baru', true, 'price', new.price));
  elsif (old.price, old.name, old.category, old.active) is distinct from (new.price, new.name, new.category, new.active) then
    perform public.log_activity('produk', new.category || ' ' || new.name, jsonb_build_object(
      'sebelum', jsonb_build_object('name', old.category || ' ' || old.name, 'price', old.price, 'active', old.active),
      'sesudah', jsonb_build_object('name', new.category || ' ' || new.name, 'price', new.price, 'active', new.active)));
  end if;
  return new;
end $$;
drop trigger if exists products_log on public.products;
create trigger products_log after insert or update on public.products for each row execute function public.trg_products_log();

-- Kas harian: perubahan setelah ditutup (ubah, hitung ulang, mulai ulang) dan hapus
create or replace function public.trg_cash_days_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform public.log_activity('hapus_kas', old.day::text, to_jsonb(old));
    return old;
  end if;
  if old.closed_at is not null and (old.opening, old.counted, old.note, old.closed_at, old.expected)
       is distinct from (new.opening, new.counted, new.note, new.closed_at, new.expected) then
    perform public.log_activity('ubah_kas', new.day::text, jsonb_build_object(
      'sebelum', jsonb_build_object('opening', old.opening, 'expected', old.expected, 'counted', old.counted, 'note', old.note),
      'sesudah', jsonb_build_object('opening', new.opening, 'expected', new.expected, 'counted', new.counted, 'note', new.note,
                                    'ditutup', new.closed_at is not null)));
  end if;
  return new;
end $$;
drop trigger if exists cash_days_log on public.cash_days;
create trigger cash_days_log after update or delete on public.cash_days for each row execute function public.trg_cash_days_log();

-- Kas keluar: ubah dan hapus
create or replace function public.trg_cash_out_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform public.log_activity('kas_keluar', old.day::text, jsonb_build_object('hapus', true, 'amount', old.amount, 'note', old.note, 'by', old.created_by));
    return old;
  end if;
  perform public.log_activity('kas_keluar', new.day::text, jsonb_build_object('sebelum', old.amount, 'sesudah', new.amount, 'note', new.note));
  return new;
end $$;
drop trigger if exists cash_out_log on public.cash_out;
create trigger cash_out_log after update or delete on public.cash_out for each row execute function public.trg_cash_out_log();

revoke execute on function public.set_staff_perms(text, jsonb, integer, boolean), public.my_options(),
  public.cash_out_allowed(integer) from public, anon;
grant execute on function public.set_staff_perms(text, jsonb, integer, boolean), public.my_options(),
  public.cash_out_allowed(integer) to authenticated;


-- ======================= 012_sinkron_cadangan.sql =======================
-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 012
-- Jalankan SEKALI di Supabase setelah 011:
-- menu SQL Editor → New query → kosongkan → tempel SELURUH isi file ini →
-- klik di area kosong (jangan ada teks yang terpilih) → Run.
--
-- 1. Sinkron otomatis antar perangkat: tabel transaksi, produk, kas, dan produksi
--    dikirim lewat Supabase Realtime, jadi perubahan dari kasir lain langsung terlihat.
--    (Hak baca tetap mengikuti aturan yang sama; tidak ada data yang jadi terbuka.)
-- 2. Waktu cadangan terakhir disimpan, untuk pengingat cadangan bagi pemilik.
-- =====================================================================


-- ---------- 1. Realtime ----------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['orders', 'products', 'cash_days', 'cash_out', 'productions'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- 2. Cadangan terakhir ----------
create table if not exists public.app_state (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_by text default (auth.jwt() ->> 'email'),
  updated_at timestamptz not null default now()
);
alter table public.app_state enable row level security;
drop policy if exists "staf lihat app_state"    on public.app_state;
drop policy if exists "pemilik ubah app_state"  on public.app_state;
drop policy if exists "pemilik ganti app_state" on public.app_state;
create policy "staf lihat app_state"    on public.app_state for select to authenticated using (public.is_staff());
create policy "pemilik ubah app_state"  on public.app_state for insert to authenticated with check (public.is_owner());
create policy "pemilik ganti app_state" on public.app_state for update to authenticated using (public.is_owner()) with check (public.is_owner());
grant select, insert, update on public.app_state to authenticated;


-- ======================= 013_stok_toko_rumah.sql =======================
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


-- ======================= 014_buat_akun_staf.sql =======================
-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 014
-- Jalankan SEKALI di Supabase setelah 013:
-- menu SQL Editor → New query → kosongkan → tempel SELURUH isi file ini →
-- klik di area kosong (jangan ada teks yang terpilih) → Run.
--
-- Pemilik bisa membuat akun login staf langsung dari Pengaturan → Staf (isi password saat
-- menambah staf, atau tombol Password). Tidak perlu lagi ke Supabase → Authentication → Users.
-- Kalau akun login sudah ada, password-nya diganti. Akun baru langsung aktif (email dianggap
-- sudah dikonfirmasi) dan hanya bisa dipakai kalau email-nya ada di daftar staf.
-- =====================================================================


create or replace function public.set_staff_password(p_email text, p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_email text := lower(trim(p_email));
  v_id    uuid;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mengatur password staf'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'Password minimal 6 karakter'; end if;
  if not exists (select 1 from public.staff where lower(email) = v_email) then
    raise exception 'Email ini tidak ada di daftar staf';
  end if;

  -- Akun sudah ada: ganti password
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at = now()
   where lower(email) = v_email
  returning id into v_id;
  if v_id is not null then return; end if;

  -- Akun belum ada: buat akun login email + password (sama seperti "Add user" dengan Auto Confirm)
  v_id := gen_random_uuid();
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
          extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
          '{"provider": "email", "providers": ["email"]}'::jsonb, '{}'::jsonb, now(), now(),
          '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
          'email', now(), now(), now());
end $$;
revoke execute on function public.set_staff_password(text, text) from public, anon;
grant execute on function public.set_staff_password(text, text) to authenticated;

-- Untuk aplikasi: email staf mana saja yang sudah punya akun login (pemilik)
create or replace function public.staff_logins() returns setof text
language sql stable security definer set search_path = public as $$
  select lower(u.email) from auth.users u
   where public.is_owner() and exists (select 1 from public.staff s where lower(s.email) = lower(u.email));
$$;
revoke execute on function public.staff_logins() from public, anon;
grant execute on function public.staff_logins() to authenticated;


commit;

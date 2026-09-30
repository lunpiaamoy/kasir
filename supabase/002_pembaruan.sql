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
-- =====================================================================

begin;

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
  public.delete_order(bigint), public.mark_done(bigint) from public, anon;
revoke execute on function public.create_order(jsonb), public.cancel_order(bigint),
  public.add_stock(bigint, integer, text) from public, anon;
grant execute on function public.my_role(), public.is_owner(), public.create_order(jsonb),
  public.update_order(bigint, jsonb), public.cancel_order(bigint), public.delete_order(bigint),
  public.mark_done(bigint), public.add_stock(bigint, integer, text) to authenticated;

-- ---------- Keamanan: rls_auto_enable() dari Supabase tidak perlu bisa dipanggil pengguna ----------
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'rls_auto_enable' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

commit;

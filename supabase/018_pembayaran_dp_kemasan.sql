-- Pembayaran bertahap & campuran + kemasan dus.
--  * order_payments: satu nota bisa dibayar beberapa kali (DP lalu pelunasan) dan dengan
--    beberapa cara (tunai, QRIS, transfer). Kas & laporan menghitung uang dari tabel ini.
--  * orders.pay_method sekarang juga bisa 'transfer', 'campuran', atau 'belum' (belum bayar).
--  * orders.packing: pembagian dus, mis. [{"size":5,"count":2}] = 2 dus isi 5.
-- Nota lama otomatis dibuatkan 1 baris pembayaran (lunas saat nota dibuat). Aman dijalankan ulang.
begin;

-- ---------- Tabel & kolom ----------
create table if not exists public.order_payments (
  id         bigint generated always as identity primary key,
  order_id   bigint not null references public.orders(id) on delete cascade,
  at         timestamptz not null default now(),
  method     text not null check (method in ('tunai', 'qris', 'transfer')),
  amount     integer not null check (amount > 0),
  created_by text default (auth.jwt() ->> 'email')
);
create index if not exists order_payments_order_idx on public.order_payments (order_id);
create index if not exists order_payments_at_idx on public.order_payments (at);
alter table public.order_payments enable row level security;
drop policy if exists "staf lihat pembayaran" on public.order_payments;
create policy "staf lihat pembayaran" on public.order_payments for select to authenticated using (public.is_staff());
revoke insert, update, delete on public.order_payments from anon, authenticated;
grant select on public.order_payments to authenticated;

alter table public.orders add column if not exists packing jsonb not null default '[]'::jsonb;
alter table public.orders drop constraint if exists orders_pay_method_check;
alter table public.orders add constraint orders_pay_method_check
  check (pay_method in ('tunai', 'qris', 'transfer', 'campuran', 'belum'));

-- Nota lama: dianggap lunas saat dibuat, dengan cara bayar yang tercatat
insert into public.order_payments (order_id, at, method, amount, created_by)
select o.id, o.created_at, o.pay_method, o.total, o.cashier
  from public.orders o
 where o.total > 0 and o.pay_method in ('tunai', 'qris', 'transfer')
   and not exists (select 1 from public.order_payments p where p.order_id = o.id);

-- ---------- Bantuan: periksa & susun pembayaran dari aplikasi ----------
-- p.payments = [{method, amount}], p.tendered = uang tunai yang diterima (untuk kembalian).
-- Aplikasi versi lama (tanpa p.payments): bayar penuh dengan p.pay_method, p.paid = uang diterima.
create or replace function public.prepare_payments(p jsonb, p_due integer, p_full boolean,
  out pays jsonb, out method text, out paid integer, out change integer)
language plpgsql immutable set search_path = public as $$
declare
  it jsonb; v_m text; v_a integer; v_sum integer := 0; v_cash integer := 0; v_tendered integer; v_methods text[] := '{}';
begin
  pays := '[]'::jsonb;
  if p -> 'payments' is null then
    v_m := coalesce(nullif(p ->> 'pay_method', ''), 'tunai');
    v_tendered := case when v_m = 'tunai' then coalesce((p ->> 'paid')::int, 0) else p_due end;
    if v_tendered < p_due then raise exception 'Uang yang dibayar kurang dari total'; end if;
    if p_due > 0 then pays := jsonb_build_array(jsonb_build_object('method', v_m, 'amount', p_due)); end if;
    method := v_m; paid := v_tendered; change := v_tendered - p_due; return;
  end if;
  for it in select * from jsonb_array_elements(p -> 'payments') loop
    v_m := it ->> 'method'; v_a := coalesce((it ->> 'amount')::int, 0);
    if v_a = 0 then continue; end if;
    if v_m not in ('tunai', 'qris', 'transfer') or v_a < 0 then raise exception 'Cara bayar tidak valid'; end if;
    pays := pays || jsonb_build_object('method', v_m, 'amount', v_a);
    v_sum := v_sum + v_a;
    if v_m = 'tunai' then v_cash := v_cash + v_a; end if;
    if not v_m = any(v_methods) then v_methods := v_methods || v_m; end if;
  end loop;
  if v_sum > p_due then raise exception 'Pembayaran (%) melebihi total yang harus dibayar (%)', v_sum, p_due; end if;
  if p_full and v_sum < p_due then raise exception 'Penjualan langsung harus dibayar lunas'; end if;
  v_tendered := coalesce(nullif(p ->> 'tendered', '')::int, v_cash);
  if v_tendered < v_cash then raise exception 'Uang tunai yang diterima kurang'; end if;
  method := case cardinality(v_methods) when 0 then 'belum' when 1 then v_methods[1] else 'campuran' end;
  paid := v_sum - v_cash + v_tendered; change := v_tendered - v_cash;
end $$;

create or replace function public.order_json(p_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(o) || jsonb_build_object(
    'order_items', (select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]'::jsonb) from public.order_items i where i.order_id = o.id),
    'order_payments', (select coalesce(jsonb_agg(to_jsonb(x) order by x.at, x.id), '[]'::jsonb) from public.order_payments x where x.order_id = o.id))
  from public.orders o where o.id = p_id;
$$;

-- Kemasan: hanya ukuran 10/5/1 dan jumlah > 0
create or replace function public.clean_packing(p jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object('size', (e ->> 'size')::int, 'count', (e ->> 'count')::int)), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) e
   where (e ->> 'size') ~ '^\d+$' and (e ->> 'size')::int in (10, 5, 1)
     and (e ->> 'count') ~ '^\d+$' and (e ->> 'count')::int between 1 and 999;
$$;

-- ---------- Nota baru ----------
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
  v_ful  text := coalesce(nullif(p ->> 'fulfillment', ''), 'langsung');
  pp     record;
begin
  if not public.is_staff() then raise exception 'Akun ini belum terdaftar sebagai staf'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]'::jsonb)) = 0 then raise exception 'Keranjang masih kosong'; end if;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::int;
    if v_qty is null or v_qty <= 0 then raise exception 'Jumlah barang tidak valid'; end if;
    select * into prod from public.products where id = (it ->> 'product_id')::bigint for update;
    if not found then raise exception 'Produk tidak ditemukan'; end if;
    v_total := v_total + prod.price * v_qty;
  end loop;

  select * into pp from public.prepare_payments(p, v_total, v_ful = 'langsung');

  insert into public.nota_counters (year, last) values (v_year, 1)
    on conflict (year) do update set last = public.nota_counters.last + 1
    returning last into v_seq;

  insert into public.orders (year, seq, customer_name, customer_wa, fulfillment, fulfill_date, fulfill_time,
                             ongkir, total, pay_method, paid, change, status, note, cashier, address, packing)
  values (v_year, v_seq,
          coalesce(p ->> 'customer_name', ''), coalesce(p ->> 'customer_wa', ''),
          v_ful, nullif(p ->> 'fulfill_date', '')::date, nullif(p ->> 'fulfill_time', '')::time,
          case when v_ful = 'kirim' then coalesce((p ->> 'ongkir')::int, 0) else 0 end,
          v_total, pp.method, pp.paid, pp.change,
          case when v_ful = 'langsung' then 'selesai' else 'menunggu' end,
          coalesce(p ->> 'note', ''), auth.jwt() ->> 'email',
          case when v_ful = 'kirim' then coalesce(p ->> 'address', '') else '' end,
          public.clean_packing(p -> 'packing'))
  returning * into o;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::int;
    select * into prod from public.products where id = (it ->> 'product_id')::bigint;
    insert into public.order_items (order_id, product_id, category, name, qty, price, subtotal)
    values (o.id, prod.id, prod.category, prod.name, v_qty, prod.price, prod.price * v_qty);
    update public.products set stock = stock - v_qty where id = prod.id;
  end loop;

  insert into public.order_payments (order_id, at, method, amount)
  select o.id, o.created_at, x ->> 'method', (x ->> 'amount')::int from jsonb_array_elements(pp.pays) x;

  return public.order_json(o.id);
end $$;

-- ---------- Ubah nota ----------
-- Pembayaran saat nota dibuat diganti sesuai isian; pelunasan yang dicatat belakangan tetap.
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
  v_later integer;
  v_ful  text := coalesce(nullif(p ->> 'fulfillment', ''), 'langsung');
  v_seq  integer := nullif(p ->> 'seq', '')::int;
  pp     record;
begin
  if not public.can('ubah_nota') then raise exception 'Akun ini tidak punya wewenang mengubah nota'; end if;
  select * into o from public.orders where id = p_id for update;
  if not found then raise exception 'Nota tidak ditemukan'; end if;
  if o.status = 'batal' then raise exception 'Nota yang sudah dibatalkan tidak bisa diubah'; end if;
  v_seq := coalesce(v_seq, o.seq);
  if v_seq <= 0 then raise exception 'Nomor nota tidak valid'; end if;
  if v_seq <> o.seq and exists (select 1 from public.orders where year = o.year and seq = v_seq) then
    raise exception 'Nomor nota (%) % sudah dipakai', o.year, lpad(v_seq::text, 5, '0');
  end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]'::jsonb)) = 0 then raise exception 'Keranjang masih kosong'; end if;

  update public.products pr set stock = pr.stock + i.qty
    from public.order_items i where i.order_id = p_id and i.product_id = pr.id;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::int;
    if v_qty is null or v_qty <= 0 then raise exception 'Jumlah barang tidak valid'; end if;
    select * into prod from public.products where id = (it ->> 'product_id')::bigint for update;
    if not found then raise exception 'Produk tidak ditemukan'; end if;
    select price into v_price from public.order_items where order_id = p_id and product_id = prod.id limit 1;
    v_price := coalesce(v_price, prod.price);
    v_items := v_items || jsonb_build_object('product_id', prod.id, 'category', prod.category, 'name', prod.name, 'qty', v_qty, 'price', v_price);
    v_total := v_total + v_price * v_qty;
  end loop;

  -- pelunasan yang dicatat sesudah nota dibuat tidak diubah
  select coalesce(sum(amount), 0) into v_later from public.order_payments where order_id = p_id and at > o.created_at;
  if v_later > v_total then raise exception 'Total baru lebih kecil dari pelunasan yang sudah diterima'; end if;
  select * into pp from public.prepare_payments(p, v_total - v_later, v_ful = 'langsung' and v_later = 0);

  delete from public.order_items where order_id = p_id;
  for it in select * from jsonb_array_elements(v_items) loop
    insert into public.order_items (order_id, product_id, category, name, qty, price, subtotal)
    values (p_id, (it ->> 'product_id')::bigint, it ->> 'category', it ->> 'name',
            (it ->> 'qty')::int, (it ->> 'price')::int, (it ->> 'price')::int * (it ->> 'qty')::int);
    update public.products set stock = stock - (it ->> 'qty')::int where id = (it ->> 'product_id')::bigint;
  end loop;

  delete from public.order_payments where order_id = p_id and at <= o.created_at;
  insert into public.order_payments (order_id, at, method, amount, created_by)
  select p_id, o.created_at, x ->> 'method', (x ->> 'amount')::int, o.cashier from jsonb_array_elements(pp.pays) x;

  update public.orders set
    customer_name = coalesce(p ->> 'customer_name', ''),
    customer_wa   = coalesce(p ->> 'customer_wa', ''),
    fulfillment   = v_ful,
    fulfill_date  = nullif(p ->> 'fulfill_date', '')::date,
    fulfill_time  = nullif(p ->> 'fulfill_time', '')::time,
    ongkir        = case when v_ful = 'kirim' then coalesce((p ->> 'ongkir')::int, 0) else 0 end,
    total         = v_total,
    pay_method    = (select case count(distinct method) when 0 then 'belum' when 1 then min(method) else 'campuran' end
                       from public.order_payments where order_id = p_id),
    paid          = pp.paid + v_later,
    change        = pp.change,
    note          = coalesce(p ->> 'note', ''),
    address       = case when v_ful = 'kirim' then coalesce(p ->> 'address', '') else '' end,
    packing       = case when p ? 'packing' then public.clean_packing(p -> 'packing') else o.packing end,
    status        = case when v_ful = 'langsung' then 'selesai'
                         when o.fulfillment = 'langsung' then 'menunggu'
                         else o.status end,
    seq           = v_seq,
    edited_at     = now(),
    edited_by     = auth.jwt() ->> 'email'
  where id = p_id;

  perform public.sync_nota_counter(o.year);
  return public.order_json(p_id);
end $$;

-- ---------- Pelunasan / bayar sisa ----------
create or replace function public.add_payment(p_order bigint, p_method text, p_amount integer, p_tendered integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders; v_paid integer; v_due integer;
begin
  if not public.can('pesanan') then raise exception 'Akun ini tidak punya wewenang menerima pembayaran pesanan'; end if;
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Nota tidak ditemukan'; end if;
  if o.status = 'batal' then raise exception 'Nota yang dibatalkan tidak bisa dibayar'; end if;
  if p_method not in ('tunai', 'qris', 'transfer') then raise exception 'Cara bayar tidak valid'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Isi jumlah pembayaran'; end if;
  select coalesce(sum(amount), 0) into v_paid from public.order_payments where order_id = p_order;
  v_due := o.total - v_paid;
  if v_due <= 0 then raise exception 'Nota ini sudah lunas'; end if;
  if p_amount > v_due then raise exception 'Pembayaran melebihi sisa (Rp %)', v_due; end if;
  if p_method = 'tunai' and coalesce(p_tendered, p_amount) < p_amount then raise exception 'Uang tunai yang diterima kurang'; end if;
  insert into public.order_payments (order_id, method, amount) values (p_order, p_method, p_amount);
  update public.orders set
    paid = paid + p_amount,
    change = case when p_method = 'tunai' then coalesce(p_tendered, p_amount) - p_amount else change end,
    pay_method = (select case count(distinct method) when 0 then 'belum' when 1 then min(method) else 'campuran' end
                    from public.order_payments where order_id = p_order)
  where id = p_order;
  perform public.log_activity('bayar_nota', public.nota_label(o.year, o.seq),
    jsonb_build_object('cara', p_method, 'jumlah', p_amount, 'sisa', v_due - p_amount));
  return public.order_json(p_order);
end $$;

revoke execute on function public.add_payment(bigint, text, integer, integer) from public, anon;
grant execute on function public.add_payment(bigint, text, integer, integer) to authenticated;
grant execute on function public.order_json(bigint) to authenticated;

-- Supaya pembayaran ikut tersinkron antar perangkat
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_payments') then
    execute 'alter publication supabase_realtime add table public.order_payments';
  end if;
end $$;

-- ---------- Pulihkan cadangan: ikut memulihkan pembayaran ----------
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
  r := public.restore_rows('order_items',
         (select coalesce(jsonb_agg(i), '[]'::jsonb) from jsonb_array_elements(d -> 'orders') o,
                 jsonb_array_elements(case when jsonb_typeof(o -> 'order_items') = 'array' then o -> 'order_items' else '[]'::jsonb end) i),
         'r.order_id = any($2) and (r.product_id is null or exists (select 1 from public.products p where p.id = r.product_id))',
         new_orders);
  r := public.restore_rows('order_payments',
         (select coalesce(jsonb_agg(i), '[]'::jsonb) from jsonb_array_elements(d -> 'orders') o,
                 jsonb_array_elements(case when jsonb_typeof(o -> 'order_payments') = 'array' then o -> 'order_payments' else '[]'::jsonb end) i),
         'r.order_id = any($2)', new_orders);
  -- cadangan lama (tanpa data pembayaran): nota dianggap lunas saat dibuat
  insert into public.order_payments (order_id, at, method, amount, created_by)
  select o.id, o.created_at, o.pay_method, o.total, o.cashier from public.orders o
   where o.id = any(new_orders) and o.total > 0 and o.pay_method in ('tunai', 'qris', 'transfer')
     and not exists (select 1 from public.order_payments p where p.order_id = o.id);

  r := public.restore_rows('stock_moves', d -> 'stock_moves',
         'exists (select 1 from public.products p where p.id = r.product_id)');
  res := res || jsonb_build_object('riwayat_stok', jsonb_array_length(r));
  res := res || jsonb_build_object('kas_harian', jsonb_array_length(public.restore_rows('cash_days', d -> 'cash_days')));
  res := res || jsonb_build_object('kas_keluar', jsonb_array_length(public.restore_rows('cash_out', d -> 'cash_out')));
  res := res || jsonb_build_object('produksi', jsonb_array_length(public.restore_rows('productions', d -> 'productions')));
  perform public.restore_rows('hidden_contacts', d -> 'hidden_contacts');

  foreach t in array array['products', 'orders', 'order_items', 'order_payments', 'stock_moves', 'cash_out', 'productions'] loop
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

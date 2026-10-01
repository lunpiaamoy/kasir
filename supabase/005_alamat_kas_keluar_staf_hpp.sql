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

begin;

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

commit;

-- =====================================================================
-- Kasir Lunpia Amoy: struktur database
-- Jalankan SEKALI di Supabase: menu SQL Editor → New query → tempel → Run.
-- =====================================================================

-- ---------- Daftar staf yang boleh memakai kasir ----------
-- Hanya email yang tercantum di sini yang bisa melihat dan mengubah data,
-- walaupun seseorang berhasil membuat akun sendiri.
create table public.staff (
  email text primary key,
  name  text not null default '',
  created_at timestamptz not null default now()
);

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where lower(email) = lower(auth.jwt() ->> 'email'));
$$;

-- ---------- Produk & stok ----------
create table public.products (
  id         bigint generated always as identity primary key,
  category   text    not null,              -- mis. "Lunpia Basah"
  name       text    not null,              -- mis. "Ayam"
  price      integer not null check (price >= 0),
  stock      integer not null default 0,
  min_stock  integer not null default 5,    -- di bawah ini dianggap "stok menipis"
  active     boolean not null default true,
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);

-- Riwayat perubahan stok (tambah stok, koreksi)
create table public.stock_moves (
  id         bigint generated always as identity primary key,
  product_id bigint not null references public.products(id) on delete cascade,
  delta      integer not null,
  note       text not null default '',
  created_by text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);

-- ---------- Transaksi ----------
create table public.orders (
  id            bigint generated always as identity primary key,
  year          integer not null,
  seq           integer not null,            -- nomor urut per tahun → "(2026) 00001"
  created_at    timestamptz not null default now(),
  customer_name text not null default '',
  customer_wa   text not null default '',
  fulfillment   text not null default 'langsung' check (fulfillment in ('langsung','ambil','kirim')),
  fulfill_date  date,
  fulfill_time  time,
  ongkir        integer not null default 0,  -- dicatat terpisah, TIDAK masuk total
  total         integer not null,
  pay_method    text not null check (pay_method in ('tunai','qris')),
  paid          integer not null,
  change        integer not null default 0,
  status        text not null default 'selesai' check (status in ('menunggu','selesai','batal')),
  cashier       text default (auth.jwt() ->> 'email'),
  unique (year, seq)
);

create table public.order_items (
  id         bigint generated always as identity primary key,
  order_id   bigint not null references public.orders(id) on delete cascade,
  product_id bigint references public.products(id),
  category   text    not null,
  name       text    not null,
  qty        integer not null check (qty > 0),
  price      integer not null,
  subtotal   integer not null
);

create index on public.orders (created_at);
create index on public.orders (status, fulfill_date);
create index on public.order_items (order_id);

-- ---------- Keamanan: hanya staf ----------
alter table public.staff       enable row level security;
alter table public.products    enable row level security;
alter table public.stock_moves enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;

create policy "staf melihat daftar staf" on public.staff       for select to authenticated using (public.is_staff());
create policy "staf kelola produk"       on public.products    for all    to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "staf kelola stok"         on public.stock_moves for all    to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "staf kelola transaksi"    on public.orders      for all    to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "staf kelola item"         on public.order_items for all    to authenticated using (public.is_staff()) with check (public.is_staff());

-- ---------- Simpan transaksi (nomor nota, total, stok: semua sekaligus) ----------
-- Harga dan total dihitung ulang dari database, bukan dipercaya dari browser.
create or replace function public.create_order(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
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

  -- Kunci per tahun supaya dua kasir tidak mendapat nomor nota yang sama
  perform pg_advisory_xact_lock(v_year);
  select coalesce(max(seq), 0) + 1 into v_seq from public.orders where year = v_year;

  insert into public.orders (year, seq, customer_name, customer_wa, fulfillment, fulfill_date, fulfill_time,
                             ongkir, total, pay_method, paid, change, status)
  values (v_year, v_seq,
          coalesce(p ->> 'customer_name', ''), coalesce(p ->> 'customer_wa', ''),
          v_ful, nullif(p ->> 'fulfill_date', '')::date, nullif(p ->> 'fulfill_time', '')::time,
          case when v_ful = 'kirim' then coalesce((p ->> 'ongkir')::int, 0) else 0 end,
          v_total, p ->> 'pay_method', v_paid, v_paid - v_total,
          case when v_ful = 'langsung' then 'selesai' else 'menunggu' end)
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

-- Batalkan transaksi: stok dikembalikan
create or replace function public.cancel_order(p_id bigint) returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Akun ini belum terdaftar sebagai staf'; end if;
  if exists (select 1 from public.orders where id = p_id and status <> 'batal') then
    update public.products pr set stock = pr.stock + i.qty
      from public.order_items i where i.order_id = p_id and i.product_id = pr.id;
    update public.orders set status = 'batal' where id = p_id;
  end if;
end $$;

-- Tambah / koreksi stok, sekaligus dicatat di riwayat
create or replace function public.add_stock(p_product bigint, p_delta integer, p_note text default '') returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Akun ini belum terdaftar sebagai staf'; end if;
  update public.products set stock = stock + p_delta where id = p_product;
  insert into public.stock_moves (product_id, delta, note) values (p_product, p_delta, coalesce(p_note, ''));
end $$;

-- ---------- Izin akses Data API ----------
-- Hanya pengguna yang login (authenticated) yang diberi akses; pengunjung anonim tidak sama sekali.
-- Diperlukan kalau "Automatically expose new tables" dimatikan saat membuat project.
grant usage on schema public to authenticated;
grant select on public.staff to authenticated;
grant select, insert, update, delete on public.products, public.stock_moves, public.orders, public.order_items to authenticated;
grant usage, select on all sequences in schema public to authenticated;

revoke execute on function public.is_staff(), public.create_order(jsonb), public.cancel_order(bigint),
  public.add_stock(bigint, integer, text) from public, anon;
grant execute on function public.is_staff(), public.create_order(jsonb), public.cancel_order(bigint),
  public.add_stock(bigint, integer, text) to authenticated;

-- ---------- Produk awal (dari contoh nota; stok mulai 0, ubah di menu Stok) ----------
insert into public.products (category, name, price, stock, min_stock, sort) values
  ('Lunpia Basah',  'Ayam',             25000, 0, 5, 10),
  ('Lunpia Basah',  'Udang',            25000, 0, 5, 20),
  ('Lunpia Goreng', 'Udang Ayam',       26000, 0, 5, 30),
  ('Lunpia Frozen', 'Udang Ayam isi 5', 150000, 0, 3, 40),
  ('Ngoyang',       'Ayam',             20000, 0, 5, 50);

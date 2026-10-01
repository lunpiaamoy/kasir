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

begin;

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

commit;

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

begin;

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

commit;

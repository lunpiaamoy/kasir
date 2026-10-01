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

begin;

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

commit;

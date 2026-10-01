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

begin;

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

commit;

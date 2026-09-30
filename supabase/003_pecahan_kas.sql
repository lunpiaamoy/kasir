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

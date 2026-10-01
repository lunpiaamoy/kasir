-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 010
-- Jalankan SEKALI di Supabase setelah 009:
-- menu SQL Editor → New query → kosongkan → tempel SELURUH isi file ini →
-- klik di area kosong (jangan ada teks yang terpilih) → Run.
--
-- Laba pindah ke tab Laporan: wewenang "lihat laba" sekarang bagian dari tab Laporan,
-- dan Laporan mengambil total bahan terpakai lewat fungsi material_used (tanpa perlu
-- wewenang membuka tab Pembelian).
-- =====================================================================

begin;

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

-- Total bahan terpakai di rentang tanggal (sama dengan hitungan di tab Pembelian):
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

commit;

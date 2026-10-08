-- Keamanan data (hasil audit):
--  1. Data pembeli (nama, WA, alamat) di transaksi lama hanya bisa dibaca pemilik dan staf yang diberi
--     wewenang Laporan atau Kontak. Staf lain hanya melihat transaksi 2 hari terakhir + pesanan yang
--     masih menunggu. Ini dijaga database, jadi tidak bisa diakali lewat aplikasi/browser.
--  2. Bawaan wewenang staf yang belum diatur dibuat lebih ketat: Laporan, Unduh Excel, dan Kontak mati
--     (pemilik bisa menyalakannya per orang di Pengaturan → Staf → Wewenang).
--  3. Wewenang baru "laci": buka laci uang tanpa transaksi; setiap pembukaan tercatat di Catatan aktivitas.
-- Aman dijalankan ulang.
begin;

create or replace function public.perm_defaults() returns jsonb
language sql immutable set search_path = public as $$
  select '{
    "pesanan": true,  "batal": true, "ubah_nota": false, "hapus_nota": false,
    "stok": true,     "stok_masuk": true, "stok_pindah": true, "stok_kurang": false, "opname": false, "produk_tambah": false, "produk_ubah": false,
    "kas": true,      "kas_buka": true, "kas_tutup": true, "kas_keluar": true, "kas_ubah": false, "kas_hapus": false, "laci": true,
    "laporan": false, "laporan_unduh": false,
    "pembelian": false, "pembelian_catat": false, "pembelian_hapus": false, "laba": false,
    "kontak": false,  "kontak_ubah": false, "kontak_hapus": false
  }'::jsonb;
$$;

create or replace function public.perm_parent(p text) returns text
language sql immutable set search_path = public as $$
  select '{
    "batal": "pesanan", "ubah_nota": "pesanan", "hapus_nota": "pesanan",
    "stok_masuk": "stok", "stok_pindah": "stok", "stok_kurang": "stok", "opname": "stok", "produk_tambah": "stok", "produk_ubah": "stok",
    "kas_buka": "kas", "kas_tutup": "kas", "kas_keluar": "kas", "kas_ubah": "kas", "kas_hapus": "kas", "laci": "kas",
    "laporan_unduh": "laporan", "laba": "laporan",
    "pembelian_catat": "pembelian", "pembelian_hapus": "pembelian",
    "kontak_ubah": "kontak", "kontak_hapus": "kontak"
  }'::jsonb ->> p;
$$;

-- Boleh melihat semua transaksi (termasuk data pembeli lama)?
create or replace function public.can_see_all_orders() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_owner() or public.can('laporan') or public.can('kontak');
$$;

drop policy if exists "staf lihat transaksi" on public.orders;
create policy "staf lihat transaksi" on public.orders for select to authenticated
  using (public.is_staff() and (public.can_see_all_orders() or status = 'menunggu' or created_at >= now() - interval '2 days'));

drop policy if exists "staf lihat item" on public.order_items;
create policy "staf lihat item" on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));

drop policy if exists "staf lihat pembayaran" on public.order_payments;
create policy "staf lihat pembayaran" on public.order_payments for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));

-- Buka laci uang tanpa transaksi: dicatat
create or replace function public.log_drawer(p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can('laci') then raise exception 'Akun ini tidak punya wewenang membuka laci tanpa transaksi'; end if;
  perform public.log_activity('buka_laci', '', jsonb_build_object('catatan', left(coalesce(p_note, ''), 200)));
end $$;
revoke execute on function public.log_drawer(text) from public, anon;
grant execute on function public.log_drawer(text) to authenticated;
grant execute on function public.can_see_all_orders() to authenticated;

commit;

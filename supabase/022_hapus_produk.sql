-- Hapus produk (pemilik). Produk tidak benar-benar dibuang supaya nota lama, laporan,
-- dan kartu stok tetap utuh; produk hanya ditandai terhapus dan hilang dari Kasir & Stok.
begin;

alter table public.products add column if not exists deleted_at timestamptz;

create or replace function public.delete_product(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare prod public.products;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa menghapus produk'; end if;
  select * into prod from public.products where id = p_id and deleted_at is null for update;
  if not found then raise exception 'Produk tidak ditemukan'; end if;
  update public.products set deleted_at = now() where id = p_id;
  perform public.log_activity('hapus_produk', prod.category || ' ' || prod.name,
    jsonb_build_object('price', prod.price, 'stock', prod.stock));
end $$;
revoke execute on function public.delete_product(bigint) from public, anon;
grant execute on function public.delete_product(bigint) to authenticated;

commit;

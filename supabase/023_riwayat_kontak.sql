-- Riwayat belanja satu kontak (nomor WA yang sama, ditulis dengan format apa pun).
-- Berjalan dengan hak akun yang memanggil, jadi aturan baca transaksi (019) tetap berlaku.
begin;

create or replace function public.contact_orders(p_key text)
returns setof public.orders
language sql stable set search_path = public as $$
  select * from public.orders
   where regexp_replace(regexp_replace(customer_wa, '\D', '', 'g'), '^0', '62') = p_key
     and p_key <> ''
   order by created_at desc
   limit 200;
$$;
revoke execute on function public.contact_orders(text) from public, anon;
grant execute on function public.contact_orders(text) to authenticated;

commit;

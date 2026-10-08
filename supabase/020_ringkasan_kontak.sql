-- Kontak dihitung di database (lebih ringan): satu baris per nomor WA, bukan seluruh transaksi.
-- Fungsi berjalan dengan hak akun yang memanggil (aturan RLS 019 tetap berlaku).
begin;

create or replace function public.contact_summary()
returns table (key text, name text, wa text, address text, n bigint, spent bigint, last timestamptz)
language sql stable set search_path = public as $$
  with o as (
    select regexp_replace(regexp_replace(customer_wa, '\D', '', 'g'), '^0', '62') as k,
           trim(customer_name) as nm, trim(customer_wa) as wa, trim(coalesce(address, '')) as addr,
           created_at, status, total
      from public.orders
     where regexp_replace(customer_wa, '\D', '', 'g') <> ''
  )
  select k,
         (array_agg(nm order by created_at desc) filter (where nm <> ''))[1],
         (array_agg(wa order by created_at desc))[1],
         (array_agg(addr order by created_at desc) filter (where addr <> ''))[1],
         count(*) filter (where status <> 'batal'),
         coalesce(sum(total) filter (where status <> 'batal'), 0),
         max(created_at)
    from o group by k;
$$;
revoke execute on function public.contact_summary() from public, anon;
grant execute on function public.contact_summary() to authenticated;

commit;

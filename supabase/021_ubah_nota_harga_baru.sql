-- Ubah nota: barang yang dikosongkan lalu dimasukkan lagi memakai harga terbaru di daftar barang.
-- Barang lain tetap memakai harga lama, dan nota lain tidak berubah.
begin;

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
  v_later integer;
  v_ful  text := coalesce(nullif(p ->> 'fulfillment', ''), 'langsung');
  v_seq  integer := nullif(p ->> 'seq', '')::int;
  pp     record;
begin
  if not public.can('ubah_nota') then raise exception 'Akun ini tidak punya wewenang mengubah nota'; end if;
  select * into o from public.orders where id = p_id for update;
  if not found then raise exception 'Nota tidak ditemukan'; end if;
  if o.status = 'batal' then raise exception 'Nota yang sudah dibatalkan tidak bisa diubah'; end if;
  v_seq := coalesce(v_seq, o.seq);
  if v_seq <= 0 then raise exception 'Nomor nota tidak valid'; end if;
  if v_seq <> o.seq and exists (select 1 from public.orders where year = o.year and seq = v_seq) then
    raise exception 'Nomor nota (%) % sudah dipakai', o.year, lpad(v_seq::text, 5, '0');
  end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]'::jsonb)) = 0 then raise exception 'Keranjang masih kosong'; end if;

  update public.products pr set stock = pr.stock + i.qty
    from public.order_items i where i.order_id = p_id and i.product_id = pr.id;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (it ->> 'qty')::int;
    if v_qty is null or v_qty <= 0 then raise exception 'Jumlah barang tidak valid'; end if;
    select * into prod from public.products where id = (it ->> 'product_id')::bigint for update;
    if not found then raise exception 'Produk tidak ditemukan'; end if;
    -- Barang yang sudah ada di nota memakai harga lama, kecuali kasir memilih harga baru
    -- (barang dikosongkan lalu ditambah lagi) → harga sekarang di daftar barang
    v_price := null;
    if coalesce((it ->> 'new_price')::boolean, false) is not true then
      select price into v_price from public.order_items where order_id = p_id and product_id = prod.id limit 1;
    end if;
    v_price := coalesce(v_price, prod.price);
    v_items := v_items || jsonb_build_object('product_id', prod.id, 'category', prod.category, 'name', prod.name, 'qty', v_qty, 'price', v_price);
    v_total := v_total + v_price * v_qty;
  end loop;

  -- pelunasan yang dicatat sesudah nota dibuat tidak diubah
  select coalesce(sum(amount), 0) into v_later from public.order_payments where order_id = p_id and at > o.created_at;
  if v_later > v_total then raise exception 'Total baru lebih kecil dari pelunasan yang sudah diterima'; end if;
  select * into pp from public.prepare_payments(p, v_total - v_later, v_ful = 'langsung' and v_later = 0);

  delete from public.order_items where order_id = p_id;
  for it in select * from jsonb_array_elements(v_items) loop
    insert into public.order_items (order_id, product_id, category, name, qty, price, subtotal)
    values (p_id, (it ->> 'product_id')::bigint, it ->> 'category', it ->> 'name',
            (it ->> 'qty')::int, (it ->> 'price')::int, (it ->> 'price')::int * (it ->> 'qty')::int);
    update public.products set stock = stock - (it ->> 'qty')::int where id = (it ->> 'product_id')::bigint;
  end loop;

  delete from public.order_payments where order_id = p_id and at <= o.created_at;
  insert into public.order_payments (order_id, at, method, amount, created_by)
  select p_id, o.created_at, x ->> 'method', (x ->> 'amount')::int, o.cashier from jsonb_array_elements(pp.pays) x;

  update public.orders set
    customer_name = coalesce(p ->> 'customer_name', ''),
    customer_wa   = coalesce(p ->> 'customer_wa', ''),
    fulfillment   = v_ful,
    fulfill_date  = nullif(p ->> 'fulfill_date', '')::date,
    fulfill_time  = nullif(p ->> 'fulfill_time', '')::time,
    ongkir        = case when v_ful = 'kirim' then coalesce((p ->> 'ongkir')::int, 0) else 0 end,
    total         = v_total,
    pay_method    = (select case count(distinct method) when 0 then 'belum' when 1 then min(method) else 'campuran' end
                       from public.order_payments where order_id = p_id),
    paid          = pp.paid + v_later,
    change        = pp.change,
    note          = coalesce(p ->> 'note', ''),
    address       = case when v_ful = 'kirim' then coalesce(p ->> 'address', '') else '' end,
    packing       = case when p ? 'packing' then public.clean_packing(p -> 'packing') else o.packing end,
    status        = case when v_ful = 'langsung' then 'selesai'
                         when o.fulfillment = 'langsung' then 'menunggu'
                         else o.status end,
    seq           = v_seq,
    edited_at     = now(),
    edited_by     = auth.jwt() ->> 'email'
  where id = p_id;

  perform public.sync_nota_counter(o.year);
  return public.order_json(p_id);
end $$;

commit;

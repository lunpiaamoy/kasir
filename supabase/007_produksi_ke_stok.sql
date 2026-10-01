-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 007
-- Jalankan SEKALI di Supabase setelah 006:
-- menu SQL Editor → New query → kosongkan → tempel SELURUH isi file ini →
-- klik di area kosong (jangan ada teks yang terpilih) → Run.
--
-- Hasil produksi di Laporan langsung menambah stok produk (tercatat di kartu stok
-- sebagai "Produksi tgl"). Mengubah catatan menyesuaikan selisihnya; menghapus
-- catatan mengurangi kembali stoknya. Catatan lama (sebelum file ini) tidak mengubah stok.
-- Juga: pemilik bisa mengganti password akun staf (tombol Password di Pengaturan → Staf).
-- =====================================================================

begin;

alter table public.productions add column if not exists stocked boolean not null default false;

-- Catatan produksi hanya lewat fungsi di bawah, supaya stok selalu ikut
revoke insert, update, delete on public.productions from authenticated;

-- Tambah/kurangi stok sebesar selisih kontribusi lama → baru
create or replace function public.production_stock(p_old jsonb, p_new jsonb, p_note text)
returns void language plpgsql set search_path = public as $$
declare r record;
begin
  for r in
    select x.product_id, sum(x.q)::int d from (
      select (o ->> 'product_id')::bigint product_id, (o ->> 'qty')::int q from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) o
      union all
      select (o ->> 'product_id')::bigint, -(o ->> 'qty')::int from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) o
    ) x
    where exists (select 1 from public.products p where p.id = x.product_id)
    group by x.product_id having sum(x.q) <> 0
  loop
    update public.products set stock = stock + r.d where id = r.product_id;
    insert into public.stock_moves (product_id, delta, note) values (r.product_id, r.d, p_note);
  end loop;
end $$;
revoke execute on function public.production_stock(jsonb, jsonb, text) from public, anon, authenticated;

create or replace function public.save_production(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id      bigint := nullif(p ->> 'id', '')::bigint;
  v_day     date := nullif(p ->> 'day', '')::date;
  v_stocked boolean := coalesce((p ->> 'stocked')::boolean, true);
  v_out     jsonb := coalesce(p -> 'outputs', '[]'::jsonb);
  old       public.productions;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mencatat produksi'; end if;
  if v_day is null then raise exception 'Isi tanggal'; end if;
  if exists (select 1 from jsonb_array_elements(v_out) o where coalesce((o ->> 'qty')::int, 0) <= 0) then
    raise exception 'Jumlah hasil produksi tidak valid';
  end if;
  if v_id is null then
    insert into public.productions (day, purchases, outputs, note, stocked)
    values (v_day, coalesce(p -> 'purchases', '[]'::jsonb), v_out, coalesce(p ->> 'note', ''), v_stocked)
    returning id into v_id;
    perform public.production_stock(null, case when v_stocked then v_out end,
      'Produksi ' || to_char(v_day, 'DD/MM/YYYY'));
  else
    select * into old from public.productions where id = v_id for update;
    if not found then raise exception 'Catatan produksi tidak ditemukan'; end if;
    update public.productions
       set day = v_day, purchases = coalesce(p -> 'purchases', '[]'::jsonb), outputs = v_out,
           note = coalesce(p ->> 'note', ''), stocked = v_stocked
     where id = v_id;
    perform public.production_stock(case when old.stocked then old.outputs end, case when v_stocked then v_out end,
      'Produksi ' || to_char(v_day, 'DD/MM/YYYY') || ' (diubah)');
  end if;
  return v_id;
end $$;

create or replace function public.delete_production(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare old public.productions;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa menghapus catatan produksi'; end if;
  select * into old from public.productions where id = p_id for update;
  if not found then return; end if;
  if old.stocked then
    perform public.production_stock(old.outputs, null, 'Produksi ' || to_char(old.day, 'DD/MM/YYYY') || ' (dihapus)');
  end if;
  delete from public.productions where id = p_id;
end $$;

revoke execute on function public.save_production(jsonb), public.delete_production(bigint) from public, anon;
grant execute on function public.save_production(jsonb), public.delete_production(bigint) to authenticated;

-- ---------- Pemilik mengganti password akun staf ----------
-- Akun login harus sudah dibuat di Authentication → Users (email sama dengan daftar staf).
create or replace function public.set_staff_password(p_email text, p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mengganti password staf'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'Password minimal 6 karakter'; end if;
  if not exists (select 1 from public.staff where lower(email) = lower(p_email)) then
    raise exception 'Email ini tidak ada di daftar staf';
  end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
   where lower(email) = lower(p_email);
  if not found then
    raise exception 'Akun login untuk % belum dibuat. Buat dulu di Supabase: Authentication → Users → Add user.', p_email;
  end if;
end $$;
revoke execute on function public.set_staff_password(text, text) from public, anon;
grant execute on function public.set_staff_password(text, text) to authenticated;

commit;

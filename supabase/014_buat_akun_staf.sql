-- =====================================================================
-- Kasir Lunpia Amoy: pembaruan 014
-- Jalankan SEKALI di Supabase setelah 013:
-- menu SQL Editor → New query → kosongkan → tempel SELURUH isi file ini →
-- klik di area kosong (jangan ada teks yang terpilih) → Run.
--
-- Pemilik bisa membuat akun login staf langsung dari Pengaturan → Staf (isi password saat
-- menambah staf, atau tombol Password). Tidak perlu lagi ke Supabase → Authentication → Users.
-- Kalau akun login sudah ada, password-nya diganti. Akun baru langsung aktif (email dianggap
-- sudah dikonfirmasi) dan hanya bisa dipakai kalau email-nya ada di daftar staf.
-- =====================================================================

begin;

create or replace function public.set_staff_password(p_email text, p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_email text := lower(trim(p_email));
  v_id    uuid;
begin
  if not public.is_owner() then raise exception 'Hanya pemilik yang bisa mengatur password staf'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'Password minimal 6 karakter'; end if;
  if not exists (select 1 from public.staff where lower(email) = v_email) then
    raise exception 'Email ini tidak ada di daftar staf';
  end if;

  -- Akun sudah ada: ganti password
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at = now()
   where lower(email) = v_email
  returning id into v_id;
  if v_id is not null then return; end if;

  -- Akun belum ada: buat akun login email + password (sama seperti "Add user" dengan Auto Confirm)
  v_id := gen_random_uuid();
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
          extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
          '{"provider": "email", "providers": ["email"]}'::jsonb, '{}'::jsonb, now(), now(),
          '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
          'email', now(), now(), now());
end $$;
revoke execute on function public.set_staff_password(text, text) from public, anon;
grant execute on function public.set_staff_password(text, text) to authenticated;

-- Untuk aplikasi: email staf mana saja yang sudah punya akun login (pemilik)
create or replace function public.staff_logins() returns setof text
language sql stable security definer set search_path = public as $$
  select lower(u.email) from auth.users u
   where public.is_owner() and exists (select 1 from public.staff s where lower(s.email) = lower(u.email));
$$;
revoke execute on function public.staff_logins() from public, anon;
grant execute on function public.staff_logins() to authenticated;

commit;

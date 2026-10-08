-- Cek file SQL pembaruan mana yang sudah dijalankan.
-- Supabase → SQL Editor → New query → tempel seluruh isi file ini → Run.
-- Baris "BELUM" = file itu (atau sebelumnya) belum berhasil dijalankan.
select file, case when ada then 'sudah' else 'BELUM' end as status from (values
  ('002', to_regprocedure('public.update_order(bigint, jsonb)') is not null),
  ('003', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cash_days' and column_name = 'opening_detail')),
  ('004', to_regclass('public.hidden_contacts') is not null),
  ('005', to_regclass('public.cash_out') is not null),
  ('006', to_regclass('public.productions') is not null),
  ('007', to_regprocedure('public.save_production(jsonb)') is not null),
  ('008', to_regprocedure('public.can(text)') is not null),
  ('009', to_regprocedure('public.sync_nota_counter(integer)') is not null),
  ('010', to_regprocedure('public.material_used(date, date)') is not null),
  ('011', to_regclass('public.activity_log') is not null),
  ('012', to_regclass('public.app_state') is not null),
  ('013', to_regprocedure('public.move_stock(bigint, integer, text)') is not null),
  ('014', to_regprocedure('public.staff_logins()') is not null),
  ('016', exists (select 1 from pg_policies where policyname = 'staf lihat siapa online')),
  ('017', to_regprocedure('public.online_devices()') is not null),
  ('018', to_regclass('public.order_payments') is not null)
) as t(file, ada) order by file;

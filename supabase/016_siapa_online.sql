-- Siapa yang sedang login: daftar perangkat yang sedang membuka aplikasi (Supabase Realtime Presence).
-- Kanal "lunpia-online" dibuat privat: hanya staf yang login yang bisa melihat dan mengirim status,
-- supaya email staf tidak bisa dilihat orang luar yang hanya punya anon key.
-- Aman dijalankan ulang. Kalau tabel realtime.messages tidak ada (bukan Supabase), dilewati.
begin;

do $$
begin
  if to_regclass('realtime.messages') is null then
    raise notice 'realtime.messages tidak ada, dilewati';
    return;
  end if;
  execute 'drop policy if exists "staf lihat siapa online" on realtime.messages';
  execute 'drop policy if exists "staf kirim status online" on realtime.messages';
  execute $p$create policy "staf lihat siapa online" on realtime.messages for select to authenticated
    using (realtime.topic() = 'lunpia-online' and extension = 'presence' and public.is_staff())$p$;
  execute $p$create policy "staf kirim status online" on realtime.messages for insert to authenticated
    with check (realtime.topic() = 'lunpia-online' and extension = 'presence' and public.is_staff())$p$;
end $$;

commit;

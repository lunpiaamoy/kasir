-- Siapa yang sedang login (pengganti kanal Realtime di 016, yang tidak selalu bisa tersambung):
-- tiap perangkat mengirim "masih aktif" (heartbeat) ± tiap 45 detik ke tabel device_sessions.
-- Pemilik melihat daftar perangkat: online (aktif < 3 menit) dan terakhir aktif (7 hari).
-- Tabel hanya bisa diakses lewat fungsi di bawah. Aman dijalankan ulang.
begin;

create table if not exists public.device_sessions (
  device_id text primary key,
  email     text not null,
  role      text,
  device    text not null default '',
  tab       text not null default '',
  since     timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
alter table public.device_sessions enable row level security;
revoke all on public.device_sessions from anon, authenticated;

create or replace function public.heartbeat(p_device text, p_info jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(auth.jwt() ->> 'email');
begin
  if not public.is_staff() or coalesce(p_device, '') = '' or length(p_device) > 64 then return; end if;
  insert into public.device_sessions as d (device_id, email, role, device, tab, since, last_seen)
  values (p_device, v_email, public.my_role(), left(coalesce(p_info ->> 'device', ''), 120), left(coalesce(p_info ->> 'tab', ''), 40), now(), now())
  on conflict (device_id) do update set
    email = excluded.email, role = excluded.role, device = excluded.device, tab = excluded.tab,
    -- "sejak" diulang kalau ganti akun atau perangkat sempat tidak aktif > 5 menit
    since = case when d.email = excluded.email and d.last_seen > now() - interval '5 minutes' then d.since else now() end,
    last_seen = now();
  delete from public.device_sessions where last_seen < now() - interval '30 days';
end $$;

-- Keluar: hapus tanda aktif perangkat ini
create or replace function public.heartbeat_end(p_device text) returns void
language sql security definer set search_path = public as $$
  delete from public.device_sessions where device_id = p_device and email = lower(auth.jwt() ->> 'email');
$$;

-- Daftar untuk pemilik (7 hari terakhir), plus waktu server untuk menghitung "online"
create or replace function public.online_devices()
returns table (device_id text, email text, role text, device text, tab text, since timestamptz, last_seen timestamptz, now_at timestamptz)
language sql stable security definer set search_path = public as $$
  select d.device_id, d.email, d.role, d.device, d.tab, d.since, d.last_seen, now()
    from public.device_sessions d
   where public.is_owner() and d.last_seen > now() - interval '7 days'
   order by d.last_seen desc;
$$;

revoke execute on function public.heartbeat(text, jsonb), public.heartbeat_end(text), public.online_devices() from public, anon;
grant execute on function public.heartbeat(text, jsonb), public.heartbeat_end(text), public.online_devices() to authenticated;

commit;

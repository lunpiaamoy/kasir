#!/usr/bin/env bash
# Menjalankan file SQL pembaruan (supabase/NNN_*.sql) yang belum pernah dijalankan.
# Dipakai GitHub Actions (.github/workflows/pembaruan-database.yml) setiap ada merge ke main.
# Butuh DATABASE_URL (Supabase → Connect → Session pooler). Setiap file dicatat di
# public.app_migrations supaya hanya dijalankan sekali.
set -euo pipefail
cd "$(dirname "$0")"
: "${DATABASE_URL:?DATABASE_URL belum diisi}"
export PGSSLMODE="${PGSSLMODE:-require}"
q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qAtX "$@"; }

q -c "create table if not exists public.app_migrations (
        file text primary key, applied_at timestamptz not null default now());
      alter table public.app_migrations enable row level security;"

# Pertama kali: tandai file yang sudah dijalankan manual (pemeriksaan sama dengan
# cek_pembaruan.sql). Berhenti di file pertama yang belum; sisanya dijalankan di bawah.
if [ "$(q -c 'select count(*) from public.app_migrations')" = "0" ]; then
  q <<'SQL'
insert into public.app_migrations (file)
select file from (
  select file, bool_and(ada) over (order by file) as semua from (values
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
    ('014', to_regprocedure('public.staff_logins()') is not null)
  ) as t(file, ada)
) s where semua;
SQL
  echo "Sudah ada sebelumnya: $(q -c "select coalesce(string_agg(file, ' ' order by file), '-') from public.app_migrations")"
fi

n=0
for f in [0-9][0-9][0-9]_*.sql; do
  id="${f:0:3}"
  [ "$(q -c "select count(*) from public.app_migrations where file = '$id'")" = "0" ] || continue
  echo "Menjalankan $f ..."
  q -f "$f"
  q -c "insert into public.app_migrations (file) values ('$id')"
  n=$((n + 1))
done
echo "Selesai. File baru yang dijalankan: $n"

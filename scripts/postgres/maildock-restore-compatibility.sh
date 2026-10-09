#!/bin/sh
# Trusted, complete baseline custom archives only. No dump editing by operators.
set -eu
umask 077
export LC_ALL=C
stage=arguments
fail() { printf 'recovery_archive_refused (%s): Keep writers stopped; use fresh destination storage before retry.\n' "$stage" >&2; exit 1; }
resources=/usr/local/share/maildock-recovery
tmp=$(mktemp -d) || fail
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
export PGPASSWORD="${POSTGRES_PASSWORD:?}"
export PGHOST=postgres PGUSER="${POSTGRES_USER:?}" PGDATABASE="${POSTGRES_DB:?}"
if [ "$#" = 1 ] && [ "$1" = '--check-fresh-destination' ]; then
  stage=destination
  psql -X -v ON_ERROR_STOP=1 -f "$resources/restore-preflight.sql" > "$tmp/result" 2> "$tmp/error" || fail
  printf '%s\n' 'recovery_destination_verified: Fresh ordinary destination verified.' >&2
  exit 0
fi
[ "$#" = 2 ] && [ "$1" = '--fresh-destination-writers-stopped' ] || fail
[ -f "$2" ] || fail
pg_restore --list "$2" > "$tmp/toc" 2> "$tmp/error" || fail
stage=archive_version
grep -Eq '^;[[:space:]]+Dumped from database version: 18\.' "$tmp/toc" || fail
grep -Eq '^;[[:space:]]+Dumped by pg_dump version: 18\.' "$tmp/toc" || fail
grep -Eq '^;[[:space:]]+Format: CUSTOM$' "$tmp/toc" || fail
# Exact signatures and counts; no ambiguous/overloaded helper may be omitted.
stage=function_signatures
awk '$4 == "FUNCTION" && $5 == "public" { $1=$2=$3=$4=$5=""; sub(/^ +/, ""); sub(/ [^ ]+$/, ""); print }' "$tmp/toc" | sort > "$tmp/all-functions"
cmp -s "$tmp/all-functions" "$resources/legacy-function-toc.txt" || fail
awk '$4 == "SCHEMA" && $6 != "public" && $6 != "drizzle" && $6 != "pgboss" { bad=1 } END { exit bad }' "$tmp/toc" || fail
awk '/^[^;].* FUNCTION public maildock_search_/ { print $0 }' "$tmp/toc" > "$tmp/functions"
[ "$(wc -l < "$tmp/functions")" -eq 2 ] || fail
grep -Eq '^[0-9]+; [0-9]+ [0-9]+ FUNCTION public maildock_search_addresses\(jsonb\) [^ ]+$' "$tmp/functions" || fail
grep -Eq '^[0-9]+; [0-9]+ [0-9]+ FUNCTION public maildock_search_vector\(text, jsonb, jsonb, jsonb, jsonb, text\) [^ ]+$' "$tmp/functions" || fail
awk '/^[^;].* TABLE public / { print $6 }' "$tmp/toc" | sort > "$tmp/tables"
stage=archive_tables
archive_family=legacy
if ! cmp -s "$tmp/tables" "$resources/legacy-tables.txt"; then
  cmp -s "$tmp/tables" "$resources/native-tables.txt" || fail
  archive_family=native
fi
pg_restore --no-owner --no-acl --schema-only --use-list="$tmp/functions" --file="$tmp/functions.sql" "$2" 2> "$tmp/error" || fail
# Match the reviewed entire function definitions, including bodies/properties.
stage=function_definitions
awk '/^CREATE FUNCTION / { active=1 } active { sub(/\r$/, ""); print } active && /^\$\$;/ { active=0 }' "$tmp/functions.sql" > "$tmp/definitions"
cmp -s "$tmp/definitions" "$resources/$archive_family-functions.sql" || fail
pg_restore --data-only --table=__drizzle_migrations --file="$tmp/migrations.sql" "$2" 2> "$tmp/error" || fail
stage=archive_migrations
awk '/^COPY drizzle.__drizzle_migrations / { active=1; next } active && /^\\\.$/ {active=0; next} active { if(NF != 3) exit 1; print $2 "\t" $3 }' "$tmp/migrations.sql" > "$tmp/migrations" || fail
# Exact complete baseline histories from the deployed image and the LF checkout.
# Never accept per-row alternatives, normalize hashes, or edit archive contents.
if ! cmp -s "$tmp/migrations" "$resources/$archive_family-migrations.txt"; then
  cmp -s "$tmp/migrations" "$resources/$archive_family-migrations-lf.txt" || fail
fi
# The preflight checks actual ordinary authority and rejects any destination
# application storage. A failed import leaves the two predefinitions behind.
stage=destination
psql -X -v ON_ERROR_STOP=1 -f "$resources/restore-preflight.sql" > "$tmp/result" 2> "$tmp/error" || fail
psql -X -v ON_ERROR_STOP=1 -f "$resources/search-functions.sql" > "$tmp/result" 2> "$tmp/error" || fail
stage=restore
awk '!/^[^;].* FUNCTION public maildock_search_addresses\(jsonb\) / && !/^[^;].* FUNCTION public maildock_search_vector\(text, jsonb, jsonb, jsonb, jsonb, text\) /' "$tmp/toc" > "$tmp/restore-list"
pg_restore --dbname="$PGDATABASE" --no-owner --no-acl --exit-on-error --single-transaction --use-list="$tmp/restore-list" "$2" > "$tmp/result" 2> "$tmp/error" || fail
printf '%s\n' 'recovery_archive_restored: Run matching migrations and offline security maintenance before starting writers.' >&2

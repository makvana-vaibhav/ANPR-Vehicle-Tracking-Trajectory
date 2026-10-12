#!/bin/bash
# ══════════════════════════════════════════════════════════════════════
#  Contrail backups — the database and the object store, verified.
#
#    scripts/backup.sh backup                 → backups/<UTC timestamp>/
#    scripts/backup.sh verify  backups/<ts>   → restore into a throwaway
#                                               Postgres and count rows
#    scripts/backup.sh restore backups/<ts>   → restore INTO THE RUNNING STACK
#
#  (`make backup`, `make backup-verify BACKUP=…`, `make restore BACKUP=…`.)
#
#  What a backup holds:
#    postgres.dump    pg_dump custom format (-Fc) of the whole database:
#                     registry, detections, alerts, watchlists, users, audit
#    minio/<bucket>/  every object in the crop bucket and the private persons
#                     bucket, mirrored with the MinIO client
#    manifest.json    when, what code, what schema, row and object counts,
#                     the dump's sha256, and what verify found
#
#  What it does not hold, deliberately: the Redis stream (events in flight;
#  a restored platform re-reads nothing, and edge workers spool through an
#  outage), the OpenSearch index (nothing is indexed into it), and video
#  (the platform records none).
#
#  This is personal data — plate histories and faces. Encrypt it before it
#  leaves this machine; see docs/INFRASTRUCTURE.md §8.4.
#
#  Written for the bash 3.2 that macOS ships: no associative arrays, no
#  coproc. Secrets are read from .env into this process's environment and
#  handed to containers by NAME (`docker run -e VAR`), so a value never
#  appears on a command line, in `ps`, or in output.
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TIMESCALE_IMAGE="timescale/timescaledb-ha:pg16.14-ts2.29.2-all"
MINIO_IMAGE="minio/minio:RELEASE.2025-09-07T16-13-09Z"
NETWORK="contrail-net"
KEY_TABLES="cameras detections alerts watchlist person_watchlist users audit_log camera_health vehicle_tracks"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }
die() { red "✗ $*" >&2; exit 1; }

# ── configuration, from .env with the compose defaults ────────────────
envval() {
    # envval KEY DEFAULT — the value .env gives KEY, parsed the way compose
    # reads it (inline comments and surrounding quotes stripped), else DEFAULT.
    local key="$1" default="$2" line value
    line=""
    if [ -f "$REPO/.env" ]; then
        line="$(grep -E "^${key}=" "$REPO/.env" | tail -n 1 || true)"
    fi
    if [ -z "$line" ]; then
        printf '%s' "$default"
        return
    fi
    value="${line#*=}"
    value="$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
    printf '%s' "${value:-$default}"
}

PG_DB="$(envval POSTGRES_DB nagarnetra)"
PG_USER="$(envval POSTGRES_USER nagarnetra)"
BUCKETS="$(envval MINIO_BUCKET nagarnetra-media) $(envval MINIO_PERSONS_BUCKET nagarnetra-persons)"
MINIO_ROOT_USER="$(envval MINIO_ROOT_USER nagarnetra)"
MINIO_ROOT_PASSWORD="$(envval MINIO_ROOT_PASSWORD nagarnetra_dev_pw)"
export MINIO_ROOT_USER MINIO_ROOT_PASSWORD

compose() { docker compose "$@"; }
psql_live() { compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -At -v ON_ERROR_STOP=1 "$@"; }

sha256_of() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
    else sha256sum "$1" | awk '{print $1}'; fi
}

# Row counts of the key tables that exist, as "table count" lines.
COUNT_SQL="SELECT t || ' ' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', t), false, true, '')))[1]::text FROM unnest(string_to_array('$(echo $KEY_TABLES)', ' ')) AS t WHERE to_regclass(t) IS NOT NULL ORDER BY t"

manifest_get() {  # manifest_get DIR python-expression-on-m
    python3 -c "import json,sys; m=json.load(open(sys.argv[1]+'/manifest.json')); print($2)" "$1"
}

# ── restore a dump into a Postgres container ──────────────────────────
# The one restore path: `verify` runs it against a throwaway container and
# `restore` against the live one, so what verify proves is what restore does.
# TimescaleDB's documented procedure: create the extension, pre_restore,
# pg_restore, post_restore. Ownership is not restored (--no-owner): objects
# belong to the role doing the restore, which on the live stack is the same
# role that owned them.
BENIGN_RESTORE_ERRORS='extension "timescaledb" already exists|COMMENT ON EXTENSION|must be owner of extension|schema "public" already exists|errors ignored on restore|pg_restore: error: could not execute query: $|Command was:|^$|^pg_restore: warning:|^WARNING:|^HINT:|^DETAIL:|^CONTEXT:|timescaledb_information|_timescaledb_|circular foreign-key'
restore_into() {  # restore_into CONTAINER ROLE DATABASE DUMPFILE LOGFILE
    local container="$1" role="$2" db="$3" dump="$4" log="$5" status=0
    docker exec -i "$container" psql -U "$role" -d "$db" -v ON_ERROR_STOP=1 -q \
        -c "CREATE EXTENSION IF NOT EXISTS timescaledb" \
        -c "SELECT timescaledb_pre_restore()" >/dev/null
    docker exec -i "$container" pg_restore -U "$role" -d "$db" --no-owner --no-privileges \
        < "$dump" > "$log" 2>&1 || status=$?
    docker exec -i "$container" psql -U "$role" -d "$db" -v ON_ERROR_STOP=1 -q \
        -c "SELECT timescaledb_post_restore()" >/dev/null
    if [ "$status" -ne 0 ]; then
        # pg_restore exits non-zero for any error, including the ones the
        # procedure above produces by design. Fail only on the others.
        local unexpected
        unexpected="$(grep -v -E "$BENIGN_RESTORE_ERRORS" "$log" | grep -E 'error|ERROR' || true)"
        if [ -n "$unexpected" ]; then
            red "pg_restore reported errors that are not part of the TimescaleDB procedure:"
            printf '%s\n' "$unexpected" | head -20
            return 1
        fi
    fi
    return 0
}

# ── mirror backed-up buckets into an object store ─────────────────────
mirror_into() {  # mirror_into BACKUP_DIR ENDPOINT_URL
    local dir="$1" endpoint="$2"
    docker run --rm --network "$NETWORK" -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD \
        -e DST="$endpoint" -e BUCKETS="$BUCKETS" -v "$REPO/$dir/minio:/backup:ro" \
        --entrypoint sh "$MINIO_IMAGE" -c '
            set -e
            mc alias set dst "$DST" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
            for b in $BUCKETS; do
                [ -d "/backup/$b" ] || continue
                mc mb --ignore-existing "dst/$b" >/dev/null
                mc mirror --quiet --overwrite "/backup/$b" "dst/$b" >/dev/null
                echo "$b $(mc ls --recursive "dst/$b" | wc -l)"
            done'
}

# ══════════════════════════════════════════════════════════════════════
cmd_backup() {
    compose ps --status running --services 2>/dev/null | grep -qx postgres \
        || die "postgres is not running — start the stack first (make up)"
    local ts dir started
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    dir="backups/$ts"
    mkdir -p "$dir/minio"
    chmod 700 "$dir"
    started="$(date +%s)"
    echo "Backing up to $dir"

    psql_live -c "$COUNT_SQL" > "$dir/.counts_before"
    dim "  pg_dump (custom format)…"
    compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" -Fc \
        > "$dir/postgres.dump" 2> "$dir/pg_dump.log" \
        || { cat "$dir/pg_dump.log" >&2; die "pg_dump failed"; }
    psql_live -c "$COUNT_SQL" > "$dir/.counts_after"
    local dumped
    dumped="$(date +%s)"

    dim "  mirroring buckets: $BUCKETS…"
    docker run --rm --network "$NETWORK" -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD \
        -e BUCKETS="$BUCKETS" -v "$REPO/$dir/minio:/backup" \
        --entrypoint sh "$MINIO_IMAGE" -c '
            set -e
            mc alias set src http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
            for b in $BUCKETS; do
                mkdir -p "/backup/$b"
                if mc ls "src/$b" >/dev/null 2>&1; then
                    mc mirror --quiet --overwrite "src/$b" "/backup/$b" >/dev/null
                fi
            done'
    local mirrored
    mirrored="$(date +%s)"

    local alembic tsdb commit
    alembic="$(psql_live -c "SELECT version_num FROM alembic_version" 2>/dev/null || echo unknown)"
    tsdb="$(psql_live -c "SELECT extversion FROM pg_extension WHERE extname='timescaledb'")"
    commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    [ -n "$(git status --porcelain 2>/dev/null | head -1)" ] && commit="$commit+dirty"

    python3 - "$dir" "$ts" "$commit" "$alembic" "$tsdb" "$TIMESCALE_IMAGE" "$MINIO_IMAGE" \
        "$(sha256_of "$dir/postgres.dump")" "$((dumped - started))" "$((mirrored - dumped))" "$BUCKETS" <<'PY'
import json, os, sys
d, ts, commit, alembic, tsdb, pg_image, minio_image, sha, dump_s, mirror_s, buckets = sys.argv[1:12]
def counts(name):
    out = {}
    for line in open(os.path.join(d, name)).read().split("\n"):
        if line.strip():
            table, count = line.rsplit(" ", 1)
            out[table] = int(count)
    return out
objects = {}
for b in buckets.split():
    n = size = 0
    for root, _, files in os.walk(os.path.join(d, "minio", b)):
        for f in files:
            n += 1
            size += os.path.getsize(os.path.join(root, f))
    objects[b] = {"objects": n, "bytes": size}
manifest = {
    "created_utc": ts,
    "git_commit": commit,
    "alembic_revision": alembic.strip(),
    "timescaledb_version": tsdb.strip(),
    "images": {"postgres": pg_image, "minio_client": minio_image},
    "postgres_dump": {
        "file": "postgres.dump",
        "format": "pg_dump custom (-Fc)",
        "bytes": os.path.getsize(os.path.join(d, "postgres.dump")),
        "sha256": sha,
        "seconds": int(dump_s),
    },
    "rows_live_before_dump": counts(".counts_before"),
    "rows_live_after_dump": counts(".counts_after"),
    "minio": {"seconds": int(mirror_s), "buckets": objects},
    "verified": None,
}
json.dump(manifest, open(os.path.join(d, "manifest.json"), "w"), indent=2)
PY
    rm -f "$dir/.counts_before" "$dir/.counts_after"
    chmod -R go-rwx "$dir"
    green "✓ backup written: $dir ($(du -sh "$dir" | awk '{print $1}'), dump $((dumped - started)) s, objects $((mirrored - dumped)) s)"
    cmd_verify "$dir"
}

# ══════════════════════════════════════════════════════════════════════
cmd_verify() {
    local dir="${1:?usage: backup.sh verify backups/<timestamp>}"
    dir="${dir%/}"
    [ -f "$dir/manifest.json" ] && [ -f "$dir/postgres.dump" ] || die "$dir is not a backup"
    echo "Verifying $dir"

    local want got
    want="$(manifest_get "$dir" "m['postgres_dump']['sha256']")"
    got="$(sha256_of "$dir/postgres.dump")"
    [ "$want" = "$got" ] || die "postgres.dump sha256 mismatch (manifest $want, file $got)"
    dim "  sha256 ok"

    local name started
    name="contrail-backuptest-pg-$$-$RANDOM"
    # No network at all: the throwaway is reached only through `docker exec`.
    docker run -d --rm --name "$name" --network none \
        -e POSTGRES_USER="$PG_USER" -e POSTGRES_DB="$PG_DB" -e POSTGRES_PASSWORD=verify-only \
        "$TIMESCALE_IMAGE" >/dev/null
    # shellcheck disable=SC2064
    trap "docker rm -f -v '$name' >/dev/null 2>&1 || true" EXIT INT TERM
    started="$(date +%s)"
    local i
    for i in $(seq 1 90); do
        # The image restarts the server once after initdb; wait for the real one.
        if docker exec "$name" psql -U "$PG_USER" -d "$PG_DB" -Atc "SELECT 1" >/dev/null 2>&1 \
            && docker exec "$name" sh -c 'test -f "$PGDATA/postmaster.pid"' 2>/dev/null \
            && [ "$(docker logs "$name" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ]; then
            break
        fi
        sleep 1
    done
    dim "  throwaway Postgres up ($name, no network)"

    restore_into "$name" "$PG_USER" "$PG_DB" "$dir/postgres.dump" "$dir/verify_restore.log" \
        || die "restore into the throwaway failed — see $dir/verify_restore.log"
    local restored_s
    restored_s="$(( $(date +%s) - started ))"
    docker exec "$name" psql -U "$PG_USER" -d "$PG_DB" -At -c "$COUNT_SQL" > "$dir/.counts_restored"

    python3 - "$dir" "$restored_s" <<'PY'
import json, os, sys, datetime
d, seconds = sys.argv[1], int(sys.argv[2])
path = os.path.join(d, "manifest.json")
m = json.load(open(path))
restored = {}
for line in open(os.path.join(d, ".counts_restored")).read().split("\n"):
    if line.strip():
        t, c = line.rsplit(" ", 1)
        restored[t] = int(c)
before, after = m["rows_live_before_dump"], m["rows_live_after_dump"]
ok, rows = True, []
for table in sorted(set(before) | set(restored)):
    b, a, r = before.get(table), after.get(table), restored.get(table)
    lo, hi = min(b or 0, a or 0), max(b or 0, a or 0)
    if r is None:
        verdict, ok = "MISSING", False
    elif (b or a) and r == 0:
        verdict, ok = "EMPTY", False
    elif lo <= r <= hi:
        verdict = "ok"
    else:
        verdict = "drift"  # rows changed while the dump ran (deletes); reported, not fatal
    rows.append((table, b, a, r, verdict))
print(f"  {'table':<18}{'live before':>13}{'live after':>12}{'restored':>10}  verdict")
for t, b, a, r, v in rows:
    print(f"  {t:<18}{b if b is not None else '-':>13}{a if a is not None else '-':>12}{r if r is not None else '-':>10}  {v}")
m["verified"] = {
    "at_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
    "ok": ok,
    "restore_seconds": seconds,
    "rows_restored": restored,
}
json.dump(m, open(path, "w"), indent=2)
sys.exit(0 if ok else 1)
PY
    local verdict=$?
    rm -f "$dir/.counts_restored"
    docker rm -f -v "$name" >/dev/null 2>&1 || true
    trap - EXIT INT TERM
    [ "$verdict" -eq 0 ] || die "verify FAILED for $dir"
    green "✓ verified: $dir restores cleanly into $TIMESCALE_IMAGE (${restored_s} s)"
}

# ══════════════════════════════════════════════════════════════════════
cmd_restore() {
    local dir="${1:?usage: backup.sh restore backups/<timestamp>}"
    dir="${dir%/}"
    [ -f "$dir/manifest.json" ] && [ -f "$dir/postgres.dump" ] || die "$dir is not a backup"
    local want got
    want="$(manifest_get "$dir" "m['postgres_dump']['sha256']")"
    got="$(sha256_of "$dir/postgres.dump")"
    [ "$want" = "$got" ] || die "postgres.dump sha256 mismatch — refusing to restore a damaged backup"
    compose ps --status running --services 2>/dev/null | grep -qx postgres \
        || die "postgres is not running — start the stack first (make up)"

    local live backed verified
    live="$(psql_live -c "$COUNT_SQL" | tr '\n' ' ')"
    backed="$(manifest_get "$dir" "' '.join(f'{k} {v}' for k, v in sorted(m['rows_live_after_dump'].items()))")"
    verified="$(manifest_get "$dir" "(m.get('verified') or {}).get('ok')")"

    printf '\n\033[1;41;97m  DESTRUCTIVE: RESTORE INTO THE RUNNING STACK  \033[0m\n\n'
    red "  This DROPS the live database \"$PG_DB\" and replaces it with $dir."
    red "  Every detection, alert, watchlist change, user and audit row written"
    red "  since $(manifest_get "$dir" "m['created_utc']") is LOST."
    echo
    echo "  live now      : $live"
    echo "  in the backup : $backed"
    echo "  backup verified by restore: $verified"
    echo "  buckets       : $BUCKETS — objects are copied back over (additive: objects"
    echo "                  created since the backup are kept, not deleted)"
    echo "  stopped       : api, ingest (and consumer replicas) for the duration."
    echo "                  AI workers keep running; their events queue in the Redis"
    echo "                  stream and are consumed when the API is back."
    echo
    if [ "${DRY_RUN:-0}" = "1" ]; then
        green "DRY RUN — preconditions hold (backup intact, postgres up). Nothing was changed."
        return 0
    fi
    local answer="${CONFIRM:-}"
    if [ -z "$answer" ]; then
        if [ ! -t 0 ]; then die "not a terminal: pass CONFIRM=$PG_DB to confirm"; fi
        printf '  Type the database name (%s) to proceed: ' "$PG_DB"
        read -r answer
    fi
    [ "$answer" = "$PG_DB" ] || die "confirmation did not match — nothing was changed"

    local writers
    writers="api ingest $(compose ps --services 2>/dev/null | grep -x consumer || true)"
    echo "Stopping writers: $writers"
    # shellcheck disable=SC2086
    compose stop $writers
    psql_postgres() { compose exec -T postgres psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
    psql_postgres -c "DROP DATABASE IF EXISTS \"$PG_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$PG_DB\""
    local container
    container="$(compose ps -q postgres)"
    restore_into "$container" "$PG_USER" "$PG_DB" "$dir/postgres.dump" "$dir/restore.log" \
        || die "database restore failed — see $dir/restore.log; api/ingest are left STOPPED"
    green "✓ database restored"
    echo "Copying objects back:"
    mirror_into "$dir" "http://minio:9000" | sed 's/^/  /'
    echo "Starting writers again"
    # shellcheck disable=SC2086
    compose up -d --no-deps $writers
    green "✓ restore complete — check \`make status\` and the command centre"
}

case "${1:-}" in
    backup) cmd_backup ;;
    verify) shift; cmd_verify "$@" ;;
    restore) shift; cmd_restore "$@" ;;
    _mirror-into) shift; mirror_into "$@" ;;  # restore drills against a throwaway MinIO
    *) echo "usage: scripts/backup.sh backup | verify <dir> | restore <dir>" >&2; exit 2 ;;
esac

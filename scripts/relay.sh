#!/usr/bin/env bash
# scripts/relay.sh - Run the blind mailbox relay locally (ADR-0028)
# Usage: ./scripts/relay.sh [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

case "${1:-}" in
    "")
        ;;
    --help)
        cat << EOF
Usage: $(basename "$0") [--help]

Run the relay (reconcile.relay.app) on 127.0.0.1 with one Uvicorn worker.
Nothing is logged: access logs, proxy headers and the Server header are off.

ENVIRONMENT:
    RECONCILE_RELAY_PORT          Port to listen on (default 8787)
    RECONCILE_RELAY_DB            SQLite file, relative to the project root
                                  (default .relay-data/relay.db, gitignored)
    RECONCILE_RELAY_MAX_DB_BYTES  Refuse PUTs above this size (default 1 GiB)

--no-proxy-headers matters: Uvicorn otherwise trusts X-Forwarded-For from
127.0.0.1, which is where a reverse proxy on the same host connects from.

Delete expired blobs with: python -m reconcile.relay.purge
EOF
        exit 0
        ;;
    *)
        echo "Error: Unknown option: $1" >&2
        exit 2
        ;;
esac

cd "$PROJECT_ROOT"

export RECONCILE_RELAY_DB="${RECONCILE_RELAY_DB:-.relay-data/relay.db}"

# Only this user may read the database, its WAL or the directory holding them.
umask 077
mkdir -p "$(dirname "$RECONCILE_RELAY_DB")"

exec python -m uvicorn reconcile.relay.app:create_app --factory \
    --host 127.0.0.1 --port "${RECONCILE_RELAY_PORT:-8787}" \
    --no-access-log --no-proxy-headers --no-server-header

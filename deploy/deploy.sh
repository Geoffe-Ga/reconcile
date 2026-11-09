#!/usr/bin/env bash
# deploy/deploy.sh - Deploy the app and the relay to the one VM.
#
# The founder runs this from their own machine: there are no CI deploys and
# no deploy key in GitHub (ADR-0041, ADR-0073). It reads
# RECONCILE_DEPLOY_HOST (an SSH destination, such as deploy@<vm>) and
# RECONCILE_SITE (the domain) from the environment, or else from the
# gitignored deploy/.env. Then it:
#   1. builds the client (npm ci, npm run build);
#   2. syncs client/dist to /srv/reconcile/app/, and the relay (reconcile/,
#      requirements.txt, the units and the Caddyfile) to /opt/reconcile/src/.
#      It never touches /var/lib/reconcile, where the database lives;
#   3. installs requirements.txt into /opt/reconcile/venv and validates the
#      Caddyfile with the VM's Caddy, then, with sudo, installs the units, the
#      Caddyfile at /etc/caddy/Caddyfile and a caddy.service drop-in that
#      sets RECONCILE_SITE;
#   4. restarts caddy and reconcile-relay (`admin off` disables `caddy
#      reload`), enables the purge timer, and runs deploy/smoke.sh against
#      https://$RECONCILE_SITE.
# It exits non-zero if any step or the smoke test fails.
#
# deploy/README.md has the one-time VM setup this assumes.
#
# Usage: deploy/deploy.sh [--help]

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$DEPLOY_DIR")"
APP_DIR=/srv/reconcile/app
SRC_DIR=/opt/reconcile/src
VENV=/opt/reconcile/venv
UNITS=(reconcile-relay.service reconcile-purge.service reconcile-purge.timer)
# The first deploy waits for Caddy to get its certificate.
READY_SECONDS=120

case "${1:-}" in
    "") ;;
    --help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Error: Unknown option: $1" >&2; exit 2 ;;
esac

die() {
    echo "deploy: $*" >&2
    exit 1
}

# Read the two settings from deploy/.env, for any the environment didn't set.
# The file is parsed, never sourced, so it can't run anything.
load_env_file() {
    local file="$DEPLOY_DIR/.env" line key value
    [[ -f "$file" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
        [[ "$line" =~ ^(export[[:space:]]+)?([A-Z_]+)=(.*)$ ]] ||
            die "deploy/.env: expected NAME=value, got: $line"
        key="${BASH_REMATCH[2]}"
        value="${BASH_REMATCH[3]}"
        if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
            value="${BASH_REMATCH[1]}"
        fi
        case "$key" in
            RECONCILE_DEPLOY_HOST | RECONCILE_SITE)
                if [[ -z "${!key:-}" ]]; then
                    printf -v "$key" '%s' "$value"
                fi
                ;;
            *) die "deploy/.env: unknown setting $key" ;;
        esac
    done < "$file"
}

# Both values end up in ssh arguments and a systemd drop-in: allow no
# quotes, spaces, leading dashes or anything else a shell would act on.
check_settings() {
    [[ -n "${RECONCILE_DEPLOY_HOST:-}" ]] ||
        die "set RECONCILE_DEPLOY_HOST (deploy@<vm>) in the environment or deploy/.env."
    [[ -n "${RECONCILE_SITE:-}" ]] ||
        die "set RECONCILE_SITE (the domain) in the environment or deploy/.env."
    [[ "$RECONCILE_DEPLOY_HOST" =~ ^[A-Za-z0-9_][A-Za-z0-9_.@-]*$ ]] ||
        die "RECONCILE_DEPLOY_HOST must be user@host or an SSH alias."
    local label='[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?'
    [[ "$RECONCILE_SITE" =~ ^$label(\.$label)+$ ]] ||
        die "RECONCILE_SITE must be a domain name, without a scheme, port or path."
}

for tool in npm rsync ssh curl base64; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool isn't on PATH."
done
load_env_file
check_settings
host="$RECONCILE_DEPLOY_HOST"
site="$RECONCILE_SITE"

# run_on_vm SUDO FUNCTION ARGS...: run FUNCTION from this file on the VM,
# under sudo when SUDO is "sudo". The function travels base64-encoded and is
# read by bash from a pipe, so the VM's login shell never parses it, and
# sudo can still ask for a password on the terminal (ssh -t).
run_on_vm() {
    local sudo=$1 fn=$2 encoded arg args=""
    local ssh=(ssh)
    shift 2
    for arg in "$@"; do
        [[ "$arg" != *"'"* ]] || die "can't pass a quote to the VM: $arg"
        args+=" '$arg'"
    done
    if [[ -n "$sudo" ]]; then
        ssh+=(-t)
    fi
    encoded="$( { declare -f "$fn"; echo "$fn \"\$@\""; } | base64 | tr -d '\n')"
    "${ssh[@]}" "$host" "printf %s $encoded | base64 -d | ${sudo:+$sudo }bash -s --$args"
}

# On the VM, as the deploy user: dependencies, then the VM's own Caddy
# validates the Caddyfile before anything is restarted.
prepare_on_vm() {
    set -euo pipefail
    local venv=$1 src=$2 site=$3 out
    "$venv/bin/pip" install --quiet --disable-pip-version-check \
        -r "$src/requirements.txt"
    out="$(RECONCILE_SITE="$site" caddy validate --adapter caddyfile \
        --config "$src/deploy/Caddyfile" 2>&1)" || {
        printf '%s\n' "$out" >&2
        exit 1
    }
}

# On the VM, as root: install the units and the Caddyfile, then restart.
install_on_vm() {
    set -euo pipefail
    local src=$1 site=$2 unit
    shift 2
    for unit in "$@"; do
        install -m 0644 "$src/deploy/$unit" "/etc/systemd/system/$unit"
    done
    install -m 0644 "$src/deploy/Caddyfile" /etc/caddy/Caddyfile
    install -d -m 0755 /etc/systemd/system/caddy.service.d
    printf '[Service]\nEnvironment=RECONCILE_SITE=%s\n' "$site" \
        > /etc/systemd/system/caddy.service.d/reconcile.conf
    systemctl daemon-reload
    systemctl enable --quiet reconcile-relay.service reconcile-purge.timer
    systemctl restart caddy.service reconcile-relay.service
    systemctl start reconcile-purge.timer
}

revision="$(git -C "$PROJECT_ROOT" describe --always --dirty 2>/dev/null || echo unknown)"
echo "deploy: $revision to $site"

# 1. Build.
npm --prefix "$PROJECT_ROOT/client" ci --no-audit --no-fund --loglevel=error
npm --prefix "$PROJECT_ROOT/client" run build --silent
[[ -f "$PROJECT_ROOT/client/dist/index.html" ]] || die "the build left no client/dist/index.html."
summary="built client"

# 2. Sync. Caddy and the reconcile user only read these, so make them readable
# whatever the local umask; neither can write them.
SYNC=(rsync -rlptz --delete "--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r")
"${SYNC[@]}" "$PROJECT_ROOT/client/dist/" "$host:$APP_DIR/"
units=()
for unit in "${UNITS[@]}"; do
    units+=("deploy/$unit")
done
(cd "$PROJECT_ROOT" && "${SYNC[@]}" --relative --exclude __pycache__ \
    reconcile requirements.txt deploy/Caddyfile "${units[@]}" "$host:$SRC_DIR/")
summary+=" · synced"

# 3 and 4. Install and restart.
run_on_vm "" prepare_on_vm "$VENV" "$SRC_DIR" "$site"
run_on_vm sudo install_on_vm "$SRC_DIR" "$site" "${UNITS[@]}"
echo "$summary · restarted reconcile-relay"

deadline=$((SECONDS + READY_SECONDS))
until curl -sf --max-time 5 -o /dev/null "https://$site/v1/health" ||
    ((SECONDS >= deadline)); do
    sleep 1
done
"$DEPLOY_DIR/smoke.sh" "https://$site"

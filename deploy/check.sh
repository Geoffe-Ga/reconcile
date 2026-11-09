#!/usr/bin/env bash
# deploy/check.sh - Validate the deploy config without a VM (CI's deploy job).
#
#   1. caddy validate: the Caddyfile adapts and provisions, with
#      RECONCILE_SITE=localhost:8443.
#   2. The adapted config keeps the privacy settings: the admin API is off,
#      and the only logger is the default one, writing to discard.
#   3. systemd-analyze verify: the three units, in a temp root holding the
#      system's own units and a stub at each ExecStart binary (verify refuses
#      a missing one). Any output fails: verify exits 0 on an unknown key or
#      an unparsable value, which systemd would then ignore.
#   4. client/vite.config.ts serves the Caddyfile's CSP under vite preview.
#
# Needs caddy and systemd-analyze on PATH (Linux; see deploy/README.md).
# ./scripts/check-all.sh runs this whenever deploy/ changes.
#
# Usage: deploy/check.sh [--verbose] [--help]

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$DEPLOY_DIR")"
UNITS=(reconcile-relay.service reconcile-purge.service reconcile-purge.timer)
# What the README's one-time setup and requirements.txt put in the venv.
EXECUTABLES=(/opt/reconcile/venv/bin/uvicorn /opt/reconcile/venv/bin/python)
SYSTEM_UNITS=/usr/lib/systemd/system
TEST_SITE=localhost:8443

VERBOSE=false
for arg in "$@"; do
    case "$arg" in
        --verbose) VERBOSE=true ;;
        --help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Error: Unknown option: $arg" >&2; exit 2 ;;
    esac
done

for tool in caddy systemd-analyze; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "deploy/check.sh needs $tool on PATH (see deploy/README.md)." >&2
        exit 2
    fi
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failed=0

# Each check below returns non-zero itself: bash clears `set -e` inside the
# command substitution that runs it.

# Caddy with its storage (the local CA validate provisions) in the temp dir.
caddy_here() {
    RECONCILE_SITE="$TEST_SITE" XDG_DATA_HOME="$work/data" \
        XDG_CONFIG_HOME="$work/config" caddy "$@"
}

validate_caddyfile() {
    caddy_here validate --adapter caddyfile --config "$DEPLOY_DIR/Caddyfile"
}

# Fail unless the adapted JSON contains $2; $3 says what it means.
expect_json() {
    if [[ "$1" != *"$2"* ]]; then
        echo "The adapted Caddyfile must contain $2 ($3)."
        return 1
    fi
}

check_privacy_settings() {
    local json status=0
    json="$(caddy_here adapt --adapter caddyfile --config "$DEPLOY_DIR/Caddyfile")" || return 1
    expect_json "$json" '"admin":{"disabled":true}' "admin off" || status=1
    # Exactly this: a site `log`, a second logger or a level would change it.
    expect_json "$json" '"logging":{"logs":{"default":{"writer":{"output":"discard"}}}}' \
        "one logger, the default, writing to discard" || status=1
    return "$status"
}

verify_units() {
    local root="$work/root" exe unit out
    local paths=()
    if [[ ! -d "$SYSTEM_UNITS" ]]; then
        echo "No $SYSTEM_UNITS here: systemd-analyze verify needs the system's units."
        return 1
    fi
    mkdir -p "$root/etc/systemd/system" "$root/usr/lib/systemd" || return 1
    cp -R "$SYSTEM_UNITS" "$root/usr/lib/systemd/" || return 1
    for exe in "${EXECUTABLES[@]}"; do
        mkdir -p "$root$(dirname "$exe")" || return 1
        printf '#!/bin/sh\nexit 0\n' > "$root$exe" || return 1
        chmod 755 "$root$exe" || return 1
    done
    for unit in "${UNITS[@]}"; do
        cp "$DEPLOY_DIR/$unit" "$root/etc/systemd/system/$unit" || return 1
        paths+=("$root/etc/systemd/system/$unit")
    done
    out="$(systemd-analyze verify --root="$root" "${paths[@]}" 2>&1)" || {
        printf '%s\n' "$out"
        return 1
    }
    if [[ -n "$out" ]]; then
        printf '%s\n' "$out"
        echo "systemd-analyze verify warned: systemd would ignore that setting."
        return 1
    fi
}

check_preview_csp() {
    local csp
    csp="$(sed -n 's/^[[:space:]]*Content-Security-Policy "\(.*\)"$/\1/p' "$DEPLOY_DIR/Caddyfile")"
    if [[ -z "$csp" || "$csp" == *$'\n'* ]]; then
        echo "deploy/Caddyfile must set one Content-Security-Policy header."
        return 1
    fi
    if ! grep -qF "\"$csp\"" "$PROJECT_ROOT/client/vite.config.ts"; then
        echo "client/vite.config.ts must serve the Caddyfile's CSP under preview.headers:"
        echo "  $csp"
        return 1
    fi
}

# report NAME: the verdict on the check that just ran, from $status and $out.
# Its output shows when it failed, or with --verbose.
report() {
    if [[ "$status" == 0 ]]; then
        echo "✓ $1"
        if $VERBOSE && [[ -n "$out" ]]; then
            printf '%s\n' "$out"
        fi
    else
        echo "✗ $1"
        printf '%s\n' "$out"
        failed=1
    fi
}

status=0
out="$(validate_caddyfile 2>&1)" || status=$?
report "caddy validate (deploy/Caddyfile)"

status=0
out="$(check_privacy_settings 2>&1)" || status=$?
report "Caddy keeps admin off and discards every log"

status=0
out="$(verify_units 2>&1)" || status=$?
report "systemd-analyze verify (${UNITS[*]})"

status=0
out="$(check_preview_csp 2>&1)" || status=$?
report "vite preview serves the Caddyfile's CSP"

exit "$failed"

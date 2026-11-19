#!/usr/bin/env bash
# scripts/models.sh - Fetch the Bedfellows model's files into client/.models/ (#476).
#
# The model and its tokenizer are too large for git. This fetches each file
# src/net/modelPins.ts serves (SERVED_FILES: the embedder's, and a stance
# model's once one is pinned) from its source, a Hugging Face URL at a fixed
# revision, checks its size and SHA-256, and only then moves it into
# client/.models/, where the build (plugins/modelFiles.ts) reads it. A file
# already there with the right hash isn't fetched again. The runtime's
# WebAssembly comes from npm (package-lock.json), so it isn't fetched here.
#
# The founder runs this before a deploy (deploy/deploy.sh does it). CI never
# does: its builds and tests run without the model, on the stand-ins.
#
# Usage: scripts/models.sh [--help]
set -euo pipefail
cd "$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"

case "${1:-}" in
    "") ;;
    --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Error: Unknown option: $1" >&2; exit 2 ;;
esac

for tool in node curl sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || { echo "✗ $tool isn't on PATH." >&2; exit 1; }
done

# One line per pinned file with an https source: file, sha256, bytes, source.
pins="$(node --input-type=module -e "
import { SERVED_FILES } from './src/net/modelPins.ts';
for (const pin of SERVED_FILES) {
  if (pin.source.startsWith('https://')) console.log([pin.file, pin.sha256, pin.bytes, pin.source].join(' '));
}")"

mkdir -p .models
status=0
while read -r file sha bytes source; do
    target=".models/$file"
    if [[ -f "$target" ]] && sha256sum "$target" | grep -q "^$sha "; then
        echo "✓ $file is here and matches its pin"
        continue
    fi
    part="$target.part"
    echo "Fetching $file"
    if ! curl -fsSL --proto '=https' --proto-redir '=https' --retry 2 -o "$part" "$source"; then
        echo "✗ couldn't fetch $source" >&2
        rm -f "$part"
        status=1
        continue
    fi
    got_bytes="$(wc -c < "$part" | tr -d ' ')"
    if [[ "$got_bytes" != "$bytes" ]] || ! sha256sum "$part" | grep -q "^$sha "; then
        echo "✗ $file doesn't match its pin (got $got_bytes bytes); it was not kept" >&2
        rm -f "$part"
        status=1
        continue
    fi
    mv "$part" "$target"
    echo "✓ $file fetched and matches its pin"
done <<< "$pins"
exit "$status"

#!/usr/bin/env bash
# Runs every check that can execute in this environment.
set -euo pipefail

# Resolve the project root from this script's location.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BIN="$ROOT/node_modules/.bin"

echo "== typecheck =="
"$BIN/tsc" --noEmit

echo "== frontend build =="
"$BIN/vite" build >/dev/null

echo "== rust unit tests =="
bash "$ROOT/scripts/test-rust.sh"

echo "== browser visual check =="
node "$ROOT/test/visual-check.mjs"

echo
echo "all checks passed"

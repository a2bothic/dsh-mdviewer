#!/usr/bin/env bash
# Runs the Rust unit tests for the filesystem/search logic.
#
# `cargo test` on the full crate needs the GTK/WebKit system libraries that
# Tauri links against, which are not always installed (and cannot be installed
# without root here). The logic under test does not touch Tauri at all, so this
# extracts it into a scratch crate with only serde + walkdir and runs the tests
# there. The tests themselves are the ones shipped in src-tauri/src/lib.rs, so a
# regression in the real source still fails.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found - skipping rust tests"
  exit 0
fi

SRC="$ROOT/src-tauri/src/lib.rs"
SCRATCH="${TMPDIR:-/tmp}/mdviewer-rustcheck"

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/src"

cat > "$SCRATCH/Cargo.toml" <<'EOF'
[package]
name = "mdviewer-logic"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
walkdir = "2"
EOF

# Strip the Tauri-only attribute, the pick_folder command (which needs
# tauri::AppHandle) and the run() harness; keep everything else verbatim.
python3 - "$SRC" "$SCRATCH/src/lib.rs" <<'PY'
import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
out = src.replace("#[tauri::command]\n", "")
out = re.sub(r"/// Open a folder picker[\s\S]*?\n}\n", "", out)
out = re.sub(r"#\[cfg_attr\(mobile[\s\S]*?\n\}\n", "", out)
pathlib.Path(sys.argv[2]).write_text(out, encoding="utf-8")
PY

cd "$SCRATCH"
cargo test --quiet 2>&1 | grep -vE '^\s*$' | tail -20

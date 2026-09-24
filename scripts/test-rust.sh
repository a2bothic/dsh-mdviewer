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

# Strip anything that depends on the tauri crate, since this scratch crate has
# no GUI dependencies. Items are matched by name (not by surrounding comments)
# so the extraction cannot silently drift when the file is edited.
python3 - "$SRC" "$SCRATCH/src/lib.rs" <<'PY'
import sys, pathlib

src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
lines = src.split("\n")
out, i = [], 0

TAURI_FNS = {"pick_folder", "take_pending_open", "emit_open_file",
             "document_from_args"}

while i < len(lines):
    line = lines[i]
    stripped = line.strip()

    # Drop the `use tauri...` imports.
    if stripped.startswith("use tauri"):
        i += 1
        continue

    # Drop the attribute that only exists with the tauri crate.
    if stripped == "#[tauri::command]":
        i += 1
        continue

    # Drop a tauri-dependent fn together with its doc comment / attributes.
    if stripped.startswith(("fn ", "async fn ", "pub fn ", "pub async fn ")):
        name = stripped.split("fn ", 1)[1].split("(")[0].strip()
        if name in TAURI_FNS:
            # Walk back over the attribute/doc lines already emitted.
            while out and out[-1].strip().startswith(("///", "#[")):
                out.pop()
            depth = 0
            while i < len(lines):
                depth += lines[i].count("{") - lines[i].count("}")
                i += 1
                if depth == 0 and lines[i - 1].strip().endswith("}"):
                    break
            continue

    # Drop the PendingOpen struct and everything from the mobile entry point on.
    if stripped.startswith("struct PendingOpen") or stripped.startswith("#[cfg_attr(mobile"):
        while out and out[-1].strip().startswith(("///", "#[")):
            out.pop()
        depth = 0
        while i < len(lines):
            depth += lines[i].count("{") - lines[i].count("}")
            i += 1
            if depth <= 0 and lines[i - 1].strip().endswith("}"):
                break
        continue

    out.append(line)
    i += 1

pathlib.Path(sys.argv[2]).write_text("\n".join(out), encoding="utf-8")
PY
cd "$SCRATCH"
cargo test --quiet 2>&1 | grep -vE '^\s*$' | tail -20

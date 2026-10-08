# Contributing

**English** | [中文](CONTRIBUTING.zh.md)

## The rule: every change ends with a local reinstall

**Any change to this project must be rebuilt and reinstalled on this machine
before the work is considered done.** A passing test suite is not the finish
line — the install step is.

The reason is that the automated suites do **not** exercise the real runtime:

| Suite | What it actually runs |
|---|---|
| `test/visual-check.mjs` | The production **bundle** in Chromium, with a **mocked** Tauri bridge |
| `test/open-external.mjs` | Same — a mocked bridge, including the drag-drop and second-launch paths |
| `cargo test` | Rust logic only; no window, no webview, no IPC |

So these suites cannot catch a regression in the parts that only exist in the
shipped binary: the real IPC surface, plugin wiring, window creation, file
associations, single-instance forwarding, or WebView2 behaviour. Those have
regressed silently before while every check stayed green. A reinstall and a
launch is the only thing that proves the app a user double-clicks still works.

### The finish checklist

Run every step. Do not report the work as complete while any step is unrun.

1. **Typecheck and unit tests**

   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   node_modules\.bin\tsc.cmd --noEmit
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

2. **Browser suites** (needs a preview server on port 4173)

   ```powershell
   node_modules\.bin\vite.cmd preview --port 4173 --strictPort   # background
   $env:MDREADER_HEADLESS_OLD = "1"
   node test/visual-check.mjs
   node test/open-external.mjs
   ```

3. **Build the installers**

   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   node_modules\.bin\tauri.cmd build
   ```

4. **Reinstall on this machine** — non-negotiable, and it must be the artifact
   just built, not the one already on disk.

   ```powershell
   Get-Process -Name dsh-mdviewer -ErrorAction SilentlyContinue | Stop-Process -Force
   $setup = Get-ChildItem "src-tauri\target\release\bundle\nsis\*-setup.exe" |
     Sort-Object LastWriteTime -Descending | Select-Object -First 1
   Start-Process $setup.FullName -ArgumentList "/S" -Wait
   ```

   The installer exits immediately on success, so do not trust its exit code —
   confirm the installed exe was actually refreshed:

   ```powershell
   Get-ChildItem "$env:LOCALAPPDATA\Markdown Viewer" |
     Select-Object Name, LastWriteTime
   ```

   **Do not compare hashes against `target/release/dsh-mdviewer.exe`.** Tauri
   stamps each bundle with its type, so the standalone exe and the installed one
   differ by a few bytes on purpose: the standalone binary reads `UNK`
   (unknown), an NSIS install reads `NSS`. Sizes match; only that marker
   differs, roughly 230 KB before the end of the file.

   Confirm the marker instead of the hash:

   ```powershell
   $exe = "$env:LOCALAPPDATA\Markdown Viewer\dsh-mdviewer.exe"
   $b = [System.IO.File]::ReadAllBytes($exe)
   $start = $b.Length - 300000
   for ($i = $start; $i -lt $b.Length - 2; $i++) {
     if ($b[$i] -eq 0x4E -and $b[$i+1] -eq 0x53 -and $b[$i+2] -eq 0x53) {
       "NSIS install confirmed"; break
     }
   }
   ```

   Note that an installer of the **same version** may decline to overwrite an
   install it considers identical, so a timestamp that does *not* move is not by
   itself proof of failure. If you need certainty, check the marker, or bump the
   version in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.

5. **Launch and exercise the change**

   ```powershell
   Start-Process "$env:LOCALAPPDATA\Markdown Viewer\dsh-mdviewer.exe"
   ```

   Open whatever the change touched and look at it. For a file-format change,
   open a real file of that type; for a UI change, look at the window.

6. **Clean up** — stop the app and the preview server, and delete temporary
   fixtures and screenshots.

### If the change affects what the program accepts or how it looks

Also update, in the same change:

- `README.md` and `README.zh.md` (both, or the pair drifts)
- `src-tauri/tauri.conf.json` `fileAssociations`, when a newly accepted
  extension should also be openable from Explorer
- `test/visual-check.mjs`, so the new behaviour is covered by a regression test

## Windows file associations and the installer

Two rules keep "Open with" from listing this app twice.

**Never register the app by hand.** Pointing Windows at a portable exe (or any
copy outside the install directory) adds a second entry under
`HKCU\Software\Classes\Applications`, and Explorer then offers two identical
icons for the same program. If that has already happened, remove the key and
drop its letter from the `.sh` `OpenWithList` `MRUList` value.

**Let the installer own the association.** `bundle.fileAssociations` registers
one progid per group in the config; adding a second group that overlaps an
extension already claimed (for example putting `sh` in both "Shell Script" and
a catch-all "Source File") registers two progids for one extension.

The install mode matters for upgrades. `bundle.windows.nsis.installMode` is
`currentUser`, and `src-tauri/nsis/hooks.nsh` runs in `NSIS_HOOK_PREINSTALL` to
uninstall any previous copy — from `HKCU`, from `HKLM`, and leftover files in
the install directory — before writing new ones. That hook is why an upgrade
replaces the old version instead of sitting beside it. If you change the
install directory, install mode, or product name, re-check the hook: it keys off
`${PRODUCTNAME}` and `$INSTDIR`.

## Windows notes

Two things bite on a fresh Windows machine, neither of which is a code problem:

1. **`cargo` must be on `PATH`.** Tauri shells out to `cargo metadata`, and the
   rustup installer does not always add `%USERPROFILE%\.cargo\bin` to the
   environment of every shell. If the build fails with

   ```
   failed to run 'cargo metadata' ... program not found
   ```

   prepend the directory for that session:

   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   ```

2. **`bundle.targets` must be `"all"`, not an explicit cross-platform list.**
   Naming `dmg`, `deb`, or `appimage` while building on Windows makes Tauri
   abort the whole bundle step.

3. **A stale crates.io mirror breaks dependency resolution.** `cargo` reads
   `%USERPROFILE%\.cargo\config.toml`. If it replaces crates.io with a mirror,
   that mirror can lag behind on Tauri plugins, and the update then fails with
   `no matching package named ... found`. Point at crates.io directly when this
   happens:

   ```toml
   [net]
   git-fetch-with-cli = true
   ```

4. **`pnpm` may refuse to run build scripts** (`ERR_PNPM_IGNORED_BUILDS` for
   `esbuild`). It does not block `vite build` or `tauri build`; invoking the
   binaries in `node_modules\.bin` directly sidesteps it.

## Building on other platforms

To build a **Windows** binary you must run the build on Windows; cross-compiling
a Tauri app from WSL needs the MSVC toolchain and is not supported out of the
box.

; NSIS installer hooks for dsh-mdviewer.
;
; Why this exists: the default Tauri installer only prompts to remove a previous
; version when it can SEE one — it keys off its own uninstall metadata. Two
; situations slip past that and leave two copies of the app registered, which
; is what makes Windows offer the same program twice in "Open with":
;
;   1. A previous install whose registry entry was left behind or written by a
;      differently-named build (for example a portable exe registered by hand).
;   2. A per-machine (HKLM) install being replaced by a per-user (HKCU) one,
;      because the two live in different registry hives.
;
; pre-install runs after the installer has unpacked itself but before it writes
; any files, so removing a stale copy here is safe and always wins.

!macro NSIS_HOOK_PREINSTALL
  ; Remove a previous per-user install recorded under HKCU.
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}" "UninstallString"
  StrCmp $R0 "" check_hklm
    DetailPrint "Removing the previous version..."
    ; The uninstaller is a separate process and cannot delete itself in place,
    ; so it is copied out and run from there with _?= to keep it quiet.
    CopyFiles /SILENT "$R0" "$TEMP\dsh-mdviewer-uninstall.exe"
    ExecWait '"$TEMP\dsh-mdviewer-uninstall.exe" /S _?=$INSTDIR'
    Delete "$TEMP\dsh-mdviewer-uninstall.exe"
    Goto check_appdir

  check_hklm:
  ; Remove a previous per-machine install recorded under HKLM.
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}" "UninstallString"
  StrCmp $R0 "" check_appdir
    DetailPrint "Removing the previous machine-wide version..."
    CopyFiles /SILENT "$R0" "$TEMP\dsh-mdviewer-uninstall.exe"
    ExecWait '"$TEMP\dsh-mdviewer-uninstall.exe" /S _?=$INSTDIR'
    Delete "$TEMP\dsh-mdviewer-uninstall.exe"

  check_appdir:
  ; Whatever the registry said, do not install on top of stray leftover files.
  ; This is what a hand-registered portable build leaves behind.
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 done
    DetailPrint "Removing leftover files from a previous copy..."
    Delete "$INSTDIR\${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\uninstall.exe"
    RMDir /r "$INSTDIR"

  done:
!macroend

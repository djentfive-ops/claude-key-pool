; OVIS Gate(오비스 게이트) — 한 번 누르면 설치되고 바로 켜지는 설치 파일
Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!define APPNAME "OVIS Gate"
!define OLDNAME "Claude 키 묶음"   ; 1.5.0 까지의 이름 — 바로 가기 정리용
!define EXE "ClaudeKeyPool.exe"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClaudeKeyPool"
!ifndef VERSION
  !define VERSION "1.6.0"
!endif

Name "${APPNAME}"
OutFile "dist/ClaudeKeyPool-Setup.exe"
Icon "core/assets/icon.ico"
UninstallIcon "core/assets/icon.ico"
InstallDir "$LOCALAPPDATA\Programs\ClaudeKeyPool"
RequestExecutionLevel user
ShowInstDetails nevershow
ShowUninstDetails nevershow
AutoCloseWindow true
BrandingText "OVIS Studio"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1042 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=1042 "FileDescription" "${APPNAME} 설치"
VIAddVersionKey /LANG=1042 "CompanyName" "OVIS Studio"
VIAddVersionKey /LANG=1042 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1042 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1042 "LegalCopyright" "OVIS Studio"

LoadLanguageFile "${NSISDIR}\Contrib\Language files\Korean.nlf"

Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "install"
  ; 켜져 있는 이전 버전을 먼저 끈다(업데이트 설치)
  nsExec::Exec 'taskkill /IM ${EXE} /F'
  Sleep 800
  SetOutPath "$INSTDIR"
  File /r "dist/win-unpacked/*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  Delete "$DESKTOP\${OLDNAME}.lnk"
  Delete "$SMPROGRAMS\${OLDNAME}.lnk"

  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  CreateShortCut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0

  WriteRegStr HKCU "${REGKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "OVIS Studio"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1

  ; 설치가 끝나면 바로 켠다
  Exec '"$INSTDIR\${EXE}"'
SectionEnd

Section "uninstall"
  nsExec::Exec 'taskkill /IM ${EXE} /F'
  Sleep 800
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ClaudeKeyPool"
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${OLDNAME}.lnk"
  Delete "$SMPROGRAMS\${OLDNAME}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${REGKEY}"
  ; 저장된 키(%APPDATA%\Claude 키 묶음 — 이름을 바꿔도 폴더는 그대로)는 남겨 둔다 — 다시 설치하면 그대로 이어진다
SectionEnd

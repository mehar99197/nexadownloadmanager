!include "MUI2.nsh"
Name "Nexa Download Manager"
OutFile "NexaSetup.exe"
Unicode True
InstallDir "$PROGRAMFILES64\Nexa Download Manager"
RequestExecutionLevel admin
!define MUI_ABORTWARNING
!define MUI_ICON "assets\nexa.ico"
!define MUI_UNICON "assets\nexa.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "assets\nexa-header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "assets\nexa-header.bmp"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
; NOTE: no MUI_FINISHPAGE_RUN. This installer is elevated (admin), so a
; finish-page launch would start nexa.exe at admin integrity. That nexa
; would create the "nexa-ipc" named pipe with a per-user (admin) DACL, and
; the browser-spawned nexa-host.exe (running as the normal logged-in user)
; could not connect to it. Let the user launch via the shortcut instead;
; the host also launches nexa.exe on demand, both at the correct integrity.
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  ; A previous install (or the background-autostart instance) may still be
  ; running and holding its own DLLs open, which turns every subsequent
  ; File /r into an "Error opening file for writing" prompt. Close it first.
  DetailPrint "Closing any running Nexa instance..."
  nsExec::Exec 'taskkill /IM nexa.exe /F'
  nsExec::Exec 'taskkill /IM nexa-host.exe /F'
  Sleep 500
  SetOutPath "$INSTDIR"
  ; Write to the native 64-bit registry view. makensis produces a 32-bit
  ; installer; without this, HKLM\Software\* writes are redirected into
  ; HKLM\Software\WOW6432Node\* — where 64-bit Chrome/Edge/Brave never look,
  ; so the native host would be invisible even though the keys "exist".
  SetRegView 64
  File /r "dist\*"
  ; Write native messaging host manifest
  FileOpen $0 "$INSTDIR\manifest_template.json" r
  FileOpen $1 "$INSTDIR\com.nexa.host.json" w
  loop:
    FileRead $0 $2
    IfErrors done
    FileWrite $1 $2
    Goto loop
  done:
  FileClose $0
  FileClose $1
  Delete "$INSTDIR\manifest_template.json"
  ; Register the native host MACHINE-WIDE (HKLM), for Chrome, Chromium,
  ; Edge, Brave. This installer is elevated and installs to Program Files,
  ; so HKLM is the correct, all-users hive — and crucially it is the hive
  ; the logged-in account Chrome actually reads. Writing HKCU from an
  ; elevated installer lands in the admin hive, invisible to the real
  ; user, which is why the extension reported "native host not found".
  WriteRegStr HKLM "Software\Google\Chrome\NativeMessagingHosts\com.nexa.host" "" "$INSTDIR\com.nexa.host.json"
  WriteRegStr HKLM "Software\Chromium\NativeMessagingHosts\com.nexa.host" "" "$INSTDIR\com.nexa.host.json"
  WriteRegStr HKLM "Software\Microsoft\Edge\NativeMessagingHosts\com.nexa.host" "" "$INSTDIR\com.nexa.host.json"
  WriteRegStr HKLM "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.nexa.host" "" "$INSTDIR\com.nexa.host.json"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "NexaDL" "$\"$INSTDIR\nexa.exe$\" --background"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexaDL" "DisplayName" "Nexa Download Manager"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexaDL" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexaDL" "DisplayIcon" "$INSTDIR\nexa.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Nexa Download Manager"
  CreateShortCut "$SMPROGRAMS\Nexa Download Manager\Nexa.lnk" "$INSTDIR\nexa.exe"
  CreateShortCut "$DESKTOP\Nexa Download Manager.lnk" "$INSTDIR\nexa.exe"
SectionEnd

Section "Uninstall"
  ; Same reasoning as the install section: a running instance holds its own
  ; DLLs/exe open, which would make RMDir "$INSTDIR" fail to remove them.
  DetailPrint "Closing any running Nexa instance..."
  nsExec::Exec 'taskkill /IM nexa.exe /F'
  nsExec::Exec 'taskkill /IM nexa-host.exe /F'
  Sleep 500
  ; Must match the install view (64-bit) and hive (HKLM) used above,
  ; otherwise these deletes target the wrong, empty keys and leave the
  ; real registrations behind.
  SetRegView 64
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "NexaDL"
  DeleteRegKey HKLM "Software\Google\Chrome\NativeMessagingHosts\com.nexa.host"
  DeleteRegKey HKLM "Software\Chromium\NativeMessagingHosts\com.nexa.host"
  DeleteRegKey HKLM "Software\Microsoft\Edge\NativeMessagingHosts\com.nexa.host"
  DeleteRegKey HKLM "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.nexa.host"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexaDL"
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\Nexa Download Manager.lnk"
  RMDir /r "$SMPROGRAMS\Nexa Download Manager"
SectionEnd

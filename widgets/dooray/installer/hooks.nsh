; Dooray widget installer hooks (tools/widget-kit/installer.nsi includes this file).
;
; The Dooray widget replaces the old standalone app "Dooray Widget" (1.0.x). On install, that app
; is removed silently while its data is kept: the Desk Widgets engine copied %APPDATA%\dooray-widget
; into this widget's settings folder on its first start (engine/main/migrate.js). The old
; uninstaller also removes its startup entry and shortcuts.

; Uninstall entry of the old app: electron-builder names it after UUIDv5(appId "com.cap577.dooray-widget").
!define LEGACY_GUID "e01d85e0-c5c1-5d10-ba55-c37e20b55007"
!define LEGACY_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${LEGACY_GUID}"
!define LEGACY_UNINSTALLER "Uninstall Dooray Widget.exe"

; $R7 old install folder
!macro removeLegacyDoorayApp ROOT MODE
  ReadRegStr $R6 ${ROOT} "${LEGACY_UNINSTALL_KEY}" "UninstallString"
  ${If} $R6 != ""
    ReadRegStr $R7 ${ROOT} "Software\${LEGACY_GUID}" "InstallLocation"
    ${If} $R7 != ""
    ${AndIf} ${FileExists} "$R7\${LEGACY_UNINSTALLER}"
      DetailPrint "이전 앱(Dooray Widget) 제거 중: $R7 (설정은 유지)"
      ; Run a copy so the old folder can be removed; _? makes ExecWait wait for it.
      CopyFiles /SILENT "$R7\${LEGACY_UNINSTALLER}" "$PLUGINSDIR\legacy-uninstaller.exe"
      ExecWait '"$PLUGINSDIR\legacy-uninstaller.exe" /S /KEEP_APP_DATA ${MODE} _?=$R7'
      Delete "$R7\${LEGACY_UNINSTALLER}"
      RMDir "$R7"
    ${EndIf}
  ${EndIf}
!macroend

!macro widgetPreInstall
  InitPluginsDir
  !insertmacro removeLegacyDoorayApp HKLM "/allusers"
  !insertmacro removeLegacyDoorayApp HKCU "/currentuser"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.cap577.dooray-widget"
!macroend

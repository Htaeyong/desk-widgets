; Custom NSIS steps for the Desk Widgets engine installer (electron-builder; UTF-8 with BOM).
;
; The engine ships no widgets. Widgets have their own installers (tools/widget-kit) and go to the
; widgets folder next to the engine folder: C:\Program Files\chilgong88\widgets\<id>\. Engine
; updates and uninstalls replace or remove only the engine folder, so installed widgets stay.
; (The old "Dooray Widget" app is removed by the Dooray widget's installer, not here.)
;
; On install: create the widgets folder (admin-only, like Program Files).
; On a real uninstall (not an update):
;  - remove the "launch at Windows startup" entries (new and old app)
;  - ask whether to delete the user's settings (%APPDATA%\chilgong88\desk-widgets: engine settings
;    and every widget's settings). The old app's folder %APPDATA%\dooray-widget is NEVER deleted:
;    it is the migration backup, and a reinstall copies it in again (#36).
;    Default and silent uninstall keep them. "/S --delete-app-data" deletes them without asking
;    (handled here: electron-builder's own option deletes the product-name folder instead).
;  - remove the widgets folder only if no widget is left in it (widgets have their own uninstallers)

!macro customInstall
  ${GetParent} "$INSTDIR" $0
  CreateDirectory "$0\widgets"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.chilgong88.desk-widgets"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.cap577.dooray-widget"

    ; $R2: "delete" when --delete-app-data is given or the user answers Yes; otherwise keep.
    StrCpy $R2 "keep"
    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "--delete-app-data" $R1
    ${ifNot} ${Errors}
      StrCpy $R2 "delete"
    ${else}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "사용자 설정도 함께 삭제할까요?$\n$\nDesk Widgets 설정과 모든 위젯의 설정(두레이 주소·API 토큰, 분류, 조건 알림, 창 위치 등)$\n$\n[예]  설정 삭제 — 다시 설치하면 처음부터 설정합니다.$\n[아니요]  설정 유지 — 다시 설치하면 기존 설정을 그대로 사용합니다.$\n$\n설치한 위젯은 제어판에서 따로 제거합니다." /SD IDNO IDNO +2
      StrCpy $R2 "delete"
    ${endIf}

    ${if} $R2 == "delete"
      ; Settings live in the uninstalling user's own AppData, also for an all-users install.
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}
      RMDir /r "$APPDATA\chilgong88\desk-widgets"
      RMDir "$APPDATA\chilgong88"
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    ${endIf}

    ; Only empty folders go: installed widgets keep their own uninstallers.
    ${GetParent} "$INSTDIR" $0
    RMDir "$0\widgets"
    RMDir "$0"
  ${endIf}
!macroend

; Desk Widgets widget installer template (UTF-8 with BOM for the Korean text).
; Built by tools/widget-kit/build.js, which passes:
;   WIDGET_ID, WIDGET_NAME, PRODUCT_NAME, VERSION, VI_VERSION, PKG_DIR, OUT_FILE, ENGINE_GUID, [HOOKS]
;
; Install: needs the Desk Widgets engine (installed for all users); copies the widget package to
; <engine folder>\..\widgets\<id>\ (widget.json last, so the engine never sees half a package),
; registers "Desk Widgets-<PRODUCT_NAME>" in Control Panel and tells the running engine (or starts
; it) with --widget-installed=<id>: the widget turns on and opens its setup if it needs one.
; Uninstall: removes the package (the engine notices and stops the widget) and asks whether to
; delete this widget's settings (%APPDATA%\chilgong88\desk-widgets\widgets\<id>); silent keeps them,
; "/S --delete-app-data" deletes them.
; Hooks (optional, from the widget): !macro widgetPreInstall / widgetPostInstall / widgetUninstall

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel admin

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "StdUtils.nsh"

!define DISPLAY_NAME "Desk Widgets-${PRODUCT_NAME}"
!define PUBLISHER "chilgong88"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeskWidgets-${WIDGET_ID}"
!define ENGINE_KEY "Software\${ENGINE_GUID}"
!define ENGINE_EXE "Desk Widgets.exe"

!ifdef HOOKS
  !include "${HOOKS}"
!endif

Name "${DISPLAY_NAME}"
Caption "${DISPLAY_NAME} ${VERSION} 설치"
OutFile "${OUT_FILE}"
InstallDir "$PROGRAMFILES64\chilgong88\widgets\${WIDGET_ID}"
ShowInstDetails show
ShowUninstDetails show
BrandingText "Desk Widgets"

Var EngineDir

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_TEXT "${WIDGET_NAME} 위젯을 설치했습니다.$\r$\n$\r$\nDesk Widgets에서 바로 시작됩니다. 설정이 필요한 위젯은 설정 창이 열립니다."
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"

VIProductVersion "${VI_VERSION}"
VIAddVersionKey /LANG=${LANG_KOREAN} "ProductName" "${DISPLAY_NAME}"
VIAddVersionKey /LANG=${LANG_KOREAN} "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=${LANG_KOREAN} "LegalCopyright" "${PUBLISHER}"
VIAddVersionKey /LANG=${LANG_KOREAN} "FileDescription" "${DISPLAY_NAME} 설치"
VIAddVersionKey /LANG=${LANG_KOREAN} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_KOREAN} "ProductVersion" "${VERSION}"

Function .onInit
  SetRegView 64
  ; The engine installer writes its folder here (electron-builder, all-users install).
  ReadRegStr $EngineDir HKLM "${ENGINE_KEY}" "InstallLocation"
  ${If} $EngineDir == ""
  ${OrIfNot} ${FileExists} "$EngineDir\${ENGINE_EXE}"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Desk Widgets가 설치되어 있지 않습니다.$\r$\n$\r$\n${WIDGET_NAME} 위젯은 Desk Widgets 위에서 동작합니다. 먼저 Desk Widgets(DeskWidgets-Setup)를 설치한 뒤 이 설치 파일을 다시 실행하세요." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ; Widgets live next to the engine folder: <...>\chilgong88\widgets\<id>
  ${GetParent} "$EngineDir" $0
  StrCpy $INSTDIR "$0\widgets\${WIDGET_ID}"
FunctionEnd

Section "Install"
  SetShellVarContext all
  !ifmacrodef widgetPreInstall
    !insertmacro widgetPreInstall
  !endif

  ; Replace an older version: widget.json goes first (the engine drops the widget), then the rest.
  Delete "$INSTDIR\widget.json"
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /r /x widget.json "${PKG_DIR}\*.*"
  ; widget.json last: the engine loads the widget once it appears.
  File "${PKG_DIR}\widget.json"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${DISPLAY_NAME}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$EngineDir\${ENGINE_EXE},0"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "EstimatedSize" $0

  !ifmacrodef widgetPostInstall
    !insertmacro widgetPostInstall
  !endif

  ; Tell Desk Widgets as the signed-in user (not as administrator); starts it if it is not running.
  ${StdUtils.ExecShellAsUser} $0 "$EngineDir\${ENGINE_EXE}" "open" "--widget-installed=${WIDGET_ID}"
SectionEnd

Function un.onInit
  SetRegView 64
FunctionEnd

Section "Uninstall"
  SetShellVarContext all
  !ifmacrodef widgetUninstall
    !insertmacro widgetUninstall
  !endif

  ; widget.json first: the engine stops the widget, then the files go.
  Delete "$INSTDIR\widget.json"
  Sleep 500
  RMDir /r "$INSTDIR"
  ${GetParent} "$INSTDIR" $0
  RMDir "$0"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"

  ; This widget's settings: keep (default, silent) or delete.
  StrCpy $R2 "keep"
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    StrCpy $R2 "delete"
  ${Else}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "${WIDGET_NAME} 위젯의 설정도 함께 삭제할까요?$\r$\n$\r$\n[예]  설정 삭제 — 다시 설치하면 처음부터 설정합니다.$\r$\n[아니요]  설정 유지 — 다시 설치하면 기존 설정을 그대로 사용합니다." /SD IDNO IDNO +2
    StrCpy $R2 "delete"
  ${EndIf}
  ${If} $R2 == "delete"
    SetShellVarContext current
    RMDir /r "$APPDATA\chilgong88\desk-widgets\widgets\${WIDGET_ID}"
    SetShellVarContext all
  ${EndIf}
SectionEnd

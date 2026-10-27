; NSIS hooks for the Windows installer (bundle.windows.nsis.installerHooks).
;
; The bundled node.exe can still be running when an install or update starts:
; a shell that was force-closed — which is how the installer and the updater
; close it — never ran its exit handler, so the Node sidecar outlived it
; (builds before 0.9.0; the shell now ties it to a kill-on-close job). A
; running .exe cannot be overwritten, and the install stops at "Error opening
; file for writing: ...\node.exe".
;
; Windows does let a running executable be *renamed*, so the old one is moved
; aside and deleted — now if it has exited, at the next reboot if it has not —
; and the new node.exe is written to a free path. Nothing is killed: the
; installer cannot tell our node.exe from anyone else's by name, and a hook
; that shells out to terminate processes is exactly what antivirus heuristics
; flag an installer for.

!include LogicLib.nsh

!macro AGENT_UI_MOVE_ASIDE_NODE
  Delete "$INSTDIR\node.exe.old"
  Delete "$INSTDIR\node.exe.old2"
  ${If} ${FileExists} "$INSTDIR\node.exe"
    ClearErrors
    Delete "$INSTDIR\node.exe"
    ${If} ${Errors}
      ClearErrors
      Rename "$INSTDIR\node.exe" "$INSTDIR\node.exe.old"
      ${If} ${Errors}
        Rename "$INSTDIR\node.exe" "$INSTDIR\node.exe.old2"
        Delete /REBOOTOK "$INSTDIR\node.exe.old2"
      ${Else}
        Delete /REBOOTOK "$INSTDIR\node.exe.old"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AGENT_UI_MOVE_ASIDE_NODE
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete /REBOOTOK "$INSTDIR\node.exe.old"
  Delete /REBOOTOK "$INSTDIR\node.exe.old2"
!macroend

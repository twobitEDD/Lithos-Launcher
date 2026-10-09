; Replaces electron-builder's "close the running app" step. Its default terminates Lithos Launcher
; after about a second, and on Windows that also terminates the Ergo node the launcher started (it
; runs in the launcher's job object), so the node's next start spends hours restoring its state.
; Here the running launcher is asked to quit first: it stops the miner, the Lithos Client and the
; node through the node's API, then exits. Only then does the default step run, for what is left
; (the background SOAT service, whose miner has nothing to lose).

!include "getProcessInfo.nsh"
Var pid

; $R0 = 0 while the main launcher (not the SOAT service, not an Electron helper) is running.
!macro LITHOS_FIND_LAUNCHER _RETURN
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -C "if (@(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') -and -not ($$_.CommandLine -match '--soat|--type=')}).Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop ${_RETURN}
  ${else}
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" ${_RETURN}
  ${endIf}
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro LITHOS_FIND_LAUNCHER $R0
  ${if} $R0 == 0
    DetailPrint "Asking Lithos Launcher to stop the Ergo node safely (up to 4 minutes)..."
    Exec `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --lithos-quit-for-update`
    lithosWaitAgain:
    StrCpy $R1 0
    lithosWait:
      Sleep 2000
      IntOp $R1 $R1 + 2
      !insertmacro LITHOS_FIND_LAUNCHER $R0
      ${if} $R0 != 0
        Goto lithosStopped
      ${endIf}
      ${if} $R1 < 240
        Goto lithosWait
      ${endIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Lithos Launcher is still running.$\r$\n$\r$\nIn its window, press Quit and choose Stop and quit, so the Ergo node shuts down safely (this can take a couple of minutes). Then press Retry.$\r$\n$\r$\nCancel stops this installer; nothing is changed." /SD IDCANCEL IDRETRY lithosWaitAgain
    Quit
    lithosStopped:
    DetailPrint "Lithos Launcher stopped."
  ${endIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend

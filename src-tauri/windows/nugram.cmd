@echo off
rem Launcher shim so `nugram` returns the prompt in pwsh/nushell.
rem Those shells WaitForExit on the process they launch; a GUI-subsystem exe
rem invoked directly keeps them blocked until the window closes. Routing through
rem this .cmd (run under cmd.exe, which never waits for GUI apps) plus `start`
rem detaches the app so the terminal is freed immediately. Mirrors VS Code's
rem `code.cmd`. The exe itself is intentionally NOT on PATH (PATHEXT prefers .EXE
rem over .CMD) — only this bin dir is, so `nugram` resolves here. See main.wxs.
start "" "%~dp0..\nugram.exe" %*

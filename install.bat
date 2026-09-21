@echo off
rem Tokens UI For Codex - one-click installer launcher
rem Prefers PowerShell 7 (pwsh) and falls back to Windows PowerShell 5.1.
setlocal
chcp 65001 >nul
title Tokens UI For Codex - Install

set "PS_EXE=powershell.exe"
where pwsh.exe >nul 2>&1 && set "PS_EXE=pwsh.exe"

if not exist "%~dp0install.ps1" (
  echo [ERROR] install.ps1 not found next to install.bat
  echo [ERROR] Please extract the whole package folder and run again.
  echo.
  pause
  exit /b 1
)

echo Tokens UI For Codex installer
echo Using: %PS_EXE%
echo.

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
  echo [DONE] Installation finished.
) else (
  echo [FAILED] Exit code: %EXITCODE%
)
echo.
pause
exit /b %EXITCODE%

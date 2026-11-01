@echo off
setlocal
if "%~1"=="" (
  set /p "PluginRoot=Plugin deployment directory: "
) else (
  set "PluginRoot=%~1"
)
if not defined PluginRoot exit /b 2
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-rust-launcher.ps1" -PluginRoot "%PluginRoot%"
exit /b %ERRORLEVEL%

@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-and-package.ps1" %*
exit /b %ERRORLEVEL%

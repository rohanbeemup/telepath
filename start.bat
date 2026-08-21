@echo off
REM Double-click to start telepath. Closes when the daemon stops (Ctrl+C in the window).
powershell -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause

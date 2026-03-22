@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo ========================================
echo   DunCrew Desktop - Starting...
echo ========================================
echo.
REM Kill any existing process on port 5173
powershell -Command "Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
call npm run electron:dev
echo.
echo Process exited. Press any key to close.
pause >nul

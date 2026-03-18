@echo off
chcp 65001 >nul
title DunCrew - AI Operating System

echo.
echo  ╔══════════════════════════════════════════════════════════╗
echo  ║           DunCrew - AI Operating System                    ║
echo  ╚══════════════════════════════════════════════════════════╝
echo.

:: 设置数据目录
set DUNCREW_DATA_PATH=%USERPROFILE%\.duncrew

:: 检查 Python
where python >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Python not found. Please install Python 3.8+
    pause
    exit /b 1
)

:: 检查 Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found. Please install Node.js 18+
    pause
    exit /b 1
)

:: 创建数据目录
if not exist "%DUNCREW_DATA_PATH%" (
    echo [INFO] Creating data directory: %DUNCREW_DATA_PATH%
    mkdir "%DUNCREW_DATA_PATH%"
)

:: 迁移旧数据目录 (.ddos -> .duncrew)
if exist "%USERPROFILE%\.ddos" (
    if not exist "%DUNCREW_DATA_PATH%\skills" (
        echo [MIGRATE] Migrating data from .ddos to .duncrew...
        xcopy /E /I /Y "%USERPROFILE%\.ddos" "%DUNCREW_DATA_PATH%" >nul 2>nul
        echo [OK] Migration complete
    )
)

:: 复制内置技能到用户数据目录（首次运行或技能目录为空时）
set SCRIPT_DIR=%~dp0
if exist "%SCRIPT_DIR%skills" (
    if not exist "%DUNCREW_DATA_PATH%\skills" (
        echo [SETUP] Installing bundled skills to %DUNCREW_DATA_PATH%\skills...
        xcopy /E /I /Y "%SCRIPT_DIR%skills" "%DUNCREW_DATA_PATH%\skills" >nul 2>nul
        echo [OK] Skills installed
    )
)

:: 直接使用系统 Python
set PYTHON_CMD=python

:: 启动后端
echo [1/2] Starting backend server...
start "DunCrew Backend" cmd /k "%PYTHON_CMD% duncrew-server.py --path %DUNCREW_DATA_PATH% 2>&1 || echo [ERROR] Backend exited with error! && pause"

:: 等待后端启动
timeout /t 2 /nobreak >nul

:: 检查后端是否启动成功
curl -s http://localhost:3001/status >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] Backend may not be ready, waiting...
    timeout /t 3 /nobreak >nul
)

:: 启动前端
echo [2/2] Starting frontend server...
start "DunCrew Frontend" /min cmd /c "npm run dev 2>&1"

:: 等待前端启动
timeout /t 3 /nobreak >nul

echo.
echo  ╔══════════════════════════════════════════════════════════╗
echo  ║                  DunCrew is running!                       ║
echo  ╠══════════════════════════════════════════════════════════╣
echo  ║  Frontend: http://localhost:5173                           ║
echo  ║  Backend:  http://localhost:3001                           ║
echo  ║  Data:     %USERPROFILE%\.duncrew                          ║
echo  ╚══════════════════════════════════════════════════════════╝
echo.

:: 自动打开浏览器
start "" http://localhost:5173

echo Press any key to stop DunCrew...
pause >nul

:: 清理进程
echo.
echo [INFO] Stopping DunCrew...
taskkill /FI "WINDOWTITLE eq DunCrew Backend*" /F >nul 2>nul
taskkill /FI "WINDOWTITLE eq DunCrew Frontend*" /F >nul 2>nul
echo [INFO] DunCrew stopped.

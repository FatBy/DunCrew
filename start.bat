@echo off
chcp 65001 >nul
title DD-OS - AI Operating System

echo.
echo  ╔══════════════════════════════════════════════════════════╗
echo  ║              DD-OS - AI Operating System                  ║
echo  ╚══════════════════════════════════════════════════════════╝
echo.

:: 设置数据目录
set DDOS_DATA_PATH=%USERPROFILE%\.ddos

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
if not exist "%DDOS_DATA_PATH%" (
    echo [INFO] Creating data directory: %DDOS_DATA_PATH%
    mkdir "%DDOS_DATA_PATH%"
)

:: 复制内置技能到用户数据目录（首次运行或技能目录为空时）
set SCRIPT_DIR=%~dp0
if exist "%SCRIPT_DIR%skills" (
    if not exist "%DDOS_DATA_PATH%\skills" (
        echo [SETUP] Installing bundled skills to %DDOS_DATA_PATH%\skills...
        xcopy /E /I /Y "%SCRIPT_DIR%skills" "%DDOS_DATA_PATH%\skills" >nul 2>nul
        echo [OK] Skills installed
    )
)

:: 直接使用系统 Python
set PYTHON_CMD=python

:: 启动后端
echo [1/2] Starting backend server...
start "DD-OS Backend" cmd /k "%PYTHON_CMD% ddos-local-server.py --path %DDOS_DATA_PATH% 2>&1 || echo [ERROR] Backend exited with error! && pause"

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
start "DD-OS Frontend" /min cmd /c "npm run dev 2>&1"

:: 等待前端启动
timeout /t 3 /nobreak >nul

echo.
echo  ╔══════════════════════════════════════════════════════════╗
echo  ║                   DD-OS is running!                       ║
echo  ╠══════════════════════════════════════════════════════════╣
echo  ║  Frontend: http://localhost:5173                          ║
echo  ║  Backend:  http://localhost:3001                          ║
echo  ║  Data:     %USERPROFILE%\.ddos                            ║
echo  ╚══════════════════════════════════════════════════════════╝
echo.

:: 自动打开浏览器
start "" http://localhost:5173

echo Press any key to stop DD-OS...
pause >nul

:: 清理进程
echo.
echo [INFO] Stopping DD-OS...
taskkill /FI "WINDOWTITLE eq DD-OS Backend*" /F >nul 2>nul
taskkill /FI "WINDOWTITLE eq DD-OS Frontend*" /F >nul 2>nul
echo [INFO] DD-OS stopped.

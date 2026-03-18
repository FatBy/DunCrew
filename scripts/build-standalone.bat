@echo off
chcp 65001 >nul
echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║       DunCrew Standalone Build Script (Windows)            ║
echo ╚══════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0\.."

:: 检查 PyInstaller
where pyinstaller >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] Installing PyInstaller...
    pip install pyinstaller
)

:: 步骤 1: 构建前端
echo [1/4] Building frontend...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Frontend build failed!
    exit /b 1
)
echo [OK] Frontend built successfully.

:: 步骤 2: 类型检查
echo [2/4] Type checking...
call npx tsc --noEmit
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] Type check has warnings, continuing...
)

:: 步骤 3: PyInstaller 打包
echo [3/4] Packaging with PyInstaller...
pyinstaller duncrew-server.spec --clean --noconfirm
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] PyInstaller build failed!
    exit /b 1
)
echo [OK] PyInstaller build successful.

:: 步骤 4: 创建发布包
echo [4/4] Creating release package...

set RELEASE_DIR=release\duncrew-standalone
if exist "%RELEASE_DIR%" rmdir /s /q "%RELEASE_DIR%"
mkdir "%RELEASE_DIR%"

:: 复制可执行文件
xcopy /E /I /Y dist\duncrew-server "%RELEASE_DIR%\duncrew-server"

:: 复制启动脚本
copy start-standalone.bat "%RELEASE_DIR%\" >nul

:: 复制说明文件
echo DunCrew Standalone Edition > "%RELEASE_DIR%\README.txt"
echo. >> "%RELEASE_DIR%\README.txt"
echo Usage: >> "%RELEASE_DIR%\README.txt"
echo   1. Double-click start-standalone.bat >> "%RELEASE_DIR%\README.txt"
echo   2. Open http://localhost:3001 in your browser >> "%RELEASE_DIR%\README.txt"
echo. >> "%RELEASE_DIR%\README.txt"
echo Data directory: %%USERPROFILE%%\.duncrew >> "%RELEASE_DIR%\README.txt"

echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║                    Build Complete!                         ║
echo ╠══════════════════════════════════════════════════════════╣
echo ║  Output: release\duncrew-standalone\                       ║
echo ╚══════════════════════════════════════════════════════════╝
echo.

pause

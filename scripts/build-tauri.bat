@echo off
chcp 65001 >nul
echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║         DunCrew Tauri Desktop Build Script                 ║
echo ╚══════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0\.."

:: 检查 Rust
where cargo >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Rust not found. Please install Rust from https://rustup.rs
    echo [INFO] Run: winget install Rustlang.Rust.MSVC
    pause
    exit /b 1
)

:: 检查 PyInstaller
where pyinstaller >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] Installing PyInstaller...
    pip install pyinstaller
)

:: 步骤 1: 构建前端
echo [1/5] Building frontend...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Frontend build failed!
    exit /b 1
)
echo [OK] Frontend built.

:: 步骤 2: 打包 Python 后端
echo [2/5] Packaging Python backend with PyInstaller...
pyinstaller duncrew-server.spec --clean --noconfirm
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] PyInstaller build failed!
    exit /b 1
)
echo [OK] Backend packaged.

:: 步骤 3: 复制 Sidecar 到 Tauri
echo [3/5] Copying sidecar binary...
if not exist "src-tauri\binaries" mkdir "src-tauri\binaries"

:: 根据架构确定目标文件名
set TARGET=x86_64-pc-windows-msvc
copy /Y "dist\duncrew-server.exe" "src-tauri\binaries\duncrew-server-%TARGET%.exe"
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to copy sidecar binary!
    exit /b 1
)
echo [OK] Sidecar copied.

:: 步骤 4: Tauri 构建
echo [4/5] Building Tauri application...
call npm run tauri build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Tauri build failed!
    exit /b 1
)
echo [OK] Tauri built.

:: 步骤 5: 输出结果
echo [5/5] Build complete!
echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║                    Build Complete!                         ║
echo ╠══════════════════════════════════════════════════════════╣
echo ║  Installer: src-tauri\target\release\bundle\               ║
echo ╚══════════════════════════════════════════════════════════╝
echo.

:: 打开输出目录
explorer "src-tauri\target\release\bundle"

pause

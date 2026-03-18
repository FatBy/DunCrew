@echo off
chcp 65001 >nul
title DunCrew Docker Launcher

echo ==========================================
echo    DunCrew - AI Operating System
echo    Docker 一键启动脚本
echo ==========================================
echo.

:: 检查 Docker 是否安装
docker --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] 未检测到 Docker，请先安装 Docker Desktop
    echo.
    echo 下载地址: https://www.docker.com/products/docker-desktop/
    echo.
    pause
    exit /b 1
)

:: 检查 Docker 是否运行
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker 未运行，请先启动 Docker Desktop
    echo.
    pause
    exit /b 1
)

echo [INFO] Docker 已就绪
echo.

:: 检查是否需要构建镜像
docker images duncrew --format "{{.Repository}}" | findstr /C:"duncrew" >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] 首次运行，正在构建镜像（可能需要几分钟）...
    echo.
    docker-compose build
    if %errorlevel% neq 0 (
        echo [ERROR] 镜像构建失败
        pause
        exit /b 1
    )
    echo.
    echo [INFO] 镜像构建完成
    echo.
)

:: 启动服务
echo [INFO] 正在启动 DunCrew...
echo.
docker-compose up -d

if %errorlevel% neq 0 (
    echo [ERROR] 启动失败
    pause
    exit /b 1
)

echo.
echo ==========================================
echo    DunCrew 已启动！
echo.
echo    前端界面: http://localhost:4173
echo    后端 API: http://localhost:3001
echo.
echo    停止命令: docker-compose down
echo ==========================================
echo.

:: 自动打开浏览器
timeout /t 3 >nul
start http://localhost:4173

echo 按任意键关闭此窗口...
pause >nul

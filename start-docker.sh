#!/bin/bash
# DunCrew macOS/Linux Docker 一键启动脚本

set -e

echo "=========================================="
echo "   DunCrew - AI Operating System"
echo "   Docker 一键启动脚本"
echo "=========================================="
echo ""

# 检查 Docker 是否安装
if ! command -v docker &> /dev/null; then
    echo "[ERROR] 未检测到 Docker，请先安装 Docker Desktop"
    echo ""
    echo "macOS 下载: https://www.docker.com/products/docker-desktop/"
    echo "或使用 Homebrew: brew install --cask docker"
    echo ""
    exit 1
fi

# 检查 Docker 是否运行
if ! docker info &> /dev/null; then
    echo "[ERROR] Docker 未运行，请先启动 Docker Desktop"
    echo ""
    exit 1
fi

echo "[INFO] Docker 已就绪"
echo ""

# 检查是否需要构建镜像
if ! docker images duncrew --format "{{.Repository}}" | grep -q "duncrew"; then
    echo "[INFO] 首次运行，正在构建镜像（可能需要几分钟）..."
    echo ""
    docker-compose build
    echo ""
    echo "[INFO] 镜像构建完成"
    echo ""
fi

# 启动服务
echo "[INFO] 正在启动 DunCrew..."
echo ""
docker-compose up -d

echo ""
echo "=========================================="
echo "   DunCrew 已启动！"
echo ""
echo "   前端界面: http://localhost:4173"
echo "   后端 API: http://localhost:3001"
echo ""
echo "   停止命令: docker-compose down"
echo "=========================================="
echo ""

# 自动打开浏览器
sleep 3
if command -v open &> /dev/null; then
    # macOS
    open http://localhost:4173
elif command -v xdg-open &> /dev/null; then
    # Linux
    xdg-open http://localhost:4173
fi

echo "DunCrew 正在后台运行。"

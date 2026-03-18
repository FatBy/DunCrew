#!/bin/bash
# DunCrew Docker 启动脚本
# 同时启动 Python 后端 + 前端预览服务

set -e

echo "=========================================="
echo "   DunCrew - AI Operating System"
echo "=========================================="
echo ""

# 启动 Python 后端（后台运行）
echo "[1/2] Starting Python backend on port 3001..."
python3 duncrew-server.py --port 3001 --path /root/.duncrew &
BACKEND_PID=$!

# 等待后端启动
sleep 2

# 检查后端是否成功启动
if ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo "ERROR: Backend failed to start"
    exit 1
fi

echo "       Backend started (PID: $BACKEND_PID)"

# 启动前端预览服务
echo "[2/2] Starting frontend on port 4173..."
echo ""
npm run preview -- --host 0.0.0.0 --port 4173 &
FRONTEND_PID=$!

sleep 2

echo "=========================================="
echo "   DunCrew is running!"
echo ""
echo "   Frontend:  http://localhost:4173"
echo "   Backend:   http://localhost:3001"
echo ""
echo "   Press Ctrl+C to stop"
echo "=========================================="

# 捕获退出信号，清理进程
cleanup() {
    echo ""
    echo "Shutting down DunCrew..."
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

# 保持容器运行
wait

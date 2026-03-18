@echo off
chcp 65001 >nul
title DunCrew Stop

echo 正在停止 DunCrew...
docker-compose down

echo.
echo DunCrew 已停止。
echo.
pause

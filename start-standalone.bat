@echo off
chcp 65001 >nul
title DunCrew Standalone

:: 设置数据目录
set DUNCREW_DATA_PATH=%USERPROFILE%\.duncrew

echo.
echo  DunCrew Standalone Server
echo  ========================
echo.
echo  Data: %DUNCREW_DATA_PATH%
echo  URL:  http://localhost:3001
echo.

:: 启动服务器
duncrew-server\duncrew-server.exe --path "%DUNCREW_DATA_PATH%"

pause

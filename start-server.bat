@echo off
REM 启动 Web 管理面板(需先启动浏览器 start-browser.bat 才能用采集/投递/反馈)
REM 用法: 双击运行,或在命令行执行 start-server.bat
setlocal
set "DIR=%~dp0"
echo 启动管理面板...
start "自动投递管理面板" cmd /c "cd /d "%DIR%" && node server.mjs"
timeout /t 2 >nul
start "" http://localhost:8111
echo 面板已启动: http://localhost:8111  (关闭窗口即停止服务,不影响浏览器)
endlocal

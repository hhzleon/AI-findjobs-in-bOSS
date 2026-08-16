@echo off
REM 启动带 CDP 调试端口的 Edge,使用项目内持久化 profile(登录态保留)
REM 用法: 双击运行,或在命令行执行 start-browser.bat
setlocal
set "PROFILE=%~dp0.edge-profile"
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"

echo 启动 Edge(CDP 端口 9222,profile: %PROFILE%)
start "" "%EDGE%" --remote-debugging-port=9222 --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check "https://www.zhipin.com/web/geek/jobs"
echo 已启动。确认 CDP 可用: curl http://localhost:9222/json/version
endlocal

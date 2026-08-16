#!/usr/bin/env bash
# 启动带 CDP 调试端口的 Edge,使用项目内持久化 profile(登录态保留)
set -e
PROFILE="$(cygpath -w "$(cd "$(dirname "$0")" && pwd)/.edge-profile")"
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
[ -f "$EDGE" ] || EDGE="/c/Program Files/Microsoft/Edge/Application/msedge.exe"

echo "启动 Edge(CDP 端口 9222,profile: $PROFILE)"
"$EDGE" --remote-debugging-port=9222 --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  "https://www.zhipin.com/web/geek/jobs" &
echo "已启动。确认 CDP 可用: curl http://localhost:9222/json/version"

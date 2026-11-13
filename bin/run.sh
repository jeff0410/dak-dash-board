#!/bin/sh
# tmux 안에서 띄운다: tmux new -d -s dashboard ./bin/run.sh
# 코드를 바꾼 뒤 다시 켜기: tmux respawn-pane -k -t dashboard  (Ctrl+C 는 tmux 세션까지 끈다)
cd "$(dirname "$0")/.." || exit 1
while true; do
  node server.mjs 2>&1 | tee -a server.log
  echo "[run] 서버 종료 — 2초 뒤 다시 켭니다" | tee -a server.log
  sleep 2
done

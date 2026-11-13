#!/bin/sh
# Claude Code 훅 → 대시보드(127.0.0.1). 대시보드가 꺼져 있어도 Claude 를 막지 않는다.
# ~/.claude/settings.json 의 hooks 에서 이 파일을 부른다 (README 참고).
TOKEN=$(cat "$HOME/.agent-dash/hook-token" 2>/dev/null) || exit 0
jq -c 'if (.tool_response | tostring | length) > 20000 then .tool_response = {"truncated": true} else . end' 2>/dev/null \
  | curl -s -m 2 -o /dev/null -X POST \
      -H 'Content-Type: application/json' -H "X-Hook-Token: $TOKEN" -H "X-Tmux-Pane: ${TMUX_PANE:-}" \
      --data-binary @- "http://127.0.0.1:${DASH_PORT:-4545}/hook"
exit 0

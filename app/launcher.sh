#!/bin/bash
# Dock launcher for Feeld Swiper: starts the dashboard if it isn't running, then opens it in the browser.
# PROJECT_DIR is filled in by scripts/install-app.sh when the bundle is built.
PROJECT="__PROJECT_DIR__"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
PORT=$(grep -E '^PORT=' "$PROJECT/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
PORT="${PORT:-4848}"
URL="http://localhost:$PORT"

up() { curl -sf -m 2 "$URL/api/state" >/dev/null 2>&1; }

if ! up; then
  mkdir -p "$PROJECT/data"
  (cd "$PROJECT" && nohup npm start >> "$PROJECT/data/server.log" 2>&1 &)
  for _ in $(seq 1 40); do sleep 1; up && break; done
fi

if up; then
  open "$URL"
else
  osascript -e 'display notification "The dashboard did not start. See data/server.log in the project." with title "Feeld Swiper"'
  exit 1
fi

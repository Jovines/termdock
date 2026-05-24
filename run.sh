#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="$SCRIPT_DIR/dist/server/cli.js"
PID_FILE="$HOME/.termdock/server.json"

build() {
  echo "==> Building termdock..."
  cd "$SCRIPT_DIR"
  npm run build
  echo "==> Build done."
}

status() {
  if [ -f "$PID_FILE" ]; then
    node "$CLI" --status
  else
    echo "Termdock is not running."
  fi
}

start() {
  if [ ! -f "$CLI" ]; then
    echo "No build found, building first..."
    build
  fi

  RUNNING=$(node "$CLI" --status 2>/dev/null || true)
  if echo "$RUNNING" | grep -q "is running"; then
    echo "Termdock is already running:"
    echo "$RUNNING"
    return 0
  fi

  node "$CLI"
}

stop() {
  if [ ! -f "$CLI" ]; then
    echo "Termdock is not built. Nothing to stop."
    return 0
  fi
  node "$CLI" --stop
}

restart() {
  stop
  sleep 1
  start
}

case "${1:-}" in
  start)    start ;;
  stop)     stop ;;
  restart)  restart ;;
  status)   status ;;
  build)    build ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|build}"
    exit 1
    ;;
esac

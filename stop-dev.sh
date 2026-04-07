#!/usr/bin/env sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

SERVER_PID_FILE="$ROOT_DIR/.dev-server.pid"
CLIENT_PID_FILE="$ROOT_DIR/.dev-client.pid"

kill_pid_and_children() {
  pid="$1"

  if [ -z "${pid:-}" ] || ! kill -0 "$pid" 2>/dev/null; then
    return
  fi

  pkill -TERM -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  sleep 1

  if kill -0 "$pid" 2>/dev/null; then
    pkill -KILL -P "$pid" 2>/dev/null || true
    kill -9 "$pid" 2>/dev/null || true
  fi
}

stop_by_pid_file() {
  pid_file="$1"
  name="$2"

  if [ ! -f "$pid_file" ]; then
    return
  fi

  pid=$(cat "$pid_file" 2>/dev/null || true)
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    echo "Stopping $name (pid=$pid)..."
    kill_pid_and_children "$pid"
  fi

  rm -f "$pid_file"
}

echo "Stopping termdock dev services..."
stop_by_pid_file "$SERVER_PID_FILE" "server"
stop_by_pid_file "$CLIENT_PID_FILE" "client"
echo "Done."

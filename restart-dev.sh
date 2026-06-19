#!/usr/bin/env bash

set -euo pipefail

# 端口配置 (与 src/server/config.ts 保持一致)
FRONTEND_PORT=9833
BACKEND_PORT=9835

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# 运行时产物(pid/log)放系统临时目录,避免污染仓库
RUNTIME_DIR="${TMPDIR:-/tmp}/termdock-dev"
mkdir -p "$RUNTIME_DIR"

SERVER_PID_FILE="$RUNTIME_DIR/dev-server.pid"
CLIENT_PID_FILE="$RUNTIME_DIR/dev-client.pid"
SERVER_LOG_FILE="$RUNTIME_DIR/dev-server.log"
CLIENT_LOG_FILE="$RUNTIME_DIR/dev-client.log"

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

kill_matching_processes() {
  pattern="$1"
  label="$2"
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)

  if [ -z "${pids:-}" ]; then
    return
  fi

  echo "Stopping stale $label processes..."
  for pid in $pids; do
    kill_pid_and_children "$pid"
  done
}

ensure_port_available() {
  port="$1"
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)

  if [ -z "${pids:-}" ]; then
    return
  fi

  echo "Port $port is in use, killing..."
  for pid in $pids; do
    kill_pid_and_children "$pid"
  done
  sleep 1
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

start_service() {
  name="$1"
  cmd="$2"
  pid_file="$3"
  log_file="$4"

  echo "Starting $name..."
  nohup sh -c "cd \"$ROOT_DIR\" && exec $cmd" >"$log_file" 2>&1 &
  pid=$!
  echo "$pid" > "$pid_file"

  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$name failed to start. Check log: $log_file"
    exit 1
  fi
}

do_stop() {
  echo "Stopping termdock dev services..."
  stop_by_pid_file "$SERVER_PID_FILE" "server"
  stop_by_pid_file "$CLIENT_PID_FILE" "client"
  kill_matching_processes "tsx.*watch.*src/server/entry" "server"
  kill_matching_processes "node.*vite" "client"
  echo "Done."
}

do_restart() {
  echo "Restarting termdock dev services in background..."

  do_stop

  ensure_port_available "$BACKEND_PORT"
  ensure_port_available "$FRONTEND_PORT"

  start_service "server" "npm run dev:server" "$SERVER_PID_FILE" "$SERVER_LOG_FILE"
  start_service "client" "npm run dev:client" "$CLIENT_PID_FILE" "$CLIENT_LOG_FILE"

  echo "Done."
  echo "Server PID: $(cat "$SERVER_PID_FILE")"
  echo "Client PID: $(cat "$CLIENT_PID_FILE")"
  echo "Server log: $SERVER_LOG_FILE"
  echo "Client log: $CLIENT_LOG_FILE"
  echo "Open: http://localhost:$FRONTEND_PORT"
}

case "${1:-}" in
  stop)    do_stop ;;
  restart) do_restart ;;
  *)
    do_restart
    ;;
esac

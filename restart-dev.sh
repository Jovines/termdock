#!/usr/bin/env sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

SERVER_PID_FILE="$ROOT_DIR/.dev-server.pid"
CLIENT_PID_FILE="$ROOT_DIR/.dev-client.pid"
SERVER_LOG_FILE="$ROOT_DIR/.dev-server.log"
CLIENT_LOG_FILE="$ROOT_DIR/.dev-client.log"

stop_by_pid_file() {
  pid_file="$1"
  name="$2"

  if [ ! -f "$pid_file" ]; then
    return
  fi

  pid=$(cat "$pid_file" 2>/dev/null || true)
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    echo "Stopping $name (pid=$pid)..."
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi

  rm -f "$pid_file"
}

start_service() {
  name="$1"
  cmd="$2"
  pid_file="$3"
  log_file="$4"

  echo "Starting $name..."
  nohup sh -c "cd \"$ROOT_DIR\" && $cmd" >"$log_file" 2>&1 &
  pid=$!
  echo "$pid" > "$pid_file"

  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$name failed to start. Check log: $log_file"
    exit 1
  fi
}

echo "Restarting web-terminal dev services in background..."

stop_by_pid_file "$SERVER_PID_FILE" "server"
stop_by_pid_file "$CLIENT_PID_FILE" "client"

start_service "server" "npm run dev:server" "$SERVER_PID_FILE" "$SERVER_LOG_FILE"
start_service "client" "npm run dev:client" "$CLIENT_PID_FILE" "$CLIENT_LOG_FILE"

echo "Done."
echo "Server PID: $(cat "$SERVER_PID_FILE")"
echo "Client PID: $(cat "$CLIENT_PID_FILE")"
echo "Server log: $SERVER_LOG_FILE"
echo "Client log: $CLIENT_LOG_FILE"
echo "Open: http://localhost:5173"

#!/usr/bin/env sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

SERVER_PID_FILE="$ROOT_DIR/.dev-server.pid"
CLIENT_PID_FILE="$ROOT_DIR/.dev-client.pid"
SERVER_LOG_FILE="$ROOT_DIR/.dev-server.log"
CLIENT_LOG_FILE="$ROOT_DIR/.dev-client.log"

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

ensure_port_available_for_project() {
  port="$1"
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)

  if [ -z "${pids:-}" ]; then
    return
  fi

  for pid in $pids; do
    cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)
    case "$cmd" in
      *"$ROOT_DIR"*)
        echo "Stopping existing project process on port $port (pid=$pid)..."
        kill_pid_and_children "$pid"
        ;;
      *)
        echo "Port $port is occupied by an external process (pid=$pid):"
        echo "  $cmd"
        echo "Please stop it and rerun restart-dev.sh."
        exit 1
        ;;
    esac
  done
}

extract_local_url() {
  log_file="$1"

  if [ ! -f "$log_file" ]; then
    return
  fi

  while IFS= read -r line; do
    case "$line" in
      *"Local:"*)
        candidate=${line#*Local:}
        set -- $candidate
        if [ -n "${1:-}" ]; then
          printf '%s\n' "$1"
          return
        fi
        ;;
    esac
  done < "$log_file"
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

echo "Restarting web-terminal dev services in background..."

stop_by_pid_file "$SERVER_PID_FILE" "server"
stop_by_pid_file "$CLIENT_PID_FILE" "client"

kill_matching_processes "$ROOT_DIR/node_modules/.bin/tsx watch src/server/entry.ts" "server"
kill_matching_processes "$ROOT_DIR/node_modules/.bin/vite" "client"

ensure_port_available_for_project 3001
ensure_port_available_for_project 5173

start_service "server" "npm run dev:server" "$SERVER_PID_FILE" "$SERVER_LOG_FILE"
start_service "client" "npm run dev:client" "$CLIENT_PID_FILE" "$CLIENT_LOG_FILE"

echo "Done."
echo "Server PID: $(cat "$SERVER_PID_FILE")"
echo "Client PID: $(cat "$CLIENT_PID_FILE")"
echo "Server log: $SERVER_LOG_FILE"
echo "Client log: $CLIENT_LOG_FILE"

client_url=""
attempt=0
while [ "$attempt" -lt 30 ]; do
  client_url=$(extract_local_url "$CLIENT_LOG_FILE" || true)
  if [ -n "$client_url" ]; then
    break
  fi
  sleep 1
  attempt=$((attempt + 1))
done

if [ -z "$client_url" ]; then
  client_url="http://localhost:5173"
fi

echo "Open: $client_url"

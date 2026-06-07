#!/usr/bin/env bash

set -euo pipefail

NODE_PTY_RELEASE_DIR="node_modules/node-pty/build/Release"
NODE_PTY_HELPER="$NODE_PTY_RELEASE_DIR/spawn-helper"
NODE_PTY_NATIVE="$NODE_PTY_RELEASE_DIR/pty.node"

if ! command -v npm >/dev/null 2>&1; then
  printf 'npm is required but was not found in PATH.\n' >&2
  exit 1
fi

ensure_node_pty() {
  printf 'Rebuilding node-pty native module...\n'
  npm rebuild node-pty --build-from-source

  if [ "$(uname -s)" = "Darwin" ]; then
    if [ -f "$NODE_PTY_HELPER" ]; then
      chmod +x "$NODE_PTY_HELPER"
      xattr -d com.apple.quarantine "$NODE_PTY_HELPER" >/dev/null 2>&1 || true
    fi
  fi

  if [ ! -f "$NODE_PTY_NATIVE" ]; then
    printf 'node-pty native module was not built: %s\n' "$NODE_PTY_NATIVE" >&2
    exit 1
  fi

  if [ "$(uname -s)" = "Darwin" ] && [ ! -f "$NODE_PTY_HELPER" ]; then
    printf 'node-pty spawn-helper is missing: %s\n' "$NODE_PTY_HELPER" >&2
    printf 'Please ensure Xcode Command Line Tools are installed, then rerun this script.\n' >&2
    exit 1
  fi
}

printf 'Installing dependencies...\n'
npm install

ensure_node_pty

printf 'Building termdock...\n'
npm run build

printf 'Installing termdock CLI globally from local source...\n'
npm install -g .

printf '\nDone. Termdock installed globally.\n'
printf '\n'
printf 'Quick start:\n'
printf '  termdock                 Start server in background\n'
printf '  termdock --foreground    Run in foreground (for debugging)\n'
printf '  termdock --status        Show running server status\n'
printf '  termdock --stop          Stop background server\n'
printf '  termdock --help          Show all options\n'
printf '\n'
printf 'After starting, inspect URLs with:\n'
printf '  termdock --status\n'
printf '\n'
printf 'Logs: ~/.termdock/server.log\n'

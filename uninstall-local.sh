#!/usr/bin/env bash

set -euo pipefail

if ! command -v npm >/dev/null 2>&1; then
  printf 'npm is required but was not found in PATH.\n' >&2
  exit 1
fi

if command -v termdock >/dev/null 2>&1; then
  printf 'Stopping running Termdock service if present...\n'
  termdock --stop >/dev/null 2>&1 || true
fi

printf 'Removing global termdock installation...\n'
npm uninstall -g termdock

printf 'Cleaning local Termdock state...\n'
rm -rf "$HOME/.termdock"

printf '\nDone. termdock has been removed.\n'

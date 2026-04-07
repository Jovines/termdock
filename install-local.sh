#!/usr/bin/env bash

set -euo pipefail

if ! command -v npm >/dev/null 2>&1; then
  printf 'npm is required but was not found in PATH.\n' >&2
  exit 1
fi

printf 'Installing dependencies...\n'
npm install

printf 'Building termdock...\n'
npm run build

printf 'Installing termdock CLI globally from local source...\n'
npm install -g .

printf '\nDone. You can now run:\n'
printf '  termdock\n'

#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
download="$(mktemp)"
trap 'rm -f "$download"' EXIT
curl -fL --max-time 60 -o "$download" https://github.com/Genymobile/scrcpy/releases/download/v3.3.4/scrcpy-server-v3.3.4
python3 - "$download" "$root/scrcpy-server-v3.3.4" <<'PY'
import hashlib, pathlib, sys
data = pathlib.Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(data).hexdigest() == '8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e'
pathlib.Path(sys.argv[2]).write_bytes(data)
PY

#!/usr/bin/env bash
set -euo pipefail
# Rebuild only this ABI-compatible overlay, never the user's installed scrcpy.
# SDK 33 and Java 8 bytecode are sufficient; the interface stub is compile-only.
root="$(cd "$(dirname "$0")" && pwd)"
sdk="${ANDROID_HOME:?Set ANDROID_HOME to an Android SDK}"
build_tools="${ANDROID_BUILD_TOOLS:-33.0.2}"
work="$(mktemp -d)"
trap 'rm -r "$work"' EXIT
mkdir -p "$work/classes"
cat > "$work/SurfaceCapture.java" <<'JAVA'
package com.genymobile.scrcpy.video;
public abstract class SurfaceCapture {
    public interface CaptureListener { void onInvalidated(); }
}
JAVA
javac -source 8 -target 8 -bootclasspath "$sdk/platforms/android-33/android.jar" \
    -cp "$sdk/build-tools/$build_tools/core-lambda-stubs.jar" -d "$work/classes" "$work/SurfaceCapture.java" "$root/CaptureReset.java"
"$sdk/build-tools/$build_tools/d8" --min-api 21 --lib "$sdk/platforms/android-33/android.jar" \
    --output "$work" "$work/classes/com/genymobile/scrcpy/video/CaptureReset.class"
# Deterministic jar (zip timestamps are fixed).
python3 - "$work/classes.dex" "$root/bitrate.jar" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[2], 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    info = zipfile.ZipInfo('classes.dex', (1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(info, open(sys.argv[1], 'rb').read())
PY

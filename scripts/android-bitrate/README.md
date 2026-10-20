# scrcpy live bitrate extension

Termdock loads this 3 KB Android DEX overlay before the bundled, verified scrcpy 3.3.4 server
for preview sessions only. The host scrcpy version no longer gates automatic quality. Recording uses the unmodified scrcpy executable/server.

CaptureReset.java preserves scrcpy 3.3.4's existing ABI and reset behavior,
adding a session-scoped ADB reverse socket. The running hardware encoder receives
MediaCodec.PARAMETER_KEY_VIDEO_BITRATE via setParameters, under the same lock
used to clear the codec before stop/reset. There is no transcoding, frame polling,
forced keyframe, video reset, resolution change or new video connection.

Wire format is big-endian uint32: device sends TDB2 once ready, host sends target
bps, device replies with that value after setParameters returns, or zero on
rejection followed by a uint32 byte length and a UTF-8 codec diagnostic. The host
also accepts TDB1 acknowledgements from old extensions without diagnostics. An ACK confirms API acceptance, not exact vendor output bandwidth.
One request may be outstanding. Timeout retires only this optional channel;
video and input keep running.

Enabled only for the tested scrcpy 3.3.4 server SHA-256:
8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e
Both server and overlay hashes are checked in src/server/android/liveBitrate.ts.
The official 89 KB server is included, pinned to the checksum above, so host
scrcpy versions (including 4.x) do not affect preview compatibility. Reproduce it
with fetch-server.sh (downloads the official GitHub v3.3.4 release, verifies the
checksum before writing). Its source is https://github.com/Genymobile/scrcpy/tree/v3.3.4/server .
An explicit TERMDOCK_SCRCPY_SERVER override is honored. Missing/invalid bundled
assets fall back to the host server; unverified host builds then retain current
quality with a diagnostic. Rejections and channel failures also preserve video.

Network ADB preview sessions use `adb forward` for video and control; USB
sessions retain `adb reverse`. The forward connector waits for the scrcpy dummy
byte before opening control and removes only its own allocated TCP rule on stop.
The optional bitrate channel still uses a separate reverse rule. If reverse rules
register but carry no data, its handshake times out with a diagnostic; preview
continues at the configured bitrate.

Extend the allowlist only after verifying the CaptureReset ABI and real-device
behavior. No global scrcpy installation is modified.

Rebuild with JDK, Android platform 33 and build tools 33.0.2:

    ANDROID_HOME=/path/to/sdk bash scripts/android-bitrate/build.sh

Update the overlay SHA-256 in liveBitrate.ts after rebuilding. SurfaceCapture is
a compile-only ABI stub, deliberately excluded from the DEX. The jar is a runtime
asset distributed through package.json's scripts inclusion, also copied by the
desktop runtime packager. Apache-2.0 license is included.

Validation: Mi MIX 2S / Android 13 accepted 1.8 → 6 → 0.9 → 4 Mbps within
one session, continuously producing frames, with one video header and one codec
configuration packet.

Mac server and iPhone preview rendering were also verified with network
PTP-AN00 / Android 16 and Pixel 9 / Android 15 using forward video. On those cloud
routes, reverse registration succeeded without carrying data: bitrate handshakes
timed out while preview stayed alive. Physical identity properties matched across
the PTP IPv4/IPv6 routes; option grouping and selected-route preservation are
covered by tests. These observations do not establish live bitrate support on
those devices or full native input/recording acceptance.

Diagnostics distinguish version/build, missing/corrupt extension, ADB push/reverse,
15s handshake timeout, 2.5s device ACK timeout, 4s client confirmation timeout,
channel/protocol failure and device codec rejection. Detailed reasons travel over
the existing encrypted stream and appear in an expandable warning. Intentional
shutdown produces no bitrate failure.

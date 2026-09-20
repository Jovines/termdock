# scrcpy live bitrate extension

Termdock loads this 3 KB Android DEX overlay before the installed scrcpy server
for preview sessions only. Recording uses the unmodified scrcpy executable/server.

CaptureReset.java preserves scrcpy 3.3.4's existing ABI and reset behavior,
adding a session-scoped ADB reverse socket. The running hardware encoder receives
MediaCodec.PARAMETER_KEY_VIDEO_BITRATE via setParameters, under the same lock
used to clear the codec before stop/reset. There is no transcoding, frame polling,
forced keyframe, video reset, resolution change or new video connection.

Wire format is big-endian uint32: device sends TDB1 once ready, host sends target
bps, device replies with that value after setParameters returns, or zero on
rejection. An ACK confirms API acceptance, not exact vendor output bandwidth.
One request may be outstanding. Timeout retires only this optional channel;
video and input keep running.

Enabled only for the tested scrcpy 3.3.4 server SHA-256:
8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e
Both server and overlay hashes are checked in src/server/android/liveBitrate.ts.
Unrecognized builds (including 4.x), missing assets, rejected updates and channel
failures retain existing preview quality, without automatic reconnect fallback.
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
configuration packet. Other vendor encoders and macOS/iOS clients require real
device verification.

// Based on scrcpy 3.3.4 CaptureReset, Copyright Genymobile.
// SPDX-License-Identifier: Apache-2.0
// Termdock addition: a separate, session-scoped bitrate control socket.
package com.genymobile.scrcpy.video;

import android.media.MediaCodec;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Bundle;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

public class CaptureReset implements SurfaceCapture.CaptureListener {
    private final AtomicBoolean reset = new AtomicBoolean();
    private MediaCodec runningMediaCodec;
    private int bitrate;
    private boolean started;

    public boolean consumeReset() { return reset.getAndSet(false); }

    public synchronized void reset() {
        reset.set(true);
        if (runningMediaCodec != null) {
            try { runningMediaCodec.signalEndOfInputStream(); }
            catch (IllegalStateException ignored) { }
        }
    }

    public synchronized void setRunningMediaCodec(MediaCodec codec) {
        runningMediaCodec = codec;
        // Reapply after an actual rotation/reset, without causing one ourselves.
        if (codec != null && bitrate > 0) applyBitrate(bitrate);
        String name = System.getProperty("termdock.bitrate");
        if (codec != null && !started && name != null) {
            started = true;
            Thread thread = new Thread(() -> serve(name), "termdock-bitrate");
            thread.setDaemon(true);
            thread.start();
        }
    }

    private synchronized String applyBitrate(int value) {
        if (runningMediaCodec == null) return "Encoder temporarily unavailable during reset";
        if (value < 300000 || value > 30000000) return "Bitrate outside supported request range";
        try {
            Bundle params = new Bundle();
            params.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, value);
            runningMediaCodec.setParameters(params);
            bitrate = value;
            return null;
        } catch (IllegalArgumentException | IllegalStateException error) {
            String diagnostic = error instanceof MediaCodec.CodecException
                    ? ((MediaCodec.CodecException) error).getDiagnosticInfo() : error.getClass().getSimpleName();
            return diagnostic + ": " + error.getMessage();
        }
    }

    private void serve(String name) {
        try (LocalSocket socket = new LocalSocket()) {
            socket.connect(new LocalSocketAddress(name));
            DataInputStream input = new DataInputStream(socket.getInputStream());
            DataOutputStream output = new DataOutputStream(socket.getOutputStream());
            output.writeInt(0x54444232); // TDB2: rejection includes length-prefixed UTF-8 diagnostic
            output.flush();
            while (true) {
                int requested = input.readInt();
                String failure = applyBitrate(requested);
                output.writeInt(failure == null ? requested : 0);
                if (failure != null) {
                    byte[] detail = failure.substring(0, Math.min(512, failure.length())).getBytes(StandardCharsets.UTF_8);
                    output.writeInt(detail.length);
                    output.write(detail);
                }
                output.flush();
            }
        } catch (IOException ignored) {
            // A bitrate-channel failure must never tear down video/control.
        }
    }

    @Override
    public void onInvalidated() { reset(); }
}

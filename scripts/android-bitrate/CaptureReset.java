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

    private synchronized boolean applyBitrate(int value) {
        if (runningMediaCodec == null || value < 300000 || value > 30000000) return false;
        try {
            Bundle params = new Bundle();
            params.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, value);
            runningMediaCodec.setParameters(params);
            bitrate = value;
            return true;
        } catch (IllegalArgumentException | IllegalStateException ignored) {
            return false;
        }
    }

    private void serve(String name) {
        try (LocalSocket socket = new LocalSocket()) {
            socket.connect(new LocalSocketAddress(name));
            DataInputStream input = new DataInputStream(socket.getInputStream());
            DataOutputStream output = new DataOutputStream(socket.getOutputStream());
            output.writeInt(0x54444231); // TDB1: extension ready, codec is running
            output.flush();
            while (true) {
                int requested = input.readInt();
                output.writeInt(applyBitrate(requested) ? requested : 0);
                output.flush();
            }
        } catch (IOException ignored) {
            // A bitrate-channel failure must never tear down video/control.
        }
    }

    @Override
    public void onInvalidated() { reset(); }
}

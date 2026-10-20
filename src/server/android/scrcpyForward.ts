import net from 'node:net';

/** Wait for scrcpy's dummy byte: an ADB forward TCP accept alone does not
 * prove the device-side localabstract listener has started yet. */
export async function connectScrcpyForward(
  port: number,
  signal: AbortSignal,
  accept: (socket: net.Socket) => void,
  timeoutMs = 12_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const open = (dummy: boolean): Promise<net.Socket> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('SCRCPY_SESSION_STOPPED')); return; }
    const socket = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => fail(new Error('SCRCPY_FORWARD_CONNECT_TIMEOUT')), Math.min(500, Math.max(1, deadline - Date.now())));
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.removeListener('error', fail);
      socket.removeListener('close', closed);
      socket.removeListener('data', data);
      socket.removeListener('connect', connected);
    };
    const fail = (error: Error) => { cleanup(); socket.destroy(); reject(error); };
    const closed = () => fail(new Error('SCRCPY_FORWARD_CONNECTION_CLOSED'));
    const abort = () => fail(new Error('SCRCPY_SESSION_STOPPED'));
    const ready = () => { socket.pause(); cleanup(); resolve(socket); };
    const connected = () => { if (!dummy) ready(); };
    const data = (chunk: Buffer) => {
      if (!chunk.length) return;
      if (chunk[0] !== 0) { fail(new Error('SCRCPY_FORWARD_HANDSHAKE_INVALID')); return; }
      socket.pause();
      if (chunk.length > 1) socket.unshift(chunk.subarray(1));
      ready();
    };
    signal.addEventListener('abort', abort, { once: true });
    socket.on('error', fail);
    socket.on('close', closed);
    socket.on('connect', connected);
    if (dummy) socket.on('data', data);
  });
  let video: net.Socket | undefined;
  let control: net.Socket | undefined;
  try {
    while (!signal.aborted && Date.now() < deadline) {
      try { video = await open(true); break; }
      catch (error) {
        if (signal.aborted || Date.now() >= deadline) throw error;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 100);
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
      }
    }
    if (!video || signal.aborted) throw new Error(signal.aborted ? 'SCRCPY_SESSION_STOPPED' : 'SCRCPY_FORWARD_CONNECT_TIMEOUT');
    // Install video error/close listeners before waiting for control.
    accept(video);
    control = await open(false);
    if (signal.aborted) throw new Error('SCRCPY_SESSION_STOPPED');
    // Keep video paused until both sockets have listeners and definite roles.
    accept(control);
    video.resume();
    control.resume();
  } catch (error) {
    video?.destroy();
    control?.destroy();
    throw error;
  }
}

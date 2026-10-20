import net from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectScrcpyForward } from './scrcpyForward';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.reverse().forEach(fn => fn()); cleanup.length = 0; });
async function listener(connection: (socket: net.Socket) => void) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); connection(socket); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return (server.address() as net.AddressInfo).port;
}
function accepting() {
  const sockets: net.Socket[] = [];
  return { sockets, accept: (socket: net.Socket) => {
    socket.on('error', () => {}); sockets.push(socket); cleanup.push(() => socket.destroy());
  } };
}

describe('scrcpy ADB forward connection', () => {
  it('retries premature TCP accepts, consumes one dummy byte and preserves coalesced metadata before connecting control', async () => {
    let connections = 0;
    const port = await listener(socket => {
      connections++;
      if (connections < 3) { socket.destroy(); return; }
      if (connections === 3) socket.write(Buffer.from([0, 72, 79, 78, 79, 82]));
    });
    const { sockets, accept } = accepting();
    const video: Buffer[] = [];
    await connectScrcpyForward(port, new AbortController().signal, socket => {
      accept(socket);
      if (sockets.length === 1) socket.on('data', data => video.push(data));
    });
    // Client connect and the server accept callback can run on separate turns.
    await vi.waitFor(() => expect(connections).toBe(4)); // Two failed probes, video, then control.
    expect(sockets).toHaveLength(2);
    await vi.waitFor(() => expect(Buffer.concat(video).toString()).toBe('HONOR'));
  });

  it('does not open control merely because the forwarded host port accepts TCP', async () => {
    let connections = 0;
    const port = await listener(() => { connections++; });
    const { sockets, accept } = accepting();
    await expect(connectScrcpyForward(port, new AbortController().signal, accept, 150)).rejects.toThrow('SCRCPY_FORWARD_CONNECT_TIMEOUT');
    expect(connections).toBe(1);
    expect(sockets).toHaveLength(0);
  });

  it('cancels an in-flight handshake on stop without opening control', async () => {
    let connections = 0;
    const controller = new AbortController();
    const port = await listener(() => { connections++; controller.abort(); });
    const { sockets, accept } = accepting();
    await expect(connectScrcpyForward(port, controller.signal, accept)).rejects.toThrow('SCRCPY_SESSION_STOPPED');
    expect(connections).toBe(1);
    expect(sockets).toHaveLength(0);
  });

  it('rejects an already stopped session without touching the ADB port', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(connectScrcpyForward(1, controller.signal, () => {})).rejects.toThrow('SCRCPY_SESSION_STOPPED');
  });
});

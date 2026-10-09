import { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { WebSocket } from 'ws';
import { resolveComputerHost } from './computerTarget.js';
import { GuacamoleParser, guacamoleInstruction } from './guacamoleProtocol.js';

const guacdPort = () => Number(process.env.TERMDOCK_GUACD_PORT) || 4822;
const bridges = new Set<Socket>();
export function stopRdpBridges(): void { for (const tcp of bridges) tcp.destroy(); bridges.clear(); }
export function rdpBackendAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    const tcp = new Socket();
    const done = (available: boolean) => { tcp.destroy(); resolve(available); };
    tcp.setTimeout(500, () => done(false));
    tcp.once('error', () => done(false)); tcp.once('connect', () => done(true));
    tcp.connect(guacdPort(), '127.0.0.1');
  });
}

/** Only this server builds guacd's handshake. Credentials arrive inside the
 * authenticated encrypted logical socket, never query strings or logs. */
export function handleRdpWebSocket(socket: WebSocket, host: string, port: number): void {
  let closed = false;
  let started = false;
  let ready = false;
  let tcp: Socket | undefined;
  let sent = 0;
  let acked = 0;
  let lastAckAt = Date.now();
  let credentials: Record<string, string> = {};
  const finish = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true; credentials = {};
    clearTimeout(timer); clearInterval(flowTimer);
    if (tcp) { bridges.delete(tcp); tcp.destroy(); }
    socket.close(code, reason);
  };
  const timer = setTimeout(() => finish(4408, 'COMPUTER_CONNECT_TIMEOUT'), 15_000);
  const flowTimer = setInterval(() => {
    if (sent > acked && Date.now() - lastAckAt > 30_000) finish(4408, 'COMPUTER_STREAM_TIMEOUT');
  }, 5000);
  const decoder = new StringDecoder('utf8');
  let instructions: string[][] = [];
  let handshakeSent = false;
  const parser = new GuacamoleParser(values => {
    const [opcode, ...args] = values;
    if (!ready && opcode === 'args' && !handshakeSent) {
      handshakeSent = true;
      tcp!.write(guacamoleInstruction('size', credentials.width, credentials.height, '96')
        + guacamoleInstruction('audio') + guacamoleInstruction('video')
        + guacamoleInstruction('image', 'image/png', 'image/jpeg')
        + guacamoleInstruction('connect', ...args.map(name => name.startsWith('VERSION_') ? 'VERSION_1_5_0' : credentials[name] ?? '')));
      credentials = {};
    } else if (opcode === 'ready') {
      if (!handshakeSent || ready) throw new Error('GUAC_INVALID_HANDSHAKE');
      ready = true; clearTimeout(timer); instructions.push(values);
    } else if (ready || opcode === 'error') instructions.push(values);
    else throw new Error('GUAC_INVALID_HANDSHAKE');
  });
  const pump = () => {
    if (closed || !tcp) return;
    try {
      while (sent - acked < 8 && tcp.readableLength > 0) {
        const bytes = tcp.read(Math.min(tcp.readableLength, 32 * 1024)) as Buffer | null;
        if (!bytes) break;
        parser.receive(decoder.write(bytes));
        if (instructions.length) {
          if (sent === acked) lastAckAt = Date.now();
          socket.send(JSON.stringify({ type: 'instructions', seq: ++sent, instructions }));
          instructions = [];
        }
      }
    } catch { finish(4502, 'COMPUTER_INVALID_MESSAGE'); }
  };
  socket.on('close', () => finish()); socket.on('error', () => finish());
  socket.on('message', raw => {
    if (closed) return;
    try {
      if (raw.toString().length > 128 * 1024) throw new Error('INPUT_LIMIT');
      const message = JSON.parse(raw.toString());
      if (message.type === 'start' && !started) {
        started = true;
        for (const key of ['username', 'password', 'domain']) {
          if (typeof message[key] !== 'string' || message[key].length > 1024 || message[key].includes('\0')) throw new Error('INVALID_CREDENTIALS');
        }
        if (!message.username.trim() || !message.password || typeof message.ignoreCert !== 'boolean') throw new Error('INVALID_CREDENTIALS');
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
        credentials = {
          username: message.username, password: message.password, domain: message.domain,
          port: String(port), security: 'any', 'ignore-cert': String(message.ignoreCert),
          width: String(Math.max(640, Math.min(2560, Number(message.width) || 1280))),
          height: String(Math.max(480, Math.min(1600, Number(message.height) || 800))),
          'color-depth': '32', 'disable-audio': 'true', 'enable-drive': 'false',
          'disable-copy': 'true', 'server-layout': 'en-us-qwerty', 'resize-method': 'display-update',
        };
        void resolveComputerHost(host).then(address => {
          if (closed) return;
          credentials.hostname = address.address;
          tcp = new Socket(); bridges.add(tcp); tcp.setNoDelay(true);
          tcp.on('readable', pump);
          tcp.once('connect', () => { tcp!.write(guacamoleInstruction('select', 'rdp')); });
          tcp.once('error', () => finish(4503, 'COMPUTER_RDP_BACKEND_UNAVAILABLE'));
          tcp.once('end', () => finish(1000, 'COMPUTER_DISCONNECTED'));
          tcp.once('close', () => finish(1000, 'COMPUTER_DISCONNECTED'));
          tcp.connect(guacdPort(), '127.0.0.1');
        }).catch(reason => finish(4400, reason instanceof Error && /^COMPUTER_(?:INVALID_HOST|PRIVATE_HOST_ONLY)$/.test(reason.message) ? reason.message : 'COMPUTER_UNREACHABLE'));
      } else if (message.type === 'ack') {
        if (!Number.isSafeInteger(message.seq) || message.seq <= acked || message.seq > sent) throw new Error('INVALID_ACK');
        acked = message.seq; lastAckAt = Date.now(); pump();
      } else if (message.type === 'instruction' && ready && tcp) {
        // Disallow re-handshakes, filesystem, recording, arbitrary connection
        // parameters, and other protocols through this full-service bridge.
        if (!['sync', 'key', 'mouse', 'clipboard', 'blob', 'end', 'ack', 'nop', 'size', 'disconnect'].includes(message.opcode)
          || !Array.isArray(message.args) || message.args.length > 8
          || message.args.some((arg: unknown) => typeof arg !== 'string' || arg.length > 64 * 1024)
          || tcp.writableLength > 1024 * 1024) throw new Error('INVALID_INSTRUCTION');
        if (message.opcode === 'size' && (message.args.length !== 2 || message.args.some((value: string, index: number) =>
          !/^\d{1,4}$/.test(value) || Number(value) < (index ? 480 : 640) || Number(value) > (index ? 1600 : 2560)))) throw new Error('INVALID_SIZE');
        tcp.write(guacamoleInstruction(message.opcode, ...message.args));
      } else throw new Error('INVALID_MESSAGE');
    } catch { finish(4400, 'COMPUTER_INVALID_MESSAGE'); }
  });
}

import Guacamole from 'guacamole-common-js';
import { secureSocket } from '../federation/browserIntegration';

export interface RdpConnection {
  host: string; port: number; username: string; password: string; domain: string;
  ignoreCert: boolean; width: number; height: number;
}

/** A Guacamole tunnel backed solely by Termdock's authenticated Noise channel. */
export class SecureRdpTunnel extends Guacamole.Tunnel {
  private socket: WebSocket | null = null;
  cancelPointerMoves: () => void;
  constructor(options: RdpConnection, fail: (reason: string) => void, localPointer: () => boolean = () => false) {
    super();
    let movement: string[] | null = null, animation: number | null = null, buttons = '0';
    const cancelMovement = () => {
      if (animation !== null) cancelAnimationFrame(animation);
      animation = null; movement = null;
    };
    this.cancelPointerMoves = cancelMovement;
    const send = (values: string[]) => {
      if (this.socket?.readyState !== 1 || this.state !== Guacamole.Tunnel.State.OPEN) return;
      this.socket.send(JSON.stringify({ type: 'instruction', opcode: values[0], args: values.slice(1) }));
    };
    const flushMovement = () => {
      const latest = movement; cancelMovement();
      if (latest) send(latest);
    };
    const state = (next: Guacamole.Tunnel.State) => {
      if (this.state === next) return;
      this.state = next; this.onstatechange?.(next);
    };
    // Tunnel defines these methods as instance properties, so override them
    // here rather than on a subclass prototype.
    this.connect = () => {
      state(Guacamole.Tunnel.State.CONNECTING);
      let received = 0;
      const query = new URLSearchParams({ host: options.host, protocol: 'rdp', port: String(options.port) });
      const socket = this.socket = secureSocket(`/api/computer/ws?${query}`);
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'start', username: options.username, password: options.password,
          domain: options.domain, ignoreCert: options.ignoreCert, width: options.width, height: options.height }));
        options.password = '';
      };
      socket.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type !== 'instructions' || message.seq !== received + 1 || !Array.isArray(message.instructions)) throw new Error('Invalid RDP record');
          received = message.seq;
          for (const instruction of message.instructions) {
            if (!Array.isArray(instruction) || !instruction.length || instruction.some(value => typeof value !== 'string')) throw new Error('Invalid RDP instruction');
            const [opcode, ...args] = instruction;
            if (opcode === 'ready') {
              this.uuid = args[0]; this.onuuid?.(args[0]); state(Guacamole.Tunnel.State.OPEN);
              this.sendMessage('nop');
            } else if (opcode !== 'mouse' || !localPointer()) this.oninstruction?.(opcode, args);
          }
          if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'ack', seq: message.seq }));
        } catch { fail('COMPUTER_INVALID_MESSAGE'); this.disconnect(); }
      };
      // SecureSocket emits close immediately after error, carrying the precise
      // authorization/transport reason. Preserve it for the UI.
      socket.onerror = () => {};
      socket.onclose = event => {
        cancelMovement();
        options.password = '';
        fail(event.reason || 'COMPUTER_DISCONNECTED'); state(Guacamole.Tunnel.State.CLOSED);
      };
    };
    this.disconnect = () => {
      cancelMovement();
      options.password = '';
      const socket = this.socket; this.socket = null;
      if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.onopen = null; socket.close(); }
      state(Guacamole.Tunnel.State.CLOSED);
    };
    this.sendMessage = (...values: unknown[]) => {
      if (this.socket?.readyState !== 1 || this.state !== Guacamole.Tunnel.State.OPEN) return;
      const instruction = values.map(String);
      if (instruction[0] === 'mouse' && instruction.length === 4 && instruction[3] === buttons) {
        // Guacamole already moved the local cursor. Transmit only the newest
        // continuous position each animation frame, not a queue of old moves.
        movement = instruction;
        animation ??= requestAnimationFrame(flushMovement);
      } else {
        flushMovement();
        if (instruction[0] === 'mouse') buttons = instruction[3];
        send(instruction);
      }
    };
  }
}

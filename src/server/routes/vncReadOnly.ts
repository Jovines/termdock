/** Stateful RFB client filter. Handshake bytes are length-delimited; after
 * ClientInit only framebuffer negotiation/requests pass. Never scan raw bytes
 * for opcodes: credentials and fragmented records can contain any byte. */
export class VncReadOnlyFilter {
  private client = Buffer.alloc(0);
  private server = Buffer.alloc(0);
  private stage: 'version' | 'security' | 'auth' | 'init' | 'messages' = 'version';
  private serverStage: 'version' | 'security' | 'challenge' | 'done' = 'version';
  private security = 0;
  private authBytes = 0;
  private offered: number[] = [];
  serverData(bytes: Buffer): void {
    if (this.serverStage === 'done') return;
    this.server = Buffer.concat([this.server, bytes]);
    if (this.server.length > 65536) throw new Error('COMPUTER_INVALID_MESSAGE');
    if (this.serverStage === 'version' && this.server.length >= 12) { this.server = this.server.subarray(12); this.serverStage = 'security'; }
    if (this.serverStage === 'security' && this.server.length >= 1 && this.server.length >= 1 + this.server[0]) {
      this.offered = [...this.server.subarray(1, 1 + this.server[0])]; this.server = this.server.subarray(1 + this.server[0]); this.serverStage = 'challenge';
    }
    if (this.serverStage === 'challenge' && this.security === 30 && this.server.length >= 4) {
      const length = this.server.readUInt16BE(2);
      if (length < 16 || length > 512) throw new Error('COMPUTER_INVALID_MESSAGE');
      this.authBytes = 128 + length; this.serverStage = 'done'; this.server = Buffer.alloc(0);
    } else if (this.serverStage === 'challenge' && [1, 2].includes(this.security)) { this.serverStage = 'done'; this.server = Buffer.alloc(0); }
  }
  clientData(bytes: Buffer): Buffer[] {
    this.client = Buffer.concat([this.client, bytes]);
    if (this.client.length > 1024 * 1024) throw new Error('COMPUTER_INVALID_MESSAGE');
    const output: Buffer[] = [];
    const consume = (n: number, forward = true) => { if (forward) output.push(this.client.subarray(0, n)); this.client = this.client.subarray(n); };
    while (this.client.length) {
      if (this.stage === 'version') {
        if (this.client.length < 12) break;
        // 3.8 has explicit security selection/results; fail closed for legacy.
        if (this.client.subarray(0, 12).toString() !== 'RFB 003.008\n') throw new Error('COMPUTER_READ_ONLY_PROTOCOL');
        consume(12); this.stage = 'security';
      } else if (this.stage === 'security') {
        this.security = this.client[0];
        if (![1, 2, 30].includes(this.security) || !this.offered.includes(this.security)) throw new Error('COMPUTER_READ_ONLY_PROTOCOL');
        this.authBytes = this.security === 2 ? 16 : 0;
        consume(1); this.stage = this.security === 1 ? 'init' : 'auth'; this.serverData(Buffer.alloc(0));
      } else if (this.stage === 'auth') {
        if (!this.authBytes || this.client.length < this.authBytes) break;
        consume(this.authBytes); this.stage = 'init';
      } else if (this.stage === 'init') {
        if (this.client[0] !== 1) throw new Error('COMPUTER_READ_ONLY_PROTOCOL');
        consume(1); this.stage = 'messages';
      } else {
        const type = this.client[0]; let length: number;
        if (type === 0) length = 20;
        else if (type === 2) { if (this.client.length < 4) break; length = 4 + 4 * this.client.readUInt16BE(2); }
        else if (type === 3 || type === 150) length = 10;
        else if (type === 4) length = 8;
        else if (type === 5) length = 6;
        else if (type === 6) { if (this.client.length < 8) break; length = 8 + Math.abs(this.client.readInt32BE(4)); }
        else if (type === 248) { if (this.client.length < 9) break; length = 9 + this.client[8]; }
        else if (type === 251) { if (this.client.length < 8) break; length = 8 + 16 * this.client[6]; }
        else if (type === 255) length = 12;
        else throw new Error('COMPUTER_READ_ONLY_PROTOCOL');
        if (length > 1024 * 1024) throw new Error('COMPUTER_INVALID_MESSAGE');
        if (this.client.length < length) break;
        if (type === 2) {
          // Do not advertise clipboard extensions to a view-only client.
          const encodings: Buffer[] = []; for (let i = 4; i < length; i += 4) if (this.client.readUInt32BE(i) !== 0xc0a1e5ce) encodings.push(this.client.subarray(i, i + 4));
          const header = Buffer.from([2, 0, 0, 0]); header.writeUInt16BE(encodings.length, 2); output.push(Buffer.concat([header, ...encodings])); consume(length, false);
        } else consume(length, [0, 3, 150, 248].includes(type));
      }
    }
    return output;
  }
}

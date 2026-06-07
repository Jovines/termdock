declare module 'multicast-dns' {
  import type { EventEmitter } from 'events';

  export interface Question {
    name: string;
    type: string;
    class?: string;
  }

  export interface Answer {
    name: string;
    type: string;
    ttl?: number;
    data: string | unknown;
  }

  export interface Packet {
    type?: 'query' | 'response';
    questions?: Question[];
    answers?: Answer[];
    authorities?: Answer[];
    additionals?: Answer[];
  }

  export interface RemoteInfo {
    address: string;
    family: string;
    port: number;
    size: number;
  }

  export interface MulticastDns extends EventEmitter {
    on(event: 'query' | 'response', listener: (packet: Packet, rinfo: RemoteInfo) => void): this;
    query(name: string, type?: string, callback?: (error?: Error) => void): void;
    query(packet: Packet | Question[], callback?: (error?: Error) => void): void;
    respond(packet: Packet | Answer[], callback?: (error?: Error) => void): void;
    destroy(callback?: () => void): void;
  }

  export default function multicastDns(options?: Record<string, unknown>): MulticastDns;
}

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { PtyHostManager, ptyHostSocketPath } from './manager.js';
import { FrameDecoder, encodeControl, type ControlOp } from './protocol.js';

/**
 * 假 host：用 net.createServer 在 manager 期望的 socket 路径上监听，
 * 按剧本响应控制帧（或故意不响应，模拟 wedge）。
 */

type FakeHostBehavior = {
  /** 收到 hello 是否回 helloAck。 */
  answerHello: boolean;
  /** 收到 ping 是否回 pong。 */
  answerPing?: boolean;
  /** 收到控制帧的回调（测试断言用）。 */
  onControl?: (msg: ControlOp, conn: net.Socket) => void;
};

interface FakeHost {
  server: net.Server;
  sockets: Set<net.Socket>;
  close: () => Promise<void>;
}

function socketDir(): string {
  return path.join(os.homedir(), '.termdock', 'pty-hosts');
}

async function startFakeHost(behavior: FakeHostBehavior): Promise<FakeHost> {
  const sockPath = ptyHostSocketPath();
  fs.mkdirSync(socketDir(), { recursive: true });
  try { fs.unlinkSync(sockPath); } catch { /* not present */ }

  const sockets = new Set<net.Socket>();
  const server = net.createServer((conn) => {
    sockets.add(conn);
    conn.on('close', () => sockets.delete(conn));
    const decoder = new FrameDecoder();
    conn.on('data', (chunk) => {
      for (const frame of decoder.feed(chunk)) {
        if (!frame.control) continue;
        behavior.onControl?.(frame.control, conn);
        if (frame.control.op === 'hello' && behavior.answerHello) {
          conn.write(encodeControl({ op: 'helloAck', v: 1, channels: [] }));
        }
        if (frame.control.op === 'ping' && behavior.answerPing) {
          conn.write(encodeControl({ op: 'pong', t: frame.control.t }));
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve());
  });

  return {
    server,
    sockets,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { fs.unlinkSync(sockPath); } catch { /* gone */ }
    },
  };
}

let manager: PtyHostManager | null = null;
let fakeHost: FakeHost | null = null;

beforeEach(() => {
  process.env.TERMDOCK_PTY_HOST_KEY = `vitest-manager-${process.pid}-${Date.now()}`;
  manager = new PtyHostManager();
  // 测试里绝不真的 spawn daemon。
  (manager as unknown as { spawnHostDaemon: () => void }).spawnHostDaemon = () => undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (manager) {
    (manager as unknown as { stopHeartbeat: () => void }).stopHeartbeat();
    (manager as unknown as { conn: net.Socket | null }).conn?.destroy();
    manager = null;
  }
  if (fakeHost) {
    await fakeHost.close();
    fakeHost = null;
  }
  delete process.env.TERMDOCK_PTY_HOST_KEY;
});

describe('PtyHostManager hang guards', () => {
  it('rejects instead of hanging forever when the host never answers hello', async () => {
    fakeHost = await startFakeHost({ answerHello: false });

    // 握手 4s 超时 → 视为 wedge → 清理 → 5s 内重试无果 → 拒绝。
    await expect(manager!.ensureConnected()).rejects.toThrow(/did not start listening|timed out/);

    // 锁存器必须已清掉：下一次调用也要失败而不是挂在同一个 promise 上。
    await expect(manager!.ensureConnected()).rejects.toThrow();
  }, 30_000);

  it('rejects spawnChannel when the host never answers spawn', async () => {
    fakeHost = await startFakeHost({ answerHello: true });

    await expect(
      manager!.spawnChannel('chan-1', {
        shell: '/bin/sh',
        args: [],
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        env: {},
        termName: 'xterm-256color',
      }),
    ).rejects.toThrow(/spawn timed out/);
  }, 20_000);

  it('sends heartbeat pings after the handshake', async () => {
    const seen: ControlOp[] = [];
    fakeHost = await startFakeHost({
      answerHello: true,
      answerPing: true,
      onControl: (msg) => seen.push(msg),
    });

    await manager!.ensureConnected();

    // 心跳间隔 15s：等到第一个 ping 出现。
    await vi.waitFor(() => {
      expect(seen.some((msg) => msg.op === 'ping')).toBe(true);
    }, { timeout: 20_000, interval: 250 });
  }, 30_000);
});

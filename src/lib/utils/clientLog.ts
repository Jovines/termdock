/**
 * 浏览器端诊断日志 → POST /api/client-log → 服务端 client.log。
 * 用于真机（手机 PWA + 软键盘）上无法开 DevTools 的运行时排障。
 * 简单合流批量发送，失败即丢弃（诊断日志不值得重试风暴）。
 */

let queue: string[] = [];
let flushing = false;

export function clientLog(level: 'debug' | 'info' | 'warn', message: string, data: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  queue.push(JSON.stringify({
    level,
    message,
    data: { ts: Date.now(), ...data },
  }));
  void flush();
}

async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const payload = queue[0];
      try {
        await fetch('/api/client-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        });
        queue.shift();
      } catch {
        // 网络抖动时整批丢弃，避免离线时队列无限增长
        queue = [];
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

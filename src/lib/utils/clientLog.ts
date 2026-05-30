const LOG_ENDPOINT = '/api/client-log';
const MAX_QUEUE = 100;
const FLUSH_INTERVAL = 2000;

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
  timestamp: number;
}

let queue: LogEntry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let enabled = true;

function flush() {
  timer = null;
  if (queue.length === 0) return;
  const batch = queue.splice(0);
  for (const entry of batch) {
    fetch(LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: entry.level,
        message: entry.message,
        data: entry.data,
      }),
      keepalive: true,
    }).catch(() => {});
  }
}

function scheduleFlush() {
  if (timer !== null) return;
  timer = setTimeout(flush, FLUSH_INTERVAL);
}

export function clientLog(level: LogEntry['level'], message: string, data?: unknown) {
  if (!enabled) return;

  const entry: LogEntry = { level, message, data, timestamp: Date.now() };
  queue.push(entry);

  if (queue.length >= MAX_QUEUE) {
    if (timer) { clearTimeout(timer); timer = null; }
    flush();
  } else {
    scheduleFlush();
  }

  // Also echo to browser console for local debugging
  const consoleFn = console[level] ?? console.log;
  consoleFn(`[clientLog:${level}] ${message}`, data ?? '');
}

export function disableClientLog() {
  enabled = false;
  if (timer) { clearTimeout(timer); timer = null; }
  flush();
}

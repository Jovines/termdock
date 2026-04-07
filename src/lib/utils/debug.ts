type DebugChannel = 'keyboard' | 'viewport' | 'terminal' | 'session';

const DEBUG_QUERY_KEY = 'debug';
const DEBUG_STORAGE_KEY = 'termdock:debug';

function parseChannels(raw: string | null): Set<string> {
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

function readEnabledChannels(): Set<string> {
  if (typeof window === 'undefined') {
    return new Set();
  }

  const fromQuery = parseChannels(new URLSearchParams(window.location.search).get(DEBUG_QUERY_KEY));
  let fromStorage = new Set<string>();
  try {
    fromStorage = parseChannels(window.localStorage.getItem(DEBUG_STORAGE_KEY));
  } catch {
    fromStorage = new Set<string>();
  }
  const all = new Set<string>([...fromQuery, ...fromStorage]);

  if (all.has('1') || all.has('true') || all.has('*') || all.has('all')) {
    return new Set(['*']);
  }

  return all;
}

export function isDebugChannelEnabled(channel: DebugChannel): boolean {
  const channels = readEnabledChannels();
  return channels.has('*') || channels.has(channel);
}

export function createDebugLogger(channel: DebugChannel) {
  const enabled = isDebugChannelEnabled(channel);

  return (...args: unknown[]) => {
    if (!enabled) {
      return;
    }

    console.log(`[debug:${channel}]`, ...args);
  };
}

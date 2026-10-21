const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
// Node and DOM declare compression inputs in different scopes. Derive the
// accepted byte type so this shared module type-checks in both builds.
type CompressionInput = NonNullable<Parameters<ReturnType<CompressionStream['writable']['getWriter']>['write']>[0]>;

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const source: ReadableStream<CompressionInput> = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();
  const reader = source.pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RECORD_BYTES) throw new Error('Expanded record exceeds budget');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/** Independent records avoid retaining compression dictionaries across messages.
 * Only explicitly negotiated terminal output is eligible, before Noise encryption. */
export async function compressRecord(frame: Uint8Array, id: string): Promise<Uint8Array> {
  if (frame.byteLength < 4096 || typeof CompressionStream === 'undefined') return frame;
  const compressed = await transform(frame.subarray(4), new CompressionStream('gzip'));
  let binary = '';
  for (let offset = 0; offset < compressed.length; offset += 8192) binary += String.fromCharCode(...compressed.subarray(offset, offset + 8192));
  const body = encoder.encode(JSON.stringify({ type: 'compressed', id, encoding: 'gzip', data: btoa(binary) }));
  // Account for base64 and the envelope: already compressed content goes as-is.
  if (body.byteLength + 4 >= frame.byteLength * 0.9) return frame;
  const result = new Uint8Array(body.byteLength + 4);
  new DataView(result.buffer).setUint32(0, body.byteLength);
  result.set(body, 4);
  return result;
}

export async function expandRecord(data: unknown): Promise<unknown> {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_RECORD_BYTES / 3) * 4) throw new Error('Invalid compressed record');
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  const expanded = await transform(bytes, new DecompressionStream('gzip'));
  return JSON.parse(decoder.decode(expanded));
}

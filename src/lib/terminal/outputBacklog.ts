export const OUTPUT_BACKLOG_MAX_CHUNK_SIZE = 256 * 1024;
export const OUTPUT_BACKLOG_FRAME_BYTE_BUDGET = 256 * 1024;
export const OUTPUT_BACKLOG_FRAME_CHUNK_BUDGET = 128;

export function splitTerminalOutputChunk(
  data: string,
  maxChunkSize = OUTPUT_BACKLOG_MAX_CHUNK_SIZE,
): string[] {
  if (!data) return [];
  if (data.length <= maxChunkSize) return [data];

  const chunks: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    let end = Math.min(offset + maxChunkSize, data.length);
    if (end < data.length) {
      const lastNewline = data.lastIndexOf('\n', end);
      if (lastNewline > offset) end = lastNewline + 1;
    }
    chunks.push(data.slice(offset, end));
    offset = end;
  }
  return chunks;
}

/**
 * Drain a bounded, fair slice of queued terminal output for one animation
 * frame. The input map is mutated in place so a large wake-up backlog does
 * not need to be copied before the UI gets a chance to respond.
 */
export function drainTerminalOutputFrame(
  pending: Map<string, string[]>,
  byteBudget = OUTPUT_BACKLOG_FRAME_BYTE_BUDGET,
  chunkBudget = OUTPUT_BACKLOG_FRAME_CHUNK_BUDGET,
): Map<string, string[]> {
  const drained = new Map<string, string[]>();
  let drainedBytes = 0;
  let drainedChunks = 0;

  // Snapshot the keys: sessions that still have data are moved to the end of
  // the map, giving another session first turn on the next frame.
  for (const sessionId of [...pending.keys()]) {
    const queue = pending.get(sessionId);
    if (!queue || queue.length === 0) {
      pending.delete(sessionId);
      continue;
    }

    const sessionBatch: string[] = [];
    while (queue.length > 0) {
      const next = queue[0];
      const wouldExceedBudget = drainedChunks > 0 && (
        drainedChunks >= chunkBudget || drainedBytes + next.length > byteBudget
      );
      if (wouldExceedBudget) break;
      queue.shift();
      sessionBatch.push(next);
      drainedBytes += next.length;
      drainedChunks += 1;
    }
    if (sessionBatch.length > 0) drained.set(sessionId, sessionBatch);

    pending.delete(sessionId);
    if (queue.length > 0) pending.set(sessionId, queue);
    if (drainedChunks >= chunkBudget || drainedBytes >= byteBudget) break;
  }

  return drained;
}

export interface WritableHttpResponse {
  destroyed: boolean;
  writableEnded: boolean;
  writableFinished: boolean;
  write(chunk: string): unknown;
}

export function isResponseWritable(response: WritableHttpResponse): boolean {
  return !response.destroyed && !response.writableEnded && !response.writableFinished;
}

export function writeResponseChunk(response: WritableHttpResponse, chunk: string): boolean {
  if (!isResponseWritable(response)) return false;
  try {
    response.write(chunk);
    return true;
  } catch {
    return false;
  }
}

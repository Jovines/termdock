/** Validate untrusted browser geometry before creating the attached PTY. */
export function readTerminalHandshakeDimensions(params: URLSearchParams): { cols: number; rows: number } | undefined {
  const cols = Number(params.get('cols'));
  const rows = Number(params.get('rows'));
  if (!Number.isInteger(cols) || !Number.isInteger(rows)
    || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return undefined;
  return { cols, rows };
}

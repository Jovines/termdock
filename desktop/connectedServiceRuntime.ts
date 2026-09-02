import type { WebContents } from 'electron';

const GET_CONNECTED_SERVICE_STATE_SCRIPT = String.raw`
(async () => {
  const response = await fetch('/api/terminal/update');
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload && typeof payload.error === 'string'
      ? payload.error
      : 'Failed to read the connected Termdock update state.');
  }
  return payload;
})()
`;

function connectedServiceMutationScript(path: string): string {
  return String.raw`
(async () => {
  const tokenResponse = await fetch('/api/csrf-token');
  const tokenPayload = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok || !tokenPayload || typeof tokenPayload.csrfToken !== 'string') {
    throw new Error('Failed to get the connected service CSRF token.');
  }
  const response = await fetch('${path}', {
    method: 'POST',
    headers: { 'X-XSRF-TOKEN': tokenPayload.csrfToken },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload && typeof payload.error === 'string'
      ? payload.error
      : 'Failed to restart the connected Termdock service.');
  }
  return payload;
})()
`;
}

export async function getConnectedServiceRuntimeState(
  webContents: Pick<WebContents, 'executeJavaScript'>,
): Promise<unknown> {
  return webContents.executeJavaScript(GET_CONNECTED_SERVICE_STATE_SCRIPT, true);
}

export async function checkConnectedServiceRuntime(
  webContents: Pick<WebContents, 'executeJavaScript'>,
): Promise<unknown> {
  return webContents.executeJavaScript(
    connectedServiceMutationScript('/api/terminal/update/check'),
    true,
  );
}

export async function restartConnectedServiceRuntime(
  webContents: Pick<WebContents, 'executeJavaScript'>,
): Promise<unknown> {
  return webContents.executeJavaScript(
    connectedServiceMutationScript('/api/terminal/update/restart'),
    true,
  );
}

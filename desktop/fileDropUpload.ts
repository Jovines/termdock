export const REMOTE_FILE_DROP_DIRECTORY = '/tmp';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '[::1]']);

export function shouldUploadDroppedFiles(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(normalized)) return false;
  return !/^127(?:\.\d{1,3}){3}$/.test(normalized);
}

type UploadResponse = {
  files?: Array<{ path?: unknown }>;
  error?: unknown;
};

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null) as UploadResponse | null;
  return new Error(typeof body?.error === 'string' && body.error ? body.error : fallback);
}

/** Upload native desktop drops to the Termdock service loaded in this window. */
export async function uploadDroppedFiles(
  files: File[],
  fetchRequest: typeof fetch = fetch,
): Promise<string[]> {
  if (files.length === 0) return [];

  const csrfResponse = await fetchRequest('/api/csrf-token', { credentials: 'same-origin' });
  if (!csrfResponse.ok) throw await responseError(csrfResponse, 'Failed to prepare file upload');
  const csrfBody = await csrfResponse.json() as { csrfToken?: unknown };
  if (typeof csrfBody.csrfToken !== 'string' || !csrfBody.csrfToken) {
    throw new Error('Invalid CSRF token response');
  }

  const formData = new FormData();
  for (const file of files) formData.append('files', file);
  const uploadResponse = await fetchRequest(
    `/api/terminal/fs/upload?dir=${encodeURIComponent(REMOTE_FILE_DROP_DIRECTORY)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-XSRF-TOKEN': csrfBody.csrfToken },
      body: formData,
    },
  );
  if (!uploadResponse.ok) throw await responseError(uploadResponse, 'File upload failed');

  const uploadBody = await uploadResponse.json() as UploadResponse;
  const paths = Array.isArray(uploadBody.files)
    ? uploadBody.files
      .map((file) => file?.path)
      .filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0)
    : [];
  if (paths.length !== files.length) {
    throw new Error('The service did not return every uploaded file path');
  }
  return paths;
}

export function buildClipboardImageFilename(uploadedAt = new Date()): string {
  const timestamp = uploadedAt.toISOString().replace(/[:.]/g, '-');
  return `termdock-clipboard-${timestamp}.png`;
}

/** Upload a PNG read by the native desktop shell to the active service. */
export async function uploadClipboardImage(
  png: ArrayBuffer,
  fetchRequest: typeof fetch = fetch,
  uploadedAt = new Date(),
): Promise<string> {
  if (png.byteLength === 0) throw new Error('Clipboard image is empty');
  const file = new File([png], buildClipboardImageFilename(uploadedAt), { type: 'image/png' });
  const [uploadedPath] = await uploadDroppedFiles([file], fetchRequest);
  if (!uploadedPath) throw new Error('The service did not return a clipboard image path');
  return uploadedPath;
}

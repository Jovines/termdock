export const TEMPORARY_FILE_UPLOAD_DIRECTORY = '/tmp';
export const TEMPORARY_IMAGE_UPLOAD_DIRECTORY = TEMPORARY_FILE_UPLOAD_DIRECTORY;

export interface TemporaryFileUploadResult {
  name: string;
  path: string;
  size: number;
}

export type UploadFilesForTemporaryFile = (
  directory: string,
  files: File[],
) => Promise<{ files: TemporaryFileUploadResult[] }>;

/**
 * Reuse the regular filesystem upload, but keep the phone's local file out
 * of the active workspace. The server returns the collision-safe final path;
 * only that path is inserted, so the reference always points at the file that
 * was actually written.
 */
export async function uploadTemporaryFileAndInsertReference(
  file: File,
  upload: UploadFilesForTemporaryFile,
  insertReference: (path: string) => boolean | Promise<boolean>,
): Promise<TemporaryFileUploadResult> {
  const result = await upload(TEMPORARY_FILE_UPLOAD_DIRECTORY, [file]);
  const uploaded = result.files[0];
  if (!uploaded?.path) {
    throw new Error('Upload did not return a file path');
  }
  let accepted: boolean;
  try { accepted = await insertReference(uploaded.path); }
  catch { throw new UploadedReferenceRejectedError(uploaded); }
  if (!accepted) throw new UploadedReferenceRejectedError(uploaded);
  return uploaded;
}

export class UploadedReferenceRejectedError extends Error {
  constructor(public readonly uploaded: TemporaryFileUploadResult) {
    super('File uploaded, but its reference was not accepted');
    this.name = 'UploadedReferenceRejectedError';
  }
}

// Kept for the image-only picker in the file sidebar.
export const uploadTemporaryImageAndInsertReference = uploadTemporaryFileAndInsertReference;

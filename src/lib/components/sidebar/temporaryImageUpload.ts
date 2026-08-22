export const TEMPORARY_IMAGE_UPLOAD_DIRECTORY = '/tmp';

export interface TemporaryImageUploadResult {
  name: string;
  path: string;
  size: number;
}

export type UploadFilesForTemporaryImage = (
  directory: string,
  files: File[],
) => Promise<{ files: TemporaryImageUploadResult[] }>;

/**
 * Reuse the regular filesystem upload, but keep the phone's local image out
 * of the active workspace. The server returns the collision-safe final path;
 * only that path is inserted, so the reference always points at the file that
 * was actually written.
 */
export async function uploadTemporaryImageAndInsertReference(
  file: File,
  upload: UploadFilesForTemporaryImage,
  insertReference: (path: string) => void,
): Promise<TemporaryImageUploadResult> {
  const result = await upload(TEMPORARY_IMAGE_UPLOAD_DIRECTORY, [file]);
  const uploaded = result.files[0];
  if (!uploaded?.path) {
    throw new Error('Upload did not return a file path');
  }
  insertReference(uploaded.path);
  return uploaded;
}

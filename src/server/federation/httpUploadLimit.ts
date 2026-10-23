const MIB = 1024 * 1024;
/** File bodies include multipart framing; filesystem handlers still enforce
 * the 100 MiB attachment limit. This budget never grants endpoint access. */
export function httpUploadLimit(pathname: string): number {
  const fileUpload = pathname === '/api/terminal/fs/upload'
    || /^\/api\/terminal\/[^/]+\/chat\/attachments$/.test(pathname);
  return (fileUpload ? 110 : 5) * MIB;
}

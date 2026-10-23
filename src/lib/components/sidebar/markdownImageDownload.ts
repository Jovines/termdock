import { downloadFile, saveDownloadBlob, type DownloadResult } from '../../terminal/api';

type DownloadImage = { kind: 'image'; src: string; alt: string; title?: string }
  | { kind: 'mermaid'; svg: string; alt: string; title?: string };

export async function downloadMarkdownImage(image: DownloadImage, signal?: AbortSignal): Promise<DownloadResult> {
  if (image.kind === 'mermaid') {
    return saveDownloadBlob(new Blob([image.svg], { type: 'image/svg+xml' }), 'mermaid.svg', signal);
  }

  const url = new URL(image.src, window.location.href);
  // Markdown local images are resolved to this same-origin endpoint. Reuse
  // the file download API so federation routing and original names are kept.
  if (url.origin === window.location.origin && url.pathname === '/api/terminal/fs/blob') {
    const path = url.searchParams.get('path');
    if (!path) throw new Error('Missing image path');
    return downloadFile(path, signal);
  }

  const response = signal ? await fetch(image.src, { signal }) : await fetch(image.src);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const filename = decodeURIComponent(url.pathname.split('/').pop() || '')
    || `image.${({ 'image/svg+xml': 'svg', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[blob.type] || 'png'}`;
  return saveDownloadBlob(blob, filename, signal);
}

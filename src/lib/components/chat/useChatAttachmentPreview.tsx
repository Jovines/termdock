import { lazy, Suspense, useCallback, useState } from 'react';
import { useShareAccess } from '../../federation/ShareAccessContext';
import { resolveTerminalPath } from '../../terminal/pathLinks';
import { useChatImagePreview } from './useChatImagePreview';
import { chatAttachmentKind, type ChatAttachment } from './chatComposerContent';
const Video = lazy(() => import('./ChatVideoPreviewDialog').then(module => ({ default: module.ChatVideoPreviewDialog })));

/** Both media types use the existing page-owned encrypted resource readers. */
export function useChatAttachmentPreview(files: ChatAttachment[]) {
  const image = useChatImagePreview(files), access = useShareAccess();
  const [video, setVideo] = useState<ChatAttachment | null>(null);
  const close = useCallback(() => setVideo(null), []);
  const open = useCallback((file: ChatAttachment) => {
    if (!image.onPreview) return;
    if (chatAttachmentKind(file) === '视频') {
      const path = resolveTerminalPath(file.path, null);
      if (!path || access !== undefined && !access.directories?.some(grant => {
        const root = grant.path.replace(/\/$/, '');
        return path === root || path.startsWith(`${root}/`);
      })) return;
      setVideo({ ...file, path });
    } else image.onPreview(file);
  }, [image.onPreview, access]);
  return {
    preview: <>{image.preview}{image.onPreview && video && <Suspense fallback={null}><Video file={video} close={close} /></Suspense>}</>,
    onPreview: image.onPreview ? open : undefined,
  };
}

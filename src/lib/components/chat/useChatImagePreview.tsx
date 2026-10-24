import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSessionCapabilities } from '../../federation/ShareAccessContext';
import { chatAttachmentKind, type ChatAttachment } from './chatComposerContent';

const Lightbox = lazy(() => import('../markdown/MarkdownPreview').then(module => ({ default: module.MarkdownImageLightbox })));

/** The existing lightbox fetches private images through the page transport. */
export function useChatImagePreview(files: ChatAttachment[]) {
  const allowed = useSessionCapabilities().has('resource.files');
  const [selected, setSelected] = useState<string | null>(null);
  const images = useMemo(() => files.filter(file => chatAttachmentKind(file) === '图片').map(file => ({
    kind: 'image' as const,
    src: `/api/terminal/fs/blob?${new URLSearchParams({ path: file.path })}`,
    alt: file.name,
    title: file.name,
  })), [files]);
  const index = images.findIndex(image => image.src === selected);
  const open = useCallback((file: ChatAttachment) => {
    if (allowed && chatAttachmentKind(file) === '图片') setSelected(`/api/terminal/fs/blob?${new URLSearchParams({ path: file.path })}`);
  }, [allowed]);
  const close = useCallback(() => setSelected(null), []);
  const change = (next: number) => setSelected(images[next]?.src ?? null);
  useEffect(() => {
    if (!allowed || index < 0) return;
    // The editor can retain focus beneath a portal and stops bubbling keys.
    // Handle preview keys before they reach the underlying composer.
    const keyDown = (event: KeyboardEvent) => {
      if (!['Escape', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        if (event.target instanceof Element && event.target.closest('.session-chat-rich-editor')) {
          event.preventDefault(); event.stopImmediatePropagation();
          if (event.key === 'Tab') document.querySelector<HTMLButtonElement>('[data-markdown-image-lightbox] button')?.focus();
        }
        return;
      }
      if (event.isComposing) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') close();
      else setSelected(images[(index + (event.key === 'ArrowLeft' ? -1 : 1) + images.length) % images.length].src);
    };
    document.addEventListener('keydown', keyDown, true);
    return () => document.removeEventListener('keydown', keyDown, true);
  }, [allowed, index, images, close]);
  return {
    onPreview: allowed ? open : undefined,
    preview: allowed && index >= 0 ? <Suspense fallback={null}><Lightbox images={images} index={index} onChange={change} onClose={close} /></Suspense> : null,
  };
}

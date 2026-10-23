import { Markdown } from './Markdown';
import type { MarkdownRendererProps } from './MarkdownRenderer';

// Preserve the file preview/helper API while all product surfaces use Markdown.
export {
  type MarkdownLocalLinkTarget,
  resolveMarkdownLocalLinkTarget,
  isSvgImageSrc,
  computeMarkdownImageDisplayBox,
  shouldCloseMarkdownImageLightboxDrag,
  __testParseMarkdownListBlock,
  buildMarkdownPreviewRenderResult,
  buildMarkdownPreviewBlocks,
  getMarkdownHeadingPathAtLine,
  getMarkdownHeadingOutline,
  MarkdownImageLightbox,
  ZoomableImage,
  FILE_PREVIEW_HORIZONTAL_SCROLL_CLASS,
  logFilePreviewLoadingEvent,
} from './MarkdownRenderer';

export type MarkdownPreviewProps = Omit<MarkdownRendererProps, 'variant'> & { embedded?: boolean };

/** File-reader adapter: directory/line selection and externally controlled history. */
export function MarkdownPreview({
  embedded = false, referenceLines = true, content, filePath, rootPath,
  onLocalLinkOpen, lineRange, onLineRangeClick, onLineRangeDrag, scrollTop,
  outlineOpen, outlineCloseSignal, onOutlineOpen, onOutlineClose,
  lightboxOpen, lightboxCloseSignal, onLightboxOpen, onLightboxClose,
}: MarkdownPreviewProps) {
  return <Markdown
    content={content}
    variant={embedded ? 'prose' : 'document'}
    filePath={filePath}
    rootPath={rootPath}
    onLocalLinkOpen={onLocalLinkOpen}
    fileControls={referenceLines ? {
      lineRange, onLineRangeClick, onLineRangeDrag, scrollTop,
      outlineOpen, outlineCloseSignal, onOutlineOpen, onOutlineClose,
    } : undefined}
    lightbox={lightboxOpen === undefined ? undefined : {
      open: lightboxOpen, closeSignal: lightboxCloseSignal,
      onOpen: onLightboxOpen, onClose: onLightboxClose,
    }}
  />;
}

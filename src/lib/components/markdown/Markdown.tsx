import { MarkdownRenderer, type MarkdownLocalLinkTarget, type MarkdownRendererProps, type MarkdownVariant } from './MarkdownRenderer';
import './markdown.css';

export type { MarkdownLocalLinkTarget, MarkdownVariant } from './MarkdownRenderer';

/** Source navigation belongs to file previews, not to prose consumers. */
export type MarkdownFileControls = Pick<MarkdownRendererProps,
  'lineRange' | 'onLineRangeClick' | 'onLineRangeDrag' | 'scrollTop' |
  'outlineOpen' | 'outlineCloseSignal' | 'onOutlineOpen' | 'onOutlineClose'
>;

/** Omit this to let Markdown own its gallery. File previews supply history state. */
export interface MarkdownLightboxControls {
  open: boolean;
  closeSignal?: number;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface MarkdownProps {
  content: string;
  /** Typography only; every variant has the same syntax, safety and media support. */
  variant?: MarkdownVariant;
  /** Resolve relative resources against the document, then the workspace root. */
  filePath?: string | null;
  rootPath?: string | null;
  onLocalLinkOpen?: (target: MarkdownLocalLinkTarget) => void;
  fileControls?: MarkdownFileControls;
  lightbox?: MarkdownLightboxControls;
}

const ignoreLineRange = () => {};

/** All product Markdown goes through this component, including file previews.
 * Keep parsing, safe HTML, failure recovery, highlighting, math and media here;
 * callers choose typography and optionally provide file navigation controls.
 */
export function Markdown({ content, variant = 'prose', filePath = null, rootPath = null, onLocalLinkOpen, fileControls, lightbox }: MarkdownProps) {
  return <MarkdownRenderer
    content={content}
    variant={variant}
    filePath={filePath}
    rootPath={rootPath}
    onLocalLinkOpen={onLocalLinkOpen}
    referenceLines={Boolean(fileControls)}
    lineRange={fileControls?.lineRange ?? null}
    onLineRangeClick={fileControls?.onLineRangeClick ?? ignoreLineRange}
    onLineRangeDrag={fileControls?.onLineRangeDrag}
    scrollTop={fileControls?.scrollTop ?? 0}
    outlineOpen={fileControls?.outlineOpen ?? false}
    outlineCloseSignal={fileControls?.outlineCloseSignal}
    onOutlineOpen={fileControls?.onOutlineOpen}
    onOutlineClose={fileControls?.onOutlineClose}
    lightboxOpen={lightbox?.open}
    lightboxCloseSignal={lightbox?.closeSignal}
    onLightboxOpen={lightbox?.onOpen}
    onLightboxClose={lightbox?.onClose}
  />;
}

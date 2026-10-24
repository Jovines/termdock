import './openuiRuntime';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createLibrary, defineComponent, useStateField, type ComponentRenderProps } from '@openuidev/react-lang';
import { openuiLibrary } from '@openuidev/react-ui/genui-lib';
import { ThemeContext, defaultLightTheme, defaultDarkTheme } from '@openuidev/react-ui/ThemeProvider';
import { X } from 'lucide-react';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';
import { readImagePreviewBlob } from '../../terminal/api';
import { fetchPreviewResource } from '../../utils/previewResourceCache';
import { useChatFileNavigation } from './ChatFileNavigation';
import { resolveMarkdownLocalLinkTarget } from '../markdown/MarkdownPreview';
import { CodeBlock } from './ChatMarkdownBridge';
import { ChatUIDatePicker } from './ChatUIDatePicker';
import { ChatMarkdown } from './ChatMarkdown';
import { chatUISchemas } from '../../../server/shared/chatUILibrary';

export const FullUIContext = createContext({ canWrite: false, canReadPath: (_path: string): boolean => false, openFile: (_path: string) => {} });
const IMAGE_KEYS = new Set(['src', 'bgImageSrc', 'imageSrc', 'imageUrl']);
/** Convert local images before mounting vendor components: native img/background
 * requests cannot inherit the page's encrypted fetch wrapper. */
async function prepareMedia(value: unknown, base: string | null, canReadPath: (path: string) => boolean, signal: AbortSignal, urls: string[], key = ''): Promise<unknown> {
  if (typeof value === 'string' && IMAGE_KEYS.has(key) && value) {
    if (/^https?:\/\//i.test(value) && new URL(value).origin !== location.origin) return value;
    if (/^blob:/i.test(value)) return value;
    let blob: Blob;
    if (value.startsWith('/api/terminal/fs/blob?')) {
      const path = new URL(value, location.origin).searchParams.get('path');
      if (!path || !canReadPath(path)) throw new Error('没有此图片的访问权限');
      const response = await fetchPreviewResource(value, { signal });
      if (!response.ok) throw new Error('图片读取失败');
      blob = await response.blob();
    } else {
      const target = resolveMarkdownLocalLinkTarget(value, base, null);
      if (!target || !canReadPath(target.path)) throw new Error('图片路径无效或未授权');
      blob = (await readImagePreviewBlob(target.path, signal)).blob;
    }
    if (signal.aborted) throw signal.reason;
    const url = URL.createObjectURL(blob); urls.push(url); return url;
  }
  if (Array.isArray(value)) return Promise.all(value.map(child => prepareMedia(child, base, canReadPath, signal, urls)));
  if (value && typeof value === 'object') {
    // Preserve runtime reactive bindings and action ASTs; only plain props carry images.
    if ('__openuiReactive' in value || 'steps' in value) return value;
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([name, child]) => [name, await prepareMedia(child, base, canReadPath, signal, urls, name)])));
  }
  return value;
}
const hasImages = (value: unknown): boolean => !!value && typeof value === 'object' && Object.entries(value).some(([key, child]) => IMAGE_KEYS.has(key) && typeof child === 'string' && !!child || hasImages(child));
function MediaComponent({ component: Component, ...input }: ComponentRenderProps & { component: ComponentType<ComponentRenderProps> }) {
  const { canReadPath } = useContext(FullUIContext), navigation = useChatFileNavigation();
  const source = JSON.stringify(input.props);
  const [prepared, setPrepared] = useState<{ source: string; props?: Record<string, unknown>; error?: string }>();
  useEffect(() => {
    const controller = new AbortController(), urls: string[] = [];
    void prepareMedia(input.props, navigation?.filePath ?? null, canReadPath, controller.signal, urls).then(props => {
      if (!controller.signal.aborted) setPrepared({ source, props: props as Record<string, unknown> });
    }).catch(error => { if (!controller.signal.aborted) setPrepared({ source, error: error instanceof Error ? error.message : '图片读取失败' }); });
    return () => { controller.abort(); urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [source, navigation?.filePath, canReadPath]);
  if (prepared?.source !== source) return <p role="status" className="text-xs text-muted-foreground">正在读取图片…</p>;
  if (prepared.error) return <p role="alert" className="text-xs text-destructive">{prepared.error}</p>;
  return <Component {...input} props={prepared.props!} />;
}
function FullModal({ props, renderNode }: ComponentRenderProps) {
  const field = useStateField('open', props.open), panel = useRef<HTMLDivElement>(null);
  const open = field.value === true || field.value === 'true';
  const close = () => field.setValue(false);
  useKeyboardLayer(panel, open, close);
  if (!open) return null;
  return createPortal(<div className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-[var(--app-backdrop)] preview-safe-area [--preview-safe-area-gap:0.5rem] sm:[--preview-safe-area-gap:1.5rem]" data-sidebar-gesture-ignore onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={String(props.title)} className="z-modal-panel flex max-h-full min-h-0 w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-surface text-foreground">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4"><h3 className="min-w-0 flex-1 truncate text-base font-medium">{String(props.title)}</h3><button type="button" aria-label="关闭" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-surface-2" onClick={close}><X size={18} /></button></header>
      <div className="termdock-rich-ui min-h-0 overflow-auto p-4">{renderNode(props.children) as ReactNode}</div>
    </section>
  </div>, document.body);
}
const editComponents = new Set(['Button', 'IconButton', 'Input', 'TextArea', 'Select', 'DatePicker', 'Slider', 'CheckBoxGroup', 'RadioGroup', 'SwitchGroup', 'Chips', 'OptionCards', 'EditableTable']);
function ComponentBoundary({ component: Component, name, ...input }: ComponentRenderProps & { component: ComponentType<ComponentRenderProps>; name: string }) {
  const { canWrite } = useContext(FullUIContext);
  const content = hasImages(input.props) ? <MediaComponent component={Component} {...input} /> : <Component {...input} />;
  return <div className="min-w-0 max-w-full" {...(!canWrite && editComponents.has(name) ? { inert: '' } : {})}>{content}</div>;
}
const Resource = defineComponent({ name: 'Resource', props: chatUISchemas.Resource, description: 'User-opened file preview or external web link.', component: ({ props }) => {
  const { openFile } = useContext(FullUIContext);
  const label = String(props.label), target = String(props.target);
  const className = 'inline-flex min-h-11 max-w-full items-center rounded-xl border border-border px-3 py-2 text-sm text-primary hover:bg-surface-2';
  if (props.kind === 'link') return /^https?:\/\//i.test(target) ? <a className={className} href={target} target="_blank" rel="noopener noreferrer">{label}</a> : <span>{label}</span>;
  return <button type="button" className={className} onClick={() => openFile(target)}>{label}</button>;
} });
export const chatFullUILibrary = createLibrary({ id: 'termdock-chat@2', root: 'Stack', components: [
  ...Object.values(openuiLibrary.components).map(definition => ({ ...definition,
    component: definition.name === 'DatePicker' ? ChatUIDatePicker : definition.name === 'CodeBlock' ? ({ props }: ComponentRenderProps) => <CodeBlock language={String(props.language)} codeString={String(props.codeString)} /> : definition.name === 'Modal' ? FullModal : definition.name === 'MarkDownRenderer' ? ({ props }: ComponentRenderProps) => <ChatMarkdown content={String(props.textMarkdown ?? '')} />
      : (props: ComponentRenderProps) => <ComponentBoundary {...props} name={definition.name} component={definition.component as ComponentType<ComponentRenderProps>} />,
  })), Resource,
] });
export function FullUITheme({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<'light' | 'dark'>(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  const value = useMemo(() => ({ theme: { ...(mode === 'dark' ? defaultDarkTheme : defaultLightTheme), defaultChartPalette: ['var(--primary)', 'var(--accent)', 'var(--warning)', 'var(--tmux)', 'var(--destructive)', 'var(--foreground)'] }, mode, portalThemeClassName: 'termdock-rich-ui' }), [mode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Copy, X } from 'lucide-react';
import { analysisFile, buildArchitecturePrompt, normalizeAnalysis, type ArchitectureAnalysis } from '../../architecture/model';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';
import { useI18n } from '../../i18n';

export function ArchitectureGenerationForm({ rootPath, initial, outputFile, active = true, onInsertPrompt, onPrepared, onClose }: {
  rootPath: string;
  initial: ArchitectureAnalysis;
  outputFile?: string;
  active?: boolean;
  onInsertPrompt: (prompt: string, source: HTMLElement) => boolean | Promise<boolean>;
  onPrepared: (file: string, analysis: ArchitectureAnalysis) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const form = useRef<HTMLFormElement>(null);
  useKeyboardLayer(form, active, onClose);
  useLayoutEffect(() => { if (active) form.current?.scrollIntoView?.({ block: 'start' }); }, [active]);
  const fieldId = useId();
  const [kind, setKind] = useState(initial.kind);
  const [target, setTarget] = useState(initial.target);
  const [paths, setPaths] = useState(initial.paths.join('\n'));
  const [depth, setDepth] = useState(initial.depth);
  const [focus, setFocus] = useState(initial.focus);
  const [feedback, setFeedback] = useState<'inserted' | 'copied' | 'failed' | 'insertFailed' | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => { if (!active) { request.current++; setPending(false); } }, [active]);
  let scope: ArchitectureAnalysis | null = null;
  try { scope = normalizeAnalysis({ kind, target, paths: paths.split('\n').map(path => path.trim()).filter(Boolean), depth, focus }); } catch { /* validated below */ }
  const prompt = scope ? buildArchitecturePrompt(rootPath, locale, scope, outputFile) : '';
  const button = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-medium transition hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';
  const field = 'min-h-10 w-full min-w-0 rounded-lg border border-border/20 bg-surface px-2 py-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring';
  const change = () => { request.current++; setPending(false); setFeedback(null); };
  const prepared = scope;
  return <form ref={form} tabIndex={-1} className="space-y-3 rounded-xl border border-border/20 bg-surface-2 p-3" onSubmit={event => {
    event.preventDefault();
    if (!prepared || pending || !active || !form.current) return;
    const revision = ++request.current;
    const source = form.current;
    // Disabling the focused submit button otherwise drops browser focus to body.
    source.focus({ preventScroll: true });
    setPending(true); setFeedback(null);
    void Promise.resolve().then(() => revision === request.current && source.isConnected ? onInsertPrompt(prompt, source) : false).then(ok => {
      if (revision !== request.current) return;
      if (ok === true) { onPrepared(outputFile ?? analysisFile(prepared), prepared); setFeedback('inserted'); }
      else setFeedback('insertFailed');
    }).catch(() => { if (revision === request.current) setFeedback('insertFailed'); })
      .finally(() => { if (revision === request.current) setPending(false); });
  }}>
    <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-medium">{t(outputFile ? 'architecture.updateAnalysis' : 'architecture.prepare')}</h2><button type="button" className={`${button} px-2`} aria-label={t('architecture.closePreparation')} onClick={onClose}><X size={16} /></button></div>
    <label className="block space-y-1 text-xs" htmlFor={`${fieldId}-kind`}><span>{t('architecture.analysisRange')}</span><select id={`${fieldId}-kind`} className={field} value={kind} disabled={!!outputFile} onChange={event => { setKind(event.target.value as ArchitectureAnalysis['kind']); change(); }}>
      <option value="project">{t('architecture.projectRange')}</option><option value="module">{t('architecture.moduleRange')}</option><option value="feature">{t('architecture.featureRange')}</option>
    </select></label>
    {kind === 'module' && <label className="block space-y-1 text-xs" htmlFor={`${fieldId}-paths`}><span>{t('architecture.modulePaths')}</span><textarea id={`${fieldId}-paths`} className={`${field} resize-y font-mono`} rows={2} value={paths} readOnly={!!outputFile} placeholder={t('architecture.modulePlaceholder')} onChange={event => { setPaths(event.target.value); change(); }} aria-describedby={`${fieldId}-validation`} /></label>}
    {kind === 'feature' && <label className="block space-y-1 text-xs" htmlFor={`${fieldId}-target`}><span>{t('architecture.featureTarget')}</span><input id={`${fieldId}-target`} className={field} value={target} readOnly={!!outputFile} maxLength={1000} placeholder={t('architecture.featurePlaceholder')} onChange={event => { setTarget(event.target.value); change(); }} aria-describedby={`${fieldId}-validation`} /></label>}
    {!scope && <p id={`${fieldId}-validation`} role={paths.trim() || target.trim() ? 'alert' : undefined} className="text-xs text-muted-foreground">{t(kind === 'module' ? 'architecture.invalidPaths' : 'architecture.requiredFeature')}</p>}
    <p className="text-xs leading-relaxed text-muted-foreground">{t(outputFile ? 'architecture.updateOnly' : 'architecture.independentHint')}</p>
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={!scope || pending} className={`${button} bg-primary/15 text-primary`}>{t(pending ? 'architecture.inserting' : 'architecture.insertPrompt')}</button>
      <button type="button" disabled={!scope || pending} className={button} onClick={() => {
        if (!prepared) return;
        const revision = ++request.current;
        void Promise.resolve().then(() => navigator.clipboard.writeText(prompt)).then(() => { if (revision !== request.current) return; onPrepared(outputFile ?? analysisFile(prepared), prepared); setFeedback('copied'); }).catch(() => { if (revision === request.current) setFeedback('failed'); });
      }}><Copy size={14} />{t('architecture.copyPrompt')}</button>
    </div>
    {feedback && <p role="status" className="text-xs text-muted-foreground">{t(`architecture.${feedback}`)}</p>}
    <details><summary className="cursor-pointer py-2 text-xs text-muted-foreground">{t('architecture.analysisOptions')}</summary><div className="space-y-3 pt-1">
      <label className="block space-y-1 text-xs" htmlFor={`${fieldId}-depth`}><span>{t('architecture.dependencyDepth')}</span><select id={`${fieldId}-depth`} className={field} value={depth} onChange={event => { setDepth(event.target.value as ArchitectureAnalysis['depth']); change(); }}><option value="boundary">{t('architecture.boundaryDepth')}</option><option value="dependencies">{t('architecture.followDepth')}</option></select></label>
      {kind === 'feature' && <label className="block space-y-1 text-xs" htmlFor={`${fieldId}-starts`}><span>{t('architecture.startPaths')}</span><textarea id={`${fieldId}-starts`} rows={2} className={`${field} resize-y font-mono`} value={paths} readOnly={!!outputFile} placeholder={t('architecture.modulePlaceholder')} onChange={event => { setPaths(event.target.value); change(); }} /></label>}
      <label className="block space-y-1 text-xs" htmlFor={`${fieldId}-focus`}><span>{t('architecture.focus')}</span><textarea id={`${fieldId}-focus`} className={`${field} resize-y`} rows={2} maxLength={2000} value={focus} placeholder={t('architecture.focusPlaceholder')} onChange={event => { setFocus(event.target.value); change(); }} /></label>
    </div></details>
    <details><summary className="cursor-pointer py-2 text-xs text-muted-foreground">{t('architecture.previewPrompt')}</summary><textarea readOnly aria-label={t('architecture.previewPrompt')} value={prompt} className={`${field} mt-2 h-52 resize-y font-mono text-xs`} /></details>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('architecture.promptHint')}</p>
  </form>;
}

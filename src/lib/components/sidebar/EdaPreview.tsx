import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { RefreshCw as RiRefresh } from 'lucide-react';
import { useI18n } from '../../i18n';
import { inspectEdaPoint, type EdaPointInspection, type EdaPreviewView } from '../../terminal/api';
import { SvgInspectionPreview } from './SvgInspectionPreview';
import { FloatingAnnotationButton } from './FloatingAnnotationButton';

interface EdaPreviewProps {
  blobUrl: string;
  filePath: string;
  view: EdaPreviewView;
  board: boolean;
  onViewChange: (view: EdaPreviewView) => void;
  onInsertAnnotation?: (text: string, key: string) => void;
  onRefresh: () => void;
  /** Interactive viewer used for KiCad's exported PCB GLB. */
  interactive3d?: ReactNode;
}

interface PickPoint {
  xPercent: number;
  yPercent: number;
}

interface DisplayPickPoint extends PickPoint {
  stageXPercent: number;
  stageYPercent: number;
  inspection?: EdaPointInspection;
  inspecting?: boolean;
}

export function edaViewLabel(view: EdaPreviewView): string {
  switch (view) {
  case 'schematic': return '原理图第1页';
  case 'pcb-front': return 'PCB正面';
  case 'pcb-back': return 'PCB背面（镜像）';
  case 'pcb-3d': return 'PCB 3D正面';
  }
}

export function formatEdaAnnotation(filePath: string, view: EdaPreviewView, point: PickPoint, inspection?: EdaPointInspection): string {
  const fields = [
    `电子标注: ${filePath}`,
    `视图: ${edaViewLabel(view)}`,
    `图片位置: (${point.xPercent.toFixed(1)}%,${point.yPercent.toFixed(1)}%) [相对渲染图左上角]`,
  ];
  if (inspection?.available && inspection.xMm !== undefined && inspection.yMm !== undefined) {
    fields.push(`PCB坐标: (${inspection.xMm.toFixed(2)},${inspection.yMm.toFixed(2)})mm [KiCad板坐标]`);
    if (inspection.layer) fields.push(`显示层: ${inspection.layer}`);
    if (inspection.nearest) {
      const details = [
        inspection.nearest.net ? `网络 ${inspection.nearest.net}` : null,
        `对象层 ${inspection.nearest.layer}`,
        `距离 ${inspection.nearest.distanceMm.toFixed(2)}mm`,
      ].filter(Boolean).join('，');
      fields.push(`最近对象: ${inspection.nearest.label}${details ? `（${details}）` : ''}`);
    }
  }
  return `"${fields.join(' / ')}"`;
}

export function EdaPreview({
  blobUrl,
  filePath,
  view,
  board,
  onViewChange,
  onInsertAnnotation,
  onRefresh,
  interactive3d,
}: EdaPreviewProps) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const inspectionControllerRef = useRef<AbortController | null>(null);
  const [pick, setPick] = useState<DisplayPickPoint | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    inspectionControllerRef.current?.abort();
    setPick(null);
    setLoaded(false);
    return () => inspectionControllerRef.current?.abort();
  }, [blobUrl, view]);

  const annotation = useMemo(
    () => pick ? formatEdaAnnotation(filePath, view, pick, pick.inspection) : null,
    [filePath, pick, view],
  );

  const handlePick = (event: MouseEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image || !image.naturalWidth || !image.naturalHeight) return;
    const rect = stage.getBoundingClientRect();
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const renderedWidth = image.naturalWidth * scale;
    const renderedHeight = image.naturalHeight * scale;
    const left = rect.left + (rect.width - renderedWidth) / 2;
    const top = rect.top + (rect.height - renderedHeight) / 2;
    const x = event.clientX - left;
    const y = event.clientY - top;
    if (x < 0 || y < 0 || x > renderedWidth || y > renderedHeight) return;
    const nextPick: DisplayPickPoint = {
      xPercent: Math.max(0, Math.min(100, (x / renderedWidth) * 100)),
      yPercent: Math.max(0, Math.min(100, (y / renderedHeight) * 100)),
      stageXPercent: ((event.clientX - rect.left) / rect.width) * 100,
      stageYPercent: ((event.clientY - rect.top) / rect.height) * 100,
      inspecting: board && view !== 'pcb-3d',
    };
    setPick(nextPick);
    inspectionControllerRef.current?.abort();
    if (!nextPick.inspecting) return;
    const controller = new AbortController();
    inspectionControllerRef.current = controller;
    void inspectEdaPoint(filePath, view, nextPick.xPercent, nextPick.yPercent, controller.signal)
      .then((inspection) => setPick((current) => current === nextPick ? { ...current, inspection, inspecting: false } : current))
      .catch(() => {
        if (!controller.signal.aborted) {
          setPick((current) => current === nextPick ? { ...current, inspection: { available: false }, inspecting: false } : current);
        }
      });
  };

  const views: EdaPreviewView[] = board ? ['pcb-front', 'pcb-back', 'pcb-3d'] : ['schematic'];

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/15 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {views.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => onViewChange(candidate)}
              className={`h-8 shrink-0 rounded-full px-3 text-xs font-semibold transition active:scale-95 ${candidate === view ? 'bg-primary/15 text-primary' : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'}`}
            >
              {edaViewLabel(candidate)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
          title={t('rightSidebar.edaRefresh')}
          aria-label={t('rightSidebar.edaRefresh')}
        >
          <RiRefresh size={13} />
        </button>
      </div>

      {board && interactive3d ? (
        <div className={view === 'pcb-3d' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
          {interactive3d}
        </div>
      ) : null}

      {!board ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <SvgInspectionPreview
            blobUrl={blobUrl}
            filePath={filePath}
            viewLabel={edaViewLabel(view)}
            onInsertAnnotation={onInsertAnnotation}
          />
        </div>
      ) : view === 'pcb-3d' ? (
        interactive3d ? null : <div className="min-h-0 flex-1" />
      ) : (
        <>
          <div
            ref={stageRef}
            role="button"
            tabIndex={0}
            onClick={handlePick}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              setPick({ xPercent: 50, yPercent: 50, stageXPercent: 50, stageYPercent: 50 });
            }}
            className="relative min-h-0 flex-1 cursor-crosshair overflow-hidden bg-surface p-3 outline-none"
            title={t('rightSidebar.edaPickHint')}
          >
            <img
              ref={imageRef}
              src={blobUrl}
              alt={`${filePath} ${edaViewLabel(view)}`}
              onLoad={() => setLoaded(true)}
              className={`pointer-events-none h-full w-full object-contain transition-opacity ${loaded ? 'opacity-100' : 'opacity-0'}`}
            />
            {pick && (
              <span
                className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-surface shadow-sm"
                style={{ left: `${pick.stageXPercent}%`, top: `${pick.stageYPercent}%` }}
              />
            )}
            {pick && annotation && (
              <FloatingAnnotationButton
                anchor={{ xPercent: pick.stageXPercent, yPercent: pick.stageYPercent }}
                disabled={pick.inspecting}
                title={t('rightSidebar.edaInsertAnnotation')}
                onClick={() => {
                  onInsertAnnotation?.(annotation, `eda:${view}:${pick.xPercent.toFixed(1)}:${pick.yPercent.toFixed(1)}`);
                  setPick(null);
                }}
              >
                {t('rightSidebar.edaInsertAnnotation')}
              </FloatingAnnotationButton>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/15 px-3 py-2">
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {pick
                ? pick.inspecting
                  ? t('rightSidebar.edaInspecting')
                  : pick.inspection?.available
                    ? t('rightSidebar.edaPickedBoardPosition', {
                      x: pick.inspection.xMm?.toFixed(2) ?? '—',
                      y: pick.inspection.yMm?.toFixed(2) ?? '—',
                      object: pick.inspection.nearest?.label ?? t('rightSidebar.edaNoNearbyObject'),
                    })
                    : t('rightSidebar.edaPickedPosition', { x: pick.xPercent.toFixed(1), y: pick.yPercent.toFixed(1) })
                : t('rightSidebar.edaPickHint')}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

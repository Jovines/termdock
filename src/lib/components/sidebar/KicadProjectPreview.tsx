import { useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { FloatingAnnotationButton } from './FloatingAnnotationButton';

interface SummaryItem {
  label: string;
  value: string;
}

function valueAt(root: unknown, keys: string[]): unknown {
  let current = root;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function summarizeKicadJson(content: string, localState: boolean): SummaryItem[] {
  const data = JSON.parse(content) as Record<string, unknown>;
  const metaVersion = valueAt(data, ['meta', 'version']);
  if (localState) {
    return [
      { label: '文件性质', value: 'KiCad 本机界面状态，不属于电气设计源文件' },
      { label: '格式版本', value: String(metaVersion ?? '未知') },
      { label: '活动层编号', value: String(valueAt(data, ['board', 'active_layer']) ?? '未知') },
      { label: '可见层掩码', value: String(valueAt(data, ['board', 'visible_layers']) ?? '未知') },
      { label: 'Git 集成', value: valueAt(data, ['git', 'integration_disabled']) === true ? '已禁用' : '未禁用' },
    ];
  }

  const netClasses = valueAt(data, ['net_settings', 'classes']);
  const defaultClass = Array.isArray(netClasses)
    ? netClasses.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).name === 'Default') as Record<string, unknown> | undefined
    : undefined;
  const exclusions = valueAt(data, ['board', 'design_settings', 'drc_exclusions']);
  return [
    { label: '文件性质', value: 'KiCad 工程配置' },
    { label: '格式版本', value: String(metaVersion ?? '未知') },
    { label: '网络类数量', value: String(Array.isArray(netClasses) ? netClasses.length : 0) },
    { label: '默认间距', value: defaultClass?.clearance !== undefined ? `${defaultClass.clearance} mm` : '未设置' },
    { label: '默认线宽', value: defaultClass?.track_width !== undefined ? `${defaultClass.track_width} mm` : '未设置' },
    { label: '默认过孔', value: defaultClass?.via_diameter !== undefined ? `${defaultClass.via_diameter} / ${defaultClass.via_drill ?? '—'} mm（外径/钻孔）` : '未设置' },
    { label: 'DRC 排除项', value: String(Array.isArray(exclusions) ? exclusions.length : 0) },
  ];
}

export function formatKicadProjectAnnotation(filePath: string, item: SummaryItem): string {
  return `"KiCad项目标注: ${filePath} / 项: ${item.label} / 值: ${item.value}"`;
}

export function KicadProjectPreview({ content, filePath, localState, onInsertAnnotation }: {
  content: string;
  filePath: string;
  localState: boolean;
  onInsertAnnotation?: (text: string, key: string) => void;
}) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<{ index: number; xPercent: number; yPercent: number } | null>(null);
  const result = useMemo(() => {
    try {
      return { items: summarizeKicadJson(content, localState), error: null };
    } catch (error) {
      return { items: [], error: error instanceof Error ? error.message : String(error) };
    }
  }, [content, localState]);
  const selectedItem = selected === null ? null : result.items[selected.index];

  if (result.error) {
    return <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-foreground">{content}</pre>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      {localState && (
        <div className="border-b border-[color:var(--warning)]/20 bg-[color:var(--warning)]/5 px-3 py-2 text-xs text-[color:var(--warning)]">
          {t('rightSidebar.kicadLocalStateNotice')}
        </div>
      )}
      <div ref={stageRef} className="relative min-h-0 flex-1">
        <div className="h-full overflow-auto px-3 py-2">
          <div className="divide-y divide-border/15">
          {result.items.map((item, index) => (
            <button
              key={item.label}
              type="button"
              onClick={(event) => {
                const stageRect = stageRef.current?.getBoundingClientRect();
                const rowRect = event.currentTarget.getBoundingClientRect();
                if (!stageRect?.width || !stageRect.height) return;
                const clientX = event.clientX || rowRect.left + rowRect.width / 2;
                const clientY = event.clientY || rowRect.top + rowRect.height / 2;
                setSelected({
                  index,
                  xPercent: (clientX - stageRect.left) / stageRect.width * 100,
                  yPercent: (clientY - stageRect.top) / stageRect.height * 100,
                });
              }}
              className={`grid w-full grid-cols-[minmax(7rem,0.8fr)_minmax(0,1.4fr)] gap-3 px-2 py-3 text-left transition hover:bg-surface-2 ${selected?.index === index ? 'bg-primary/10' : ''}`}
            >
              <span className="text-xs font-semibold text-muted-foreground">{item.label}</span>
              <span className="break-words text-xs text-foreground">{item.value}</span>
            </button>
          ))}
          </div>
          <details className="mt-3 border-t border-border/15 pt-3">
            <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">{t('rightSidebar.kicadShowRawJson')}</summary>
            <pre className="mt-2 overflow-auto whitespace-pre p-2 font-mono text-[10px] leading-relaxed text-foreground">{content}</pre>
          </details>
        </div>
        {selectedItem && selected && (
          <FloatingAnnotationButton
            anchor={{ xPercent: selected.xPercent, yPercent: selected.yPercent }}
            title={t('rightSidebar.kicadInsertSetting')}
            onClick={() => {
              onInsertAnnotation?.(formatKicadProjectAnnotation(filePath, selectedItem), `kicad-project:${filePath}:${selectedItem.label}`);
              setSelected(null);
            }}
          >
            {t('rightSidebar.kicadInsertSetting')}
          </FloatingAnnotationButton>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/15 px-3 py-2">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {selectedItem ? `${selectedItem.label}: ${selectedItem.value}` : t('rightSidebar.kicadProjectPickHint')}
        </span>
      </div>
    </div>
  );
}

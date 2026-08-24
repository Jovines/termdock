import { useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { FloatingAnnotationButton } from './FloatingAnnotationButton';

export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

export function formatCsvAnnotation(filePath: string, headers: string[], row: string[], rowIndex: number, columnIndex: number): string {
  const column = headers[columnIndex] || `第${columnIndex + 1}列`;
  const value = row[columnIndex] ?? '';
  const record = headers
    .map((header, index) => `${header || `第${index + 1}列`}=${row[index] ?? ''}`)
    .join('；');
  return `"表格标注: ${filePath} / 数据行: ${rowIndex + 1} / 列: ${column} / 值: ${value} / 记录: ${record}"`;
}

export function CsvPreview({ content, filePath, onInsertAnnotation }: {
  content: string;
  filePath: string;
  onInsertAnnotation?: (text: string, key: string) => void;
}) {
  const { t } = useI18n();
  const parsed = useMemo(() => parseCsv(content), [content]);
  const headers = parsed[0] ?? [];
  const rows = parsed.slice(1);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<{ row: number; column: number; xPercent: number; yPercent: number } | null>(null);
  const selectedRow = selected ? rows[selected.row] : null;
  const annotation = selected && selectedRow
    ? formatCsvAnnotation(filePath, headers, selectedRow, selected.row + 1, selected.column)
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div ref={stageRef} className="relative min-h-0 flex-1">
        <div className="h-full overflow-auto">
          <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 border-b border-r border-border/20 bg-surface-elevated px-2 py-2 text-[10px] font-semibold text-muted-foreground">#</th>
              {headers.map((header, index) => (
                <th key={`${header}:${index}`} className="sticky top-0 z-10 min-w-28 border-b border-r border-border/20 bg-surface-elevated px-3 py-2 font-semibold text-foreground">
                  {header || t('rightSidebar.csvUnnamedColumn', { index: index + 1 })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`row:${rowIndex}`} className="hover:bg-surface-2">
                <th className="sticky left-0 z-10 border-b border-r border-border/15 bg-surface px-2 py-2 text-right text-[10px] font-normal text-muted-foreground">{rowIndex + 1}</th>
                {headers.map((_, columnIndex) => {
                  const active = selected?.row === rowIndex && selected.column === columnIndex;
                  return (
                    <td key={`cell:${rowIndex}:${columnIndex}`} className={`border-b border-r border-border/15 p-0 ${active ? 'bg-primary/15' : ''}`}>
                      <button
                        type="button"
                        onClick={(event) => {
                          const stageRect = stageRef.current?.getBoundingClientRect();
                          const cellRect = event.currentTarget.getBoundingClientRect();
                          if (!stageRect?.width || !stageRect.height) return;
                          const clientX = event.clientX || cellRect.left + cellRect.width / 2;
                          const clientY = event.clientY || cellRect.top + cellRect.height / 2;
                          setSelected({
                            row: rowIndex,
                            column: columnIndex,
                            xPercent: (clientX - stageRect.left) / stageRect.width * 100,
                            yPercent: (clientY - stageRect.top) / stageRect.height * 100,
                          });
                        }}
                        className="block h-full min-h-9 w-full whitespace-pre-wrap px-3 py-2 text-left text-foreground outline-none hover:bg-primary/10 focus-visible:bg-primary/10"
                      >
                        {row[columnIndex] || ' '}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          </table>
        </div>
        {selected && annotation && (
          <FloatingAnnotationButton
            anchor={{ xPercent: selected.xPercent, yPercent: selected.yPercent }}
            title={t('rightSidebar.csvInsertAnnotation')}
            onClick={() => {
              onInsertAnnotation?.(annotation, `csv:${filePath}:${selected.row + 1}:${selected.column + 1}`);
              setSelected(null);
            }}
          >
            {t('rightSidebar.csvInsertAnnotation')}
          </FloatingAnnotationButton>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/15 px-3 py-2">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {selected && selectedRow
            ? t('rightSidebar.csvSelectedCell', { row: selected.row + 1, column: headers[selected.column] || selected.column + 1 })
            : t('rightSidebar.csvPickHint', { rows: rows.length, columns: headers.length })}
        </span>
      </div>
    </div>
  );
}

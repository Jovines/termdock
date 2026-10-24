import { ChatMarkdown } from './ChatMarkdown';
/** Adapter for vendor card prose, form options, steps and inline Markdown. */
export function MarkDownRenderer({ textMarkdown, className }: { textMarkdown: string; className?: string; variant?: string; options?: unknown }) {
  return <div className={className}><ChatMarkdown content={textMarkdown ?? ''} /></div>;
}

export function CodeBlock({ language, codeString }: { language: string; codeString: string; theme?: unknown }) {
  // Choose a fence longer than any run in the source so code remains literal.
  const fence = '`'.repeat(Math.max(3, ...Array.from((codeString ?? '').matchAll(/`+/g), match => match[0].length + 1)));
  return <ChatMarkdown content={`${fence}${(language ?? 'text').replace(/[^\w+-]/g, '') || 'text'}\n${codeString ?? ''}\n${fence}`} />;
}

/** Low-level date cells in editable tables also use native pickers. */
export function DatePicker({ selectedSingleDate, setSelectedSingleDate, selectedRangeDates, setSelectedRangeDates, mode = 'single', setIsOpen, className }: {
  selectedSingleDate?: Date; setSelectedSingleDate?: (value?: Date) => void;
  selectedRangeDates?: { from?: Date; to?: Date }; setSelectedRangeDates?: (value?: { from?: Date; to?: Date }) => void;
  mode?: 'single' | 'range'; isOpen?: boolean; setIsOpen?: (open: boolean) => void; className?: string;
}) {
  const date = (value?: Date) => value instanceof Date && Number.isFinite(value.getTime()) ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : '';
  const parsed = (value: string) => value ? new Date(`${value}T00:00:00`) : undefined;
  if (mode === 'range') return <div className={className}>
    <input type="date" aria-label="开始日期" value={date(selectedRangeDates?.from)} onChange={event => setSelectedRangeDates?.({ ...selectedRangeDates, from: parsed(event.target.value) })} />
    <input type="date" aria-label="结束日期" value={date(selectedRangeDates?.to)} onChange={event => setSelectedRangeDates?.({ ...selectedRangeDates, to: parsed(event.target.value) })} />
  </div>;
  return <input type="date" aria-label="日期" className={className} value={date(selectedSingleDate)} onChange={event => { setSelectedSingleDate?.(parsed(event.target.value)); setIsOpen?.(false); }} />;
}

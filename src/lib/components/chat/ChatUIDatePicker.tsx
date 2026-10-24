import { useContext, useEffect, useMemo } from 'react';
import { parseStructuredRules, useFormValidation, useIsStreaming, useStateField, type ComponentRenderProps } from '@openuidev/react-lang';
import { FullUIContext } from './chatFullUIRuntime';
const day = (value: unknown): string => typeof value === 'string' ? value.slice(0, 10) : value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : '';
/** Native date controls keep OS picker accessibility and safe areas, while ISO
 * values survive persistence and can bind to variables and query arguments. */
export function ChatUIDatePicker({ props }: ComponentRenderProps) {
  const field = useStateField(String(props.name), props.value), validation = useFormValidation();
  const streaming = useIsStreaming(), { canWrite } = useContext(FullUIContext);
  const rules = useMemo(() => parseStructuredRules(props.rules), [props.rules]);
  const range = props.mode === 'range';
  const values = range && field.value && typeof field.value === 'object' ? field.value as { from?: unknown; to?: unknown } : {};
  const from = day(values.from), to = day(values.to);
  useEffect(() => {
    if (streaming || !rules.length || !validation) return;
    validation.registerField(field.name, rules, () => range ? from && to && from <= to ? { from, to } : '' : field.value);
    return () => validation.unregisterField(field.name);
  }, [field.name, field.value, rules, validation, range, from, to, streaming]);
  const className = 'min-h-11 min-w-0 w-full rounded-xl border border-border bg-surface px-3 py-2 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
  if (!range) return <input id={field.name} name={field.name} type="date" value={day(field.value)} disabled={streaming || !canWrite} className={className} onChange={event => { field.setValue(event.target.value); validation?.clearFieldError(field.name); }} />;
  return <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
    <label className="min-w-0 text-xs text-muted-foreground">开始日期<input id={field.name} name={field.name} aria-label="开始日期" type="date" value={from} max={to || undefined} disabled={streaming || !canWrite} className={className} onChange={event => { field.setValue({ from: event.target.value, to }); validation?.clearFieldError(field.name); }} /></label>
    <label className="min-w-0 text-xs text-muted-foreground">结束日期<input aria-label="结束日期" type="date" value={to} min={from || undefined} disabled={streaming || !canWrite} className={className} onChange={event => { field.setValue({ from, to: event.target.value }); validation?.clearFieldError(field.name); }} /></label>
  </div>;
}

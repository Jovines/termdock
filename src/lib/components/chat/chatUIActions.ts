import type { ActionEvent, ElementNode } from '@openuidev/lang-core';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Conversation history contains the user's choices, not renderer internals. */
export function chatUIActionText(event: ActionEvent, root: ElementNode | null): string {
  const labels = new Map<string, string>();
  const visit = (value: unknown, form?: string) => {
    if (Array.isArray(value)) { value.forEach(item => visit(item, form)); return; }
    if (!record(value)) return;
    if (value.type === 'element' && record(value.props)) {
      const props = value.props, current = value.typeName === 'Form' ? String(props.name) : form;
      if (['Input', 'Select', 'Checkbox'].includes(String(value.typeName)) && (!event.formName || current === event.formName)) labels.set(String(props.name), String(props.label));
      Object.values(props).forEach(child => visit(child, current));
    }
  };
  visit(root);
  const raw = event.formState || {}, fields = event.formName && record(raw[event.formName]) ? raw[event.formName] as Record<string, unknown> : raw;
  const rows = [...labels].flatMap(([name, label]) => {
    const rawValue = fields[name], value = record(rawValue) && 'value' in rawValue ? rawValue.value : rawValue;
    if (value === undefined || value === null || value === '') return [];
    return [`${label}：${typeof value === 'boolean' ? value ? '是' : '否' : typeof value === 'string' || typeof value === 'number' ? String(value) : ''}`];
  });
  const context = event.params.context;
  return [event.humanFriendlyMessage || '提交填写内容', rows.length ? rows.join('\n') : '', typeof context === 'string' ? context : ''].filter(Boolean).join('\n\n');
}

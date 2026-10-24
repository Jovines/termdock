import type { ActionEvent, ElementNode } from '@openuidev/lang-core';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Conversation history contains the user's choices, not renderer internals. */
export function chatUIActionText(event: ActionEvent, root: ElementNode | null): string {
  const labels = new Map<string, string>(), options = new Map<string, Map<string, string>>(), tables = new Map<string, string[]>();
  const visit = (value: unknown, form?: string, fieldLabel?: string) => {
    if (Array.isArray(value)) { value.forEach(item => visit(item, form, fieldLabel)); return; }
    if (!record(value)) return;
    if (value.type === 'element' && record(value.props)) {
      const props = value.props, current = value.typeName === 'Form' ? String(props.name) : form;
      if (['Input', 'Select', 'Checkbox', 'TextArea', 'DatePicker', 'Slider', 'CheckBoxGroup', 'RadioGroup', 'SwitchGroup', 'Chips', 'OptionCards'].includes(String(value.typeName)) && (!event.formName || current === event.formName)) {
        const name = String(props.name);
        labels.set(name, String(props.label ?? fieldLabel ?? props.text ?? props.name));
        if (Array.isArray(props.items)) options.set(name, new Map(props.items.flatMap(item => {
          if (!record(item) || !record(item.props)) return [];
          const choice = item.props;
          return [[String(choice.value ?? choice.name), String(choice.label ?? choice.title ?? choice.text ?? choice.value ?? choice.name)]];
        })));
      }
      if (value.typeName === 'EditableTable' && (!event.formName || event.formName === props.name)) {
        const name = String(props.name); labels.set(name, '表格修改');
        tables.set(name, Array.isArray(props.columns) ? props.columns.map(column => record(column) ? String(column.header ?? column.key ?? '') : '') : []);
      }
      const label = value.typeName === 'FormControl' && typeof props.label === 'string' ? props.label : fieldLabel;
      Object.values(props).forEach(child => visit(child, current, label));
    }
  };
  visit(root);
  const raw = event.formState || {}, fields = event.formName && record(raw[event.formName]) ? raw[event.formName] as Record<string, unknown> : raw;
  const rows = [...labels].flatMap(([name, label]) => {
    const rawValue = fields[name], value = record(rawValue) && 'value' in rawValue ? rawValue.value : rawValue;
    if (value === undefined || value === null || value === '') return [];
    if (tables.has(name) && Array.isArray(value)) {
      const escape = (cell: unknown) => String(cell ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
      const columns = ['行ID', ...tables.get(name)!];
      const body = value.flatMap(row => record(row) && Array.isArray(row.values) ? [`| ${[row.id, ...row.values].map(escape).join(' | ')} |`] : []);
      return [`${label}：\n| ${columns.map(escape).join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n${body.join('\n')}`];
    }
    const choices = options.get(name);
    const format = (item: unknown) => typeof item === 'boolean' ? item ? '是' : '否' : choices?.get(String(item)) ?? String(item);
    const display = Array.isArray(value) ? value.map(format).join('、') : record(value)
      ? 'from' in value || 'to' in value ? `${String(value.from ?? '')} 至 ${String(value.to ?? '')}`
        : Object.entries(value).map(([key, entry]) => `${choices?.get(key) ?? key}：${format(entry)}`).join('、')
      : format(value);
    return [`${label}：${display}`];
  });
  const context = event.params.context;
  return [event.humanFriendlyMessage || '提交填写内容', rows.length ? rows.join('\n') : '', typeof context === 'string' ? context : context != null ? `关联信息：\n${JSON.stringify(context, null, 2)}` : ''].filter(Boolean).join('\n\n');
}

import { action, createLibrary, defineComponent } from '@openuidev/lang-core';
import { z } from 'zod/v4';
const text = z.string().max(16000), short = z.string().max(160), name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const cell = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);
export const chatUISchemas = {
  Text: z.object({ content: text }),
  Metric: z.object({ label: short, value: short, detail: short.optional() }),
  Callout: z.object({ title: short, content: text, tone: z.enum(['info', 'success', 'warning']).optional() }),
  Table: z.object({ columns: z.array(short).min(1).max(12), rows: z.array(z.array(cell).max(12)).max(300), caption: short.optional() }),
  Chart: z.object({ title: short, labels: z.array(short).min(1).max(30), series: z.array(z.object({ name: short, values: z.array(z.number().finite()).max(30) })).min(1).max(6), kind: z.enum(['bar', 'line']).optional() }),
  Checklist: z.object({ title: short, items: z.array(z.object({ label: short, detail: short.optional(), done: z.boolean() })).max(30) }),
  Input: z.object({ name, label: short, placeholder: short.optional(), required: z.boolean().optional() }),
  Select: z.object({ name, label: short, options: z.array(short).min(1).max(50), required: z.boolean().optional() }),
  Checkbox: z.object({ name, label: short }),
  Button: z.object({ label: short, action: action().optional() }),
  Resource: z.object({ label: short, kind: z.enum(['file', 'link']), target: z.string().max(4096), description: short.optional() }),
};
const components = Object.entries(chatUISchemas).map(([key, props]) => defineComponent({ name: key, props, component: null, description: ({
  Text: 'Markdown prose using the shared preview renderer.', Metric: 'A known metric with label, value and optional context.', Callout: 'An important explanation; tone info/success/warning.', Table: 'A comparison table with horizontally scrollable, filterable and sortable rows.', Chart: 'A chart of supplied factual values. Do not invent values.', Checklist: 'Explicitly reported checklist items, never inferred Agent activity.',
  Input: 'Text field inside Form; name must be unique in that form.', Select: 'Selection field inside Form.', Checkbox: 'Checkbox inside Form.', Button: 'Clickable action. @ToAssistant(message) continues this same conversation; inside Form also sends the form values.', Resource: 'User-opened file preview or external web link. Use an authorized absolute path for files.',
} as Record<string, string>)[key] }));
const refs = z.union(components.map(component => component.ref) as [typeof components[number]['ref'], typeof components[number]['ref'], ...typeof components[number]['ref'][]]);
const Form = defineComponent({ name: 'Form', description: 'User question form. Include Input/Select/Checkbox and a Button with @ToAssistant. Never nest forms.', props: z.object({ name, title: short, fields: z.array(refs).max(30) }), component: null });
const Card = defineComponent({ name: 'Card', description: 'A titled result card, with text, metrics, charts, tables or a form.', props: z.object({ title: short, content: z.array(z.union([refs, Form.ref])).max(30) }), component: null });
const Stack = defineComponent({ name: 'Stack', description: 'Root vertical layout of answer components.', props: z.object({ content: z.array(z.union([refs, Form.ref, Card.ref])).max(40) }), component: null });
export const chatUILibrary = createLibrary({ id: 'termdock-chat@1', root: 'Stack', components: [...components, Form, Card, Stack] });

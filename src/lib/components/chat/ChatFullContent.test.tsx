// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createParser, buildMessage } from '@openuidev/react-lang';
import { openuiLibrary } from '@openuidev/react-ui/genui-lib';
import { chatFullUISpec } from '../../../server/shared/chatFullUICatalog';
import { SessionCapabilitiesContext } from '../../federation/ShareAccessContext';
import { sharedSessionCapabilities } from '../../federation/sessionCapabilities';
import { readFileContent, readImagePreviewBlob } from '../../terminal/api';
import { ChatFullContent } from './ChatFullContent';
import { chatUIActionText } from './chatUIActions';
import { chatFullUILibrary } from './chatFullUIRuntime';
import type { ChatMessage } from './chatMessages';
vi.mock('../../terminal/api', async original => ({ ...await original<typeof import('../../terminal/api')>(), readFileContent: vi.fn(), readImagePreviewBlob: vi.fn() }));
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const message = (code: string, streaming = false): ChatMessage => ({ id: 'full-ui', role: 'assistant', content: '完整文字说明', createdAt: 1, status: 'stored', ui: { version: 2, code, streaming, revision: 0 } });
const mount = (code: string, canWrite = true, onAction = vi.fn().mockResolvedValue(true)) => render(<ChatFullContent message={message(code)} sessionId="full-session" canWrite={canWrite} onAction={onAction} />);
it('registers every official component with matching server signatures, plus the existing resource entry', () => {
  expect(Object.keys(openuiLibrary.components)).toHaveLength(82);
  for (const [name, definition] of Object.entries(openuiLibrary.components)) {
    expect(chatFullUILibrary.components[name].props).toBe(definition.props);
    expect(chatFullUISpec.components[name]).toEqual(openuiLibrary.toSpec().components[name]);
  }
  expect(chatFullUILibrary.components.Resource).toBeTruthy();
  const parsed = createParser(chatFullUILibrary.toJSONSchema()).parse('root = Stack([Tabs([TabItem("a", "图表", [PieChart(["A", "B"], [1, 2])]), TabItem("b", "数据", [Table([Col("值", [1, 2], "number")])])]), Accordion([AccordionItem("more", "更多", [TextContent("说明")])])])');
  expect(parsed.root).toBeTruthy(); expect(parsed.meta.errors).toEqual([]);
});
it('runs bound state, arithmetic and multi-step local actions and persists changes', async () => {
  const fetch = vi.fn(async (_url, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); return Response.json({ revision: body.revision + 1, values: body.values }); }); vi.stubGlobal('fetch', fetch);
  mount('$count = 1\nroot = Stack([TextContent("数量：" + $count), Button("增加", Action([@Set($count, $count + 1)])), Button("重置", @Reset($count))])');
  await screen.findByText('数量：1'); fireEvent.click(screen.getByRole('button', { name: '增加' }));
  await screen.findByText('数量：2'); await waitFor(() => expect(fetch).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: '重置' })); await screen.findByText('数量：1');
});
it('validates official forms, saves before submission and uses visible field labels in the conversation', async () => {
  const onAction = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); return Response.json({ revision: body.revision + 1, values: body.values }); }));
  mount('root = Stack([Form("choice", Buttons([Button("确认选择", @ToAssistant("采用填写内容"))]), [FormControl("补充说明", Input("notes", "输入备注", "text", {required: true}))])])', true, onAction);
  fireEvent.click(await screen.findByRole('button', { name: '确认选择' })); expect(onAction).not.toHaveBeenCalled();
  fireEvent.change(screen.getByPlaceholderText('输入备注'), { target: { value: '需要横屏' } });
  fireEvent.click(screen.getByRole('button', { name: '确认选择' }));
  await waitFor(() => expect(onAction).toHaveBeenCalledOnce());
  expect(onAction.mock.calls[0][0]).toContain('补充说明：需要横屏');
});
it('renders incoming partial snapshots, disables actions until complete and accepts the final snapshot in place', async () => {
  const onAction = vi.fn().mockResolvedValue(true);
  const view = render(<ChatFullContent message={message('root = Stack([TextContent("第一部分"), Button("继续", @ToAssistant("继续")),', true)} sessionId="stream" canWrite onAction={onAction} />);
  await screen.findByText('第一部分'); expect((screen.getByRole('button', { name: '继续' }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<ChatFullContent message={message('root = Stack([TextContent("完整内容"), Button("继续", @ToAssistant("继续"))])')} sessionId="stream" canWrite onAction={onAction} />);
  await screen.findByText('完整内容'); expect((screen.getByRole('button', { name: '继续' }) as HTMLButtonElement).disabled).toBe(false);
});
it('executes authorized Query reads, retries failures, and only runs Mutation after a user click', async () => {
  vi.mocked(readFileContent).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ path: '/tmp/data.txt', content: '读取结果', size: 5, modified: '', binary: false });
  const onAction = vi.fn().mockResolvedValue(true);
  mount('data = Query("read_file", {path: "/tmp/data.txt"}, {content:"等待"})\nsend = Mutation("continue_conversation", {message:"已确认"})\nroot = Stack([TextContent(data.content), Button("确认发送", @Run(send))])', true, onAction);
  await screen.findByRole('alert'); expect(onAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重试读取' }));
  await screen.findByText('读取结果'); fireEvent.click(screen.getByRole('button', { name: '确认发送' }));
  await waitFor(() => expect(onAction).toHaveBeenCalledWith('已确认'));
});
it('blocks write tools in Query and keeps shared controls and undeclared resource reads disabled', async () => {
  const onAction = vi.fn();
  const view = mount('data = Query("continue_conversation", {message:"自动发送"}, {})\nroot = Stack([TextContent("危险")])', true, onAction);
  expect(await screen.findByText('完整文字说明')).toBeTruthy(); expect(onAction).not.toHaveBeenCalled(); view.unmount();
  render(<SessionCapabilitiesContext.Provider value={sharedSessionCapabilities({})}><ChatFullContent message={message('root = Stack([Input("x"), Button("发送", @ToAssistant("执行"))])')} sessionId="shared" canWrite onAction={onAction} /></SessionCapabilitiesContext.Provider>);
  expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
});
it('fetches local media before mounting native image nodes and never falls back to a direct business URL', async () => {
  const objectURL = vi.fn().mockReturnValue('blob:safe-image'); Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: objectURL }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.mocked(readImagePreviewBlob).mockResolvedValue({ blob: new Blob(['image']), path: '/tmp/pic.png', size: 5, modified: '', mimeType: 'image/png' });
  const view = mount('root = Stack([Image("图片", "/tmp/pic.png")])');
  expect(view.container.querySelector('img')).toBeNull();
  expect((await screen.findByRole('img')).getAttribute('src')).toBe('blob:safe-image');
  expect(readImagePreviewBlob).toHaveBeenCalledWith('/tmp/pic.png', expect.any(AbortSignal));
  view.unmount(); vi.mocked(readImagePreviewBlob).mockRejectedValue(new Error('加密链路断开'));
  const failed = mount('root = Stack([Image("图片", "/tmp/pic.png")])');
  await screen.findByRole('alert'); expect(failed.container.querySelector('img')).toBeNull();
});

it('renders the standard stored-message envelope using only its content section', async () => {
  mount(buildMessage({ content: 'root = Stack([TextContent("协议正文")])', context: { private: '不展示的上下文' }, end: true }));
  expect(await screen.findByText('协议正文')).toBeTruthy(); expect(screen.queryByText('不展示的上下文')).toBeNull();
});

it('renders table columns when switching tabs and keeps all tab content reachable', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const prototype = HTMLElement.prototype as HTMLElement & { scrollTo?: unknown };
  const originalScroll = Object.getOwnPropertyDescriptor(prototype, 'scrollTo');
  Object.defineProperty(prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  mount('root = Stack([Tabs([TabItem("a", "说明", [TextContent("说明正文")]), TabItem("b", "数据", [Table([Col("数值", [1, 2], "number")])])])])');
  fireEvent.click(await screen.findByRole('tab', { name: '数据' }));
  expect(await screen.findByRole('columnheader', { name: '数值' })).toBeTruthy();
  if (originalScroll) Object.defineProperty(prototype, 'scrollTo', originalScroll); else delete (prototype as { scrollTo?: unknown }).scrollTo;
});

it('keeps edited table rows, readable choice names and explicit action context in the submitted message', () => {
  const root = createParser(chatFullUILibrary.toJSONSchema()).parse('root = Stack([EditableTable("prices", [{type:"number",key:"price",header:"价格"}], [{id:"row-1",values:[10]}])])').root!;
  const text = chatUIActionText({ type: 'continue_conversation', humanFriendlyMessage: '保存表格', params: { context: { reason: '用户确认修改' } }, formName: 'prices', formState: { prices: { prices: { value: [{ id: 'row-1', values: [20] }] } } } }, root);
  expect(text).toContain('价格'); expect(text).toContain('row-1 | 20'); expect(text).toContain('用户确认修改');
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ groups: vi.fn(), upload: vi.fn() }));
vi.mock('../../terminal/api', async original => ({ ...await original<typeof import('../../terminal/api')>(), listCollaborationGroups: api.groups, subscribeCollaborationGroups: () => () => {}, uploadFiles: api.upload }));
import { SessionChatView } from './SessionChatView';
import { clearChatSnapshots } from './chatSnapshot';
import { parseChatDraft } from './chatComposerContent';
import { useSessionDirectoryStore } from '../../stores/useSessionDirectory';
import { SessionCapabilitiesContext } from '../../federation/ShareAccessContext';
import { sharedSessionCapabilities } from '../../federation/sessionCapabilities';
const posts: { content: string; requestId: string }[] = [];
beforeEach(() => {
  posts.length = 0; api.groups.mockReset(); api.upload.mockReset();
  api.groups.mockResolvedValue({ groups: [{ id: 'team', name: '界面打磨', sessionIds: ['composer', 'worker', 'reviewer'] }], sessions: [] });
  useSessionDirectoryStore.getState().replace([
    { sessionId: 'worker', name: '设计助手', customName: true, lastActivity: 1, agent: { slug: 'codex', displayName: 'Codex', accentColor: 'var(--primary)', icon: null } },
    { sessionId: 'reviewer', name: '测试助手', customName: true, lastActivity: 1, agent: { slug: 'codex', displayName: 'Codex', accentColor: 'var(--primary)', icon: null } },
  ]);
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); throw new Error('offline'); }
    return Response.json({ agentAvailable: true, messages: [] });
  }));
});
afterEach(() => { cleanup(); clearChatSnapshots(); sessionStorage.clear(); useSessionDirectoryStore.getState().replace([]); vi.unstubAllGlobals(); });
async function mount() { const view = render(<SessionChatView sessionId="composer" onTerminal={() => {}} />); await screen.findByText('想一起完成什么？'); return view; }
it('shows image/video cards, removes one, sends a file without text, and restores it after failure', async () => {
  api.upload.mockResolvedValue({ files: [{ path: '/tmp/cover.png' }, { path: '/tmp/demo.mp4' }] });
  const view = await mount();
  fireEvent.change(screen.getByLabelText('选择附件'), { target: { files: [new File(['image'], '截图.png', { type: 'image/png' }), new File(['video'], '演示.mp4', { type: 'video/mp4' })] } });
  await screen.findByText('截图.png'); expect(screen.getByText('演示.mp4')).toBeTruthy();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('【图片1】');
  fireEvent.click(screen.getByRole('button', { name: '移除附件 截图.png' }));
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByRole('button', { name: '修改草稿' });
  expect(parseChatDraft(posts[0].content).attachments).toEqual([{ path: '/tmp/demo.mp4', name: '演示.mp4', type: 'video/mp4', size: 5, reference: '视频2' }]);
  expect(parseChatDraft(posts[0].content).text).toBe('【视频2】');
  expect(screen.queryByText(/termdock-context/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '修改草稿' }));
  expect(screen.getByRole('button', { name: '移除附件 演示.mp4' })).toBeTruthy();
  view.unmount(); await mount();
  expect(screen.getByRole('button', { name: '移除附件 演示.mp4' })).toBeTruthy();
});
it('selects a member with Enter without submitting, keeps routing across remount, and removes deleted mentions', async () => {
  let view = await mount();
  expect(api.groups).not.toHaveBeenCalled();
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '@设计' } });
  const option = await screen.findByRole('option'); expect(option.textContent).toContain('设计助手');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(posts).toHaveLength(0); expect(input.value).toContain('设计助手');
  expect(screen.queryByRole('listbox')).toBeNull();
  view.unmount(); view = await mount();
  expect(screen.getByRole('button', { name: '移除提及 设计助手' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '发送消息' })); await screen.findByRole('button', { name: '修改草稿' });
  expect(parseChatDraft(posts[0].content).mentions).toEqual([{ sessionId: 'worker', groupId: 'team', groupName: '界面打磨', name: '设计助手' }]);
  fireEvent.click(screen.getByRole('button', { name: '修改草稿' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '请直接处理' } });
  expect(screen.queryByRole('button', { name: '移除提及 设计助手' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(posts).toHaveLength(2)); expect(posts[1].content).toBe('请直接处理'); view.unmount();
});
it('supports arrow selection, Escape and member lookup retry', async () => {
  api.groups.mockRejectedValueOnce(new Error('offline'));
  await mount(); const input = screen.getByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: '提及协作成员' }));
  fireEvent.click(await screen.findByRole('button', { name: '重试' }));
  await screen.findAllByRole('option');
  fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'Enter' });
  expect((input as HTMLTextAreaElement).value).toContain('测试助手'); expect(posts).toHaveLength(0);
  fireEvent.change(input, { target: { value: '@不存在' } });
  await screen.findByText('没有匹配的成员'); fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
});
it('never offers collaboration discovery to a shared Session with input rights', async () => {
  render(<SessionCapabilitiesContext.Provider value={sharedSessionCapabilities({ canWrite: true })}><SessionChatView sessionId="composer" onTerminal={() => {}} /></SessionCapabilitiesContext.Provider>);
  await screen.findByText('想一起完成什么？');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '@' } });
  expect(screen.queryByRole('button', { name: '提及协作成员' })).toBeNull(); expect(screen.queryByRole('listbox')).toBeNull(); expect(api.groups).not.toHaveBeenCalled();
});
it('anchors attachments in prose, retains text typed during upload, and reuses the same numbered reference', async () => {
  let finish!: (value: unknown) => void;
  api.upload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount(); const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '这张与另一张对比' } }); input.setSelectionRange(2, 2);
  fireEvent.change(screen.getByLabelText('选择附件'), { target: { files: [new File(['image'], '第一张.png', { type: 'image/png' })] } });
  fireEvent.change(input, { target: { value: '这张与另一张对比，看看差别' } });
  finish({ files: [{ path: '/tmp/one.png' }] }); await screen.findByRole('button', { name: '插入引用 图片1' });
  expect(input.value).toBe('这张【图片1】 与另一张对比，看看差别');
  input.setSelectionRange(input.value.length, input.value.length);
  fireEvent.click(screen.getByRole('button', { name: '插入引用 图片1' }));
  expect(input.value.match(/【图片1】/g)).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '发送消息' })); await screen.findByRole('button', { name: '修改草稿' });
  const content = parseChatDraft(posts[0].content); expect(content.attachments).toHaveLength(1); expect(content.attachments[0]).toMatchObject({ path: '/tmp/one.png', reference: '图片1' });
  fireEvent.click(screen.getByRole('button', { name: '修改草稿' }));
  fireEvent.click(screen.getByRole('button', { name: '移除附件 第一张.png' })); expect(input.value).not.toContain('【图片1】');
});

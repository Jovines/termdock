// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationExecutionArchives } from './CollaborationExecutionArchives';
const api=vi.hoisted(()=>({list:vi.fn(),restore:vi.fn()}));
vi.mock('../../terminal/api',()=>({listExecutionArchives:api.list,restoreExecutionSession:api.restore}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const entry={sessionId:'worker',title:'执行 预览优化',groups:[{id:'project'}],agent:{slug:'codex',sessionId:'native-conversation-123'},cleanup:{state:'removed'},cwd:'/execution'};
it('shows archived native identity and directory disposition and restores once per click sequence',async()=>{
 api.list.mockResolvedValue({entries:[entry]});let resolve!:(value:unknown)=>void;api.restore.mockImplementation(()=>new Promise(done=>{resolve=done}));const onRestore=vi.fn().mockResolvedValue(undefined);
 render(<CollaborationExecutionArchives groupId="project" version={1} onRestore={onRestore}/>);
 fireEvent.click(await screen.findByText('已归档的执行会话 · 1'));
 expect(screen.getByText('执行目录已回收，恢复时重建；分支和结果保留。')).toBeTruthy();expect(screen.getByText('native-conversation-123')).toBeTruthy();
 const button=screen.getByRole('button',{name:'恢复'});fireEvent.click(button);fireEvent.click(button);expect(api.restore).toHaveBeenCalledTimes(1);expect((button as HTMLButtonElement).disabled).toBe(true);
 resolve({session:{sessionId:'worker'}});await waitFor(()=>expect(onRestore).toHaveBeenCalledWith({sessionId:'worker'}));await waitFor(()=>expect(screen.queryByText('已归档的执行会话 · 1')).toBeNull());
});
it('retains an archive after restore failure and allows retry',async()=>{
 api.list.mockResolvedValue({entries:[{...entry,cleanup:{state:'retained',reason:'存在未提交文件，保留现场'}}]});api.restore.mockRejectedValueOnce(Error('原会话正在其他终端使用')).mockResolvedValueOnce({session:{sessionId:'worker'}});const onRestore=vi.fn();
 render(<CollaborationExecutionArchives groupId="project" version={1} onRestore={onRestore}/>);fireEvent.click(await screen.findByText('已归档的执行会话 · 1'));fireEvent.click(screen.getByRole('button',{name:'恢复'}));
 await screen.findByRole('alert');expect(screen.getByText('存在未提交文件，保留现场')).toBeTruthy();expect(onRestore).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'恢复'}));await waitFor(()=>expect(onRestore).toHaveBeenCalledTimes(1));expect(api.restore).toHaveBeenCalledTimes(2);
});

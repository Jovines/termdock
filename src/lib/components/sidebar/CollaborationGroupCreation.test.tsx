// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { CollaborationTab } from './AgentOperationsPanel';
const save=vi.hoisted(()=>vi.fn());
vi.mock('../../terminal/api',async original=>({...await original<typeof import('../../terminal/api')>(),getSettings:vi.fn().mockResolvedValue({locale:'zh'}),saveCollaborationGroup:save}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('creates a project without sessions, keeps optional reuse collapsed and enters its board without launching an Agent',async()=>{
 save.mockResolvedValue({group:{id:'project',name:'改进移动体验',sessionIds:[]}});const onEnter=vi.fn().mockResolvedValue(undefined);
 render(<I18nProvider><CollaborationTab active notice={null} docked={false} inputKeySuffix="" selectedGroupId="new" setSelectedGroupId={vi.fn()} floatingVisible floating={false} sessionsState="error" groups={[]} sessions={[]} agents={[]} activeSessionId={null} initialGroupId={null} onOpenSession={vi.fn()} onOpenTaskSession={vi.fn()} onEnterGroup={onEnter} defaultSessionMode="tmux" busy={null} setBusy={vi.fn()} setError={vi.fn()} setNotice={vi.fn()} onDraftChange={vi.fn()} refresh={vi.fn().mockResolvedValue(undefined)}/></I18nProvider>);
 const button=screen.getByRole('button',{name:'创建协作组'});expect((button as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByRole('textbox',{name:'协作组名称'}),{target:{value:'改进移动体验'}});expect((button as HTMLButtonElement).disabled).toBe(false);
 expect(screen.getByText(/^复用已有会话（选填）/).closest('details')?.open).toBe(false);
 fireEvent.click(button);await waitFor(()=>expect(save).toHaveBeenCalledWith({name:'改进移动体验',sessionIds:[]}));await waitFor(()=>expect(onEnter).toHaveBeenCalledWith('project'));
});

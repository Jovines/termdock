// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalFileDropStatus } from './TerminalFileDropStatus';
afterEach(()=>{cleanup();document.body.replaceChildren();});
it('shows reading, real upload progress, cancellation and completion at the target',async()=>{
 const zone=document.createElement('div');zone.dataset.termdockTerminalDropzone='one';document.body.append(zone);
 const target={current:zone};render(<TerminalFileDropStatus target={target}/>,{container:zone});
 zone.dataset.nativeFileDropState='preparing';zone.dataset.nativeFileDropCancellable='true';
 expect(await screen.findByText('正在读取文件…')).toBeTruthy();
 zone.dataset.nativeFileDropState='uploading';zone.dataset.nativeFileDropProgress='42';
 await waitFor(()=>expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42'));
 const cancel=vi.fn();zone.addEventListener('termdock:file-drop-cancel',cancel);
 fireEvent.click(screen.getByRole('button',{name:'取消文件处理'}));expect(cancel).toHaveBeenCalledOnce();
 zone.dataset.nativeFileDropState='cancelled';delete zone.dataset.nativeFileDropCancellable;
 expect(await screen.findByText('已取消')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'取消文件处理'})).toBeNull();
 zone.dataset.nativeFileDropState='uploaded';expect(await screen.findByText('上传完成，已插入远端路径')).toBeTruthy();
});
it('distinguishes an original local path from an upload and does not invent a percentage',async()=>{
 const zone=document.createElement('div');document.body.append(zone);render(<TerminalFileDropStatus target={{current:zone}}/>,{container:zone});
 zone.dataset.nativeFileDropState='local';expect(await screen.findByText('松开以插入原文件路径')).toBeTruthy();
 zone.dataset.nativeFileDropState='uploading';expect(await screen.findByText('正在上传到当前服务…')).toBeTruthy();
 expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
 zone.dataset.nativeFileDropState='inserted';expect(await screen.findByText('已插入原文件路径')).toBeTruthy();
});

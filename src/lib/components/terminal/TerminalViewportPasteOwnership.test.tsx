// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clipboard = vi.hoisted(() => ({
  uploadTerminalClipboardFiles: vi.fn(),
  uploadTerminalClipboardImage: vi.fn(),
  readTerminalClipboardFiles: vi.fn(),
}));
const federation = vi.hoisted(() => ({ selectedTarget: vi.fn(() => ({ targetPeerId: 'peer-a' })) }));
const desktop = vi.hoisted(() => ({ bridge: undefined as { readClipboardFiles?: () => void } | undefined }));
vi.mock('../../terminal/clipboardImage', () => ({
  TerminalClipboardVideoError: class TerminalClipboardVideoError extends Error {},
  readTerminalClipboardFiles: clipboard.readTerminalClipboardFiles, uploadTerminalClipboardFiles: clipboard.uploadTerminalClipboardFiles,
  readTerminalClipboardImage: vi.fn(), readTerminalClipboardVideos: vi.fn(),
  uploadTerminalClipboardImage: clipboard.uploadTerminalClipboardImage,
}));
vi.mock('../../federation/clientScope', () => federation);
vi.mock('../../collaboration/inputTarget', () => ({ routeCollaborationInput: vi.fn(() => false) }));
vi.mock('../../desktop/nativeBridge', () => ({ supportsNativeTerminal: () => false, getTermdockDesktopBridge: () => desktop.bridge, subscribeNativeFileDrops: vi.fn(() => () => {}) }));
vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useTouchScroll', () => ({ useTouchScroll: () => ({ setupTouchScroll: vi.fn(), stopAllScroll: vi.fn() }) }));
vi.mock('../../hooks/useGesture', () => ({ useGesture: vi.fn() }));
vi.mock('../../terminal/resizePresentation', () => ({ createResizePresentation: () => ({ begin() {}, cancel() {}, dispose() {}, written() {} }) }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options: Record<string, unknown> = {}; unicode = { activeVersion: '11' };
  buffer = { active: { cursorX: 0, cursorY: 0, viewportY: 0, baseY: 0, length: 0, getLine: () => undefined } };
  textarea: HTMLTextAreaElement | null = null;
  loadAddon() {} registerLinkProvider() {} refresh() {} focus() {} blur() {} clearSelection() {}
  attachCustomWheelEventHandler() {}
  onCursorMove() { return { dispose() {} }; } onData() { return { dispose() {} }; }
  onRender() { return { dispose() {} }; } onResize() { return { dispose() {} }; }
  open() {} dispose() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 }; } } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {}, BrowserClipboardProvider: class {} }));
vi.mock('@xterm/addon-image', () => ({ ImageAddon: class {} }));
vi.mock('@xterm/addon-ligatures', () => ({ LigaturesAddon: class {} }));
vi.mock('@xterm/addon-progress', () => ({ ProgressAddon: class {} }));

import { TerminalViewport } from './TerminalViewport';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function pasteFile(file: File) {
  fireEvent.paste(screen.getByRole('textbox'), {
    clipboardData: { files: [file], items: [], getData: () => '' },
  });
}

function pasteImage(file: File) {
  fireEvent.paste(screen.getByRole('textbox'), {
    clipboardData: { files: [file], items: [], getData: () => '' },
  });
}

describe('TerminalViewport async paste ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboard.uploadTerminalClipboardFiles.mockReset().mockResolvedValue([]);
    federation.selectedTarget.mockReturnValue({ targetPeerId: 'peer-a' });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  });
  afterEach(() => {
    cleanup();
    if ('termdockDesktop' in window) delete (window as Window & { termdockDesktop?: unknown }).termdockDesktop;
    desktop.bridge = undefined;
    vi.unstubAllGlobals();
  });

  function mount(onInput: (data: string) => void | Promise<boolean>, getOwnerKey = () => 'backend-a') {
    const props = {
      sessionKey: 'frontend', sessionId: 'frontend', getPasteOwnerKey: getOwnerKey,
      chunks: [], onInput, onResize: vi.fn(), terminalSettings: { rendererMode: 'dom' } as never,
      theme: {} as never, autoFocus: false,
    };
    const view = render(<TerminalViewport {...props} />);
    return { ...view, props };
  }

  it('does not send an upload result after the selected target changes', async () => {
    const upload = deferred<string[]>();
    clipboard.uploadTerminalClipboardFiles.mockReturnValue(upload.promise);
    const onInput = vi.fn().mockResolvedValue(true);
    const view = mount(onInput);
    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy());
    pasteFile(new File(['x'], 'photo.txt', { type: 'text/plain' }));
    federation.selectedTarget.mockReturnValue({ targetPeerId: 'peer-b' });
    view.rerender(<TerminalViewport {...view.props} />);
    await act(async () => { upload.resolve(['/tmp/photo.txt']); await upload.promise; });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onInput).not.toHaveBeenCalled();
  });

  it('hides an upload failure from the old owner and reports cancellation', async () => {
    const upload = deferred<string[]>();
    clipboard.uploadTerminalClipboardFiles.mockReturnValue(upload.promise);
    const onInput = vi.fn().mockResolvedValue(true);
    const view = mount(onInput);
    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy());
    pasteFile(new File(['x'], 'photo.txt', { type: 'text/plain' }));
    federation.selectedTarget.mockReturnValue({ targetPeerId: 'peer-b' });
    view.rerender(<TerminalViewport {...view.props} />);
    await act(async () => { upload.reject(new Error('stale upload failure')); await upload.promise.catch(() => {}); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onInput).not.toHaveBeenCalled();
  });

  it('cancels an image upload when the backend session generation changes', async () => {
    const upload = deferred<string>();
    clipboard.uploadTerminalClipboardImage.mockReturnValue(upload.promise);
    const onInput = vi.fn().mockResolvedValue(true);
    let backendKey = 'backend-a';
    const getOwnerKey = () => backendKey;
    const view = mount(onInput, getOwnerKey);
    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy());
    pasteImage(new File(['image'], 'image.png', { type: 'image/png' }));
    backendKey = 'backend-b';
    view.rerender(<TerminalViewport {...view.props} />);
    await act(async () => { upload.resolve('/tmp/image.png'); await upload.promise; });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onInput).not.toHaveBeenCalled();
  });

  it('shows a visible error when the current terminal refuses a send', async () => {
    clipboard.uploadTerminalClipboardFiles.mockResolvedValue(['/tmp/current.txt']);
    const onInput = vi.fn().mockResolvedValue(false);
    mount(onInput);
    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy());
    pasteFile(new File(['x'], 'current.txt', { type: 'text/plain' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('终端未接受粘贴'));
    expect(onInput).toHaveBeenCalledWith('/tmp/current.txt ', expect.anything());
  });

  it('keeps both native paths and uploadable files from one clipboard read', async () => {
    desktop.bridge = { readClipboardFiles: vi.fn() };
    Object.defineProperty(window, 'termdockDesktop', {
      configurable: true,
      value: { readClipboardFiles: vi.fn() },
    });
    clipboard.readTerminalClipboardFiles.mockResolvedValue({
      files: [new File(['x'], 'upload.txt', { type: 'text/plain' })],
      paths: ['/Volumes/native.txt'],
    });
    clipboard.uploadTerminalClipboardFiles.mockResolvedValue(['/tmp/upload.txt']);
    const onInput = vi.fn().mockResolvedValue(true);
    mount(onInput);
    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy());
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [], items: [], getData: () => '' } });
    await waitFor(() => expect(onInput).toHaveBeenCalledWith('/Volumes/native.txt /tmp/upload.txt ', expect.anything()));
  });

for (const rejected of [false, true]) it(`native clipboard read cannot rebind its late ${rejected?'failure':'result'} to the new target`, async () => {
  desktop.bridge={readClipboardFiles:vi.fn()};Object.defineProperty(window,'termdockDesktop',{configurable:true,value:desktop.bridge});clipboard.readTerminalClipboardFiles.mockReset();
  const pending=deferred<{files:File[];paths:string[]}>();clipboard.readTerminalClipboardFiles.mockReturnValueOnce(pending.promise);
  const onInput=vi.fn().mockResolvedValue(true);
  const props={sessionKey:'read-frontend',sessionId:'read-frontend',getPasteOwnerKey:()=> 'backend-read',chunks:[],onInput,onResize:vi.fn(),terminalSettings:{rendererMode:'dom'} as never,theme:{} as never,autoFocus:false};
  const view=render(<TerminalViewport {...props}/>);await waitFor(()=>expect(screen.getByRole('textbox')).toBeTruthy());
  fireEvent.paste(screen.getByRole('textbox'),{clipboardData:{files:[],items:[],getData:()=>''}});
  expect(clipboard.readTerminalClipboardFiles).toHaveBeenCalledTimes(1);
  federation.selectedTarget.mockReturnValue({targetPeerId:'peer-b'});view.rerender(<TerminalViewport {...props}/>);
  await act(async()=>{if(rejected)pending.reject(new Error('old read failed'));else pending.resolve({files:[],paths:['/tmp/old']});await pending.promise.catch(()=>{});});
  expect(onInput).not.toHaveBeenCalled();expect(screen.queryByRole('alert')).toBeNull();
});
it('a late same-target clipboard read cannot reclaim ownership from a completed newer paste',async()=>{
 desktop.bridge={readClipboardFiles:vi.fn()};Object.defineProperty(window,'termdockDesktop',{configurable:true,value:desktop.bridge});clipboard.readTerminalClipboardFiles.mockReset();const pending=deferred<{files:File[];paths:string[]}>();
 clipboard.readTerminalClipboardFiles.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({files:[],paths:['/tmp/new']});
 const onInput=vi.fn().mockResolvedValue(true),p={sessionKey:'read-race',sessionId:'read-race',chunks:[],onInput,onResize:vi.fn(),terminalSettings:{rendererMode:'dom'} as never,theme:{} as never,autoFocus:false};
 render(<TerminalViewport {...p}/>);await waitFor(()=>expect(screen.getByRole('textbox')).toBeTruthy());
 const paste=()=>fireEvent.paste(screen.getByRole('textbox'),{clipboardData:{files:[],items:[],getData:()=>''}});
 paste();paste();await waitFor(()=>expect(onInput).toHaveBeenCalledTimes(1));
 await act(async()=>{pending.resolve({files:[],paths:['/tmp/old']});await pending.promise;});
 expect(onInput.mock.calls.map(call=>call[0])).toEqual(['/tmp/new ']);expect(screen.queryByRole('alert')).toBeNull();
});

it('a direct text paste cancels an older image upload in the same session',async()=>{
 const upload=deferred<string>();clipboard.uploadTerminalClipboardImage.mockReturnValueOnce(upload.promise);const onInput=vi.fn().mockResolvedValue(true);
 const p={sessionKey:'text-race',sessionId:'text-race',chunks:[],onInput,onResize:vi.fn(),terminalSettings:{rendererMode:'dom'} as never,theme:{} as never,autoFocus:false};render(<TerminalViewport {...p}/>);await waitFor(()=>expect(screen.getByRole('textbox')).toBeTruthy());
 pasteImage(new File(['x'],'old.png',{type:'image/png'}));fireEvent.paste(screen.getByRole('textbox'),{clipboardData:{files:[],items:[],getData:()=> 'new text'}});
 await act(async()=>{upload.resolve('/tmp/old.png');await upload.promise;});expect(onInput.mock.calls.map(call=>call[0])).toEqual(['new text']);expect(screen.queryByRole('alert')).toBeNull();
});

for(const image of [false,true])it(`a legacy void input callback remains accepted for ${image?'image':'file'} paste`,async()=>{
 const onInput=vi.fn(()=>{});if(image)clipboard.uploadTerminalClipboardImage.mockResolvedValueOnce('/tmp/void.png');else clipboard.uploadTerminalClipboardFiles.mockResolvedValueOnce(['/tmp/void.txt']);
 mount(onInput);await waitFor(()=>expect(screen.getByRole('textbox')).toBeTruthy());if(image)pasteImage(new File(['x'],'void.png',{type:'image/png'}));else pasteFile(new File(['x'],'void.txt',{type:'text/plain'}));
 await waitFor(()=>expect(onInput).toHaveBeenCalledTimes(1));await act(async()=>{});expect(screen.queryByRole('alert')).toBeNull();
});

});

// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { normalizeAndroidQuality, startAndroidRecording, stopAndroidRecording, listAndroidRecordings } from '../../android/api';
import { uploadFiles, updateSettings } from '../../terminal/api';
import { AndroidMirrorView, AndroidMirrorDock, ANDROID_DOCK_GROUP } from './AndroidMirrorView';
import { useCollaborationPanelDock } from '../../stores/useCollaborationPanelDock';
import { useAndroidRecordingDelivery } from '../../android/captureDelivery';

// 投屏控制器会去连 WebSocket，组件测试里只关心按钮接线和插入回调。
// 连接后立刻进入 streaming，截图/录屏按钮才可能出现。
vi.mock('../../android/mirrorController', () => {
  // 记录投给设备的按键，用来验证菜单开着时按键没被转发下去。
  const keyCalls: string[] = [];
  (globalThis as Record<string, unknown>).__mirrorKeyCalls = keyCalls;
  // 记录注入设备的触摸，用来验证视图手势期间没有触碰设备。
  const touchCalls: string[] = [];
  (globalThis as Record<string, unknown>).__mirrorTouchCalls = touchCalls;
  return {
    AndroidMirrorController: class {
      private readonly callbacks: { onState?: (state: string) => void; onHeader?: (header: unknown) => void };
      constructor(_canvas: HTMLCanvasElement, callbacks: { onState?: (state: string) => void; onHeader?: (header: unknown) => void }) {
        this.callbacks = callbacks;
      }
      connect(_serial?: string, quality?: unknown) {
        (globalThis as Record<string, unknown>).__mirrorConnection = { quality, callbacks: this.callbacks };
        if ((globalThis as Record<string, unknown>).__pauseMirrorConnect) { this.callbacks.onState?.('connecting'); return; }
        this.callbacks.onHeader?.({ deviceName: 'Test', codec: 'h264', width: 544, height: 1080 });
        this.callbacks.onState?.('streaming');
      }
      supportsLiveBitrate = true;
      canSetBitrate = true;
      async setBitrate(value: number) { (globalThis as Record<string, unknown>).__mirrorBitrate = value; return true; }
      disconnect() { /* no-op */ }
      back() { keyCalls.push('back'); }
      pointerDown() { touchCalls.push('down'); }
      pointerMove() { touchCalls.push('move'); }
      pointerUp() { touchCalls.push('up'); }
      pointerCancel() { touchCalls.push('cancel'); }
      scroll() { touchCalls.push('scroll'); }
    },
  };
});
vi.mock('../../android/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../android/api')>()),
  listAndroidDevices: vi.fn(async () => ({
    adbAvailable: true, scrcpyVersion: '4.0', devices: [{ serial: 'emulator-5554', state: 'device', model: 'Test', androidVersion: '14' }],
  })),
  connectAndroidDevice: vi.fn(),
  saveAndroidRecording: vi.fn(async () => ({ path: '/server/recording.mp4' })),
  listAndroidRecordings: vi.fn(async () => ({ recordings: [] })),
  startAndroidRecording: vi.fn(async () => ({ id: 'rec-1', serial: 'emulator-5554', name: 'recording.mp4', size: 0, startedAt: Date.now(), status: 'recording' })),
  stopAndroidRecording: vi.fn(async () => ({ id: 'rec-1', serial: 'emulator-5554', name: 'recording.mp4', size: 123, startedAt: Date.now(), status: 'ready' })),
}));
vi.mock('../../terminal/api', () => ({
  getSettings: vi.fn(async () => ({ androidPanel: null })),
  updateSettings: vi.fn(async () => ({})),
  uploadFiles: vi.fn(async () => ({ files: [{ name: 'shot.png', path: '/tmp/shot.png', size: 10 }] })),
}));

const streamingView = async (onInsertFile: (file: File) => Promise<void>, onRecordingComplete = vi.fn()) => {
  const view = render(<AndroidMirrorView sessionId="s1" onInsertFile={onInsertFile} onRecordingComplete={onRecordingComplete} />);
  // 唯一一台已授权设备会自动选中并连接，等标题栏出现投屏控件。
  await waitFor(() => expect(screen.getByLabelText('Screenshot and insert')).toBeTruthy());
  return view;
};

describe('AndroidMirrorView 截图/录屏插入', () => {
  beforeEach(() => {
    // 这个项目没开 testing-library 的自动 cleanup，不手动清会出现多个同名按钮。
    cleanup();
    MediaRecorderSpy.instances.length = 0;
    vi.mocked(stopAndroidRecording).mockClear();
    keyCalls().length = 0;
    stubCanvasEnvironment();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('分屏不依赖侧栏：截图绑定原终端，录屏保存对话框退出分屏后仍可操作', async () => {
    const host = document.createElement('div'); document.body.append(host);
    useCollaborationPanelDock.setState({
      docks: { [ANDROID_DOCK_GROUP]: { sessionId: 'bound-terminal', side: 'right' } },
      hosts: { [ANDROID_DOCK_GROUP]: host },
    });
    const references: { sessionId: string; text: string }[] = [];
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      references.push(detail);
      window.dispatchEvent(new CustomEvent('termdock-insert-reference-ack', { detail: { nonce: detail.nonce, ok: true } }));
    };
    window.addEventListener('termdock-insert-reference', receive);
    try {
      render(<AndroidMirrorDock sessionId="different-active-terminal" />);
      const screenshot = await screen.findByLabelText('Screenshot and insert');
      expect((screenshot as HTMLButtonElement).disabled).toBe(false);
      await userEvent.click(screenshot);
      await screen.findByText('Screenshot inserted');
      expect(uploadFiles).toHaveBeenCalledWith('/tmp', [expect.any(File)]);
      expect(references[0]).toMatchObject({ sessionId: 'bound-terminal' });
      expect(references[0].text).toContain('/tmp/shot.png');
      await userEvent.click(screen.getByLabelText('Start recording'));
      await userEvent.click(screen.getByLabelText('Stop recording'));
      await screen.findByRole('dialog');
      act(() => useCollaborationPanelDock.getState().setDock(ANDROID_DOCK_GROUP, null));
      expect(screen.getByRole('dialog')).toBeTruthy();
      await userEvent.click(screen.getByText('Insert directly'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(references[1]).toMatchObject({ sessionId: 'bound-terminal' });
      expect(references[1].text).toContain('/server/recording.mp4');
    } finally {
      cleanup();
      window.removeEventListener('termdock-insert-reference', receive);
      useCollaborationPanelDock.setState({ docks: {}, hosts: {}, activePaneId: null });
      useAndroidRecordingDelivery.setState({ pending: [] });
      host.remove();
    }
  });

  it('录制及按住操作期间不断流调码率，分辨率和连接保持不变', async () => {
    localStorage.removeItem('termdock:android:quality:v1');
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    await streamingView(async () => {});
    await userEvent.selectOptions(screen.getByLabelText('Quality'), 'auto');
    await userEvent.click(screen.getByLabelText('Start recording'));
    expect(screen.getByLabelText('Stop recording')).toBeTruthy();
    const connection = () => (globalThis as Record<string, unknown>).__mirrorConnection as {
      quality: ReturnType<typeof normalizeAndroidQuality>;
      callbacks: { onStats: (value: unknown) => void };
    };
    expect(connection().quality.maxSize).toBe(1600);
    const saved = vi.mocked(updateSettings).mock.calls.length;
    const oldConnection = connection();
    const canvas = document.querySelector('canvas')!;
    for (const time of [5000, 6000, 7000, 8000]) {
      if (time === 7000) act(() => firePointer(canvas, 'pointerdown', { pointerId: 9, clientX: 100, clientY: 100 }));
      if (time === 8000) {
        expect(connection().quality.maxSize).toBe(1600);
        act(() => firePointer(canvas, 'pointerup', { pointerId: 9, clientX: 100, clientY: 100 }));
      }
      now = time;
      act(() => oldConnection.callbacks.onStats({ fps: 12, kbps: 700, width: 720, height: 360,
        adaptation: { rttMs: 500, deliveryDelayMs: 400, decodeQueue: 0, frames: 12 } }));
    }
    expect(connection()).toBe(oldConnection);
    expect(connection().quality.maxSize).toBe(1600);
    expect((globalThis as Record<string, unknown>).__mirrorBitrate).toBe(3_200_000);
    await act(async () => {});
    expect(screen.getByLabelText('Stop recording')).toBeTruthy();
    expect(stopAndroidRecording).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Quality') as HTMLSelectElement).value).toBe('auto');
    expect(screen.getByRole('option', { name: 'Auto · 3.2 Mbps' })).toBeTruthy();
    expect(vi.mocked(updateSettings).mock.calls.length).toBe(saved);
    await userEvent.selectOptions(screen.getByLabelText('Quality'), 'high');
    now = 30000;
    act(() => oldConnection.callbacks.onStats({ adaptation: { rttMs: 1000 } }));
    expect(connection().quality.id).toBe('high');
    localStorage.removeItem('termdock:android:quality:v1');
  });

  it('截图把 PNG 文件交给插入回调', async () => {
    const inserted: File[] = [];
    await streamingView(async file => { inserted.push(file); });

    await userEvent.click(screen.getByLabelText('Screenshot and insert'));

    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0]!.name).toMatch(/\.png$/);
    expect(inserted[0]!.type).toBe('image/png');
    expect(await screen.findByText('Screenshot inserted')).toBeTruthy();
  });

  it('插入失败时报错，且不留「已插入」的假反馈', async () => {
    await streamingView(async () => { throw new Error('上传通道断开'); });

    await userEvent.click(screen.getByLabelText('Screenshot and insert'));

    expect((await screen.findByRole('alert')).textContent).toContain('上传通道断开');
    expect(screen.queryByText('Screenshot inserted')).toBeNull();
  });

  it('截图上传时显示 loading 并阻止重复插入', async () => {
    let finish!: () => void;
    const insert = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await streamingView(insert);
    const button = screen.getByLabelText('Screenshot and insert') as HTMLButtonElement;
    await userEvent.click(button);
    await waitFor(() => expect(insert).toHaveBeenCalledOnce());
    expect(button.disabled).toBe(true);
    expect(button.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.getByText('Inserting…')).toBeTruthy();
    await userEvent.click(button);
    expect(insert).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(button.disabled).toBe(false);
    expect(screen.getByText('Screenshot inserted')).toBeTruthy();
  });

  it('低频操作收进 ⋯ 菜单，菜单项点一下就展开地址输入框', async () => {
    await streamingView(async () => { /* no-op */ });

    // 收起来之前，网络连接/分屏/全屏/铺满侧栏是四个各自独立的按钮。
    expect(screen.queryByLabelText('Connect over network')).toBeNull();
    expect(screen.queryByLabelText('Fill sidebar')).toBeNull();

    await userEvent.click(screen.getByLabelText('More'));
    const menu = screen.getByRole('menu');
    expect(menu.textContent).toContain('Connect over network');
    expect(menu.textContent).toContain('Open in split view');
    expect(menu.textContent).toContain('Fullscreen');
    expect(menu.textContent).toContain('Fill sidebar');

    await userEvent.click(screen.getByRole('menuitem', { name: /Connect over network/ }));
    // 点完菜单自己收掉，输入框在原地展开（不新增行、不动画布高度）。
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByPlaceholderText('ip:port, e.g. 192.168.1.20:5555')).toBeTruthy();
  });

  it('菜单开着时 Esc 只关菜单，不当成设备返回键转发下去', async () => {
    await streamingView(async () => { /* no-op */ });

    await userEvent.click(screen.getByLabelText('More'));
    expect(screen.queryByRole('menu')).toBeTruthy();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(keyCalls()).toEqual([]);

    // 对照组：菜单关掉后同一个按键就该走设备返回键，否则上面的断言是空过。
    await userEvent.keyboard('{Escape}');
    expect(keyCalls()).toEqual(['back']);
  });

  it('地址输入框里打字时按键归输入框，不转发给设备', async () => {
    await streamingView(async () => { /* no-op */ });
    await userEvent.click(screen.getByLabelText('More'));
    await userEvent.click(screen.getByRole('menuitem', { name: /Connect over network/ }));
    const input = screen.getByPlaceholderText('ip:port, e.g. 192.168.1.20:5555');

    await userEvent.type(input, '192.168.1.20:5555');

    // 退格得真的删掉字符，而不是被 preventDefault 吃掉再当成设备返回键。
    expect((input as HTMLInputElement).value).toBe('192.168.1.20:5555');
    expect(keyCalls()).toEqual([]);

    await userEvent.type(input, '{Backspace}');
    expect((input as HTMLInputElement).value).toBe('192.168.1.20:555');
    expect(keyCalls()).toEqual([]);
  });

  it('录屏停止后只交给确认回调，不直接插入', async () => {
    const inserted: File[] = [];
    const completed = vi.fn();
    await streamingView(async file => { inserted.push(file); }, completed);

    await userEvent.click(screen.getByLabelText('Start recording'));
    expect(MediaRecorderSpy.instances).toHaveLength(0);
    expect(startAndroidRecording).toHaveBeenCalledWith('emulator-5554');
    // 徽章里的停止按钮带时长，避免与工具栏那个同名按钮混淆。
    const badgeStop = await screen.findByLabelText(/^Stop recording · \d\d:\d\d$/);
    expect(badgeStop).toBeTruthy();
    // 录屏中缩放提示让位给计时徽章，实时统计只在更多菜单展示。
    const zoomLabel = document.querySelector('[data-mirror-capture-status] > span')!;
    expect(zoomLabel.classList.contains('invisible')).toBe(true);
    expect(zoomLabel.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByText(/fps ·/)).toBeNull();

    // 真实时序：录制途中数据持续到达，点停止时已经攒了内容。

    await userEvent.click(badgeStop);

    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(completed.mock.calls[0][0].name).toMatch(/\.mp4$/);
    expect(inserted).toHaveLength(0);
  });

  it('重新打开面板找回进行中的服务端录制，预览重连不会停止它', async () => {
    vi.mocked(listAndroidRecordings).mockResolvedValueOnce({ recordings: [{
      id: 'recovered', serial: 'emulator-5554', name: 'recovered.mp4', size: 0,
      startedAt: Date.now() - 10000, status: 'recording',
    }] });
    await streamingView(async () => {});
    await screen.findByLabelText('Stop recording');
    await userEvent.selectOptions(screen.getByLabelText('Quality'), 'low');
    expect(screen.getByLabelText('Stop recording')).toBeTruthy();
    expect(stopAndroidRecording).not.toHaveBeenCalled();
  });

  it('关闭面板不停止服务端录像', async () => {
    const inserted = vi.fn();
    const completed = vi.fn();
    const view = await streamingView(inserted, completed);
    await userEvent.click(screen.getByLabelText('Start recording'));

    view.unmount();
    expect(stopAndroidRecording).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(inserted).not.toHaveBeenCalled();
  });
});

describe('AndroidMirrorView 视图缩放/平移', () => {
  beforeEach(() => {
    cleanup();
    keyCalls().length = 0;
    touchCalls().length = 0;
    stubCanvasEnvironment();
    // jsdom 没有布局：把容器尺寸伪造出来，缩放锚点和平移边界才有数可算。
    stubElementSize('clientWidth', STAGE_WIDTH);
    stubElementSize('clientHeight', STAGE_HEIGHT);
  });

  afterEach(() => {
    restoreElementSize();
    vi.restoreAllMocks();
  });

  const canvasOf = (view: ReturnType<typeof render>) => view.container.querySelector('canvas')!;

  it('静止态不挂 transform，放大后再缩回原位也不留', async () => {
    const view = await streamingView(async () => { /* no-op */ });
    const canvas = canvasOf(view);

    // 挂着恒等变换一样会把画布提升成合成层，而合成层的栅格化比例定在建层那一刻：
    // 进面板时画布还是默认的 300×150，首帧到达才换成帧尺寸，这层缓存不重算，
    // 整幅画面就被按小尺寸栅格化再放大 —— 「刚进去就糊」只有 262 会出，原因在这。
    expect(canvas.style.transform).toBe('');
    expect(canvas.style.transition).toBe('none');

    await zoomClick(screen.getByLabelText('Zoom in'));
    expect(canvas.style.transform).toBe('translate3d(0px, 0px, 0) scale(1.25)');

    for (let press = 0; press < 10; press++) await zoomClick(screen.getByLabelText('Zoom out'));
    expect(canvas.style.transform).toBe('');
  });

  it('放大/缩小按钮按档位走阶梯，到头就禁用', async () => {
    const view = await streamingView(async () => { /* no-op */ });
    const canvas = canvasOf(view);
    const zoomIn = screen.getByLabelText('Zoom in') as HTMLButtonElement;
    const zoomOut = screen.getByLabelText('Zoom out') as HTMLButtonElement;

    expect(viewTransform(canvas)).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(zoomOut.disabled).toBe(true);

    await zoomClick(zoomIn);
    expect(viewTransform(canvas).zoom).toBeCloseTo(1.25, 3);
    // 第一次放大时顺带把双指平移点破一次（借底部那行的短暂反馈位）。
    expect(screen.getByText('Two-finger drag to move the view')).toBeTruthy();

    for (let press = 0; press < 10; press++) await zoomClick(zoomIn);
    expect(viewTransform(canvas).zoom).toBeCloseTo(8, 3);
    expect(zoomIn.disabled).toBe(true);

    for (let press = 0; press < 10; press++) await zoomClick(zoomOut);
    expect(viewTransform(canvas)).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(zoomOut.disabled).toBe(true);
  });

  it('双指拖动只平移画面，不向设备注入触摸，越界钳在边缘', async () => {
    const view = await streamingView(async () => { /* no-op */ });
    const canvas = canvasOf(view);
    await zoomClick(screen.getByLabelText('Zoom in'));
    await zoomClick(screen.getByLabelText('Zoom in'));
    expect(viewTransform(canvas).zoom).toBeCloseTo(1.5, 3);

    act(() => {
      firePointer(canvas, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
      firePointer(canvas, 'pointerdown', { pointerId: 2, clientX: 200, clientY: 300 });
      // 两指一起往右下拖 1000px：X 上限 (300×1.5−300)/2=75，Y 上限 (600×1.5−600)/2=150。
      firePointer(canvas, 'pointermove', { pointerId: 1, clientX: 1100, clientY: 1300 });
      firePointer(canvas, 'pointermove', { pointerId: 2, clientX: 1200, clientY: 1300 });
      firePointer(canvas, 'pointerup', { pointerId: 1, clientX: 1100, clientY: 1300 });
      firePointer(canvas, 'pointerup', { pointerId: 2, clientX: 1200, clientY: 1300 });
    });

    expect(viewTransform(canvas)).toEqual({ x: 75, y: 150, zoom: 1.5 });
    // 第一根手指的 down 被第二根手指作废（否则设备会把它当成一次点击），此后不再注入任何触摸。
    expect(touchCalls()).toEqual(['down', 'cancel']);
  });

  it('双指张合以两指中心为锚点缩放', async () => {
    const view = await streamingView(async () => { /* no-op */ });
    const canvas = canvasOf(view);

    act(() => {
      firePointer(canvas, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
      firePointer(canvas, 'pointerdown', { pointerId: 2, clientX: 200, clientY: 300 });
      // 间距 100 → 200：倍率 = 2。中心不动，画面不该平移。
      firePointer(canvas, 'pointermove', { pointerId: 1, clientX: 50, clientY: 300 });
      firePointer(canvas, 'pointermove', { pointerId: 2, clientX: 250, clientY: 300 });
    });
    await nextFrame();

    const transform = viewTransform(canvas);
    expect(transform.zoom).toBeCloseTo(2, 2);
    expect(transform.x).toBeCloseTo(0, 3);
    expect(transform.y).toBeCloseTo(0, 3);
  });

  it('一帧内两根手指分别移动只结算一次，不把「只动了一根」的中间态画出来', async () => {
    const view = await streamingView(async () => { /* no-op */ });
    const canvas = canvasOf(view);

    act(() => {
      firePointer(canvas, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
      firePointer(canvas, 'pointerdown', { pointerId: 2, clientX: 200, clientY: 300 });
    });

    // 第一根先动：此刻另一根还停在上一帧的位置，按这半边算会得到 100→140，即 1.4×。
    act(() => { firePointer(canvas, 'pointermove', { pointerId: 1, clientX: 60, clientY: 300 }); });
    expect(viewTransform(canvas).zoom).toBe(1);

    // 同一帧里第二根也动完，一帧只结算一次：按 100→180 算，倍率 = 1.8×。
    act(() => { firePointer(canvas, 'pointermove', { pointerId: 2, clientX: 240, clientY: 300 }); });
    await nextFrame();
    expect(viewTransform(canvas).zoom).toBeCloseTo(1.8, 2);
  });

  it('按钮立即到达目标档位，滚轮从当前画面继续缩放', async () => {
    const view = await streamingView(async () => {});
    const canvas = canvasOf(view);
    const button = screen.getByLabelText('Zoom in');
    await userEvent.click(button);
    await userEvent.click(button);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 190)); });
    expect(viewTransform(canvas).zoom).toBeCloseTo(1.5, 5);
    await userEvent.click(button);
    act(() => { canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -1, ctrlKey: true, clientX: 150, clientY: 300, cancelable: true, bubbles: true,
    })); });
    await nextFrame();
    const interrupted = viewTransform(canvas).zoom;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 190)); });
    expect(viewTransform(canvas).zoom).toBe(interrupted);
    expect(interrupted).toBeCloseTo(2 * Math.exp(0.002), 6);
  });

  it('捏合越过上限后反向立即缩小，不需要退回越界前的位置', async () => {
    const view = await streamingView(async () => {});
    const canvas = canvasOf(view);
    act(() => {
      firePointer(canvas, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
      firePointer(canvas, 'pointerdown', { pointerId: 2, clientX: 200, clientY: 300 });
      firePointer(canvas, 'pointermove', { pointerId: 2, clientX: 1100, clientY: 300 });
    });
    await nextFrame();
    expect(viewTransform(canvas).zoom).toBe(8);
    act(() => { firePointer(canvas, 'pointermove', { pointerId: 2, clientX: 1090, clientY: 300 }); });
    await nextFrame();
    expect(viewTransform(canvas).zoom).toBeCloseTo(7.92, 6);
  });

  it('小幅捏合立即响应', async () => {
    const view = await streamingView(async () => {});
    const canvas = canvasOf(view);
    act(() => {
      firePointer(canvas, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
      firePointer(canvas, 'pointerdown', { pointerId: 2, clientX: 200, clientY: 300 });
      firePointer(canvas, 'pointermove', { pointerId: 2, clientX: 202, clientY: 300 });
    });
    await nextFrame();
    expect(viewTransform(canvas).zoom).toBeCloseTo(1.02, 4);
  });

  it('滚轮微小增量连续累积，零增量不缩放，焦点保持不动', async () => {
    const view = await streamingView(async () => {});
    const canvas = canvasOf(view);
    const wheel = (deltaY: number) => canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY, ctrlKey: true, clientX: 180, clientY: 330, cancelable: true, bubbles: true,
    }));
    act(() => { wheel(-1); wheel(0); wheel(-1); });
    expect(viewTransform(canvas).zoom).toBe(1);
    await nextFrame();
    const z = Math.exp(0.004);
    expect(viewTransform(canvas).zoom).toBeCloseTo(z, 6);
    expect(viewTransform(canvas).x).toBeCloseTo(30 * (1 - z), 6);
    expect(viewTransform(canvas).y).toBeCloseTo(30 * (1 - z), 6);
    expect(touchCalls()).toEqual([]);
  });

  it('区分调码率超时与编码器拒绝，详情可展开，恢复支持后清除提示', async () => {
    await streamingView(async () => {});
    await userEvent.selectOptions(screen.getByLabelText('Quality'), 'auto');
    const connection = (globalThis as Record<string, unknown>).__mirrorConnection as {
      callbacks: { onBitrateSupport: (supported: boolean, detail?: string) => void };
    };
    const detail = 'BITRATE_ACK_TIMEOUT: requested=4000000 bps; scrcpy=3.3.4; device=test';
    act(() => connection.callbacks.onBitrateSupport(false, detail));
    const summary = screen.getByText(/Bitrate confirmation timed out/);
    const disclosure = summary.closest('details')!;
    expect(disclosure.open).toBe(false);
    await userEvent.click(summary);
    expect(disclosure.open).toBe(true);
    expect(screen.getByText(detail)).toBeTruthy();
    act(() => connection.callbacks.onBitrateSupport(true));
    expect(screen.queryByText(detail)).toBeNull();
  });

  it('自定义仅改码率时复用连接，不重新创建视频流', async () => {
    await streamingView(async () => {});
    const connection = (globalThis as Record<string, unknown>).__mirrorConnection;
    await userEvent.selectOptions(screen.getByLabelText('Quality'), 'custom');
    fireEvent.change(screen.getAllByRole('slider')[1]!, { target: { value: '2' } });
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect((globalThis as Record<string, unknown>).__mirrorConnection).toBe(connection);
    expect((globalThis as Record<string, unknown>).__mirrorBitrate).toBe(2_000_000);
  });

  it('从外部输入框回到画面，首次按下同时聚焦并完整转发触摸', async () => {
    const view = await streamingView(async () => {});
    const canvas = canvasOf(view);
    const outside = document.createElement('input');
    document.body.append(outside);
    outside.focus();
    act(() => firePointer(canvas, 'pointerdown', { pointerId: 99, clientX: 100, clientY: 100 }));
    expect(document.activeElement).toBe(canvas.closest('.android-mirror-panel'));
    act(() => firePointer(canvas, 'pointerup', { pointerId: 99, clientX: 100, clientY: 100 }));
    expect(touchCalls()).toEqual(['down', 'up']);
    outside.remove();
  });

  it('同设备换画质时保留上一帧，重连空档的捏合仍由预览区域处理', async () => {
    const view = await streamingView(async () => {});
    const canvas = canvasOf(view);
    (globalThis as Record<string, unknown>).__pauseMirrorConnect = true;
    try {
      await userEvent.selectOptions(screen.getByLabelText('Quality'), 'high');
      expect(canvas.style.display).toBe('block');
      const wheel = new WheelEvent('wheel', { deltaY: -10, ctrlKey: true, bubbles: true, cancelable: true });
      act(() => { canvas.parentElement!.dispatchEvent(wheel); });
      expect(wheel.defaultPrevented).toBe(true);
    } finally { delete (globalThis as Record<string, unknown>).__pauseMirrorConnect; }
  });

  it('画面留白和原生手势不会把缩放传给浏览器，面板外仍保留默认行为', async () => {
    const view = await streamingView(async () => {});
    const canvas = canvasOf(view);
    const stage = canvas.parentElement!;
    const wheel = new WheelEvent('wheel', { deltaY: -10, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { stage.dispatchEvent(wheel); });
    expect(wheel.defaultPrevented).toBe(true);
    await nextFrame();
    expect(viewTransform(canvas).zoom).toBeGreaterThan(1);
    for (const type of ['gesturestart', 'gesturechange']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      stage.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    const outside = new WheelEvent('wheel', { ctrlKey: true, cancelable: true });
    document.body.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(false);
  });

  it('⌘/Ctrl+滚轮以光标为锚点缩放，普通滚轮照旧滚设备', async () => {
    const view = await streamingView(async () => { /* no-op */ });
    const canvas = canvasOf(view);
    touchCalls().length = 0;

    // 光标压在画面中心：锚点在中心，缩放后画面不平移。
    act(() => {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 150, clientY: 300, bubbles: true, cancelable: true }));
    });
    await nextFrame();
    expect(viewTransform(canvas).zoom).toBeCloseTo(Math.exp(0.2), 3);
    expect(viewTransform(canvas)).toEqual({ x: 0, y: 0, zoom: Math.exp(0.2) });
    expect(touchCalls()).toEqual([]);

    act(() => {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    });
    expect(touchCalls()).toEqual(['scroll']);
    await nextFrame();
    expect(viewTransform(canvas).zoom).toBeCloseTo(Math.exp(0.2), 3);
  });
});

// 由 mirrorController 的 mock 工厂写入；用取值函数读，免去模块求值顺序上的担心。
const keyCalls = () => (globalThis as Record<string, unknown>).__mirrorKeyCalls as string[];
const touchCalls = () => (globalThis as Record<string, unknown>).__mirrorTouchCalls as string[];

/** 画布容器在测试里的尺寸：画布铺满它，于是缩放后越界与否完全由数字决定。 */
const STAGE_WIDTH = 300;
const STAGE_HEIGHT = 600;

const elementSizeBackup = new Map<string, PropertyDescriptor | undefined>();

const stubElementSize = (property: 'clientWidth' | 'clientHeight', value: number) => {
  if (!elementSizeBackup.has(property)) {
    elementSizeBackup.set(property, Object.getOwnPropertyDescriptor(HTMLElement.prototype, property));
  }
  Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get: () => value });
};

const restoreElementSize = () => {
  for (const [property, descriptor] of elementSizeBackup) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
  }
  elementSizeBackup.clear();
};

/**
 * jsdom 既没有 PointerEvent 也没有指针捕获：手动派发一个带这些字段的原生事件，
 * React 的合成事件照样读得到 pointerId/pointerType（没有 pointerType 就按触摸处理）。
 */
const firePointer = (target: Element, type: string, init: { pointerId: number; clientX: number; clientY: number }) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, init);
  target.dispatchEvent(event);
};

/** 手势结算排在 rAF 上：等下一帧再断言，模拟浏览器把一帧的输入都派发完才绘制。 */
const nextFrame = () => act(() => new Promise<void>(resolve => { requestAnimationFrame(() => resolve()); }));

/**
 * 从 style.transform 里读回平移/缩放，比断言字符串更耐得住浮点误差。
 * 没有 transform 就是静止态：1× 不挂变换（见组件里 applyViewTransform 的注释）。
 */
const viewTransform = (canvas: HTMLCanvasElement) => {
  if (canvas.style.transform === '' || canvas.style.transform === 'none') return { x: 0, y: 0, zoom: 1 };
  const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\(([\d.]+)\)/.exec(canvas.style.transform);
  if (!match) throw new Error(`unexpected transform: ${canvas.style.transform}`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
};

/** 组件测试没有真实解码器，也没有布局：给画布尺寸，截图与缩放平移才有东西可算。 */
const stubCanvasEnvironment = () => {
  // vi.restoreAllMocks 不会还原本模块作用域里挂的全局，得每个用例重挂。
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = MediaRecorderSpy;
  const realCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const element = realCreateElement(tag);
    if (tag === 'canvas') {
      const node = element as HTMLCanvasElement;
      node.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as unknown as HTMLCanvasElement['getContext'];
      node.toBlob = ((callback: BlobCallback) => callback(new Blob([new Uint8Array([1])], { type: 'image/png' }))) as HTMLCanvasElement['toBlob'];
      Object.defineProperty(node, 'width', { value: 544, writable: true });
      Object.defineProperty(node, 'height', { value: 1080, writable: true });
      // offsetWidth/offsetHeight 是布局尺寸，不含 transform——平移边界就按它算。
      Object.defineProperty(node, 'offsetWidth', { value: STAGE_WIDTH });
      Object.defineProperty(node, 'offsetHeight', { value: STAGE_HEIGHT });
      return node;
    }
    return element;
  }) as typeof document.createElement);
};

class MediaRecorderSpy {
  static instances: MediaRecorderSpy[] = [];
  static isTypeSupported = (mime: string) => mime.startsWith('video/mp4');
  state = 'recording';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: unknown, _options?: unknown) { MediaRecorderSpy.instances.push(this); }
  start() { /* no-op */ }
  // 真实现里 stop() 是异步的：最后一个 dataavailable 先到、onstop 后到。
  // 同步触发会让收尾时 chunks 还是空的，录出来是 0 字节。
  stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
  emit(blob: Blob) { this.ondataavailable?.({ data: blob }); }
}
(globalThis as { MediaRecorder?: unknown }).MediaRecorder = MediaRecorderSpy;
// captureStream 在 jsdom 里不存在，补一个最小实现供采集模块使用；
// 必须返回带 getTracks 的对象，否则停止录屏时收尾会抛。
HTMLCanvasElement.prototype.captureStream = function captureStream() {
  return { getTracks: () => [{ stop: () => { /* no-op */ } }] } as unknown as MediaStream;
};

async function zoomClick(element: HTMLElement) {
  await userEvent.click(element);
}

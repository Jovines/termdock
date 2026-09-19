// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AndroidMirrorView } from './AndroidMirrorView';

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
      connect() {
        this.callbacks.onHeader?.({ deviceName: 'Test', codec: 'h264', width: 544, height: 1080 });
        this.callbacks.onState?.('streaming');
      }
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
}));
vi.mock('../../terminal/api', () => ({
  getSettings: vi.fn(async () => ({ androidPanel: null })),
  updateSettings: vi.fn(async () => ({})),
}));

const streamingView = async (onInsertFile: (file: File) => Promise<void>) => {
  const view = render(<AndroidMirrorView sessionId="s1" onInsertFile={onInsertFile} />);
  // 唯一一台已授权设备会自动选中并连接，等标题栏出现投屏控件。
  await waitFor(() => expect(screen.getByLabelText('Screenshot and insert')).toBeTruthy());
  return view;
};

describe('AndroidMirrorView 截图/录屏插入', () => {
  beforeEach(() => {
    // 这个项目没开 testing-library 的自动 cleanup，不手动清会出现多个同名按钮。
    cleanup();
    MediaRecorderSpy.instances.length = 0;
    keyCalls().length = 0;
    stubCanvasEnvironment();
  });

  afterEach(() => { vi.restoreAllMocks(); });

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

  it('录屏先出现计时与停止按钮，停止后才把视频交给插入回调', async () => {
    const inserted: File[] = [];
    await streamingView(async file => { inserted.push(file); });

    await userEvent.click(screen.getByLabelText('Start recording'));
    const recorder = MediaRecorderSpy.instances.at(-1)!;
    // 徽章里的停止按钮带时长，避免与工具栏那个同名按钮混淆。
    const badgeStop = await screen.findByLabelText(/^Stop recording · \d\d:\d\d$/);
    expect(badgeStop).toBeTruthy();
    // 录屏中画面高度不能变：统计信息让位给计时徽章，而不是另起一行。
    expect(screen.queryByText(/fps ·/)).toBeNull();

    // 真实时序：录制途中数据持续到达，点停止时已经攒了内容。
    recorder.emit(new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }));
    await userEvent.click(badgeStop);

    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0]!.name).toMatch(/\.mp4$/);
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

    await userEvent.click(screen.getByLabelText('Zoom in'));
    expect(canvas.style.transform).toBe('translate3d(0px, 0px, 0) scale(1.25)');

    for (let press = 0; press < 10; press++) await userEvent.click(screen.getByLabelText('Zoom out'));
    expect(canvas.style.transform).toBe('');
  });

  it('放大/缩小按钮按档位走阶梯，到头就禁用', async () => {
    const view = await streamingView(async () => { /* no-op */ });
    const canvas = canvasOf(view);
    const zoomIn = screen.getByLabelText('Zoom in') as HTMLButtonElement;
    const zoomOut = screen.getByLabelText('Zoom out') as HTMLButtonElement;

    expect(viewTransform(canvas)).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(zoomOut.disabled).toBe(true);

    await userEvent.click(zoomIn);
    expect(viewTransform(canvas).zoom).toBeCloseTo(1.25, 3);
    // 第一次放大时顺带把双指平移点破一次（借底部那行的短暂反馈位）。
    expect(screen.getByText('Two-finger drag to move the view')).toBeTruthy();

    for (let press = 0; press < 10; press++) await userEvent.click(zoomIn);
    expect(viewTransform(canvas).zoom).toBeCloseTo(8, 3);
    expect(zoomIn.disabled).toBe(true);

    for (let press = 0; press < 10; press++) await userEvent.click(zoomOut);
    expect(viewTransform(canvas)).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(zoomOut.disabled).toBe(true);
  });

  it('双指拖动只平移画面，不向设备注入触摸，越界钳在边缘', async () => {
    const view = await streamingView(async () => { /* no-op */ });
    const canvas = canvasOf(view);
    await userEvent.click(screen.getByLabelText('Zoom in'));
    await userEvent.click(screen.getByLabelText('Zoom in'));
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
      // 间距 100 → 200：扣掉抖动死区后倍率 = 1 + (2 − 1 − 0.12)。中心不动，画面不该平移。
      firePointer(canvas, 'pointermove', { pointerId: 1, clientX: 50, clientY: 300 });
      firePointer(canvas, 'pointermove', { pointerId: 2, clientX: 250, clientY: 300 });
    });
    await nextFrame();

    const transform = viewTransform(canvas);
    expect(transform.zoom).toBeCloseTo(1.88, 2);
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

    // 第一根先动：此刻另一根还停在上一帧的位置，按这半边算会得到 100→140，即 1.28×。
    act(() => { firePointer(canvas, 'pointermove', { pointerId: 1, clientX: 60, clientY: 300 }); });
    expect(viewTransform(canvas).zoom).toBe(1);

    // 同一帧里第二根也动完，一帧只结算一次：按 100→180 算，1 + (1.8 − 1 − 0.12) = 1.68×。
    act(() => { firePointer(canvas, 'pointermove', { pointerId: 2, clientX: 240, clientY: 300 }); });
    await nextFrame();
    expect(viewTransform(canvas).zoom).toBeCloseTo(1.68, 2);
  });

  it('⌘/Ctrl+滚轮以光标为锚点缩放，普通滚轮照旧滚设备', async () => {
    const view = await streamingView(async () => { /* no-op */ });
    const canvas = canvasOf(view);
    touchCalls().length = 0;

    // 光标压在画面中心：锚点在中心，缩放后画面不平移。
    act(() => {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 150, clientY: 300, bubbles: true, cancelable: true }));
    });
    expect(viewTransform(canvas).zoom).toBeCloseTo(1.15, 3);
    expect(viewTransform(canvas)).toEqual({ x: 0, y: 0, zoom: 1.15 });
    expect(touchCalls()).toEqual([]);

    act(() => {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    });
    expect(touchCalls()).toEqual(['scroll']);
    expect(viewTransform(canvas).zoom).toBeCloseTo(1.15, 3);
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

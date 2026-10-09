import Guacamole from 'guacamole-common-js';
import { SecureRdpTunnel, type RdpConnection } from './secureRdpTunnel';

/** Keep the UI controls shared with VNC while rendering RDP via Guacamole. */
export class RdpSession extends EventTarget {
  private client: Guacamole.Client;
  private tunnel: SecureRdpTunnel;
  private keyboard: Guacamole.Keyboard;
  private display: Guacamole.Display;
  private container: HTMLDivElement;
  private observer: ResizeObserver;
  private listeners = new AbortController();
  private readonlyMode = false;
  private fit = true;
  private disposed = false;
  private connected = false;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private requestedSize: string;
  private localPointer = false;
  private nativeCursor = false;
  constructor(target: HTMLElement, options: RdpConnection, fail: (reason: string) => void) {
    super();
    this.requestedSize = `${options.width}x${options.height}`;
    const tunnel = this.tunnel = new SecureRdpTunnel(options, fail, () => this.localPointer && !this.readonlyMode);
    this.client = new Guacamole.Client(tunnel);
    this.display = this.client.getDisplay();
    this.container = document.createElement('div');
    this.container.className = 'flex h-full w-full overflow-auto outline-none'; this.container.tabIndex = 0;
    this.container.appendChild(this.display.getElement()); target.appendChild(this.container);
    this.keyboard = new Guacamole.Keyboard(this.container);
    this.keyboard.onkeydown = keysym => { if (!this.readonlyMode) this.client.sendKeyEvent(1, keysym); return false; };
    this.keyboard.onkeyup = keysym => { if (!this.readonlyMode) this.client.sendKeyEvent(0, keysym); };
    const display = this.display.getElement();
    display.className = 'm-auto shrink-0';
    const sendMouse = (event: Guacamole.Event) => {
      if (!this.readonlyMode) { this.localPointer = true; this.client.sendMouseState((event as Guacamole.Mouse.Event).state, true); }
    };
    const mouse = new Guacamole.Mouse(display);
    mouse.onEach(['mousedown', 'mousemove', 'mouseup'], event => { sendMouse(event); if (!this.readonlyMode) this.display.showCursor(!this.nativeCursor); });
    mouse.on('mouseout', () => { this.localPointer = false; this.display.showCursor(false); });
    this.display.oncursor = (canvas, x, y) => {
      this.nativeCursor = mouse.setCursor(canvas, x, y);
      if (this.localPointer && !this.readonlyMode) this.display.showCursor(!this.nativeCursor);
    };
    new Guacamole.Mouse.Touchscreen(display).onEach(['mousedown', 'mousemove', 'mouseup'], event => { sendMouse(event); if (!this.readonlyMode) this.display.showCursor(true); });
    this.container.addEventListener('pointerdown', () => this.container.focus({ preventScroll: true }), { signal: this.listeners.signal });
    this.container.addEventListener('blur', () => this.keyboard.reset(), { signal: this.listeners.signal });
    window.addEventListener('blur', () => this.keyboard.reset(), { signal: this.listeners.signal });
    this.observer = new ResizeObserver(() => { this.scale(); this.scheduleResize(); }); this.observer.observe(target);
    this.display.onresize = () => this.scale();
    this.client.onstatechange = state => {
      if (this.disposed) return;
      if (state === Guacamole.Client.State.CONNECTED) { this.connected = true; this.dispatchEvent(new Event('connect')); this.scheduleResize(); }
      if (state === Guacamole.Client.State.DISCONNECTED) fail('COMPUTER_DISCONNECTED');
    };
    this.client.onname = name => this.dispatchEvent(new CustomEvent('desktopname', { detail: { name } }));
    this.client.onerror = status => {
      const reason = /certificate/i.test(status.message || '') ? 'COMPUTER_RDP_CERTIFICATE'
        : [0x0301, 0x0303].includes(status.code) ? 'COMPUTER_AUTH_FAILED'
        : status.code === 0x0202 ? 'COMPUTER_CONNECT_TIMEOUT' : 'COMPUTER_RDP_FAILED';
      fail(reason);
    };
    this.client.connect();
  }
  private scale(): void {
    const width = this.display.getWidth(), height = this.display.getHeight();
    if (!this.container.clientWidth || !this.container.clientHeight) return;
    this.display.scale(this.fit && width && height
      ? Math.min(this.container.clientWidth / width, this.container.clientHeight / height) : 1);
  }
  private scheduleResize(): void {
    clearTimeout(this.resizeTimer);
    if (!this.connected || this.disposed || !this.fit) return;
    this.resizeTimer = setTimeout(() => {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      if (!w || !h || this.disposed || !this.fit) return;
      // Keep a useful virtual resolution on narrow touch screens, preserving
      // their aspect ratio instead of requesting an unusable 390-pixel desktop.
      const factor = Math.max(1, 640 / w, 480 / h);
      const width = Math.max(640, Math.min(2560, Math.round(w * factor)));
      const height = Math.max(480, Math.min(1600, Math.round(h * factor)));
      const size = `${width}x${height}`;
      if (size === this.requestedSize) return;
      this.requestedSize = size; this.client.sendSize(width, height);
    }, 150);
  }
  set scaleViewport(fit: boolean) { this.fit = fit; this.scale(); this.scheduleResize(); }
  set viewOnly(value: boolean) { this.tunnel.cancelPointerMoves(); this.keyboard.reset(); this.readonlyMode = value; this.localPointer = false; }
  sendKey(keysym: number, _code?: string | null, down = true): void {
    if (!this.readonlyMode && !this.disposed) this.client.sendKeyEvent(down ? 1 : 0, keysym);
  }
  clipboardPasteFrom(text: string): void {
    if (this.readonlyMode || this.disposed) return;
    const writer = new Guacamole.StringWriter(this.client.createClipboardStream('text/plain'));
    writer.sendText(text); writer.sendEnd();
  }
  disconnect(): void {
    if (this.disposed) return;
    this.disposed = true; this.tunnel.cancelPointerMoves(); this.keyboard.reset(); this.listeners.abort(); this.observer.disconnect();
    clearTimeout(this.resizeTimer);
    this.client.disconnect(); this.container.remove();
  }
}

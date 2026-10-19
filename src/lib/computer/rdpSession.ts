import Guacamole from 'guacamole-common-js';
import { SecureRdpTunnel, type RdpConnection } from './secureRdpTunnel';
import type { ComputerPointer } from './pointer';
import { batchRdpDisplay } from './rdpDisplayBatch';
import { computerDesktopSize } from './viewport';
import { computerTextKeysyms } from './textKeys';
import { COMPUTER_CLIPBOARD_LIMIT } from './clipboard';
import type { ComputerMotionTrace } from './motionTrace';

/** Keep the UI controls shared with VNC while rendering RDP via Guacamole. */
export class RdpSession extends EventTarget {
  private client: Guacamole.Client;
  private tunnel: SecureRdpTunnel;
  private keyboard: Guacamole.Keyboard;
  private mouse: Guacamole.Mouse;
  private keyboardInput: HTMLTextAreaElement;
  private display: Guacamole.Display;
  private container: HTMLDivElement;
  private observer: ResizeObserver;
  private listeners = new AbortController();
  private readonlyMode = false;
  private fit = true;
  private zoom = 1;
  private resizePaused = false;
  private disposed = false;
  private connected = false;
  private authenticationPending = false;
  private connectionNotified = false;
  private phoneKeyboardActive = false;
  private viewportScale = 1;
  private keyboardScale: number | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private requestedSize: string;
  private clipboardGeneration = 0;
  private localPointer = false;
  private nativeCursor = false;
  private touchpadPointer = false;
  private cancelDisplayBatch: () => void;
  constructor(private readonly target: HTMLElement, options: RdpConnection, fail: (reason: string) => void, private readonly trace?: ComputerMotionTrace) {
    super();
    this.requestedSize = `${options.width}x${options.height}`;
    trace?.record('rdp-start', { width: options.width, height: options.height });
    const tunnel = this.tunnel = new SecureRdpTunnel(options, fail, () => this.localPointer && !this.readonlyMode, trace);
    tunnel.onauthentication = state => {
      this.authenticationPending = state === 'pending';
      this.notifyConnected();
    };
    this.client = new Guacamole.Client(tunnel);
    this.display = this.client.getDisplay();
    // Keep touchpad cursor motion on its own compositor layer. The bitmap is
    // still supplied by the remote OS; moving it must not repaint the desktop
    // or become an interactive hit target below the user's finger.
    const cursorLayer = this.display.getCursorLayer().getElement();
    cursorLayer.style.pointerEvents = 'none';
    const batch = batchRdpDisplay(this.display);
    this.cancelDisplayBatch = () => batch.cancel();
    tunnel.oninstructionbatch = (deliver, syncs) => batch.run(deliver, syncs);
    this.container = document.createElement('div');
    this.container.className = 'flex h-full w-full overflow-auto outline-none'; this.container.tabIndex = 0;
    this.container.appendChild(this.display.getElement()); target.appendChild(this.container);
    // An editable target lets desktop IMEs produce composition/input events
    // and gives native clipboard commands a stable focus target. Keep keyboard
    // handlers on the ancestor so ordinary keys,
    // composition and clipboard shortcuts still share one ordered input path.
    const keyboardInput = this.keyboardInput = document.createElement('textarea');
    keyboardInput.tabIndex = -1; keyboardInput.setAttribute('aria-label', 'Remote desktop keyboard');
    keyboardInput.autocapitalize = 'off'; keyboardInput.autocomplete = 'off'; keyboardInput.spellcheck = false;
    Object.assign(keyboardInput.style, { position: 'absolute', left: '0', top: '0', width: '1px', height: '1px', fontSize: '16px', opacity: '0', pointerEvents: 'none' });
    this.container.append(keyboardInput);
    keyboardInput.addEventListener('input', event => {
      if (!(event as InputEvent).isComposing) keyboardInput.value = '';
    }, { signal: this.listeners.signal });
    keyboardInput.addEventListener('compositionend', () => { keyboardInput.value = ''; }, { signal: this.listeners.signal });
    this.keyboard = new Guacamole.Keyboard(this.container);
    this.keyboard.onkeydown = keysym => { if (!this.readonlyMode) this.client.sendKeyEvent(1, keysym); return false; };
    // Guacamole 1.5 iterates UTF-16 units in Keyboard.type(), which sends an
    // extra low surrogate after an emoji. Use the same code-point mapping as
    // the visible mobile input, retaining Guacamole's pressed-key bookkeeping.
    this.keyboard.type = text => {
      if (this.readonlyMode || this.disposed || !this.connected) return;
      for (const keysym of computerTextKeysyms(text)) { this.keyboard.press(keysym); this.keyboard.release(keysym); }
    };
    this.keyboard.onkeyup = keysym => { if (!this.readonlyMode) this.client.sendKeyEvent(0, keysym); };
    const display = this.display.getElement();
    display.className = 'm-auto shrink-0';
    const sendMouse = (event: Guacamole.Event) => {
      if (this.touchpadPointer) return;
      if (!this.readonlyMode) { this.touchpadPointer = false; this.localPointer = true; this.client.sendMouseState((event as Guacamole.Mouse.Event).state, true); }
    };
    const mouse = this.mouse = new Guacamole.Mouse(display);
    mouse.onEach(['mousedown', 'mousemove', 'mouseup'], event => { const state = (event as Guacamole.Mouse.Event).state; trace?.record('rdp-native-mouse', { x: state.x, y: state.y, ignored: this.touchpadPointer }); if (this.touchpadPointer) return; sendMouse(event); if (!this.readonlyMode) this.display.showCursor(!this.nativeCursor); });
    mouse.on('mouseout', () => { if (!this.touchpadPointer) { this.localPointer = false; this.display.showCursor(false); } });
    // Touch is handled above this element by our relative touchpad. Legacy
    // mouse events emitted afterwards must not replace it with absolute input.
    // A real mouse/trackpad produces PointerEvents before its mouse events.
    const physicalMouse = (event: PointerEvent) => {
      trace?.record('rdp-pointer-event', { type: event.type, pointerType: event.pointerType, x: event.clientX, y: event.clientY });
      if (event.pointerType === 'mouse') this.touchpadPointer = false;
    };
    this.container.addEventListener('pointermove', physicalMouse, { capture: true, signal: this.listeners.signal });
    this.container.addEventListener('pointerdown', physicalMouse, { capture: true, signal: this.listeners.signal });
    this.display.oncursor = (canvas, x, y) => {
      trace?.record('rdp-cursor-shape', { width: canvas.width, height: canvas.height, hotspot: [x, y], actual: [this.display.cursorX, this.display.cursorY] });
      this.nativeCursor = mouse.setCursor(canvas, x, y);
      if (this.localPointer && !this.readonlyMode) this.display.showCursor(this.touchpadPointer || !this.nativeCursor);
    };
    new Guacamole.Mouse.Touchscreen(display).onEach(['mousedown', 'mousemove', 'mouseup'], event => { sendMouse(event); if (!this.readonlyMode) this.display.showCursor(true); });
    this.container.addEventListener('pointerdown', event => {
      if (this.phoneKeyboardActive) event.preventDefault();
      else this.keyboardInput.focus({ preventScroll: true });
    }, { signal: this.listeners.signal });
    this.container.addEventListener('blur', () => this.keyboard.reset(), { capture: true, signal: this.listeners.signal });
    window.addEventListener('blur', () => { this.keyboard.reset(); mouse.reset(); }, { signal: this.listeners.signal });
    this.observer = new ResizeObserver(() => { this.scale(); this.scheduleResize(); }); this.observer.observe(target);
    this.display.onresize = () => { this.scale(); this.notifyConnected(); };
    this.client.onstatechange = state => {
      if (this.disposed) return;
      if (state === Guacamole.Client.State.CONNECTED) { this.connected = true; this.notifyConnected(); this.scheduleResize(); }
      if (state === Guacamole.Client.State.DISCONNECTED) fail('COMPUTER_DISCONNECTED');
    };
    this.client.onclipboard = (stream, mimetype) => {
      const generation = ++this.clipboardGeneration;
      if (!/^text\/plain(?:;|$)/i.test(mimetype)) {
        stream.sendAck('Only plain text clipboard is supported', 0x0100); return;
      }
      const reader = new Guacamole.ArrayBufferReader(stream);
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '', rejected = false, bytes = 0;
      const reject = () => {
        if (rejected) return;
        rejected = true; text = ''; stream.sendAck('Invalid or oversized text clipboard', 0x0300);
        this.dispatchEvent(new Event('clipboarderror'));
      };
      reader.ondata = chunk => {
        if (rejected || this.disposed || generation !== this.clipboardGeneration) return;
        bytes += chunk.byteLength;
        try {
          if (bytes > COMPUTER_CLIPBOARD_LIMIT * 4) { reject(); return; }
          text += decoder.decode(chunk, { stream: true });
          if (text.length > COMPUTER_CLIPBOARD_LIMIT) reject();
        } catch { reject(); }
      };
      reader.onend = () => {
        if (rejected || this.disposed || generation !== this.clipboardGeneration) return;
        try { text += decoder.decode(); } catch { reject(); return; }
        if (text.length > COMPUTER_CLIPBOARD_LIMIT) { reject(); return; }
        this.dispatchEvent(new CustomEvent('clipboard', { detail: { text } }));
      };
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
  private notifyConnected(): void {
    if (!this.connected || !this.display.getWidth() || !this.display.getHeight()
      || this.authenticationPending || this.connectionNotified || this.disposed) return;
    this.connectionNotified = true; this.dispatchEvent(new Event('connect')); this.scheduleResize();
  }
  private scale(): void {
    const width = this.display.getWidth(), height = this.display.getHeight();
    if (!this.target.clientWidth || !this.target.clientHeight) return;
    this.viewportScale = this.fit && width && height
      ? Math.min(this.target.clientWidth / width, this.keyboardScale ?? this.target.clientHeight / height) : 1;
    this.display.scale(this.viewportScale * this.zoom);
    this.trace?.record('rdp-scale', { desktop: [width, height], viewport: [this.target.clientWidth, this.target.clientHeight], scale: this.viewportScale, zoom: this.zoom });
  }
  private scheduleResize(): void {
    clearTimeout(this.resizeTimer);
    if (!this.connected || !this.connectionNotified || this.disposed || !this.fit || this.resizePaused) return;
    this.resizeTimer = setTimeout(() => {
      // Measure the fixed viewport, not the scroller: its scrollbars can
      // appear during remote repaint/zoom and otherwise feed back into RDP size.
      const w = this.target.clientWidth, h = this.target.clientHeight;
      if (!w || !h || !this.connectionNotified || this.disposed || !this.fit || this.resizePaused) return;
      // Keep a useful virtual resolution on narrow touch screens, preserving
      // their aspect ratio instead of requesting an unusable 390-pixel desktop.
      const { width, height } = computerDesktopSize(w, h);
      const size = `${width}x${height}`;
      if (size === this.requestedSize) return;
      this.requestedSize = size; this.client.sendSize(width, height);
    }, 150);
  }
  set scaleViewport(fit: boolean) { this.fit = fit; this.scale(); this.scheduleResize(); }
  set viewportZoom(zoom: number) { this.zoom = zoom; this.scale(); }
  get viewportZoom(): number { return this.zoom; }
  get viewportScroller(): HTMLElement { return this.container; }
  set pauseResize(paused: boolean) { this.resizePaused = paused; this.scheduleResize(); }
  set keyboardActive(active: boolean) {
    if (active === this.phoneKeyboardActive) return;
    this.keyboardScale = active ? this.viewportScale : null;
    this.phoneKeyboardActive = active; this.keyboard.reset(); this.scale();
  }
  get pointerTarget(): ComputerPointer {
    return {
      rendersCursor: true,
      position: () => ({ x: this.display.cursorX, y: this.display.cursorY }),
      observeCursor: () => {
        const element = this.display.getCursorLayer().getElement();
        return { transform: element.style.transform, connected: element.isConnected,
          scale: this.viewportScale * this.zoom, hotspot: [this.display.cursorHotspotX, this.display.cursorHotspotY] };
      },
      size: () => ({ width: this.display.getWidth(), height: this.display.getHeight() }),
      surface: () => this.display.getElement(),
      send: (x, y, buttons) => {
        if (this.readonlyMode || this.disposed || !this.connected) return;
        this.localPointer = true;
        this.touchpadPointer = true;
        this.display.moveCursor(x, y);
        this.display.showCursor(true);
        this.tunnel.sendPointer(x, y, buttons);
      },
    };
  }
  set viewOnly(value: boolean) { this.tunnel.cancelPointerMoves(); this.keyboard.reset(); this.mouse.reset(); this.readonlyMode = value; this.localPointer = false; if (value) this.display.showCursor(false); }
  focus(options: FocusOptions = { preventScroll: true }): void { if (!this.phoneKeyboardActive && !this.readonlyMode && !this.disposed) this.keyboardInput.focus(options); }
  sendKey(keysym: number, _code?: string | null, down = true): void {
    if (!this.readonlyMode && !this.disposed) this.client.sendKeyEvent(down ? 1 : 0, keysym);
  }
  clipboardPasteFrom(text: string): void {
    if (this.readonlyMode || this.disposed) return;
    if (text.length > COMPUTER_CLIPBOARD_LIMIT) throw new RangeError('Clipboard is too large');
    // The bundled Guacamole 1.5 StringReader/StringWriter mishandle astral
    // Unicode. Retain its binary stream framing and use native UTF-8 codecs.
    const writer = new Guacamole.ArrayBufferWriter(this.client.createClipboardStream('text/plain'));
    writer.onack = status => { if (status.isError() && !this.disposed) this.dispatchEvent(new Event('clipboarderror')); };
    writer.sendData(new TextEncoder().encode(text)); writer.sendEnd();
  }
  disconnect(): void {
    if (this.disposed) return;
    this.disposed = true; this.tunnel.cancelPointerMoves(); this.keyboard.reset(); this.mouse.reset(); this.listeners.abort(); this.observer.disconnect();
    this.cancelDisplayBatch();
    (this.display as Guacamole.Display & { cancel?: () => void }).cancel?.();
    clearTimeout(this.resizeTimer);
    this.trace?.record('rdp-disconnect'); this.trace?.flush('rdp-disconnect');
    this.client.disconnect(); this.container.remove();
  }
}

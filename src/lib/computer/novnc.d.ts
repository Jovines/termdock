declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, channel: object, options?: { shared?: boolean; credentials?: { username?: string; password?: string } });
    background: string;
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    focus(): void;
    blur(): void;
    sendKey(keysym: number, code?: string | null, down?: boolean): void;
    sendCredentials(credentials: { username?: string; password?: string }): void;
    clipboardPasteFrom(text: string): void;
  }
}

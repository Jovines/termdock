declare module 'qrcode' {
  export interface QRCodeToDataURLOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    width?: number;
    color?: {
      dark?: string;
      light?: string;
    };
  }

  export function toString(text: string, options: { type: 'terminal'; small?: boolean }): Promise<string>;
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
}

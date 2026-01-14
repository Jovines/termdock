// Type declarations for node-pty and bun-pty

declare module 'node-pty' {
  export interface IPty {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    onData(callback: (data: string) => void): { dispose: () => void };
    onExit(callback: (event: { exitCode: number; signal: number | null }) => void): { dispose: () => void };
    pause?(): void;
    resume?(): void;
    pid: number;
    process: string;
  }

  export interface IPtyOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
    encoding?: string;
    uid?: number;
    gid?: number;
    encodingThreshold?: number;
    maxDataRead?: number;
  }

  export function spawn(
    file: string,
    args: string[] | string,
    options: IPtyOptions
  ): IPty;
}

declare module 'bun-pty' {
  export interface BunPtyProcess {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    onData(callback: (data: string) => void): { dispose: () => void };
    onExit(callback: (event: { exitCode: number; signal: number | null }) => void): { dispose: () => void };
    pause?(): void;
    resume?(): void;
    pid: number;
  }

  export interface BunPtyOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  }

  export function spawn(
    file: string,
    args: string[],
    options: BunPtyOptions
  ): BunPtyProcess;
}

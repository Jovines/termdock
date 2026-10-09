export type ComputerPlatform = 'mac' | 'linux' | 'windows';
export type ComputerKey = [number, string];

export function computerPlatform(platform?: string): ComputerPlatform {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux';
}

export function isComputerPlatform(value: unknown): value is ComputerPlatform {
  return value === 'mac' || value === 'linux' || value === 'windows';
}

export function computerShortcuts(platform: ComputerPlatform): Record<string, ComputerKey[]> {
  // noVNC maps Alt_L to Command on macOS servers; other desktops use Control.
  const modifier: ComputerKey = platform === 'mac' ? [0xffe9, 'MetaLeft'] : [0xffe3, 'ControlLeft'];
  const system: ComputerKey = platform === 'mac' ? modifier : [0xffeb, 'MetaLeft'];
  return {
    escape: [[0xff1b, 'Escape']], enter: [[0xff0d, 'Enter']], backspace: [[0xff08, 'Backspace']],
    tab: [platform === 'mac' ? modifier : [0xffe9, 'AltLeft'], [0xff09, 'Tab']],
    search: platform === 'mac' ? [system, [0x20, 'Space']] : [system],
    copy: [modifier, [0x63, 'KeyC']], paste: [modifier, [0x76, 'KeyV']],
    up: [[0xff52, 'ArrowUp']], down: [[0xff54, 'ArrowDown']], left: [[0xff51, 'ArrowLeft']], right: [[0xff53, 'ArrowRight']],
  };
}

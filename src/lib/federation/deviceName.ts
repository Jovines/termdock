/** Browsers expose the platform, not the user's private hardware name. */
export function defaultDeviceName(agent = navigator.userAgent, touchPoints = navigator.maxTouchPoints): string {
  const system = /iPad/.test(agent) || (/Macintosh/.test(agent) && touchPoints > 1) ? 'iPad' : /iPhone/.test(agent) ? 'iPhone' : /Android/.test(agent) ? 'Android' : /Windows/.test(agent) ? 'Windows' : /Macintosh|Mac OS X/.test(agent) ? 'Mac' : /Linux/.test(agent) ? 'Linux' : '设备';
  const browser = /Electron/.test(agent) ? 'Termdock' : /Edg\//.test(agent) ? 'Edge' : /Firefox|FxiOS/.test(agent) ? 'Firefox' : /Chrome|CriOS/.test(agent) ? 'Chrome' : /Safari/.test(agent) ? 'Safari' : '浏览器';
  return `${system} · ${browser}`;
}

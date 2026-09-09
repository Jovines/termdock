import { getTermdockDesktopBridge } from '../desktop/nativeBridge';
import { defaultDeviceName } from './deviceName';
import type { DeviceProfile } from '../../server/federation/deviceProfile';

let cached: Promise<DeviceProfile> | undefined;
export function readDeviceProfile(): Promise<DeviceProfile> {
  return cached ??= (async () => {
    const ua = navigator.userAgent;
    const [system, client] = defaultDeviceName().split(' · ');
    const version = /(?:Edg|Firefox|FxiOS|Chrome|CriOS|Version)\/([\d.]+)/g;
    const versions = [...ua.matchAll(version)];
    const osVersion = /(?:CPU (?:iPhone )?OS |Mac OS X |Android )([\d._]+)/.exec(ua)?.[1]?.replaceAll('_', '.');
    const profile: DeviceProfile = { system: `${system}${osVersion ? ` ${osVersion}` : ''}`, client: `${client}${versions.length ? ` ${versions.at(-1)![1]}` : ''}`,
      mode: matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone ? '已安装的网页应用' : '网页' };
    const bridge = getTermdockDesktopBridge();
    if (bridge) {
      profile.mode = '桌面客户端';
      const electronVersion = /Electron\/([\d.]+)/.exec(ua)?.[1];
      profile.client = electronVersion ? `Termdock（Electron ${electronVersion}）` : 'Termdock';
      try { Object.assign(profile, await bridge.deviceInfo?.()); } catch { /* Older native clients still report browser information. */ }
      return profile;
    }
    const data = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(keys: string[]): Promise<Record<string, unknown>> } }).userAgentData;
    try {
      const values = await data?.getHighEntropyValues(['model', 'architecture', 'bitness', 'platformVersion']);
      if (typeof values?.model === 'string' && values.model) profile.model = values.model;
      if (typeof values?.architecture === 'string' && values.architecture) profile.arch = `${values.architecture}${values.bitness ? ` ${values.bitness} 位` : ''}`;
    } catch { /* Browser policy may omit hardware details. */ }
    return profile;
  })();
}

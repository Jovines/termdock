import { create } from 'zustand';

/** 'window' = 整个视口全屏；'sidebar' = 铺满右侧边栏（手机上好操作）。 */
export type AndroidOverlayMode = 'off' | 'window' | 'sidebar';

/** 覆盖层投屏由 App 顶层持有实例，避免与侧栏/分屏同时开出多条流。 */
interface AndroidMirrorStore {
  overlay: AndroidOverlayMode;
  setOverlay: (overlay: AndroidOverlayMode) => void;
}

export const useAndroidMirrorStore = create<AndroidMirrorStore>(set => ({
  overlay: 'off',
  setOverlay: overlay => set({ overlay }),
}));

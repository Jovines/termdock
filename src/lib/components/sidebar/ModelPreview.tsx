// flexoki-allow-file — 3D viewer 是刻意与主题无关的组件,色值固定为一套
// 独立观感(对齐 cadquery-print skill 的 view.html),不随 Flexoki 主题切换。
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize as RiMaximize, Minimize as RiMinimize, Sun as RiSun, Moon as RiMoon, RefreshCw as RiRefreshCw, Scissors as RiScissors, ArrowLeftRight as RiArrowLeftRight } from 'lucide-react';
import {
  AmbientLight,
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  GridHelper,
  Group,
  LineBasicMaterial,
  Material,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Plane,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { useI18n } from '../../i18n';

export type Model3dLoaderKind = 'stl' | 'gltf';

export function resolveModel3dLoaderKind(ext: string): Model3dLoaderKind | null {
  const normalized = ext.toLowerCase();
  if (normalized === '.stl') return 'stl';
  if (normalized === '.glb' || normalized === '.gltf') return 'gltf';
  return null;
}

export function formatModelDimension(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

export function formatModelDimensions(size: { x: number; y: number; z: number }, unit?: string): string {
  const dims = `${formatModelDimension(size.x)} × ${formatModelDimension(size.y)} × ${formatModelDimension(size.z)}`;
  return unit ? `${dims} ${unit}` : dims;
}

type ViewerAppearanceMode = 'light' | 'dark';

// Self-contained viewer palette: the exact look of the standalone
// cadquery-print viewer (render.py), independent of the app theme.
const VIEWER_APPEARANCE: Record<ViewerAppearanceMode, { bg: string; part: string; gridLine: string; grid: string }> = {
  light: { bg: '#F4F4F2', part: '#9AA0A6', gridLine: '#CCCCCC', grid: '#DDDDDD' },
  dark: { bg: '#232527', part: '#8B929A', gridLine: '#4A4E54', grid: '#3A3E44' },
};

function currentThemeMode(): ViewerAppearanceMode {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

type ParsedModel =
  | { kind: 'stl'; geometry: BufferGeometry }
  | { kind: 'gltf'; object: Group };

/** Section (clipping-plane) state. axis is in MODEL coordinates (STL: Z-up). */
export interface ClipState {
  axis: 'x' | 'y' | 'z';
  /** 0..1 across the bounding box along the axis. */
  value01: number;
  flip: boolean;
}

async function parseModel(buffer: ArrayBuffer, kind: Model3dLoaderKind): Promise<ParsedModel> {
  if (kind === 'stl') {
    return { kind: 'stl', geometry: new STLLoader().parse(buffer) };
  }
  const gltf = await new Promise<{ scene: Group }>((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', resolve, reject);
  });
  return { kind: 'gltf', object: gltf.scene };
}

interface ViewerResult {
  dims: string;
  setAppearance: (mode: 'light' | 'dark') => void;
  setClip: (clip: ClipState | null) => void;
  dispose: () => void;
}

// Mirrors the tuned look of the cadquery-print three.js viewer (render.py):
// neutral gray standard material, ambient + two directional lights, faint
// ground grid, camera fitted to the bounding sphere, STL Z-up rotated to
// three's Y-up, OrbitControls with damping.
function mountModelViewer(container: HTMLElement, parsed: ParsedModel): ViewerResult {
  const initialMode = currentThemeMode();
  const scene = new Scene();
  scene.background = new Color(VIEWER_APPEARANCE[initialMode].bg);

  const camera = new PerspectiveCamera(45, container.clientWidth / Math.max(1, container.clientHeight), 0.1, 10000);

  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  // three r155+ uses physical light units; r128-era intensities carried an
  // implicit ×π factor. The standalone viewer (render.py, three r128) uses
  // 0.55 / 0.8 / 0.35 — multiply by π for an identical look on r185.
  scene.add(new AmbientLight('white', 0.55 * Math.PI));
  const keyLight = new DirectionalLight('white', 0.8 * Math.PI);
  keyLight.position.set(1, 2, 3);
  scene.add(keyLight);
  const fillLight = new DirectionalLight('white', 0.35 * Math.PI);
  fillLight.position.set(-2, -1, -2);
  scene.add(fillLight);

  let size: Vector3;
  let stlMaterial: MeshStandardMaterial | null = null;
  let modelObject: Mesh | Group;
  if (parsed.kind === 'stl') {
    const geometry = parsed.geometry;
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox!;
    size = bb.getSize(new Vector3());
    const center = bb.getCenter(new Vector3());
    geometry.translate(-center.x, -center.y, -center.z);
    stlMaterial = new MeshStandardMaterial({ color: new Color(VIEWER_APPEARANCE[initialMode].part), metalness: 0.1, roughness: 0.75 });
    const mesh = new Mesh(geometry, stlMaterial);
    // STL is Z-up; rotate -90° around X into three's Y-up.
    mesh.rotation.x = -Math.PI / 2;
    scene.add(mesh);
    modelObject = mesh;
  } else {
    const object = parsed.object;
    const bb = new Box3().setFromObject(object);
    size = bb.getSize(new Vector3());
    const center = bb.getCenter(new Vector3());
    object.position.sub(center);
    scene.add(object);
    modelObject = object;
  }

  // Section (clipping plane) support. The plane lives in world space; the UI
  // speaks model axes, so map model axes onto world directions first
  // (STL was rotated -90° around X: model (x,y,z) → world (x,z,-y)).
  const worldBox = new Box3().setFromObject(modelObject);
  const worldSize = worldBox.getSize(new Vector3());
  const axisDirs: Record<ClipState['axis'], Vector3> =
    parsed.kind === 'stl'
      ? { x: new Vector3(1, 0, 0), y: new Vector3(0, 0, -1), z: new Vector3(0, 1, 0) }
      : { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) };
  const clipPlane = new Plane(new Vector3(0, -1, 0), 0);
  const clipMaterials: Material[] = [];
  modelObject.traverse((node) => {
    if (node instanceof Mesh) {
      for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
        clipMaterials.push(m);
      }
    }
  });

  // Fit the camera to the bounding sphere.
  const radius = Math.max(size.length() / 2, 1e-6);
  const dist = (radius / Math.tan(((camera.fov * Math.PI) / 180) / 2)) * 1.4;
  camera.position.set(dist * 0.7, dist * 0.6, dist * 0.7);
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();

  // Grid colors are baked into the geometry at construction time, so an
  // appearance switch rebuilds the grid instead of mutating it.
  let grid: GridHelper | null = null;
  const buildGrid = (mode: ViewerAppearanceMode) => {
    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      (grid.material as LineBasicMaterial).dispose();
    }
    const appearance = VIEWER_APPEARANCE[mode];
    grid = new GridHelper(
      radius * 4,
      20,
      new Color(appearance.gridLine),
      new Color(appearance.grid),
    );
    grid.position.y = -radius * 1.001;
    scene.add(grid);
  };
  buildGrid(initialMode);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const resizeObserver = new ResizeObserver(() => {
    const width = container.clientWidth;
    const height = Math.max(1, container.clientHeight);
    if (width === 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  });
  resizeObserver.observe(container);

  let frameId = 0;
  const animate = () => {
    frameId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  return {
    // STL is always mm. glTF is nominally meters, but CAD/printing exports
    // (e.g. CadQuery) are usually mm — there is no reliable unit metadata, so
    // show raw bounding-box numbers without a unit rather than a wrong one.
    dims: formatModelDimensions(size, parsed.kind === 'stl' ? 'mm' : undefined),
    setAppearance: (mode: 'light' | 'dark') => {
      const appearance = VIEWER_APPEARANCE[mode];
      scene.background = new Color(appearance.bg);
      // Light backgrounds need a lighter part color, otherwise the gray that
      // reads well on dark looks muddy on white. glTF materials stay as baked.
      if (stlMaterial) {
        stlMaterial.color = new Color(appearance.part);
      }
      buildGrid(mode);
    },
    setClip: (clip) => {
      if (!clip) {
        for (const m of clipMaterials) m.clippingPlanes = null;
        if (stlMaterial) stlMaterial.side = FrontSide;
        return;
      }
      const dir = axisDirs[clip.axis];
      const half =
        (Math.abs(dir.x) * worldSize.x +
          Math.abs(dir.y) * worldSize.y +
          Math.abs(dir.z) * worldSize.z) / 2;
      const v = (clip.value01 * 2 - 1) * half;
      // Keep the side where dot(dir, p) <= v; flip swaps the kept side.
      clipPlane.normal.copy(dir).negate();
      clipPlane.constant = v;
      if (clip.flip) {
        clipPlane.normal.negate();
        clipPlane.constant = -v;
      }
      for (const m of clipMaterials) m.clippingPlanes = [clipPlane];
      // Clipping exposes the hollow interior; render back faces too so the
      // cut reads as a shell instead of disappearing walls.
      if (stlMaterial) stlMaterial.side = DoubleSide;
    },
    dispose: () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.dispose();
      if (grid) {
        scene.remove(grid);
        grid.geometry.dispose();
        (grid.material as LineBasicMaterial).dispose();
        grid = null;
      }
      scene.traverse((node) => {
        if (node instanceof Mesh) {
          node.geometry.dispose();
          const material = node.material;
          for (const entry of Array.isArray(material) ? material : [material]) entry.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

interface ModelPreviewProps {
  blobUrl: string;
  ext: string;
  fileName: string;
  /** Re-fetch the model from the server (manual fallback when file-watch
      auto-reload misses, e.g. suspended SSE on mobile). */
  onRefresh?: () => void;
}

type ModelPreviewStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; dims: string }
  | { kind: 'error'; message: string };

const BG_STORAGE_KEY = 'termdock.model3d.bg';

export default function ModelPreview({ blobUrl, ext, fileName, onRefresh }: ModelPreviewProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<ModelPreviewStatus>({ kind: 'loading' });
  const [isFullscreen, setIsFullscreen] = useState(false);
  // iPhone Safari has no element-level Fullscreen API (iPad/video only), so
  // fall back to an in-app viewport-filling overlay there.
  const supportsFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const expanded = isFullscreen || pseudoFullscreen;
  const toggleFullscreen = () => {
    if (supportsFullscreen) {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void rootRef.current?.requestFullscreen();
      }
    } else {
      setPseudoFullscreen((v) => !v);
    }
  };
  // Explicit light/dark viewer background; null = follow the app theme.
  // Persisted per browser so the choice survives reloads.
  const [bgOverride, setBgOverride] = useState<'light' | 'dark' | null>(() => {
    if (typeof window === 'undefined') return null;
    const saved = window.localStorage.getItem(BG_STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  });
  const viewerRef = useRef<ViewerResult | null>(null);
  const bgOverrideRef = useRef(bgOverride);
  bgOverrideRef.current = bgOverride;
  // Section (clipping plane) UI state. Z is the model's up axis (STL: Z-up),
  // the most useful default for inspecting layer/stacked features.
  const [clipOn, setClipOn] = useState(false);
  const [clipAxis, setClipAxis] = useState<ClipState['axis']>('z');
  const [clipPos, setClipPos] = useState(0.5);
  const [clipFlip, setClipFlip] = useState(false);
  const clipRef = useRef<ClipState | null>(null);
  clipRef.current = clipOn ? { axis: clipAxis, value01: clipPos, flip: clipFlip } : null;

  // The default (provider-less) useI18n returns a fresh `t` every render, so
  // it cannot sit in the effect deps without looping; keep it in a ref.
  const tRef = useRef(t);
  tRef.current = t;

  const themeDefaultBg: 'light' | 'dark' = currentThemeMode();
  const effectiveBg = bgOverride ?? themeDefaultBg;

  const toggleBg = () => {
    const next = effectiveBg === 'dark' ? ('light' as const) : ('dark' as const);
    setBgOverride(next);
    try {
      window.localStorage.setItem(BG_STORAGE_KEY, next);
    } catch {
      // Private mode / storage disabled: fall back to session-only state.
    }
  };

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === rootRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    const kind = resolveModel3dLoaderKind(ext);
    if (!kind) {
      setStatus({ kind: 'error', message: tRef.current('rightSidebar.model3dLoadFailed') });
      return;
    }

    let cancelled = false;
    let disposeViewer: (() => void) | null = null;
    setStatus({ kind: 'loading' });

    (async () => {
      const response = await fetch(blobUrl);
      if (!response.ok) throw new Error(`Failed to fetch model blob (${response.status})`);
      const buffer = await response.arrayBuffer();
      const parsed = await parseModel(buffer, kind);
      const container = containerRef.current;
      if (cancelled || !container) return;
      const viewer = mountModelViewer(container, parsed);
      disposeViewer = viewer.dispose;
      viewerRef.current = viewer;
      // A background override survives file switches (the component is reused);
      // re-apply it over the theme default set by mountModelViewer.
      if (bgOverrideRef.current) viewer.setAppearance(bgOverrideRef.current);
      // Same for the section state: re-apply after a remount/file switch.
      viewer.setClip(clipRef.current);
      if (!cancelled) setStatus({ kind: 'ready', dims: viewer.dims });
    })().catch((err) => {
      if (cancelled) return;
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : tRef.current('rightSidebar.model3dLoadFailed') });
    });

    return () => {
      cancelled = true;
      disposeViewer?.();
      viewerRef.current = null;
    };
    // pseudoFullscreen switches the portal target, which remounts the viewer
    // container — re-run the whole load/mount sequence for the new location.
  }, [blobUrl, ext, pseudoFullscreen]);

  // Apply background toggles to the live viewer.
  useEffect(() => {
    if (bgOverride) viewerRef.current?.setAppearance(bgOverride);
  }, [bgOverride]);

  // Apply section-state changes to the live viewer.
  useEffect(() => {
    viewerRef.current?.setClip(clipOn ? { axis: clipAxis, value01: clipPos, flip: clipFlip } : null);
  }, [clipOn, clipAxis, clipPos, clipFlip]);

  // Pseudo-fullscreen renders through a portal to <body> so the overlay is in
  // the root stacking context — staying inside the sidebar tree loses to
  // sibling overlays (sessions bar) and to ancestors with transforms.
  const viewerUi = (
    <div
      ref={rootRef}
      className={
        pseudoFullscreen
          ? 'fixed inset-0 z-modal-panel overflow-hidden bg-surface'
          : 'relative h-full min-h-0 flex-1 overflow-hidden bg-surface'
      }
    >
      {status.kind === 'ready' && (
        <div className={`pointer-events-none absolute z-10 select-none text-xs leading-relaxed text-muted-foreground max-sm:rounded-lg max-sm:bg-surface/75 max-sm:px-2.5 max-sm:py-1.5 max-sm:text-[15px] ${expanded ? 'left-[calc(0.75rem+env(safe-area-inset-left,0px))] top-[calc(0.625rem+env(safe-area-inset-top,0px))]' : 'left-3 top-2.5'}`}>
          <div className="text-sm font-semibold text-foreground max-sm:text-base">{fileName}</div>
          <div>{t('rightSidebar.model3dDimensions', { dims: status.dims })}</div>
          <div className="max-sm:hidden">{t('rightSidebar.model3dHintMouse')}</div>
          <div className="sm:hidden">{t('rightSidebar.model3dHintTouch')}</div>
        </div>
      )}
      {status.kind !== 'error' && (
        <div className={`absolute z-20 flex gap-1.5 ${expanded ? 'right-[calc(0.75rem+env(safe-area-inset-right,0px))] top-[calc(0.625rem+env(safe-area-inset-top,0px))]' : 'right-3 top-2.5'}`}>
          {onRefresh && (
            <button
              type="button"
              title={t('rightSidebar.model3dRefresh')}
              aria-label={t('rightSidebar.model3dRefresh')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
              onClick={onRefresh}
            >
              <RiRefreshCw size={14} />
            </button>
          )}
          <button
            type="button"
            title={t('rightSidebar.model3dClipToggle')}
            aria-label={t('rightSidebar.model3dClipToggle')}
            aria-pressed={clipOn}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition active:scale-95 ${
              clipOn
                ? 'bg-surface-elevated text-foreground'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            onClick={() => setClipOn((v) => !v)}
          >
            <RiScissors size={14} />
          </button>
          <button
            type="button"
            title={t(effectiveBg === 'dark' ? 'rightSidebar.model3dBgToLight' : 'rightSidebar.model3dBgToDark')}
            aria-label={t(effectiveBg === 'dark' ? 'rightSidebar.model3dBgToLight' : 'rightSidebar.model3dBgToDark')}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
            onClick={toggleBg}
          >
            {effectiveBg === 'dark' ? <RiSun size={14} /> : <RiMoon size={14} />}
          </button>
          <button
            type="button"
            title={t(expanded ? 'rightSidebar.model3dFullscreenExit' : 'rightSidebar.model3dFullscreenEnter')}
            aria-label={t(expanded ? 'rightSidebar.model3dFullscreenExit' : 'rightSidebar.model3dFullscreenEnter')}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
            onClick={toggleFullscreen}
          >
            {expanded ? <RiMinimize size={14} /> : <RiMaximize size={14} />}
          </button>
        </div>
      )}
      {/* Section controls: axis pickers + drag slider + flip. Local overlay
          inside the viewer, bare z-20 (local scale, below global overlays). */}
      {status.kind === 'ready' && clipOn && (
        <div
          className={`swiper-no-swiping absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 ${expanded ? 'bottom-[calc(0.75rem+env(safe-area-inset-bottom,0px))]' : 'bottom-3'}`}
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
        >
          {(['x', 'y', 'z'] as const).map((axis) => (
            <button
              key={axis}
              type="button"
              aria-pressed={clipAxis === axis}
              className={`h-6 w-6 rounded-md text-xs font-medium transition active:scale-95 ${
                clipAxis === axis
                  ? 'bg-surface-elevated text-foreground'
                  : 'text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
              }`}
              onClick={() => setClipAxis(axis)}
            >
              {axis.toUpperCase()}
            </button>
          ))}
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(clipPos * 1000)}
            onChange={(event) => setClipPos(Number(event.target.value) / 1000)}
            className="w-32 sm:w-48"
            aria-label={t('rightSidebar.model3dClipPosition')}
          />
          <button
            type="button"
            title={t('rightSidebar.model3dClipFlip')}
            aria-label={t('rightSidebar.model3dClipFlip')}
            aria-pressed={clipFlip}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition active:scale-95 ${
              clipFlip
                ? 'bg-surface-elevated text-foreground'
                : 'text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            onClick={() => setClipFlip((v) => !v)}
          >
            <RiArrowLeftRight size={13} />
          </button>
        </div>
      )}
      {/* The viewer canvas swallows pointer/touch gestures: swiper-no-swiping
          opts out of the sidebar file-list swiper (see gestureArbiter.ts) and
          stopPropagation keeps the events away from other global handlers. */}
      <div
        ref={containerRef}
        className="swiper-no-swiping absolute inset-0"
        style={{ touchAction: 'none' }}
        onPointerDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      />
      {status.kind === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {t('rightSidebar.model3dLoading')}
        </div>
      )}
      {status.kind === 'error' && (
        <div className="absolute inset-0 overflow-auto">
          <div className="mx-3 mt-3 rounded-xl border border-border/15 bg-surface-2 px-4 py-6 text-center text-sm text-muted-foreground">
            {status.message}
          </div>
        </div>
      )}
    </div>
  );

  return pseudoFullscreen ? createPortal(viewerUi, document.body) : viewerUi;
}

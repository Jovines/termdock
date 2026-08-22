// flexoki-allow-file — 3D viewer 是刻意与主题无关的组件,色值固定为一套
// 独立观感(对齐 cadquery-print skill 的 view.html),不随 Flexoki 主题切换。
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize as RiMaximize, Minimize as RiMinimize, Sun as RiSun, Moon as RiMoon, RefreshCw as RiRefreshCw, Scissors as RiScissors, ArrowLeftRight as RiArrowLeftRight, Crosshair as RiCrosshair, Tag as RiTag } from 'lucide-react';
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
  type Object3D,
  PerspectiveCamera,
  Plane,
  Raycaster,
  CircleGeometry,
  RingGeometry,
  Scene,
  Vector2,
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

/** Resolve a raycast leaf to the nearest logical glTF assembly part. */
export function resolvePickedPartName(start: Object3D | null): string {
  let node = start;
  let fallback = '';
  while (node) {
    if (node.name && !fallback) fallback = node.name;
    // Exporters often put generated/internal names on leaf Mesh objects while
    // the nearest Group carries the human-facing assembly part name.
    if (node.name && node.type === 'Group') return node.name;
    node = node.parent;
  }
  return fallback;
}

export type ModelWheelGesture = 'pinch-zoom' | 'trackpad-pan' | 'wheel-zoom';

/**
 * Browsers expose trackpad scrolling and a mouse wheel through the same event.
 * Pinches are reliably marked with ctrlKey on Chromium/WebKit, while smooth
 * pixel deltas are the best cross-browser signal for a two-finger scroll.
 */
export function classifyModelWheelGesture(event: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'deltaMode' | 'deltaX' | 'deltaY'> & { wheelDeltaY?: number }): ModelWheelGesture {
  if (event.ctrlKey || event.metaKey) return 'pinch-zoom';
  if (event.deltaMode !== 0) return 'wheel-zoom';
  const legacyDelta = Math.abs(event.wheelDeltaY ?? 0);
  // Chromium/WebKit retain 120-step legacy deltas for a notched mouse wheel;
  // trackpad deltas are continuous, including during fast momentum scrolling.
  if (legacyDelta >= 120 && legacyDelta % 120 === 0) return 'wheel-zoom';
  if (Math.abs(event.deltaX) > 0.01) return 'trackpad-pan';
  if (legacyDelta > 0 && legacyDelta % 120 !== 0) return 'trackpad-pan';
  if (!Number.isInteger(event.deltaY) || Math.abs(event.deltaY) < 50) return 'trackpad-pan';
  return 'wheel-zoom';
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

/** Semantic feature of a model part (from a sidecar .features.json). */
export interface ModelFeature {
  id: string;
  part: string;
  /** GLB 零件节点名(装配高亮用), 如 base/clip。 */
  node?: string;
  name: string;
  /** Center in the model FILE coordinates (the viewer centers the model). */
  center: [number, number, number];
  normal?: [number, number, number] | null;
  hint?: string;
}

interface GlossaryEntry {
  termZh: string;
  descZh: string;
  termEn: string;
  descEn: string;
}

/** 建模名词通俗解释(说明书), 给不熟悉建模术语的用户看。 */
const MODEL_GLOSSARY: GlossaryEntry[] = [
  { termZh: '倒角', descZh: '把棱角削成斜面（如直角边变 45° 斜边）。防割手、防崩角、方便装配。', termEn: 'Chamfer', descEn: 'Bevels a sharp edge into a flat slope (e.g. 45°). Prevents cuts/chips and eases assembly.' },
  { termZh: '圆角 / 内圆角', descZh: '把棱角磨圆。内角圆角能减少应力集中、不容易裂；外圆角防刮手。', termEn: 'Fillet / inner radius', descEn: 'Rounds a corner. Inner fillets reduce stress concentration; outer fillets prevent sharp edges.' },
  { termZh: '加厚', descZh: '增加壁厚，让零件更结实。', termEn: 'Thicken', descEn: 'Increases wall thickness for strength.' },
  { termZh: '减料', descZh: '去掉一部分材料（减重或让位）。', termEn: 'Remove material', descEn: 'Removes material (lighter or to make room).' },
  { termZh: '钻孔', descZh: '打一个圆孔，通常配螺丝/螺栓。', termEn: 'Drill / hole', descEn: 'Adds a round hole, usually for screws/bolts.' },
  { termZh: '沉孔', descZh: '孔口挖一圈浅台阶，让螺丝头/螺母沉进表面不凸出。', termEn: 'Counterbore', descEn: 'Recesses the hole mouth so screw heads/nuts sit flush.' },
  { termZh: '加强筋', descZh: '表面加一条凸起的筋，用最少材料增加抗弯强度。', termEn: 'Rib', descEn: 'A raised strip that adds bending strength with little material.' },
  { termZh: '燕尾槽', descZh: '横截面是梯形的槽，另一零件的梯形尾部滑进去后被卡住、不会脱出。', termEn: 'Dovetail slot', descEn: 'A trapezoidal slot that locks a matching tail in place.' },
  { termZh: '卡槽', descZh: '用来卡住或滑入另一个零件的槽。', termEn: 'Slot', descEn: 'A groove that holds or guides another part.' },
  { termZh: '燕尾根部', descZh: '燕尾和板身连接的地方，受力集中、容易断。', termEn: 'Tab root', descEn: 'Where the dovetail meets the plate — stress concentrates here.' },
  { termZh: '压面', descZh: '朝墙压住床垫的那个面。', termEn: 'Press face', descEn: 'The face pressing the mattress toward the wall.' },
  { termZh: '胶贴面', descZh: '贴双面胶（VHB）粘到柜子上的面。', termEn: 'Glue face', descEn: 'The face that sticks to the cabinet with VHB tape.' },
  { termZh: '支撑 / 加固', descZh: '在薄弱处加斜撑或筋，增强强度。', termEn: 'Support / reinforce', descEn: 'Adds a brace or rib to strengthen a weak spot.' },
  { termZh: '间隙 / 公差', descZh: '两个配合件之间留的缝隙，滑动配合通常单边 0.15~0.3mm。', termEn: 'Clearance / tolerance', descEn: 'The gap between mating parts (sliding fit ~0.15-0.3mm per side).' },
];

function GlossaryPanel({ locale, onClose }: { locale: 'en' | 'zh'; onClose: () => void }) {
  const isZh = locale === 'zh';
  return (
    <div className="space-y-2 p-1">
      {MODEL_GLOSSARY.map((g, i) => (
        <div key={i} className="rounded-md bg-surface/60 px-2 py-1.5">
          <div className="text-xs font-medium text-foreground">{isZh ? g.termZh : g.termEn}</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{isZh ? g.descZh : g.descEn}</div>
        </div>
      ))}
      <button
        type="button"
        className="mt-1 w-full rounded-md bg-surface-elevated px-2 py-1 text-xs font-medium text-foreground hover:bg-surface"
        onClick={onClose}
      >
        {isZh ? '返回特征列表' : 'Back to features'}
      </button>
    </div>
  );
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
  /** 通用点选: 屏幕坐标 → 模型表面命中(部位名 + CAD 坐标 + 法线)。 */
  pick: (
    screenX: number,
    screenY: number,
    width: number,
    height: number,
  ) => {
    part: string;
    point: [number, number, number];
    normal: [number, number, number] | null;
  } | null;
  /** 选中高亮: 高亮部位(整件发光) + 在命中点放贴合表面的圆环。 */
  setSelection: (
    selections: Array<{
      part: string;
      point: [number, number, number];
      normal: [number, number, number] | null;
    }> | null,
  ) => void;
  /** Project a FILE-space point onto the viewer canvas (px, relative to it). */
  projectToScreen: (filePoint: Vector3) => { x: number; y: number; visible: boolean } | null;
  /** 点到模型表面的最近距离(mm); filePoint 用文件坐标系(CAD Z-up)。 */
  surfaceDistance: (filePoint: { x: number; y: number; z: number }) => number;
  /** Register a callback invoked right after each rendered frame, so overlay
      markers move in the exact same frame as the model (no 1-frame lag). */
  setAfterRender: (cb: (() => void) | null) => void;
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
  const modelCenter = new Vector3();
  if (parsed.kind === 'stl') {
    const geometry = parsed.geometry;
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox!;
    size = bb.getSize(new Vector3());
    const center = bb.getCenter(new Vector3());
    modelCenter.copy(center);
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
    modelCenter.copy(center);
    object.position.sub(center);
    scene.add(object);
    modelObject = object;
  }

  // CAD 文件坐标(Z-up) ↔ three.js 世界坐标(Y-up) 换算。
  // GLB 的 modelCenter 是世界空间包围盒中心; STL 的是 CAD 空间中心,
  // 两者公式不同——共用一套公式会让 STL 坐标整体偏移 (cy−cz), 必须分开。
  const isStl = parsed.kind === 'stl';
  const fileToWorld = (p: { x: number; y: number; z: number }) =>
    isStl
      ? new Vector3(p.x - modelCenter.x, p.z - modelCenter.z, modelCenter.y - p.y)
      : new Vector3(p.x, p.z, -p.y).sub(modelCenter);
  const worldToFile = (w: Vector3): [number, number, number] =>
    isStl
      ? [w.x + modelCenter.x, modelCenter.y - w.z, w.y + modelCenter.z]
      : [w.x + modelCenter.x, -(w.z + modelCenter.z), w.y + modelCenter.y];

  const pointTriangleDistance = (p: Vector3, a: Vector3, b: Vector3, c: Vector3): number => {
    const ab = b.clone().sub(a);
    const ac = c.clone().sub(a);
    const ap = p.clone().sub(a);
    const d1 = ab.dot(ab);
    const d2 = ac.dot(ac);
    const d3 = ab.dot(ac);
    const d4 = ap.dot(ab);
    const d5 = ap.dot(ac);
    const denom = d1 * d2 - d3 * d3;
    if (denom !== 0) {
      const v = (d2 * d4 - d3 * d5) / denom;
      const w = (d1 * d5 - d3 * d4) / denom;
      if (v >= 0 && w >= 0 && v + w <= 1) {
        return p.distanceTo(a.clone().add(ab.multiplyScalar(v)).add(ac.multiplyScalar(w)));
      }
    }
    let best = Infinity;
    for (const [e0, e1] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const e = e1.clone().sub(e0);
      const len2 = e.dot(e);
      const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, p.clone().sub(e0).dot(e) / len2));
      best = Math.min(best, p.distanceTo(e0.clone().add(e.multiplyScalar(t))));
    }
    return best;
  };

  const distanceToSurface = (filePoint: { x: number; y: number; z: number }): number => {
    const target = fileToWorld(filePoint);
    let best = Infinity;
    const vA = new Vector3();
    const vB = new Vector3();
    const vC = new Vector3();
    modelObject.updateMatrixWorld(true);
    modelObject.traverse((node) => {
      if (!(node instanceof Mesh) || best < 1e-6) return;
      const geo = node.geometry;
      const posAttr = geo.getAttribute('position');
      if (!posAttr) return;
      const idx = geo.getIndex();
      const triCount = idx ? idx.count / 3 : posAttr.count / 3;
      for (let t = 0; t < triCount; t++) {
        const ia = idx ? idx.getX(t * 3) : t * 3;
        const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        vA.fromArray(posAttr.array, ia * 3).applyMatrix4(node.matrixWorld);
        vB.fromArray(posAttr.array, ib * 3).applyMatrix4(node.matrixWorld);
        vC.fromArray(posAttr.array, ic * 3).applyMatrix4(node.matrixWorld);
        best = Math.min(best, pointTriangleDistance(target, vA, vB, vC));
        if (best < 1e-6) break;
      }
    });
    return best;
  };

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
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.zoomSpeed = 0.85;

  // OrbitControls treats every wheel event as zoom. On a Mac that turns the
  // trackpad's two-finger scroll into accidental zoom, so intercept smooth
  // wheel deltas and translate the camera/target in screen space instead.
  // ctrl+wheel (the browser representation of a pinch) still flows through to
  // OrbitControls, whose zoomToCursor keeps the point under the fingers fixed.
  const panTrackpad = (deltaX: number, deltaY: number) => {
    const viewportHeight = Math.max(1, renderer.domElement.clientHeight || container.clientHeight);
    const distance = Math.max(camera.position.distanceTo(controls.target), 1e-6);
    const worldUnitsPerPixel = (2 * distance * Math.tan(((camera.fov * Math.PI) / 180) / 2)) / viewportHeight;
    const forward = camera.getWorldDirection(new Vector3());
    const right = new Vector3().crossVectors(forward, camera.up).normalize();
    const screenUp = new Vector3().crossVectors(right, forward).normalize();
    const translation = right
      .multiplyScalar(deltaX * worldUnitsPerPixel)
      .add(screenUp.multiplyScalar(-deltaY * worldUnitsPerPixel));
    camera.position.add(translation);
    controls.target.add(translation);
  };

  const handleWheelCapture = (event: WheelEvent) => {
    if (classifyModelWheelGesture(event) !== 'trackpad-pan') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    panTrackpad(event.deltaX, event.deltaY);
  };
  renderer.domElement.addEventListener('wheel', handleWheelCapture, { capture: true, passive: false });

  // Safari also exposes native GestureEvents for trackpad pinch. Chromium
  // takes the ctrl+wheel path above; these listeners are harmless there.
  type SafariGestureEvent = Event & { scale?: number };
  let previousGestureScale = 1;
  const handleGestureStart = (rawEvent: Event) => {
    const event = rawEvent as SafariGestureEvent;
    previousGestureScale = event.scale && event.scale > 0 ? event.scale : 1;
    event.preventDefault();
    event.stopPropagation();
  };
  const handleGestureChange = (rawEvent: Event) => {
    const event = rawEvent as SafariGestureEvent;
    const scale = event.scale && event.scale > 0 ? event.scale : previousGestureScale;
    const factor = Math.min(2, Math.max(0.5, scale / Math.max(previousGestureScale, 1e-6)));
    previousGestureScale = scale;
    const offset = camera.position.clone().sub(controls.target);
    const nextDistance = Math.min(controls.maxDistance, Math.max(controls.minDistance, offset.length() / factor));
    if (Number.isFinite(nextDistance) && nextDistance > 0) {
      camera.position.copy(controls.target).add(offset.setLength(nextDistance));
      controls.update();
    }
    event.preventDefault();
    event.stopPropagation();
  };
  const handleGestureEnd = (event: Event) => {
    previousGestureScale = 1;
    event.preventDefault();
    event.stopPropagation();
  };
  renderer.domElement.addEventListener('gesturestart', handleGestureStart, { passive: false });
  renderer.domElement.addEventListener('gesturechange', handleGestureChange, { passive: false });
  renderer.domElement.addEventListener('gestureend', handleGestureEnd, { passive: false });

  // 特征标记遮挡检测: 从相机向特征点做射线, 若先命中模型其他表面则判为背面
  const raycaster = new Raycaster();

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
  let afterRender: (() => void) | null = null;
  let selectionEntries: Array<{ point: Vector3; meshes: Mesh[] }> = [];
  // 选中光斑保持屏幕恒定大小(~36px), 放大缩小时不跟着模型变大变小
  const updateSelectionScale = () => {
    const halfH = container.clientHeight / 2;
    const tanHalf = Math.tan(((camera.fov * Math.PI) / 180) / 2);
    for (const entry of selectionEntries) {
      const dist = Math.max(camera.position.distanceTo(entry.point), 1e-6);
      const pxPerUnit = halfH / (dist * tanHalf);
      const targetR = 36 / pxPerUnit;
      const scale = targetR / (radius * 0.12);
      for (const mesh of entry.meshes) {
        mesh.scale.set(scale, scale, scale);
      }
    }
  };
  const animate = () => {
    frameId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
    updateSelectionScale();
    afterRender?.();
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
    projectToScreen: (filePoint) => {
      // 模型文件坐标是 CAD Z-up, three.js 世界是 Y-up: (x, y, z) → (x, z, -y)。
      // GLB 由 CadQuery 导出(旋转已烘焙), STL 由 mesh 旋转 -90°——两者一致。
      const world = fileToWorld(filePoint);
      const p = world.clone().project(camera);
      if (p.z < -1 || p.z > 1) return null;
      let visible = true;
      const dir = world.clone().sub(camera.position);
      const distToPoint = dir.length();
      if (distToPoint > 1e-6) {
        raycaster.set(camera.position, dir.normalize());
        const hits = raycaster.intersectObject(modelObject, true);
        if (hits.length > 0 && hits[0].distance < distToPoint - 1.5) {
          visible = false;
        }
      }
      const width = container.clientWidth;
      const height = Math.max(1, container.clientHeight);
      return { x: (p.x * 0.5 + 0.5) * width, y: (-p.y * 0.5 + 0.5) * height, visible };
    },
    surfaceDistance: (filePoint) => distanceToSurface(filePoint),
    pick: (screenX, screenY, width, height) => {
      const ndc = new Vector2((screenX / width) * 2 - 1, -((screenY / height) * 2 - 1));
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObject(modelObject, true)[0];
      if (!hit) return null;
      const w = hit.point;
      // 世界坐标 → CAD 坐标(与 projectToScreen 互逆)
      const point = worldToFile(w);
      const normal: [number, number, number] | null = hit.face
        ? [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z]
        : null;
      // 优先最近的零件 Group；底层 Mesh 名可能是导出器生成名或乱码。
      const part = resolvePickedPartName(hit.object);
      return { part, point, normal };
    },
    setSelection: (selections) => {
      // 清理旧高亮
      for (const entry of selectionEntries) {
        for (const mesh of entry.meshes) {
          scene.remove(mesh);
          mesh.geometry.dispose();
          (mesh.material as Material).dispose();
        }
      }
      selectionEntries = [];
      if (!selections || selections.length === 0) return;

      const fillGeo = new CircleGeometry(radius * 0.10, 32);
      const fillMat = new MeshStandardMaterial({
        color: new Color('#D0A215'),
        side: DoubleSide,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      });
      const ringGeo = new RingGeometry(radius * 0.09, radius * 0.12, 32);
      const ringMat = new MeshStandardMaterial({
        color: new Color('#D0A215'),
        side: DoubleSide,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const up = new Vector3(0, 0, 1);
      for (const sel of selections) {
        const worldPoint = fileToWorld({ x: sel.point[0], y: sel.point[1], z: sel.point[2] });
        const worldNormal = sel.normal
          ? new Vector3(sel.normal[0], sel.normal[2], -sel.normal[1]).normalize()
          : null;
        const meshes: Mesh[] = [];
        for (const [geo, mat] of [
          [fillGeo, fillMat],
          [ringGeo, ringMat],
        ] as const) {
          const mesh = new Mesh(geo, mat);
          if (worldNormal) {
            mesh.quaternion.setFromUnitVectors(up, worldNormal);
            mesh.position.copy(worldPoint).add(worldNormal.multiplyScalar(1));
          } else {
            mesh.position.copy(worldPoint);
          }
          scene.add(mesh);
          meshes.push(mesh);
        }
        selectionEntries.push({ point: worldPoint, meshes });
      }
      updateSelectionScale();
    },
    setAfterRender: (cb) => {
      afterRender = cb;
    },
    dispose: () => {
      cancelAnimationFrame(frameId);
      for (const entry of selectionEntries) {
        for (const mesh of entry.meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as Material).dispose();
        }
      }
      selectionEntries = [];
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('wheel', handleWheelCapture, { capture: true });
      renderer.domElement.removeEventListener('gesturestart', handleGestureStart);
      renderer.domElement.removeEventListener('gesturechange', handleGestureChange);
      renderer.domElement.removeEventListener('gestureend', handleGestureEnd);
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
  /** 模型的绝对路径; 引用文本里用它代替 fileName, 让其他 Agent 能直接定位文件。 */
  filePath?: string;
  /** Semantic features from a sidecar .features.json (Plan A annotation). */
  features?: ModelFeature[] | null;
  /** Insert a feature reference into the chat input / context draft, the same
      way file references work (draft-aware). */
  onInsertFeature?: (text: string, key: string) => void;
  /** Re-fetch the model from the server (manual fallback when file-watch
      auto-reload misses, e.g. suspended SSE on mobile). */
  onRefresh?: () => void;
}

type ModelPreviewStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; dims: string }
  | { kind: 'error'; message: string };

const BG_STORAGE_KEY = 'termdock.model3d.bg';

export default function ModelPreview({ blobUrl, ext, fileName, filePath, features, onInsertFeature, onRefresh }: ModelPreviewProps) {
  const { t, locale } = useI18n();
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

  // ---- 语义特征标注: 选特征(可多选2个) → 弹「引用」按钮 → 插入到对话/草稿 ----
  const [featureMode, setFeatureMode] = useState(false);
  const [selectedFeatureIds, setSelectedFeatureIds] = useState<string[]>([]);
  const [featureDiag, setFeatureDiag] = useState<{ total: number; positioned: number } | null>(null);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [featureListOpen, setFeatureListOpen] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= 768,
  );
  const featureLabelsRef = useRef<HTMLDivElement | null>(null);
  const selectedFeatureIdsRef = useRef(selectedFeatureIds);
  selectedFeatureIdsRef.current = selectedFeatureIds;
  const selectedFeatures = features?.filter((ft) => selectedFeatureIds.includes(ft.id)) ?? [];

  // ---- 通用点选引用(方案 A): 点模型任意位置 → 拾取部位/坐标 → 弹「引用」 ----
  const [pickMode, setPickMode] = useState(false);
  const [picked, setPicked] = useState<{
    part: string;
    point: [number, number, number];
    normal: [number, number, number] | null;
  } | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const pickMarkerRef = useRef<HTMLDivElement | null>(null);
  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);

  const pickPartLabel = (p: { part: string }) => {
    const nodeBase = p.part.replace(/_\d+$/, '');
    const f = features?.find((ft) => ft.node && (ft.node === p.part || ft.node === nodeBase));
    if (f) return f.part;
    // 单零件模型: GLB 节点名可能是 "part"/空, 直接用特征清单里的零件名
    if (features && features.length > 0 && (!p.part || p.part === 'part')) {
      return features[0].part;
    }
    return nodeBase || fileName.replace(/\.(stl|glb|gltf)$/i, '');
  };

  const insertPickRef = () => {
    const p = pickedRef.current;
    if (!p) return;
    // 坐标统一用「被引用文件自己坐标系」: GLB/GLTF 按 glTF 规范是 Y-up
    // 世界坐标(CAD (x,y,z) → (x,z,-y)); STL 无场景变换, 就是文件里的 Z-up 坐标。
    // 只给一个坐标系, Agent 直接读引用文件就能对上, 不用转换。
    const isGlb = resolveModel3dLoaderKind(ext) === 'gltf';
    const coordLabel = isGlb ? 'GLB 世界坐标 Y-up' : 'STL 文件坐标 Z-up';
    const toFileCoords = (v: [number, number, number]) => (isGlb ? [v[0], v[2], -v[1]] : v);
    const point = toFileCoords(p.point).map((v) => v.toFixed(1)).join(',');
    const normal = p.normal
      ? ` / 法线 (${toFileCoords(p.normal).map((v) => v.toFixed(2)).join(',')})`
      : '';
    // 部位名人性化: GLB 节点名(base_1) → 特征清单里的零件名(底座)
    const partLabel = pickPartLabel(p);
    // 最近特征提示: ≤8mm 直接挂特征名, ≤15mm 提示"靠近"
    let hint = '';
    if (features && features.length > 0) {
      let nearest = null;
      let best = Infinity;
      for (const ft of features) {
        const d = Math.hypot(
          ft.center[0] - p.point[0],
          ft.center[1] - p.point[1],
          ft.center[2] - p.point[2],
        );
        if (d < best) {
          best = d;
          nearest = ft;
        }
      }
      if (nearest && best <= 8) hint = ` ≈ ${nearest.part}·${nearest.name}`;
      else if (nearest && best <= 15) hint = ` ≈ 靠近 ${nearest.part}·${nearest.name}`;
    }
    const text = `"模型标注: ${filePath ?? fileName} / 部位: ${partLabel} / 点 (${point})mm [${coordLabel}]${normal}${hint}"`;
    onInsertFeature?.(text, `pick:${point}`);
    setPicked(null);
  };

  // 选中高亮: 选中的特征(面/棱/角)和点选结果 → 部位发光 + 圆环标记
  useEffect(() => {
    const selections: Array<{
      part: string;
      point: [number, number, number];
      normal: [number, number, number] | null;
    }> = [];
    if (features) {
      for (const f of features) {
        if (selectedFeatureIds.includes(f.id)) {
          selections.push({ part: f.node ?? f.part, point: f.center, normal: f.normal ?? null });
        }
      }
    }
    if (picked) {
      selections.push({ part: picked.part, point: picked.point, normal: picked.normal });
    }
    viewerRef.current?.setSelection(selections.length > 0 ? selections : null);
  }, [features, selectedFeatureIds, picked]);

  const toggleFeature = (fid: string) => {
    setSelectedFeatureIds((prev) => {
      if (prev.includes(fid)) return prev.filter((id) => id !== fid);
      if (prev.length >= 2) return [prev[1], fid]; // 已选2个时替换最早选的
      return [...prev, fid];
    });
  };

  // 特征标记跟随相机: 立即定位一次 + 注册渲染后回调,
  // 与模型绘制同一帧更新, 完全跟手(不走 React 重渲染)
  useEffect(() => {
    if (status.kind !== 'ready' || !viewerRef.current) return;
    const viewer = viewerRef.current;
    const position = () => {
      const labelsEl = featureLabelsRef.current;
      if (!viewer) return;
      if (labelsEl && features) {
      let positioned = 0;
      const selScreen: Array<{ id: string; x: number; y: number }> = [];
      const selectedIds = selectedFeatureIdsRef.current;
      for (const ft of features) {
        try {
          const el = labelsEl.querySelector<HTMLElement>(`[data-feature-id="${ft.id}"]`);
          if (!el) continue;
          // 沿特征法线向外推 2mm: 圆点贴在自己那个面外面, 不浮到相邻零件上
          const center = new Vector3(ft.center[0], ft.center[1], ft.center[2]);
          if (ft.normal) {
            center.x += ft.normal[0] * 2;
            center.y += ft.normal[1] * 2;
            center.z += ft.normal[2] * 2;
          }
          const pos = viewer.projectToScreen(center);
          el.style.display = pos ? '' : 'none';
          if (pos) {
            el.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%, -50%)`;
            // 背面(被模型遮挡)的标记调暗, 选中的始终高亮
            el.style.opacity = pos.visible || selectedIds.includes(ft.id) ? '1' : '0.22';
            if (selectedIds.includes(ft.id)) {
              selScreen.push({ id: ft.id, x: pos.x, y: pos.y });
            }
            positioned += 1;
          }
        } catch (err) {
          console.error('[ModelPreview] 特征标签定位失败', err);
        }
      }
      setFeatureDiag((prev) =>
        prev && prev.total === features.length && prev.positioned === positioned
          ? prev
          : { total: features.length, positioned },
      );
      // 两个选中点的屏幕位置太近时沿连线分开, 避免叠死看不清
      if (selScreen.length === 2) {
        const a = selScreen[0];
        const b = selScreen[1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 1e-6 && dist < 24) {
          const nx = dx / dist;
          const ny = dy / dist;
          const elA = labelsEl.querySelector<HTMLElement>(`[data-feature-id="${a.id}"]`);
          const elB = labelsEl.querySelector<HTMLElement>(`[data-feature-id="${b.id}"]`);
          if (elA) elA.style.transform = `translate(${a.x - nx * 8}px, ${a.y - ny * 8}px) translate(-50%, -50%)`;
          if (elB) elB.style.transform = `translate(${b.x + nx * 18}px, ${b.y + ny * 18}px) translate(-50%, -50%)`;
        }
      }
      }
      // 通用点选: 拾取标记跟随相机(按钮固定在底部, 不挡拖动)
      const pickedPoint = pickedRef.current;
      const pickMarker = pickMarkerRef.current;
      if (pickedPoint && pickMarker) {
        const pos = viewer.projectToScreen(
          new Vector3(pickedPoint.point[0], pickedPoint.point[1], pickedPoint.point[2]),
        );
        if (pos) {
          pickMarker.style.display = '';
          pickMarker.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%, -50%)`;
        } else {
          pickMarker.style.display = 'none';
        }
      }
    };
    position();
    viewer.setAfterRender(position);
    return () => {
      viewer.setAfterRender(null);
    };
  }, [features, featureMode, status.kind]);

  // 换文件或退出特征模式时清空选择
  useEffect(() => {
    setSelectedFeatureIds([]);
    setGlossaryOpen(false);
    setPicked(null);
    setPickMode(false);
  }, [blobUrl, featureMode]);

  const insertFeatureRef = () => {
    if (selectedFeatures.length === 0) return;
    const isGlb = resolveModel3dLoaderKind(ext) === 'gltf';
    const coordLabel = isGlb ? 'GLB 世界坐标 Y-up' : 'STL 文件坐标 Z-up';
    const toFileCoords = (v: number[]) => (isGlb ? [v[0], v[2], -v[1]] : v);
    const parts = selectedFeatures.map((ft, i) => {
      const center = toFileCoords(ft.center).map((v) => v.toFixed(1)).join(',');
      const dist = viewerRef.current?.surfaceDistance({ x: ft.center[0], y: ft.center[1], z: ft.center[2] }) ?? 0;
      // 特征中心可能不在表面(倒角后等), 命中距离 >0.05 时才写出来; 点选恒为 0 省略。
      const distText =
        Number.isFinite(dist) && dist > 0.05 ? ` / 命中距离 ${dist.toFixed(1)}mm` : '';
      const label = selectedFeatures.length > 1 ? `面${'AB'[i]}: ` : '';
      return `${label}${ft.part}·${ft.name} (中心 ${center}) [${coordLabel}]${distText}`;
    });
    const text = `"模型标注: ${filePath ?? fileName} / ${parts.join(' ; ')}"`;
    onInsertFeature?.(text, `features:${selectedFeatures.map((ft) => ft.id).join('+')}`);
    setSelectedFeatureIds([]);
  };

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
          {featureMode && featureDiag && (
            <div className="text-foreground/70">
              {t('rightSidebar.model3dFeatureStatus', { total: featureDiag.total, positioned: featureDiag.positioned })}
            </div>
          )}
          <div className="max-sm:hidden">
            {pickMode ? t('rightSidebar.model3dPickHint') : t('rightSidebar.model3dHintMouse')}
          </div>
          <div className="sm:hidden">
            {pickMode ? t('rightSidebar.model3dPickHint') : t('rightSidebar.model3dHintTouch')}
          </div>
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
          {features && features.length > 0 && (
            <button
              type="button"
              title={t('rightSidebar.model3dFeatureToggle')}
              aria-label={t('rightSidebar.model3dFeatureToggle')}
              aria-pressed={featureMode}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition active:scale-95 ${
                featureMode
                  ? 'bg-surface-elevated text-foreground'
                  : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
              }`}
              onClick={() => {
                setFeatureMode((v) => {
                  const next = !v;
                  if (next) {
                    setPickMode(false);
                    setPicked(null);
                  }
                  return next;
                });
              }}
            >
              <RiTag size={14} />
            </button>
          )}
          <button
            type="button"
            title={t('rightSidebar.model3dPickToggle')}
            aria-label={t('rightSidebar.model3dPickToggle')}
            aria-pressed={pickMode}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition active:scale-95 ${
              pickMode
                ? 'bg-surface-elevated text-foreground'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            onClick={() => {
              setPickMode((v) => {
                const next = !v;
                if (next) {
                  setFeatureMode(false);
                  setSelectedFeatureIds([]);
                }
                return next;
              });
            }}
          >
            <RiCrosshair size={14} />
          </button>
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
      {/* 语义特征标注: 模型上的特征圆点(跟随相机投影, 选中的显示名字) */}
      {status.kind === 'ready' && features && featureMode && (
        <div ref={featureLabelsRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
          {features.map((ft) => (
            <button
              key={ft.id}
              type="button"
              data-feature-id={ft.id}
              title={`${ft.part}·${ft.name}`}
              className={`pointer-events-auto absolute left-0 top-0 model3d-feature-label flex items-center gap-1 rounded-full px-1 py-0.5 transition-[opacity] ${
                selectedFeatureIds.includes(ft.id)
                  ? 'border border-foreground bg-surface-elevated'
                  : 'border border-transparent hover:border-border/60'
              }`}
              onClick={() => toggleFeature(ft.id)}
            >
              <span
                className="block h-2.5 w-2.5 flex-none rounded-full border border-black/50"
                style={{ background: ft.part === '底座' ? '#E8833A' : ft.part === '压件' ? '#3F9E6D' : '#4385BE' }}
              />
              {selectedFeatureIds.includes(ft.id) && (
                <span className="max-w-[140px] truncate text-[11px] leading-4 text-foreground">
                  面{'AB'[selectedFeatureIds.indexOf(ft.id)]}: {ft.part}·{ft.name}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {/* 语义特征标注: 右侧特征列表(可折叠, 手机默认收起省空间) */}
      {status.kind === 'ready' && features && featureMode && (
        <div
          className="swiper-no-swiping absolute right-2 top-14 z-20 max-h-[calc(100%-1rem)] w-44 overflow-hidden rounded-xl bg-surface-2/95"
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            aria-expanded={featureListOpen}
            className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-xs font-medium text-foreground"
            onClick={() => setFeatureListOpen((v) => !v)}
          >
            <span className="truncate">
              {t('rightSidebar.model3dFeatureToggle')} ({features.length})
            </span>
            <span className="flex items-center gap-1">
              <span
                role="button"
                tabIndex={0}
                title={t('rightSidebar.model3dGlossaryToggle')}
                aria-label={t('rightSidebar.model3dGlossaryToggle')}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  setGlossaryOpen((v) => !v);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.stopPropagation();
                    setGlossaryOpen((v) => !v);
                  }
                }}
              >
                ?
              </span>
              <span className="flex-none text-muted-foreground">{featureListOpen ? '▾' : '▸'}</span>
            </span>
          </button>
          {featureListOpen && (
            <div className="max-h-[calc(100%-2.25rem)] overflow-auto border-t border-border/20 p-1.5">
              {glossaryOpen ? (
                <GlossaryPanel locale={locale} onClose={() => setGlossaryOpen(false)} />
              ) : (
                features.map((ft) => (
                  <button
                    key={ft.id}
                    type="button"
                    aria-pressed={selectedFeatureIds.includes(ft.id)}
                    className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition ${
                      selectedFeatureIds.includes(ft.id)
                        ? 'bg-surface-elevated text-foreground'
                        : 'text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                    }`}
                    onClick={() => toggleFeature(ft.id)}
                  >
                    <span
                      className="h-2 w-2 flex-none rounded-full"
                      style={{ background: ft.part === '底座' ? '#E8833A' : ft.part === '压件' ? '#3F9E6D' : '#4385BE' }}
                    />
                    <span className="truncate">{ft.part}·{ft.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
      {/* 通用点选引用: 拾取标记(穿透, 不挡拖动) */}
      {status.kind === 'ready' && pickMode && picked && (
        <div
          ref={pickMarkerRef}
          className="swiper-no-swiping pointer-events-none absolute left-0 top-0 z-10 model3d-feature-label flex items-center gap-1 rounded-full border border-foreground/50 bg-surface-elevated px-2 py-0.5"
        >
          <span className="block h-2 w-2 flex-none rounded-full bg-[#4385BE]" />
          <span className="max-w-[160px] truncate text-[11px] leading-4 text-foreground">
            {pickPartLabel(picked)} ({picked.point.map((v) => v.toFixed(0)).join(',')})
          </span>
        </div>
      )}
      {/* 引用按钮固定在底部居中, 不覆盖模型、不挡拖动 */}
      {status.kind === 'ready' && (selectedFeatures.length > 0 || (pickMode && picked)) && (
        <button
          type="button"
          title={t('rightSidebar.model3dFeatureInsert')}
          className="swiper-no-swiping absolute bottom-3 left-1/2 z-30 inline-flex h-7 -translate-x-1/2 items-center gap-1 rounded-full border border-foreground/40 bg-surface-elevated px-3 text-xs font-medium text-foreground shadow"
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onClick={selectedFeatures.length > 0 ? insertFeatureRef : insertPickRef}
        >
          {t('rightSidebar.model3dFeatureInsert')}
        </button>
      )}
      {/* The viewer canvas swallows pointer/touch gestures: swiper-no-swiping
          opts out of the sidebar file-list swiper (see gestureArbiter.ts) and
          stopPropagation keeps the events away from other global handlers. */}
      <div
        ref={containerRef}
        className="swiper-no-swiping absolute inset-0"
        style={{ touchAction: 'none' }}
        onPointerDown={(event) => {
          event.stopPropagation();
          // 只记录起点: 拖动旋转不触发选中/取消
          pointerDownPosRef.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const start = pointerDownPosRef.current;
          pointerDownPosRef.current = null;
          if (!start) return;
          // 位移超过阈值 = 拖动, 不选中
          if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          if (pickMode) {
            // 通用点选: 点击模型任意位置 → 拾取部位 + 坐标
            const hit = viewerRef.current?.pick(
              event.clientX - rect.left,
              event.clientY - rect.top,
              rect.width || 1,
              rect.height || 1,
            );
            setPicked(hit ?? null);
          } else {
            // 点击空白处: 取消特征选中 / 清除点选
            setSelectedFeatureIds([]);
            setPicked(null);
          }
        }}
        onPointerCancel={() => {
          pointerDownPosRef.current = null;
        }}
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

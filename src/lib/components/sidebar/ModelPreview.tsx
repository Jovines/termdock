// flexoki-allow-file — 3D viewer 是刻意与主题无关的组件,色值固定为一套
// 独立观感(对齐 cadquery-print skill 的 view.html),不随 Flexoki 主题切换。
import { useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, Focus, ListTree, Layers3, RotateCcw, Undo2, X, Quote, House } from 'lucide-react';
import { Matrix3 } from 'three';
import { createModelExplosion, modelViewDescription, type ExplosionState } from './modelExplosion';
import { createModelVisibility, isObjectVisible, partVisibilityReducer, type ModelPartInfo, type PartVisibilityAction } from './modelVisibility';
import ModelPartsPanel from './ModelPartsPanel';
import ModelViewerMenu from './ModelViewerMenu';
import { Maximize as RiMaximize, Minimize as RiMinimize, Scissors as RiScissors, ArrowLeftRight as RiArrowLeftRight, Tag as RiTag } from 'lucide-react';
import {
  AmbientLight,
  Box3,
  BoxHelper,
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
import { captureReferenceCanvas, modelFitDistance, type ReviewReferenceHandler } from './reviewReference';

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

// Trackpads need different gains from a mouse: pinches otherwise feel muted,
// while raw two-axis scroll deltas move a narrow sidebar viewport too far.
const TRACKPAD_PAN_SENSITIVITY = 0.52;
const TRACKPAD_PAN_MAX_DELTA = 18;
const PINCH_ZOOM_SENSITIVITY = 1.38;
const TOUCH_ROTATE_SENSITIVITY = 0.62;
const TOUCH_PAN_SENSITIVITY = 0.55;
const TOUCH_ZOOM_SENSITIVITY = 0.72;

export function modelControlSensitivity(touching: boolean): { rotate: number; pan: number; zoom: number } {
  return touching
    ? { rotate: TOUCH_ROTATE_SENSITIVITY, pan: TOUCH_PAN_SENSITIVITY, zoom: TOUCH_ZOOM_SENSITIVITY }
    : { rotate: 1, pan: 1, zoom: PINCH_ZOOM_SENSITIVITY };
}

/** Fine movement stays proportional; fast swipes are softly capped. */
export function scaleModelTrackpadPanDelta(delta: number): number {
  if (!Number.isFinite(delta)) return 0;
  return TRACKPAD_PAN_MAX_DELTA * Math.tanh((delta * TRACKPAD_PAN_SENSITIVITY) / TRACKPAD_PAN_MAX_DELTA);
}

/**
 * KiCad exports silkscreen and solder mask as overlapping BLEND materials.
 * Transparent-object sorting then changes with the camera and can hide the
 * silkscreen while orbiting. Silkscreen ink is visually opaque, so make only
 * the named PCB silkscreen layer depth-stable and pull it forward by a tiny
 * raster-space offset without moving the model geometry.
 */
export function stabilizePcbSilkscreenMaterials(root: Object3D): number {
  const stabilized = new Set<Material>();
  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    let current: Object3D | null = node;
    let isSilkscreen = false;
    while (current) {
      if (current.name.toLowerCase().includes('_silkscreen')) {
        isSilkscreen = true;
        break;
      }
      current = current.parent;
    }
    if (!isSilkscreen) return;

    node.renderOrder = Math.max(node.renderOrder, 20);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      material.transparent = false;
      material.opacity = 1;
      material.depthTest = true;
      material.depthWrite = true;
      material.polygonOffset = true;
      material.polygonOffsetFactor = -2;
      material.polygonOffsetUnits = -2;
      material.needsUpdate = true;
      stabilized.add(material);
    }
  });
  return stabilized.size;
}

/**
 * KiCad's GLB exporter can also mark the board substrate itself as a nearly
 * opaque BLEND material. The substrate mesh contains the board faces, edges,
 * and drilled-hole walls in one object, so transparent triangle sorting makes
 * hole rims flicker while the camera moves. A 0.98-alpha board is intended to
 * look solid; rendering the named `_PCB` layer as opaque restores stable depth
 * testing without changing the translucent solder-mask layer above it.
 */
export function stabilizePcbSubstrateMaterials(root: Object3D): number {
  const stabilized = new Set<Material>();
  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    let current: Object3D | null = node;
    let isPcbSubstrate = false;
    while (current) {
      if (/_pcb$/i.test(current.name)) {
        isPcbSubstrate = true;
        break;
      }
      current = current.parent;
    }
    if (!isPcbSubstrate) return;

    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      material.transparent = false;
      material.opacity = 1;
      material.depthTest = true;
      material.depthWrite = true;
      material.needsUpdate = true;
      stabilized.add(material);
    }
  });
  return stabilized.size;
}

interface SectionMaterialStabilizer {
  count: number;
  setEnabled: (enabled: boolean) => void;
}

/**
 * Near-opaque BLEND materials shimmer when a moving clipping plane exposes
 * both their front and back faces. During section inspection, temporarily
 * render only those nearly solid materials as opaque depth-writing surfaces.
 * Genuinely translucent materials stay untouched, and every changed property
 * is restored when section mode is disabled.
 */
export function createSectionMaterialStabilizer(root: Object3D): SectionMaterialStabilizer {
  const originals = new Map<Material, {
    transparent: boolean;
    opacity: number;
    depthWrite: boolean;
    forceSinglePass: boolean;
  }>();
  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (originals.has(material) || !material.transparent || material.opacity < 0.8) continue;
      originals.set(material, {
        transparent: material.transparent,
        opacity: material.opacity,
        depthWrite: material.depthWrite,
        forceSinglePass: material.forceSinglePass,
      });
    }
  });

  let enabled = false;
  return {
    count: originals.size,
    setEnabled(nextEnabled) {
      if (nextEnabled === enabled) return;
      enabled = nextEnabled;
      for (const [material, original] of originals) {
        if (enabled) {
          material.transparent = false;
          material.opacity = 1;
          material.depthWrite = true;
          material.forceSinglePass = true;
        } else {
          material.transparent = original.transparent;
          material.opacity = original.opacity;
          material.depthWrite = original.depthWrite;
          material.forceSinglePass = original.forceSinglePass;
        }
        material.needsUpdate = true;
      }
    },
  };
}

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
  const gltf = await new Promise<import('three/examples/jsm/loaders/GLTFLoader.js').GLTF>((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', resolve, reject);
  });
  gltf.scene.traverse((node) => {
    const mapping = gltf.parser?.associations.get(node);
    if (mapping?.meshes !== undefined) node.userData.termdockSinglePart = true;
    const originalName = mapping?.nodes !== undefined ? gltf.parser.json.nodes?.[mapping.nodes]?.name : undefined;
    if (originalName) node.userData.termdockPartName = originalName;
  });
  return { kind: 'gltf', object: gltf.scene };
}

type ModelView = 'home' | 'fit' | 'front' | 'top' | 'right';
interface ModelCameraPose { position: Vector3; target: Vector3 }
interface ViewerResult {
  capture: (label?: string) => Promise<Blob | null>;
  partCount: number;
  parts: ModelPartInfo[];
  setSelectedPart: (id: string | null) => void;
  cameraPose: () => ModelCameraPose;
  restoreCameraPose: (pose: ModelCameraPose) => void;
  focusPart: (id?: string) => void;
  setView: (view: ModelView) => void;
  zoomAt: (x: number, y: number, width: number, height: number) => void;
  setExplosion: (state: ExplosionState | null) => void;
  setHiddenParts: (ids: readonly string[]) => void;
  dims: string;
  /** Pause the animation loop while a cached viewer is hidden. */
  setActive: (active: boolean) => void;
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
    node?: string;
    visibilityId?: string;
    point: [number, number, number];
    normal: [number, number, number] | null;
  } | null;
  /** 选中高亮: 高亮部位(整件发光) + 在命中点放贴合表面的圆环。 */
  setSelection: (
    selections: Array<{
      part: string;
      node?: string;
      point: [number, number, number];
      normal: [number, number, number] | null;
    }> | null,
  ) => void;
  /** Project a FILE-space point onto the viewer canvas (px, relative to it). */
  projectToScreen: (filePoint: Vector3, node?: string) => { x: number; y: number; visible: boolean } | null;
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
function mountModelViewer(
  container: HTMLElement,
  parsed: ParsedModel,
  unitScale = 1,
  dimensionUnit?: string,
): ViewerResult {
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
    stabilizePcbSilkscreenMaterials(object);
    stabilizePcbSubstrateMaterials(object);
    object.scale.setScalar(unitScale);
    object.updateMatrixWorld(true);
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
  const explosion = isStl ? null : createModelExplosion(modelObject);
  const visibility = createModelVisibility(modelObject);
  let selectedPartBox: BoxHelper | null = null;
  let selectedPartNode: Object3D | undefined;
  const clearPartBox = () => {
    if (!selectedPartBox) return;
    scene.remove(selectedPartBox);
    selectedPartBox.geometry.dispose();
    (selectedPartBox.material as Material).dispose();
    selectedPartBox = null;
  };
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
      const offset = explosion?.offset(node);
      for (let t = 0; t < triCount; t++) {
        const ia = idx ? idx.getX(t * 3) : t * 3;
        const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        vA.fromArray(posAttr.array, ia * 3).applyMatrix4(node.matrixWorld);
        vB.fromArray(posAttr.array, ib * 3).applyMatrix4(node.matrixWorld);
        vC.fromArray(posAttr.array, ic * 3).applyMatrix4(node.matrixWorld);
        if (offset) { vA.sub(offset); vB.sub(offset); vC.sub(offset); }
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
  let clipping = false;
  const clipMaterials: Material[] = [];
  modelObject.traverse((node) => {
    if (node instanceof Mesh) {
      for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
        clipMaterials.push(m);
      }
    }
  });
  const sectionMaterialStabilizer = createSectionMaterialStabilizer(modelObject);

  // Fit the camera to the bounding sphere.
  const radius = Math.max(size.length() / 2, 1e-6);
  const dist = modelFitDistance(radius, camera.fov, camera.aspect);
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
  controls.zoomSpeed = PINCH_ZOOM_SENSITIVITY;

  // Bound zoom so repeated pinches never cross the target or lose the model.
  controls.minDistance = Math.max(radius * 0.025, camera.near * 2);
  controls.maxDistance = dist * 30;
  let cameraMotion: { start: number; from: ModelCameraPose; to: ModelCameraPose } | null = null;
  const stopCameraMotion = () => { cameraMotion = null; };
  const moveCamera = (target: Vector3, position: Vector3) => {
    // Flush residual orbit damping before interpolating to a deliberate pose.
    const damping = controls.enableDamping;
    controls.enableDamping = false; controls.update(); controls.enableDamping = damping;
    const to = { target, position };
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      controls.target.copy(target); camera.position.copy(position); controls.update();
      cameraMotion = null;
    } else cameraMotion = { start: performance.now(), from: { target: controls.target.clone(), position: camera.position.clone() }, to };
  };
  const visibleBounds = () => {
    modelObject.updateWorldMatrix(true, true);
    const bounds = new Box3();
    modelObject.traverse((node) => {
      if (!(node instanceof Mesh) || !isObjectVisible(node)) return;
      if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
      if (node.geometry.boundingBox) bounds.union(node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld));
    });
    return bounds;
  };
  const setView = (view: ModelView) => {
    const bounds = visibleBounds();
    if (bounds.isEmpty()) return;
    const target = bounds.getCenter(new Vector3());
    const distance = modelFitDistance(Math.max(bounds.getSize(new Vector3()).length() / 2, radius * 0.025), camera.fov, camera.aspect);
    const direction = view === 'fit' ? camera.position.clone().sub(controls.target).normalize()
      : view === 'front' ? new Vector3(0, 0, 1)
      : view === 'right' ? new Vector3(1, 0, 0)
      : view === 'top' ? new Vector3(0, 1, 0.0001).normalize()
      : new Vector3(0.7, 0.6, 0.7).normalize();
    moveCamera(target, target.clone().addScaledVector(direction, distance));
  };
  renderer.domElement.addEventListener('wheel', stopCameraMotion, { capture: true });

  // OrbitControls shares one set of gains between mouse/trackpad and touch.
  // Temporarily switch to calmer mobile gains while touch pointers are down,
  // then restore the desktop values without changing trackpad behavior.
  const activeTouchPointers = new Set<number>();
  const applyTouchSensitivity = (touching: boolean) => {
    const sensitivity = modelControlSensitivity(touching);
    controls.rotateSpeed = sensitivity.rotate;
    controls.panSpeed = sensitivity.pan;
    controls.zoomSpeed = sensitivity.zoom;
  };
  const handleControlPointerDown = (event: PointerEvent) => {
    stopCameraMotion();
    if (event.pointerType !== 'touch') return;
    activeTouchPointers.add(event.pointerId);
    applyTouchSensitivity(true);
  };
  const handleControlPointerEnd = (event: PointerEvent) => {
    if (!activeTouchPointers.delete(event.pointerId)) return;
    if (activeTouchPointers.size === 0) applyTouchSensitivity(false);
  };
  renderer.domElement.addEventListener('pointerdown', handleControlPointerDown, { capture: true });
  renderer.domElement.addEventListener('pointerup', handleControlPointerEnd, { capture: true });
  renderer.domElement.addEventListener('pointercancel', handleControlPointerEnd, { capture: true });

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
      .multiplyScalar(scaleModelTrackpadPanDelta(deltaX) * worldUnitsPerPixel)
      .add(screenUp.multiplyScalar(-scaleModelTrackpadPanDelta(deltaY) * worldUnitsPerPixel));
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
    const rawFactor = scale / Math.max(previousGestureScale, 1e-6);
    const factor = Math.min(2, Math.max(0.5, Math.pow(rawFactor, PINCH_ZOOM_SENSITIVITY)));
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
    const previousFit = modelFitDistance(radius, camera.fov, camera.aspect);
    camera.aspect = width / height;
    // Opening the parts inspector changes the canvas budget. Retain orbit,
    // pan and relative user zoom while fitting the new viewport dimensions.
    const nextFit = modelFitDistance(radius, camera.fov, camera.aspect);
    camera.position.sub(controls.target).multiplyScalar(nextFit / previousFit).add(controls.target);
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  });
  resizeObserver.observe(container);

  let frameId: number | null = null;
  let active = true;
  let afterRender: (() => void) | null = null;
  let selectionEntries: Array<{ point: Vector3; meshes: Mesh[] }> = [];
  let explosionFitRatio = 1;
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
    if (!active) {
      frameId = null;
      return;
    }
    if (cameraMotion) {
      const progress = Math.min(1, (performance.now() - cameraMotion.start) / 240);
      const eased = progress * progress * (3 - 2 * progress);
      camera.position.lerpVectors(cameraMotion.from.position, cameraMotion.to.position, eased);
      controls.target.lerpVectors(cameraMotion.from.target, cameraMotion.to.target, eased);
      if (progress === 1) cameraMotion = null;
    }
    controls.update();
    if (selectedPartBox && selectedPartNode) {
      selectedPartBox.visible = isObjectVisible(selectedPartNode);
      if (selectedPartBox.visible) selectedPartBox.update();
    }
    renderer.render(scene, camera);
    updateSelectionScale();
    afterRender?.();
    frameId = requestAnimationFrame(animate);
  };
  animate();

  return {
    partCount: explosion?.count ?? 1,
    parts: visibility.parts,
    setView,
    zoomAt: (x, y, width, height) => {
      raycaster.setFromCamera(new Vector2((x / width) * 2 - 1, 1 - (y / height) * 2), camera);
      const hit = raycaster.intersectObject(modelObject, true).find((entry) => isObjectVisible(entry.object)
        && (!clipping || clipPlane.distanceToPoint(entry.point) >= 0));
      if (!hit) { setView('fit'); return; }
      const direction = camera.position.clone().sub(hit.point).normalize();
      const distance = Math.max(controls.minDistance, camera.position.distanceTo(hit.point) * 0.45);
      moveCamera(hit.point.clone(), hit.point.clone().addScaledVector(direction, distance));
    },
    cameraPose: () => ({ position: camera.position.clone(), target: controls.target.clone() }),
    restoreCameraPose: ({ position, target }) => {
      stopCameraMotion();
      camera.position.copy(position); controls.target.copy(target); controls.update();
    },
    focusPart: (id) => {
      stopCameraMotion();
      const node = id ? visibility.node(id) : modelObject;
      if (!node) return;
      const bounds = new Box3().setFromObject(node);
      if (bounds.isEmpty()) return;
      const center = bounds.getCenter(new Vector3());
      const distance = modelFitDistance(Math.max(bounds.getSize(new Vector3()).length() / 2, 1e-6), camera.fov, camera.aspect);
      const direction = camera.position.clone().sub(controls.target).normalize();
      controls.target.copy(center); camera.position.copy(center).addScaledVector(direction, distance);
      controls.update();
    },
    setSelectedPart: (id) => {
      clearPartBox();
      selectedPartNode = id ? visibility.node(id) : undefined;
      if (!selectedPartNode) return;
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || 'white';
      selectedPartBox = new BoxHelper(selectedPartNode, new Color(accent));
      selectedPartBox.visible = isObjectVisible(selectedPartNode);
      scene.add(selectedPartBox);
    },
    setHiddenParts: visibility.setHidden,
    setExplosion: (state) => {
      stopCameraMotion();
      if (!explosion || explosion.count < 2) return;
      const bounds = explosion.set(state);
      const center = bounds.getCenter(new Vector3());
      const nextRatio = Math.max(1, bounds.getSize(new Vector3()).length() / size.length());
      const offset = camera.position.clone().sub(controls.target).multiplyScalar(nextRatio / explosionFitRatio);
      controls.target.copy(center);
      camera.position.copy(center).add(offset);
      explosionFitRatio = nextRatio;
      controls.update();
    },
    capture: (label) => {
      // WebGL clears its drawing buffer between frames. Render and copy in the
      // same task; no expensive preserveDrawingBuffer needed for normal orbit.
      try {
        renderer.render(scene, camera);
        return captureReferenceCanvas(renderer.domElement, undefined, label);
      } catch { return Promise.resolve(null); }
    },
    // STL is always mm. glTF is nominally meters, but CAD/printing exports
    // (e.g. CadQuery) are usually mm — there is no reliable unit metadata, so
    // show raw bounding-box numbers without a unit rather than a wrong one.
    dims: formatModelDimensions(size, dimensionUnit ?? (parsed.kind === 'stl' ? 'mm' : undefined)),
    setActive: (nextActive) => {
      if (active === nextActive) return;
      active = nextActive;
      if (!active && frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      } else if (active && frameId === null) {
        animate();
      }
    },
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
      clipping = Boolean(clip);
      if (!clip) {
        sectionMaterialStabilizer.setEnabled(false);
        for (const m of clipMaterials) m.clippingPlanes = null;
        if (stlMaterial) stlMaterial.side = FrontSide;
        return;
      }
      sectionMaterialStabilizer.setEnabled(true);
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
    projectToScreen: (filePoint, node) => {
      if (!visibility.isPartVisible(node)) return null;
      // 模型文件坐标是 CAD Z-up, three.js 世界是 Y-up: (x, y, z) → (x, z, -y)。
      // GLB 由 CadQuery 导出(旋转已烘焙), STL 由 mesh 旋转 -90°——两者一致。
      const world = fileToWorld(filePoint);
      if (node) world.add(explosion?.offset(node) ?? new Vector3());
      const p = world.clone().project(camera);
      if (p.z < -1 || p.z > 1) return null;
      let visible = true;
      const dir = world.clone().sub(camera.position);
      const distToPoint = dir.length();
      if (distToPoint > 1e-6) {
        raycaster.set(camera.position, dir.normalize());
        const hits = raycaster.intersectObject(modelObject, true).filter((hit) => isObjectVisible(hit.object)
          && (!clipping || clipPlane.distanceToPoint(hit.point) >= 0));
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
      const hit = raycaster.intersectObject(modelObject, true).find((hit) => isObjectVisible(hit.object)
        && (!clipping || clipPlane.distanceToPoint(hit.point) >= 0));
      if (!hit) return null;
      const w = hit.point.clone().sub(explosion?.offset(hit.object) ?? new Vector3());
      // 世界坐标 → CAD 坐标(与 projectToScreen 互逆)
      const point = worldToFile(w);
      const worldNormal = hit.face?.normal.clone().applyMatrix3(new Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
      const normal: [number, number, number] | null = worldNormal ? [worldNormal.x, -worldNormal.z, worldNormal.y] : null;
      // 优先最近的零件 Group；底层 Mesh 名可能是导出器生成名或乱码。
      const partNode = explosion?.part(hit.object);
      const part = partNode?.userData.termdockPartName || partNode?.name || resolvePickedPartName(hit.object);
      return { part, node: partNode?.uuid, visibilityId: visibility.id(hit.object), point, normal };
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
      const visibleSelections = selections?.filter((sel) => visibility.isPartVisible(sel.node ?? sel.part));
      if (!visibleSelections?.length) return;

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
      for (const sel of visibleSelections) {
        const worldPoint = fileToWorld({ x: sel.point[0], y: sel.point[1], z: sel.point[2] });
        worldPoint.add(explosion?.offset(sel.node ?? sel.part) ?? new Vector3());
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
            mesh.position.copy(worldPoint).add(worldNormal.clone().multiplyScalar(0.15));
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
      clearPartBox();
      active = false;
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      for (const entry of selectionEntries) {
        for (const mesh of entry.meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as Material).dispose();
        }
      }
      selectionEntries = [];
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', handleControlPointerDown, { capture: true });
      renderer.domElement.removeEventListener('pointerup', handleControlPointerEnd, { capture: true });
      renderer.domElement.removeEventListener('pointercancel', handleControlPointerEnd, { capture: true });
      renderer.domElement.removeEventListener('wheel', stopCameraMotion, { capture: true });
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
  onInsertFeature?: ReviewReferenceHandler;
  /** Re-fetch the model from the server (manual fallback when file-watch
      auto-reload misses, e.g. suspended SSE on mobile). */
  onRefresh?: () => void;
  /** Scale glTF geometry into the display/annotation unit (KiCad GLB is metres). */
  unitScale?: number;
  dimensionUnit?: string;
  coordinateSystemLabel?: string;
  annotationPrefix?: string;
  /** Replace exporter-internal mesh names while retaining meaningful part references. */
  normalizePickedPartName?: (part: string) => string;
  /** Keep a mounted viewer cached but stop rendering while its tab is hidden. */
  active?: boolean;
}

type ModelPreviewStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; dims: string; partCount: number; parts: ModelPartInfo[] }
  | { kind: 'error'; message: string };

const BG_STORAGE_KEY = 'termdock.model3d.bg';

export default function ModelPreview({
  blobUrl,
  ext,
  fileName,
  filePath,
  features,
  onInsertFeature,
  onRefresh,
  unitScale = 1,
  dimensionUnit,
  coordinateSystemLabel,
  annotationPrefix = '',
  normalizePickedPartName,
  active = true,
}: ModelPreviewProps) {
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
  const [explodeOn, setExplodeOn] = useState(false);
  const [explodeAmount, setExplodeAmount] = useState(0.65);
  const [explodeAxis, setExplodeAxis] = useState<ExplosionState['axis']>('y');
  const explosionRef = useRef<ExplosionState | null>(null);
  explosionRef.current = explodeOn ? { axis: explodeAxis, amount: explodeAmount } : null;
  const [partVisibility, dispatchVisibility] = useReducer(partVisibilityReducer, { hidden: [], history: [] });
  const visibilityStateRef = useRef(partVisibility);
  visibilityStateRef.current = partVisibility;
  const visibilityCameraHistory = useRef<Array<ModelCameraPose | undefined>>([]);
  const dispatchPartVisibility = (action: PartVisibilityAction) => {
    const previous = visibilityStateRef.current;
    const next = partVisibilityReducer(previous, action);
    visibilityStateRef.current = next;
    if (action.type === 'reset') visibilityCameraHistory.current = [];
    else if (action.type === 'undo') {
      const pose = visibilityCameraHistory.current.pop();
      if (pose) viewerRef.current?.restoreCameraPose(pose);
    } else if (next !== previous) {
      visibilityCameraHistory.current = [...visibilityCameraHistory.current.slice(-19), viewerRef.current?.cameraPose()];
    }
    dispatchVisibility(action);
  };
  const hiddenPartIds = partVisibility.hidden;
  const [partsOpen, setPartsOpen] = useState(false);
  const [wideViewer, setWideViewer] = useState(false);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const partsButtonRef = useRef<HTMLButtonElement | null>(null);
  const parts = status.kind === 'ready' ? status.parts.filter((part) => part.initiallyVisible).map((part, index) => ({
    ...part, name: normalizePickedPartName?.(part.name) || part.name || t('rightSidebar.model3dUnnamedPart', { index: index + 1 }),
  })) : [];
  const selectedPart = parts.find((part) => part.id === selectedPartId);
  const closeParts = () => { setPartsOpen(false); partsButtonRef.current?.focus(); };
  const hiddenPartIdsRef = useRef(hiddenPartIds);
  hiddenPartIdsRef.current = hiddenPartIds;
  const viewDescription = () => [modelViewDescription(explosionRef.current, clipRef.current),
    hiddenPartIdsRef.current.length > 0 ? `Hidden parts: ${hiddenPartIdsRef.current.length}` : '',
  ].filter(Boolean).join(' / ');

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
  const [picked, setPicked] = useState<{
    part: string;
    node?: string;
    visibilityId?: string;
    point: [number, number, number];
    normal: [number, number, number] | null;
  } | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const pickMarkerRef = useRef<HTMLDivElement | null>(null);
  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const activePickPointers = useRef(new Set<number>());
  const multiTouchPick = useRef(false);
  const lastTap = useRef<{ x: number; y: number; time: number; pointerType: string } | null>(null);

  const selectPart = (id: string) => {
    setSelectedPartId(id); setPicked(null); setFeatureMode(false); setSelectedFeatureIds([]);
  };
  const togglePart = (id: string) => {
    dispatchPartVisibility({ type: 'toggle', id });
    if (hiddenPartIds.includes(id) && hiddenPartIds.length === parts.length - 1) viewerRef.current?.focusPart();
    if (picked?.visibilityId === id) setPicked(null);
  };
  const isolatePart = (id: string) => {
    dispatchPartVisibility({ type: 'set', hidden: parts.filter((part) => part.id !== id).map((part) => part.id) });
    setSelectedPartId(id);
    if (picked?.visibilityId !== id) setPicked(null);
    viewerRef.current?.focusPart(id);
  };
  const showAllParts = () => {
    dispatchPartVisibility({ type: 'set', hidden: [] });
    if (hiddenPartIds.length === parts.length - 1) viewerRef.current?.focusPart();
  };
  const hasSelection = Boolean(selectedPart || picked || selectedFeatures.length);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => setWideViewer(root.clientWidth >= 720);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, [pseudoFullscreen]);

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
    const coordLabel = coordinateSystemLabel ?? (isGlb ? 'GLB Y-up' : 'STL Z-up');
    const toFileCoords = (v: [number, number, number]) => (isGlb ? [v[0], v[2], -v[1]] : v);
    const point = toFileCoords(p.point).map((v) => v.toFixed(1)).join(',');
    const normal = p.normal
      ? ` · 法线 (${toFileCoords(p.normal).map((v) => v.toFixed(2)).join(',')})`
      : '';
    // 部位名人性化: GLB 节点名(base_1) → 特征清单里的零件名(底座)
    const partLabel = pickPartLabel(p);
    // Do not guess semantic features from distance alone: a nearby point may
    // belong to a different part. Explicit feature selections carry their name.
    const unit = dimensionUnit ?? (isGlb ? '文件单位' : 'mm');
    const text = `${annotationPrefix ? `${annotationPrefix}: ` : ''}${filePath ?? fileName}\n${partLabel} · 点 (${point}) [${coordLabel}, ${unit}]${normal}`;
    const view = viewDescription();
    onInsertFeature?.([text, view].filter(Boolean).join('\n'), `pick:${p.part}:${point}`, { snapshot: viewerRef.current?.capture(view) });
    setPicked(null);
  };

  // 选中高亮: 选中的特征(面/棱/角)和点选结果 → 部位发光 + 圆环标记
  useEffect(() => {
    viewerRef.current?.setExplosion(explosionRef.current);
  }, [explodeOn, explodeAmount, explodeAxis]);

  useEffect(() => {
    viewerRef.current?.setHiddenParts(hiddenPartIds);
  }, [hiddenPartIds]);

  useEffect(() => {
    viewerRef.current?.setSelectedPart(selectedPartId);
  }, [selectedPartId, status]);

  useEffect(() => {
    const selections: Array<{
      part: string;
      node?: string;
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
      selections.push({ part: picked.part, node: picked.node, point: picked.point, normal: picked.normal });
    }
    viewerRef.current?.setSelection(selections.length > 0 ? selections : null);
  }, [features, selectedFeatureIds, picked, explodeOn, explodeAmount, explodeAxis, status, hiddenPartIds]);

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
          const pos = viewer.projectToScreen(center, ft.node ?? ft.part);
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
          pickedPoint.node ?? pickedPoint.part,
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
  }, [blobUrl, featureMode]);

  const insertFeatureRef = () => {
    if (selectedFeatures.length === 0) return;
    const isGlb = resolveModel3dLoaderKind(ext) === 'gltf';
    const coordLabel = coordinateSystemLabel ?? (isGlb ? 'GLB Y-up' : 'STL Z-up');
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
    const text = `${annotationPrefix ? `${annotationPrefix}: ` : ''}${filePath ?? fileName}\n${parts.join(' ; ')}`;
    const view = viewDescription();
    onInsertFeature?.([text, view].filter(Boolean).join('\n'), `features:${selectedFeatures.map((ft) => ft.id).join('+')}`, { snapshot: viewerRef.current?.capture(view) });
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
      const viewer = mountModelViewer(container, parsed, unitScale, dimensionUnit);
      disposeViewer = viewer.dispose;
      viewerRef.current = viewer;
      viewer.setActive(active);
      // A background override survives file switches (the component is reused);
      // re-apply it over the theme default set by mountModelViewer.
      if (bgOverrideRef.current) viewer.setAppearance(bgOverrideRef.current);
      // Same for the section state: re-apply after a remount/file switch.
      viewer.setClip(clipRef.current);
      viewer.setExplosion(explosionRef.current);
      viewer.setHiddenParts(hiddenPartIdsRef.current);
      if (!cancelled) setStatus({ kind: 'ready', dims: viewer.dims, partCount: viewer.partCount, parts: viewer.parts });
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
  }, [blobUrl, ext, pseudoFullscreen, unitScale, dimensionUnit]);

  // File switches/reloads must not inherit an exploded pose from another file.
  useEffect(() => {
    lastTap.current = null;
    setExplodeOn(false); setClipOn(false); dispatchPartVisibility({ type: 'reset' }); setPicked(null); setSelectedPartId(null);
  }, [blobUrl, ext]);

  useEffect(() => {
    viewerRef.current?.setActive(active);
  }, [active]);

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
  const controlsBottom = !partsOpen && hasSelection
    ? (expanded ? 'bottom-[calc(4rem+env(safe-area-inset-bottom,0px))]' : 'bottom-16')
    : !partsOpen && (hiddenPartIds.length > 0 || partVisibility.history.length > 0)
      ? (expanded ? 'bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px))]' : 'bottom-14')
      : (expanded ? 'bottom-[calc(0.75rem+env(safe-area-inset-bottom,0px))]' : 'bottom-3');
  const viewerUi = (
    <div
      ref={rootRef}
      data-sidebar-gesture-ignore
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onKeyDownCapture={(event) => {
        if (event.key !== 'Escape') return;
        if (event.target instanceof Element && event.target.closest('[data-model-viewer-menu="open"]')) return;
        if (partsOpen) closeParts();
        else if (hasSelection) { setSelectedPartId(null); setPicked(null); setSelectedFeatureIds([]); }
        else return;
        event.preventDefault(); event.stopPropagation();
      }}
      className={
        pseudoFullscreen
          ? `fixed inset-0 z-modal-panel flex overflow-hidden bg-surface ${wideViewer ? 'flex-row' : 'flex-col'}`
          : `relative flex h-full min-h-0 flex-1 overflow-hidden bg-surface ${wideViewer ? 'flex-row' : 'flex-col'}`
      }
    >
      <div className="relative min-h-0 min-w-0 flex-1">
      {status.kind === 'ready' && !partsOpen && !selectedPart && (
        <div className={`pointer-events-none absolute right-3 z-10 select-none text-xs leading-relaxed text-muted-foreground max-sm:rounded-lg max-sm:bg-surface/75 max-sm:px-2.5 max-sm:py-1.5 max-sm:text-[15px] ${expanded ? 'left-[calc(0.75rem+env(safe-area-inset-left,0px))] top-[calc(3.75rem+env(safe-area-inset-top,0px))]' : 'left-3 top-14'}`}>
          <div className="text-sm font-semibold text-foreground max-sm:text-base">{fileName}</div>
          <div>{t('rightSidebar.model3dDimensions', { dims: status.dims })}</div>
          {explodeOn && !partsOpen && <div>{t('rightSidebar.model3dExplodedNotice')}</div>}
          {featureMode && featureDiag && (
            <div className="text-foreground/70">
              {t('rightSidebar.model3dFeatureStatus', { total: featureDiag.total, positioned: featureDiag.positioned })}
            </div>
          )}
          {!partsOpen && !hasSelection && <div>{t('rightSidebar.model3dInspectHint')}</div>}
        </div>
      )}
      {status.kind !== 'error' && (
        <div className={`absolute left-3 z-20 flex justify-end gap-0.5 [&>button]:h-9 [&>button]:w-9 [&>button]:shrink-0 ${expanded ? 'right-[calc(0.75rem+env(safe-area-inset-right,0px))] top-[calc(0.625rem+env(safe-area-inset-top,0px))]' : 'right-3 top-2.5'}`}>
          {status.kind === 'ready' && status.partCount > 1 && <button
            ref={partsButtonRef}
            type="button"
            title={t('rightSidebar.model3dParts')}
            aria-label={t('rightSidebar.model3dParts')}
            aria-expanded={partsOpen}
            style={{ width: 'auto' }}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition active:scale-95 ${
              partsOpen
                ? 'bg-surface-elevated text-foreground'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            onClick={() => {
              setPartsOpen((value) => !value); setFeatureMode(false); setSelectedFeatureIds([]);
            }}
          >
            <span className="inline-flex items-center gap-1 px-2"><ListTree size={16} />{t('rightSidebar.model3dParts')}{hiddenPartIds.length > 0 && <span className="text-xs tabular-nums text-accent">{hiddenPartIds.length}</span>}</span>
          </button>}
          {status.kind === 'ready' && status.partCount > 1 && (
            <button type="button" title={t('rightSidebar.model3dExplode')} aria-label={t('rightSidebar.model3dExplode')} aria-pressed={explodeOn}
              className={`inline-flex items-center justify-center rounded-full ${explodeOn ? 'bg-surface-elevated text-foreground' : 'bg-surface-2 text-muted-foreground'}`}
              onClick={() => { setExplodeOn((v) => !v); setClipOn(false); }}>
              <Layers3 size={16} />
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
                    setSelectedPartId(null);
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
            title={t('rightSidebar.model3dClipToggle')}
            aria-label={t('rightSidebar.model3dClipToggle')}
            aria-pressed={clipOn}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition active:scale-95 ${
              clipOn
                ? 'bg-surface-elevated text-foreground'
                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
            }`}
            onClick={() => { setClipOn((v) => !v); setExplodeOn(false); }}
          >
            <RiScissors size={14} />
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
          <button type="button" title={t('rightSidebar.model3dHome')} aria-label={t('rightSidebar.model3dHome')}
            className="inline-flex items-center justify-center rounded-full bg-surface-2 text-muted-foreground hover:bg-surface-elevated"
            onClick={() => viewerRef.current?.setView('home')}><House size={16} /></button>
          <ModelViewerMenu onView={(view) => viewerRef.current?.setView(view)} dark={effectiveBg === 'dark'} onToggleBackground={toggleBg} onRefresh={onRefresh} />
      </div>
      )}
      {status.kind === 'ready' && explodeOn && status.partCount > 1 && (
        <div className={`swiper-no-swiping absolute left-3 right-3 z-20 flex flex-wrap items-center justify-center gap-2 rounded-lg bg-surface-2 px-2 py-1 ${controlsBottom}`}
          onPointerDown={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()}>
          <select aria-label={t('rightSidebar.model3dExplodeAxis')} value={explodeAxis}
            onChange={(event) => setExplodeAxis(event.target.value as ExplosionState['axis'])}
            className="h-9 rounded-md bg-surface-elevated px-2 text-sm text-foreground">
            {(['x', 'y', 'z'] as const).map((axis) => <option key={axis} value={axis}>{axis.toUpperCase()}</option>)}
          </select>
          <input type="range" min={0} max={100} value={Math.round(explodeAmount * 100)}
            onChange={(event) => setExplodeAmount(Number(event.target.value) / 100)}
            aria-label={t('rightSidebar.model3dExplodeAmount')} className="h-9 min-w-0 flex-1" />
          <output className="w-9 text-right text-xs tabular-nums text-muted-foreground">{Math.round(explodeAmount * 100)}%</output>
          <button type="button" aria-label={t('rightSidebar.model3dAssemble')} title={t('rightSidebar.model3dAssemble')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-surface-elevated text-foreground"
            onClick={() => setExplodeOn(false)}><RotateCcw size={16} /></button>
        </div>
      )}
      {/* Section controls: axis pickers + drag slider + flip. Local overlay
          inside the viewer, bare z-20 (local scale, below global overlays). */}
      {status.kind === 'ready' && clipOn && (
        <div
          className={`swiper-no-swiping absolute left-3 right-3 z-20 flex items-center justify-center gap-2 rounded-xl bg-surface-2 px-3 py-2 ${controlsBottom}`}
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
            className="h-9 min-w-0 flex-1"
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
          className="swiper-no-swiping absolute bottom-28 right-2 top-40 z-20 h-fit max-h-[calc(100%-17rem)] w-44 overflow-auto rounded-xl bg-surface-2/95"
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
      {status.kind === 'ready' && !featureMode && picked && (
        <div ref={pickMarkerRef} className="pointer-events-none absolute left-0 top-0 z-10 h-3 w-3 rounded-full border-2 border-accent bg-surface" />
      )}
      {status.kind === 'ready' && !partsOpen && hasSelection && (
        <div className={`swiper-no-swiping absolute left-3 right-3 z-20 flex items-center rounded-lg border border-border/30 bg-surface pl-3 pr-1 shadow ${expanded ? 'bottom-[calc(0.75rem+env(safe-area-inset-bottom,0px))]' : 'bottom-3'}`}
          onPointerDown={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()}>
          <div className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={selectedPart?.name}>
            {selectedPart?.name ?? (picked ? pickPartLabel(picked) : selectedFeatures.map((feature) => feature.name).join(' · '))}
          </div>
          {selectedPart && parts.length > 1 && <>
            <button type="button" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-foreground hover:bg-surface-2"
              title={t(hiddenPartIds.includes(selectedPart.id) ? 'rightSidebar.model3dShowPart' : 'rightSidebar.model3dHidePart')}
              aria-label={t(hiddenPartIds.includes(selectedPart.id) ? 'rightSidebar.model3dShowPart' : 'rightSidebar.model3dHidePart')}
              onClick={() => { togglePart(selectedPart.id); setSelectedPartId(null); setPicked(null); setSelectedFeatureIds([]); }}>
              {hiddenPartIds.includes(selectedPart.id) ? <Eye size={18} /> : <EyeOff size={18} />}
            </button>
            <button type="button" onClick={() => isolatePart(selectedPart.id)} disabled={!hiddenPartIds.includes(selectedPart.id) && hiddenPartIds.length === parts.length - 1}
              title={t('rightSidebar.model3dIsolatePart')} aria-label={t('rightSidebar.model3dIsolatePart')}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-foreground hover:bg-surface-2 disabled:opacity-40"><Focus size={18} /></button>
          </>}
          {onInsertFeature && (picked || selectedFeatures.length > 0) && <button type="button" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2" title={t('rightSidebar.model3dFeatureInsert')} aria-label={t('rightSidebar.model3dFeatureInsert')} onClick={selectedFeatures.length > 0 ? insertFeatureRef : insertPickRef}><Quote size={18} /></button>}
          {partVisibility.history.length > 0 && <button type="button" onClick={() => dispatchPartVisibility({ type: 'undo' })} aria-label={t('rightSidebar.model3dUndoVisibility')} title={t('rightSidebar.model3dUndoVisibility')} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2"><Undo2 size={16} /></button>}
          <button type="button" aria-label={t('rightSidebar.model3dClearSelection')} onClick={() => { setSelectedPartId(null); setPicked(null); setSelectedFeatureIds([]); }} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2"><X size={16} /></button>
        </div>
      )}
      {status.kind === 'ready' && !partsOpen && !hasSelection && (hiddenPartIds.length > 0 || partVisibility.history.length > 0) && (
        <div className={`swiper-no-swiping absolute left-3 right-3 z-20 flex items-center justify-between gap-2 rounded-xl bg-surface px-2 ${expanded ? 'bottom-[calc(0.75rem+env(safe-area-inset-bottom,0px))]' : 'bottom-3'}`}
          onPointerDown={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()}>
          <button type="button" className="inline-flex h-9 items-center gap-1 px-1 text-xs text-foreground" onClick={() => setPartsOpen(true)}><ListTree size={15} />{hiddenPartIds.length ? t('rightSidebar.model3dHiddenParts', { count: hiddenPartIds.length }) : t('rightSidebar.model3dAllPartsVisible')}</button>
          <button type="button" disabled={!partVisibility.history.length} className="inline-flex h-9 items-center gap-1 px-1 text-xs text-foreground disabled:opacity-40" onClick={() => dispatchPartVisibility({ type: 'undo' })}><Undo2 size={14} />{t('rightSidebar.model3dUndoVisibility')}</button>
        </div>
      )}
      {/* The viewer canvas swallows pointer/touch gestures: swiper-no-swiping
          opts out of the sidebar file-list swiper (see gestureArbiter.ts) and
          stopPropagation keeps the events away from other global handlers. */}
      <div
        ref={containerRef}
        className="swiper-no-swiping absolute inset-0"
        style={{ touchAction: 'none' }}
        tabIndex={0}
        aria-label={t('rightSidebar.model3dCanvas')}
        onPointerMove={(event) => {
          const start = pointerDownPosRef.current;
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) pointerDownPosRef.current = null;
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
          event.currentTarget.focus({ preventScroll: true });
          if (activePickPointers.current.size === 0) multiTouchPick.current = false;
          activePickPointers.current.add(event.pointerId);
          if (activePickPointers.current.size > 1) { multiTouchPick.current = true; lastTap.current = null; }
          pointerDownPosRef.current = multiTouchPick.current ? null : { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const start = pointerDownPosRef.current;
          pointerDownPosRef.current = null;
          activePickPointers.current.delete(event.pointerId);
          if (!start || multiTouchPick.current) { lastTap.current = null; return; }
          // 位移超过阈值 = 拖动, 不选中
          if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
          if (event.button !== 0) return;
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          const previous = lastTap.current;
          const now = performance.now();
          if (previous && now - previous.time < 320 && previous.pointerType === event.pointerType
            && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 24) {
            lastTap.current = null;
            viewerRef.current?.zoomAt(event.clientX - rect.left, event.clientY - rect.top, rect.width || 1, rect.height || 1);
            setPicked(null); setSelectedFeatureIds([]); setSelectedPartId(null);
            return;
          }
          lastTap.current = { x: event.clientX, y: event.clientY, time: now, pointerType: event.pointerType };
          if (!featureMode) {
            // 通用点选: 点击模型任意位置 → 拾取部位 + 坐标
            const hit = viewerRef.current?.pick(
              event.clientX - rect.left,
              event.clientY - rect.top,
              rect.width || 1,
              rect.height || 1,
            );
            setSelectedPartId(hit?.visibilityId ?? null);
            setPicked(hit
              ? { ...hit, part: normalizePickedPartName?.(hit.part) ?? hit.part }
              : null);
          } else {
            // 点击空白处: 取消特征选中 / 清除点选
            setSelectedFeatureIds([]);
            setPicked(null);
            setSelectedPartId(null);
          }
        }}
        onPointerCancel={(event) => {
          activePickPointers.current.delete(event.pointerId);
          multiTouchPick.current = true;
          lastTap.current = null;
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
      {status.kind === 'ready' && partsOpen && <ModelPartsPanel key={blobUrl} parts={parts} hidden={hiddenPartIds} selected={selectedPartId} wide={wideViewer}
        canUndo={partVisibility.history.length > 0} onSelect={selectPart} onToggle={togglePart} onIsolate={isolatePart}
        onShowAll={showAllParts} onUndo={() => dispatchPartVisibility({ type: 'undo' })} onClose={closeParts} />}
    </div>
  );

  return pseudoFullscreen ? createPortal(viewerUi, document.body) : viewerUi;
}

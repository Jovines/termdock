// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mesh, MeshStandardMaterial } from 'three';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { FilePreview } from './RightSidebar';
import { classifyModelWheelGesture, createSectionMaterialStabilizer, formatModelDimension, formatModelDimensions, modelControlSensitivity, resolveModel3dLoaderKind, resolvePickedPartName, scaleModelTrackpadPanDelta, stabilizePcbSilkscreenMaterials, stabilizePcbSubstrateMaterials } from './ModelPreview';

const { stlParseMock, gltfParseMock, readModel3dBlobMock, readFileContentMock } = vi.hoisted(() => ({
  stlParseMock: vi.fn(),
  gltfParseMock: vi.fn(),
  readModel3dBlobMock: vi.fn(async (filePath: string) => ({
    blob: new Blob([new Uint8Array(8)]),
    path: filePath,
    size: 8,
    modified: null,
    ext: '.stl',
    mimeType: 'model/stl',
  })),
  readFileContentMock: vi.fn(async (filePath: string) => ({
    path: filePath,
    content: '',
    size: 0,
    modified: '',
    binary: true,
  })),
}));

function makeStlGeometryMock() {
  return {
    getAttribute() { return undefined; },
    boundingBox: null as null | { getSize: (v: { x: number; y: number; z: number }) => unknown; getCenter: (v: { x: number; y: number; z: number }) => unknown },
    computeBoundingBox() {
      this.boundingBox = {
        getSize: (v) => { v.x = 10; v.y = 20; v.z = 30; return v; },
        getCenter: (v) => { v.x = 0; v.y = 0; v.z = 0; return v; },
      };
    },
    translate() {},
    dispose() {},
  };
}

vi.mock('three', () => {
  class Vector3 {
    constructor(public x = 0, public y = 0, public z = 0) {}
    length() { return Math.hypot(this.x, this.y, this.z); }
    set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
    sub(v: Vector3) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    add(v: Vector3) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    copy(v: Vector3) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vector3().set(this.x, this.y, this.z); }
    crossVectors(a: Vector3, b: Vector3) {
      this.x = a.y * b.z - a.z * b.y;
      this.y = a.z * b.x - a.x * b.z;
      this.z = a.x * b.y - a.y * b.x;
      return this;
    }
    multiplyScalar(value: number) { this.x *= value; this.y *= value; this.z *= value; return this; }
    distanceTo(v: Vector3) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
    setLength(value: number) { return this.normalize().multiplyScalar(value); }
    project() { return this; }
    normalize() {
      const length = this.length();
      return length > 0 ? this.multiplyScalar(1 / length) : this;
    }
    negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  }
  class Plane {
    normal: Vector3;
    constant: number;
    constructor(normal?: Vector3, constant = 0) {
      this.normal = normal ?? new Vector3();
      this.constant = constant;
    }
  }
  class Color {
    value: unknown;
    constructor(value?: unknown) { this.value = value; }
    setHex() {}
  }
  class Scene {
    background: unknown = null;
    add() {}
    remove() {}
    traverse() {}
  }
  class PerspectiveCamera {
    fov: number;
    aspect = 1;
    near = 0.1;
    far = 10000;
    position = new Vector3();
    up = new Vector3(0, 1, 0);
    constructor(fov: number) { this.fov = fov; }
    getWorldDirection(target: Vector3) { return target.set(0, 0, -1); }
    updateProjectionMatrix() {}
  }
  class WebGLRenderer {
    domElement = document.createElement('canvas');
    setPixelRatio() {}
    setSize() {}
    render() {}
    dispose() {}
  }
  class Light {
    position = { set: () => {} };
  }
  class Mesh {
    geometry: { dispose: () => void };
    material: { dispose: () => void };
    rotation = { x: 0, y: 0, z: 0 };
    position = { set: () => {}, sub: () => {}, copy() { return this; }, add() { return this; } };
    quaternion = { setFromUnitVectors: () => {} };
    scale = { set: () => {} };
    constructor(geometry: { dispose: () => void }, material: { dispose: () => void }) {
      this.geometry = geometry;
      this.material = material;
    }
    traverse(cb: (node: unknown) => void) { cb(this); }
    updateMatrixWorld() {}
  }
  class MeshStandardMaterial {
    constructor(_options?: unknown) {}
    emissive = { setHex: () => {} };
    dispose() {}
  }
  class GridHelper {
    position = { y: 0, set: () => {} };
    geometry = { dispose: () => {} };
    material = { dispose: () => {} };
  }
  class Box3 {
    setFromObject() { return this; }
    getSize(v: Vector3) { return v; }
    getCenter(v: Vector3) { return v; }
  }
  class Group {
    position = { set: () => {}, sub: () => {} };
    traverse(cb: (node: unknown) => void) { cb(this); }
    updateMatrixWorld() {}
  }
  class BufferGeometry {}
  class CircleGeometry {
    dispose() {}
  }
  class RingGeometry {
    dispose() {}
  }
  class Raycaster {
    set() {}
    setFromCamera() {}
    intersectObject() { return []; }
  }
  return {
    AmbientLight: Light,
    DirectionalLight: Light,
    Box3,
    BufferGeometry,
    CircleGeometry,
    Color,
    DoubleSide: 2,
    FrontSide: 0,
    GridHelper,
    Group,
    Mesh,
    MeshStandardMaterial,
    PerspectiveCamera,
    Plane,
    Raycaster,
    RingGeometry,
    Scene,
    Vector3,
    WebGLRenderer,
  };
});

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    enableDamping = false;
    dampingFactor = 0;
    screenSpacePanning = false;
    zoomToCursor = false;
    zoomSpeed = 1;
    rotateSpeed = 1;
    panSpeed = 1;
    minDistance = 0;
    maxDistance = Infinity;
    target = new (class {
      x = 0;
      y = 0;
      z = 0;
      add(v: { x: number; y: number; z: number }) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    })();
    update() {}
    dispose() {}
  },
}));

vi.mock('three/examples/jsm/loaders/STLLoader.js', () => ({
  STLLoader: class {
    parse(buffer: ArrayBuffer) {
      stlParseMock(buffer);
      return makeStlGeometryMock();
    }
  },
}));

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    parse(buffer: ArrayBuffer, _path: string, onLoad: (gltf: { scene: unknown }) => void) {
      gltfParseMock(buffer);
      onLoad({ scene: new (class { position = { sub: () => {} }; traverse() {} })() });
    }
  },
}));

vi.mock('../../terminal/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../terminal/api')>()),
  readModel3dBlob: readModel3dBlobMock,
  readFileContent: readFileContentMock,
}));

function renderFilePreview(filePath: string) {
  return render(
    <FilePreview
      filePath={filePath}
      onInsertReference={() => {}}
      onInsertText={() => {}}
      onInsertFeature={(text) => {
        // 模拟 RightSidebar 的接线: 普通引用走 termdock-insert-reference 事件
        window.dispatchEvent(new CustomEvent('termdock-insert-reference', { detail: { text } }));
      }}
      onReferenceCopied={() => {}}
      isMobile={false}
      markdownOutlineOpen={false}
      markdownImageLightboxOpen={false}
      lineRange={null}
      onLineRangeChange={() => {}}
      insertedReferenceKey={null}
      copiedReferenceKey={null}
    />,
  );
}

describe('ModelPreview pure logic', () => {
  it('maps extensions to loader kinds', () => {
    expect(resolveModel3dLoaderKind('.stl')).toBe('stl');
    expect(resolveModel3dLoaderKind('.STL')).toBe('stl');
    expect(resolveModel3dLoaderKind('.glb')).toBe('gltf');
    expect(resolveModel3dLoaderKind('.gltf')).toBe('gltf');
    expect(resolveModel3dLoaderKind('.step')).toBeNull();
    expect(resolveModel3dLoaderKind('.png')).toBeNull();
  });

  it('formats dimensions with 0.1 precision under 100 and integer precision above', () => {
    expect(formatModelDimension(12.34)).toBe('12.3');
    expect(formatModelDimension(123.4)).toBe('123');
    expect(formatModelDimensions({ x: 10, y: 20.04, z: 300 }, 'mm')).toBe('10.0 × 20.0 × 300 mm');
  });

  it('distinguishes trackpad pan, pinch zoom, and a traditional mouse wheel', () => {
    expect(classifyModelWheelGesture({ ctrlKey: true, metaKey: false, deltaMode: 0, deltaX: 0, deltaY: 8 })).toBe('pinch-zoom');
    expect(classifyModelWheelGesture({ ctrlKey: false, metaKey: false, deltaMode: 0, deltaX: 12, deltaY: 4 })).toBe('trackpad-pan');
    expect(classifyModelWheelGesture({ ctrlKey: false, metaKey: false, deltaMode: 0, deltaX: 0, deltaY: 7.5 })).toBe('trackpad-pan');
    expect(classifyModelWheelGesture({ ctrlKey: false, metaKey: false, deltaMode: 0, deltaX: 0, deltaY: 73, wheelDeltaY: 73 })).toBe('trackpad-pan');
    expect(classifyModelWheelGesture({ ctrlKey: false, metaKey: false, deltaMode: 1, deltaX: 0, deltaY: 3 })).toBe('wheel-zoom');
    expect(classifyModelWheelGesture({ ctrlKey: false, metaKey: false, deltaMode: 0, deltaX: 0, deltaY: 3, wheelDeltaY: 120 })).toBe('wheel-zoom');
    expect(classifyModelWheelGesture({ ctrlKey: false, metaKey: false, deltaMode: 0, deltaX: 0, deltaY: 100 })).toBe('wheel-zoom');
  });

  it('keeps trackpad micro-pans precise and softly caps fast swipes', () => {
    expect(scaleModelTrackpadPanDelta(1)).toBeCloseTo(0.52, 2);
    expect(scaleModelTrackpadPanDelta(-1)).toBeCloseTo(-0.52, 2);
    expect(scaleModelTrackpadPanDelta(100)).toBeLessThanOrEqual(18);
    expect(scaleModelTrackpadPanDelta(100)).toBeGreaterThan(scaleModelTrackpadPanDelta(10));
  });

  it('uses calmer controls for touch without changing desktop gains', () => {
    expect(modelControlSensitivity(true)).toEqual({ rotate: 0.62, pan: 0.55, zoom: 0.72 });
    expect(modelControlSensitivity(false)).toEqual({ rotate: 1, pan: 1, zoom: 1.38 });
  });

  it('uses the nearest named glTF part group instead of a mojibake leaf mesh name', () => {
    const part = { name: '罩板和门框（参照，罩板已上移）', type: 'Group', parent: null };
    const leaf = { name: 'ç½©æ¿åé¨æ¡', type: 'Mesh', parent: part };
    expect(resolvePickedPartName(leaf as never)).toBe('罩板和门框（参照，罩板已上移）');
  });

  it('makes KiCad silkscreen opaque and depth-stable without changing other PCB layers', () => {
    const silkscreenMaterial = new MeshStandardMaterial() as MeshStandardMaterial & Record<string, unknown>;
    Object.assign(silkscreenMaterial, { transparent: true, opacity: 0.9, depthWrite: false });
    const soldermaskMaterial = new MeshStandardMaterial() as MeshStandardMaterial & Record<string, unknown>;
    Object.assign(soldermaskMaterial, { transparent: true, opacity: 0.83, depthWrite: false });
    const silkscreen = new Mesh({ dispose() {} } as never, silkscreenMaterial);
    Object.assign(silkscreen, { name: '推拉门P0_silkscreen', parent: null, renderOrder: 0 });
    const soldermask = new Mesh({ dispose() {} } as never, soldermaskMaterial);
    Object.assign(soldermask, { name: '推拉门P0_soldermask', parent: null, renderOrder: 0 });
    const root = {
      traverse(callback: (node: unknown) => void) {
        callback(silkscreen);
        callback(soldermask);
      },
    };

    expect(stabilizePcbSilkscreenMaterials(root as never)).toBe(1);
    expect(silkscreenMaterial).toMatchObject({
      transparent: false,
      opacity: 1,
      depthTest: true,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      needsUpdate: true,
    });
    expect(silkscreen.renderOrder).toBe(20);
    expect(soldermaskMaterial).toMatchObject({ transparent: true, opacity: 0.83, depthWrite: false });
  });

  it('makes the KiCad board substrate and drilled-hole walls depth-stable', () => {
    const substrateMaterial = new MeshStandardMaterial() as MeshStandardMaterial & Record<string, unknown>;
    Object.assign(substrateMaterial, { transparent: true, opacity: 0.98, depthWrite: false });
    const soldermaskMaterial = new MeshStandardMaterial() as MeshStandardMaterial & Record<string, unknown>;
    Object.assign(soldermaskMaterial, { transparent: true, opacity: 0.83, depthWrite: false });
    const substrate = new Mesh({ dispose() {} } as never, substrateMaterial);
    Object.assign(substrate, { name: '推拉门P0布局验证板_PCB', parent: null });
    const soldermask = new Mesh({ dispose() {} } as never, soldermaskMaterial);
    Object.assign(soldermask, { name: '推拉门P0布局验证板_soldermask', parent: null });
    const root = {
      traverse(callback: (node: unknown) => void) {
        callback(substrate);
        callback(soldermask);
      },
    };

    expect(stabilizePcbSubstrateMaterials(root as never)).toBe(1);
    expect(substrateMaterial).toMatchObject({
      transparent: false,
      opacity: 1,
      depthTest: true,
      depthWrite: true,
      needsUpdate: true,
    });
    expect(soldermaskMaterial).toMatchObject({ transparent: true, opacity: 0.83, depthWrite: false });
  });

  it('stabilizes near-opaque materials only while section view is active', () => {
    const soldermask = new MeshStandardMaterial() as MeshStandardMaterial & Record<string, unknown>;
    Object.assign(soldermask, { transparent: true, opacity: 0.83, depthWrite: false, forceSinglePass: false });
    const glass = new MeshStandardMaterial() as MeshStandardMaterial & Record<string, unknown>;
    Object.assign(glass, { transparent: true, opacity: 0.4, depthWrite: false, forceSinglePass: false });
    const soldermaskMesh = new Mesh({ dispose() {} } as never, soldermask);
    const glassMesh = new Mesh({ dispose() {} } as never, glass);
    const root = {
      traverse(callback: (node: unknown) => void) {
        callback(soldermaskMesh);
        callback(glassMesh);
      },
    };

    const stabilizer = createSectionMaterialStabilizer(root as never);
    expect(stabilizer.count).toBe(1);
    stabilizer.setEnabled(true);
    expect(soldermask).toMatchObject({
      transparent: false,
      opacity: 1,
      depthWrite: true,
      forceSinglePass: true,
      needsUpdate: true,
    });
    expect(glass).toMatchObject({ transparent: true, opacity: 0.4, depthWrite: false });

    stabilizer.setEnabled(false);
    expect(soldermask).toMatchObject({
      transparent: true,
      opacity: 0.83,
      depthWrite: false,
      forceSinglePass: false,
      needsUpdate: true,
    });
  });
});

describe('right sidebar 3D model preview', () => {
  const originalFetch = globalThis.fetch;
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;

  beforeEach(() => {
    useSidebarStore.setState({ rootPath: '/repo' });
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    URL.createObjectURL = vi.fn(() => 'blob:model3d-mock');
    URL.revokeObjectURL = vi.fn();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('blob:')) {
        return new Response(new Uint8Array(8), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    globalThis.ResizeObserver = originalResizeObserver;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    stlParseMock.mockClear();
    gltfParseMock.mockClear();
    readModel3dBlobMock.mockClear();
    readFileContentMock.mockClear();
  });

  it('routes .stl files to the interactive 3D viewer through the STLLoader path', async () => {
    const { container } = renderFilePreview('parts/gear.stl');

    // HUD shows the bounding-box dimensions in mm for STL once the viewer is up.
    expect(await screen.findByText('Dimensions: 10.0 × 20.0 × 30.0 mm')).toBeTruthy();
    expect(readModel3dBlobMock).toHaveBeenCalledWith('/repo/parts/gear.stl', expect.anything(), 'view_file', expect.any(String));
    expect(stlParseMock).toHaveBeenCalledTimes(1);
    expect(gltfParseMock).not.toHaveBeenCalled();
    // File name shows both in the preview header and in the viewer HUD.
    expect(screen.getAllByText('gear.stl').length).toBeGreaterThanOrEqual(2);
    // The canvas container opts out of the sidebar swiper gestures.
    expect(container.querySelector('.swiper-no-swiping')).not.toBeNull();
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    const trackpadPan = new WheelEvent('wheel', { deltaX: 6, deltaY: 4, deltaMode: 0, cancelable: true });
    canvas!.dispatchEvent(trackpadPan);
    expect(trackpadPan.defaultPrevented).toBe(true);

  });

  it('falls back to the binary hint for .step files and never calls the 3D loader', async () => {
    renderFilePreview('parts/gear.step');

    expect(await screen.findByText('Binary files cannot be previewed. Use the download button above to save it.')).toBeTruthy();
    expect(readModel3dBlobMock).not.toHaveBeenCalled();
    expect(stlParseMock).not.toHaveBeenCalled();
  });

  it('loads semantic features and sends a feature annotation', async () => {
    readFileContentMock.mockImplementation(async (path: string) => {
      if (path.includes('features/')) {
        return {
          path,
          content: JSON.stringify({
            version: 1,
            features: [
              { id: 'feat-a', part: 'Part A', name: 'Feature 1', center: [0, 0, 0] },
              { id: 'feat-b', part: 'Part B', name: 'Feature 2', center: [1, 1, 1] },
            ],
          }),
          size: 0,
          modified: '',
          binary: false,
        };
      }
      return { path, content: '', size: 0, modified: '', binary: true };
    });
    renderFilePreview('parts/gear.stl');
    await screen.findByText('Dimensions: 10.0 × 20.0 × 30.0 mm');
    expect(readFileContentMock).toHaveBeenCalledWith('features/gear.json');
    expect(await screen.findByRole('button', { name: 'Features' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Features' }));
    expect(screen.queryByText('Part A·Feature 1')).toBeTruthy();
    const marker = document.querySelector('[data-feature-id="feat-a"]') as HTMLElement;
    expect(marker.style.transform).toContain('translate(0px,');
    expect(marker.style.transform).toContain('translate(-50%, -50%)');
    fireEvent.click(screen.getByText('Part A·Feature 1'));
    expect(screen.getByRole('button', { name: 'Insert reference' })).toBeTruthy();
    // 多选: 再选一个面, 引用文本应包含 面A/面B
    fireEvent.click(screen.getByText('Part B·Feature 2'));
    let inserted = '';
    const handler = (e: Event) => {
      inserted = (e as CustomEvent<{ text?: string }>).detail?.text ?? '';
    };
    window.addEventListener('termdock-insert-reference', handler);
    fireEvent.click(screen.getByRole('button', { name: 'Insert reference' }));
    expect(inserted).toContain('面A: Part A·Feature 1');
    expect(inserted).toContain('面B: Part B·Feature 2');
    window.removeEventListener('termdock-insert-reference', handler);
    fireEvent.click(screen.getByRole('button', { name: 'Features' }));
  });
});

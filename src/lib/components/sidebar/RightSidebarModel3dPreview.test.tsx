// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { FilePreview } from './RightSidebar';
import { formatModelDimension, formatModelDimensions, resolveModel3dLoaderKind } from './ModelPreview';

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
    x = 0;
    y = 0;
    z = 0;
    length() { return Math.hypot(this.x, this.y, this.z); }
    set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
    sub(v: Vector3) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    copy(v: Vector3) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
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
    position = { set: () => {} };
    constructor(fov: number) { this.fov = fov; }
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
    position = { set: () => {}, sub: () => {} };
    constructor(geometry: { dispose: () => void }, material: { dispose: () => void }) {
      this.geometry = geometry;
      this.material = material;
    }
    traverse(cb: (node: unknown) => void) { cb(this); }
  }
  class MeshStandardMaterial {
    constructor(_options?: unknown) {}
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
  }
  class BufferGeometry {}
  return {
    AmbientLight: Light,
    DirectionalLight: Light,
    Box3,
    BufferGeometry,
    Color,
    DoubleSide: 2,
    FrontSide: 0,
    GridHelper,
    Group,
    Mesh,
    MeshStandardMaterial,
    PerspectiveCamera,
    Plane,
    Scene,
    Vector3,
    WebGLRenderer,
  };
});

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    enableDamping = false;
    dampingFactor = 0;
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
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('falls back to the binary hint for .step files and never calls the 3D loader', async () => {
    renderFilePreview('parts/gear.step');

    expect(await screen.findByText('Binary files cannot be previewed. Use the download button above to save it.')).toBeTruthy();
    expect(readModel3dBlobMock).not.toHaveBeenCalled();
    expect(stlParseMock).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import ModelPreview from './ModelPreview';
import { Sidebar } from './Sidebar';

const fixture = vi.hoisted(() => ({ root: null as unknown, part: null as unknown }));
vi.mock('three', async (original) => ({
  ...await original<typeof import('three')>(),
  WebGLRenderer: class {
    domElement = document.createElement('canvas');
    setPixelRatio() {} setSize() {} render() {} dispose() {}
  },
  Raycaster: class {
    set() {} setFromCamera() {}
    intersectObject(root: Group) {
      // Intentionally include hidden hits, as Three's raycaster does.
      return [...root.children].reverse().map((object) => ({ object, point: new Vector3(), distance: 1 }));
    }
  },
}));
vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    target = new Vector3(); update() {} dispose() {}
  },
}));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { parse(_buffer: unknown, _path: unknown, done: (value: unknown) => void) {
    done({ scene: fixture.root, parser: { associations: new Map(), json: {} } });
  } },
}));

const originalAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  if (originalAnimations) Object.defineProperty(Element.prototype, 'getAnimations', originalAnimations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
});
function setup(single = false) {
  const root = new Group();
  const base = new Mesh(new BoxGeometry(40, 2, 30), new MeshStandardMaterial()); base.name = 'base';
  const lid = new Mesh(new BoxGeometry(40, 2, 30), new MeshStandardMaterial()); lid.name = 'lid'; lid.position.y = 8;
  root.add(base); if (!single) root.add(lid);
  fixture.root = root; fixture.part = lid;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  return lid;
}

describe('assembly viewer controls', () => {
  it.each([false, true])('keeps part clicks working through drawer capture (fullscreen=%s)', async (fullscreen) => {
    const lid = setup();
    Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    render(<Sidebar side="right" isOpen drawerWidthPx={390} onClose={() => {}}>
      <ModelPreview blobUrl="blob:assembly" ext=".glb" fileName="assembly.glb" />
    </Sidebar>);
    await screen.findByRole('button', { name: 'Parts' });
    if (fullscreen) {
      fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
      await screen.findByRole('button', { name: 'Parts' });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Parts' }));
    fireEvent.click(screen.getByRole('button', { name: 'lid' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close parts' }));
    // Real browser clicks carry detail=1. The drawer has not seen the
    // independent surface's touch start, so its tap flag is false.
    fireEvent.click(screen.getByRole('button', { name: 'Only this part' }), { detail: 1 });
    expect((fixture.root as Group).children[0].visible).toBe(false);
    expect(lid.visible).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }), { detail: 1 });
    expect((fixture.root as Group).children[0].visible).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Hide part' }), { detail: 1 });
    expect(lid.visible).toBe(false);
  });
  it('closes secondary options before the inspector and retains the reload action', async () => {
    setup(); const refresh = vi.fn();
    render(<ModelPreview blobUrl="blob:assembly" ext=".glb" fileName="assembly.glb" onRefresh={refresh} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Parts' }));
    fireEvent.click(screen.getByRole('button', { name: 'More model options' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Light background' }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Light background' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Find a part' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More model options' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Find a part' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More model options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload model' }));
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('manages named parts directly, restores one part, isolates, and undoes without a picking mode', async () => {
    const lid = setup();
    render(<ModelPreview blobUrl="blob:assembly" ext=".glb" fileName="assembly.glb" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Parts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide lid' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide base' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show lid' }));
    expect(lid.visible).toBe(true);
    expect((fixture.root as Group).children[0].visible).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Only show base' }));
    expect(lid.visible).toBe(false);
    expect((fixture.root as Group).children[0].visible).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(lid.visible).toBe(true);
    expect((fixture.root as Group).children[0].visible).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Find a part' }), { target: { value: 'missing' } });
    expect(screen.getByText('No matching parts')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find a part' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Find a part' })).toBeNull();
    expect((fixture.root as Group).children[0].visible).toBe(false);
  });
  it('does not select during dragging or a two-finger gesture', async () => {
    setup();
    // jsdom lacks PointerEvent: preserve pointer IDs and coordinates in this path.
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      pointerId: number;
      constructor(type: string, props: PointerEventInit) { super(type, props); this.pointerId = props.pointerId ?? 0; }
    });
    const view = render(<ModelPreview blobUrl="blob:assembly" ext=".glb" fileName="assembly.glb" />);
    await screen.findByRole('button', { name: 'Parts' });
    const canvas = view.container.querySelector('canvas')!.parentElement!;
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 40, clientY: 10 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(screen.queryByRole('button', { name: 'Hide part' })).toBeNull();
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 20, clientY: 10 });
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 20, clientY: 10 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(screen.queryByRole('button', { name: 'Hide part' })).toBeNull();
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(screen.getByRole('button', { name: 'Hide part' })).toBeTruthy();
  });
  it('hides picked parts, picks through them, and restores all while retaining the exploded pose', async () => {
    const lid = setup();
    const view = render(<ModelPreview blobUrl="blob:assembly" ext=".glb" fileName="assembly.glb" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Exploded view' }));
    const explodedY = lid.position.y;
    const pick = () => {
      const canvasContainer = view.container.querySelector('canvas')!.parentElement!;
      fireEvent.pointerDown(canvasContainer, { clientX: 1, clientY: 1 });
      fireEvent.pointerUp(canvasContainer, { clientX: 1, clientY: 1 });
    };
    pick();
    fireEvent.click(screen.getByRole('button', { name: 'Hide part' }));
    expect(lid.visible).toBe(false);
    expect(screen.queryByRole('button', { name: 'Hide part' })).toBeNull();
    expect(screen.getByRole('button', { name: '1 hidden' })).toBeTruthy();
    expect(screen.getByText('Dimensions: 40.0 × 10.0 × 30.0')).toBeTruthy();
    pick();
    fireEvent.click(screen.getByRole('button', { name: 'Hide part' }));
    expect((fixture.root as Group).children.every((node) => !node.visible)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Parts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show all (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close parts' }));
    expect((fixture.root as Group).children.every((node) => node.visible)).toBe(true);
    expect(lid.position.y).toBe(explodedY);
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
    pick(); fireEvent.click(screen.getByRole('button', { name: 'Hide part' }));
    const reloaded = setup();
    view.rerender(<ModelPreview blobUrl="blob:reloaded" ext=".glb" fileName="assembly.glb" />);
    await screen.findByRole('button', { name: 'Exploded view' });
    expect(reloaded.visible).toBe(true);
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });
  it('opens, adjusts and resets explosion without changing dimensions or requiring a dialog', async () => {
    const lid = setup();
    render(<ModelPreview blobUrl="blob:assembly" ext=".glb" fileName="assembly.glb" />);
    const toggle = await screen.findByRole('button', { name: 'Exploded view' });
    fireEvent.click(toggle);
    expect(lid.position.y).toBeGreaterThan(8);
    expect(screen.getByText('Dimensions: 40.0 × 10.0 × 30.0')).toBeTruthy();
    fireEvent.change(screen.getByRole('slider', { name: 'Explosion amount' }), { target: { value: '0' } });
    expect(lid.position.y).toBe(8);
    fireEvent.change(screen.getByRole('slider', { name: 'Explosion amount' }), { target: { value: '100' } });
    expect(lid.position.y).toBeGreaterThan(8);
    fireEvent.click(screen.getByRole('button', { name: 'Restore assembly' }));
    expect(lid.position.y).toBe(8);
    expect(screen.queryByRole('slider', { name: 'Explosion amount' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('makes section and explosion mutually exclusive and resets on file reload', async () => {
    const lid = setup();
    const view = render(<ModelPreview blobUrl="blob:first" ext=".glb" fileName="assembly.glb" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Exploded view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Section view' }));
    expect(lid.position.y).toBe(8);
    expect(screen.queryByRole('slider', { name: 'Explosion amount' })).toBeNull();
    expect(screen.getByRole('slider', { name: 'Section position' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Exploded view' }));
    expect(screen.queryByRole('slider', { name: 'Section position' })).toBeNull();
    setup(true);
    view.rerender(<ModelPreview blobUrl="blob:single" ext=".glb" fileName="part.glb" />);
    await waitFor(() => expect(screen.getByText('Dimensions: 40.0 × 2.0 × 30.0')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Exploded view' })).toBeNull();
  });
});

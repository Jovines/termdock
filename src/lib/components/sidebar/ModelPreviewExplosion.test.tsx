// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import ModelPreview from './ModelPreview';

const fixture = vi.hoisted(() => ({ root: null as unknown, part: null as unknown }));
vi.mock('three', async (original) => ({
  ...await original<typeof import('three')>(),
  WebGLRenderer: class {
    domElement = document.createElement('canvas');
    setPixelRatio() {} setSize() {} render() {} dispose() {}
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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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

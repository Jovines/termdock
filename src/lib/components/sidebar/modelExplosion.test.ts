import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from 'three';
import { assemblyRoots, createModelExplosion, modelViewDescription, partVolumeCenter } from './modelExplosion';

function fixture() {
  const scene = new Group();
  const wrapper = new Group(); scene.add(wrapper);
  const base = new Mesh(new BoxGeometry(40, 2, 30), new MeshBasicMaterial()); base.name = '底壳';
  const lid = new Group(); lid.name = '上盖'; lid.position.y = 8;
  lid.add(new Mesh(new BoxGeometry(40, 2, 30), new MeshBasicMaterial()));
  lid.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  wrapper.add(base, lid);
  return { scene, wrapper, base, lid };
}

describe('display-only assembly explosion', () => {
  it('keeps top-inserted screw heads above the PCB and pads below a skirted tray', () => {
    const scene = new Group();
    const box = (parent: Group, width: number, height: number, depth: number, bottom: number) => {
      const mesh = new Mesh(new BoxGeometry(width, height, depth), new MeshBasicMaterial());
      mesh.position.y = bottom + height / 2; parent.add(mesh); return mesh;
    };
    const base = box(scene, 60, 1, 60, 0);
    const pcb = box(scene, 50, 1.6, 30, 3.5);
    const screw = new Group(); scene.add(screw);
    box(screw, 2, 4, 2, 1.1); // shaft extends below the board
    box(screw, 3.4, 1.6, 3.4, 5.1); // head sits on the board
    const pad = box(scene, 4, 1.5, 4, 19);
    const tray = new Group(); scene.add(tray);
    box(tray, 60, 2, 60, 21);
    box(tray, 1, 3, 60, 18); // locating skirt extends below the pad
    const controller = createModelExplosion(scene);
    for (const amount of [0.13, 0.48, 1]) {
      controller.set({ axis: 'y', amount });
      expect(controller.offset(base).y).toBe(0);
      expect(controller.offset(screw).y).toBeGreaterThan(controller.offset(pcb).y);
      expect(controller.offset(tray).y).toBeGreaterThan(controller.offset(pad).y);
    }
    controller.set(null);
    expect(screw.position.y).toBe(0);
    expect(tray.position.y).toBe(0);
  });
  it('computes volume centers through transformed material primitives and falls back for open surfaces', () => {
    const part = new Group();
    const a = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    const b = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()); b.position.y = 3;
    part.add(a, b); part.position.set(1000, 2000, -3000); part.scale.set(-2, 3, 4); part.rotation.z = 0.4;
    part.updateMatrixWorld(true);
    const expected = new Vector3(0, 1 / 3, 0).applyMatrix4(part.matrixWorld);
    expect(partVolumeCenter(part, new Box3().setFromObject(part)).distanceTo(expected)).toBeLessThan(1e-8);
    const plane = new Mesh(new PlaneGeometry(2, 4), new MeshBasicMaterial()); plane.position.set(3, 4, 5);
    plane.updateMatrixWorld(true);
    expect(partVolumeCenter(plane, new Box3().setFromObject(plane))).toEqual(plane.position);
  });
  it('moves repeated hardware together without increasing the explosion span', () => {
    const { scene, wrapper, lid } = fixture();
    const controller = createModelExplosion(scene);
    const originalHeight = controller.set({ axis: 'y', amount: 1 }).getSize(new Vector3()).y;
    controller.set(null);
    const twin = lid.clone(); wrapper.add(twin);
    const many = createModelExplosion(scene);
    const manyHeight = many.set({ axis: 'y', amount: 1 }).getSize(new Vector3()).y;
    expect(many.offset(lid).y).toBe(many.offset(twin).y);
    expect(manyHeight).toBeCloseTo(originalHeight);
    const expectedOffset = many.offset(lid).y;
    wrapper.children.reverse(); many.set(null);
    const reordered = createModelExplosion(scene);
    reordered.set({ axis: 'y', amount: 1 });
    expect(reordered.offset(lid).y).toBe(expectedOffset);
    expect(reordered.offset(twin).y).toBe(expectedOffset);
  });
  it('clears nested layers at full expansion and keeps equal lower faces with different heights separate', () => {
    const scene = new Group();
    const add = (height: number, bottom: number) => {
      const mesh = new Mesh(new BoxGeometry(10, height, 10), new MeshBasicMaterial());
      mesh.position.y = bottom + height / 2; scene.add(mesh); return mesh;
    };
    const base = add(20, 0);
    const screw = add(5, 0);
    const board = add(2, 3);
    const lid = add(3, 18);
    const c = createModelExplosion(scene);
    c.set({ axis: 'y', amount: 1 });
    expect(c.offset(base).y).toBe(0);
    expect(c.offset(screw).y).toBeGreaterThan(20);
    expect(3 + c.offset(board).y).toBeGreaterThan(5 + c.offset(screw).y);
    expect(18 + c.offset(lid).y).toBeGreaterThan(5 + c.offset(board).y);
    const full = c.offset(lid).y;
    c.set({ axis: 'y', amount: 0.19 });
    expect(c.offset(lid).y).toBeCloseTo(full * 0.19);
    c.set({ axis: 'x', amount: 1 });
    expect(c.offset(lid).y).toBe(0);
    c.set(null);
    expect(lid.position.y).toBe(19.5);
  });
  it('preserves multi-material part groups and exposes only assembly roots', () => {
    const { scene, base, lid } = fixture();
    expect(assemblyRoots(scene)).toEqual([base, lid]);
    const single = new Group(); single.add(lid); lid.userData.termdockSinglePart = true;
    expect(assemblyRoots(single)).toEqual([lid]);
    const c = createModelExplosion(single); c.set({ axis: 'y', amount: 1 });
    expect(c.offset(lid).length()).toBe(0);
  });
  it('round-trips original coordinates through rotated/scaled parents and repeated resets', () => {
    const { scene, wrapper, lid } = fixture();
    wrapper.rotation.z = 0.3; wrapper.scale.set(2, 3, 4); wrapper.position.set(10, 12, -2);
    scene.updateMatrixWorld(true);
    const original = lid.matrixWorld.clone();
    const local = new Vector3(2, 1, 3);
    const initialPoint = local.clone().applyMatrix4(original);
    const controller = createModelExplosion(scene);
    for (const axis of ['x', 'y', 'z'] as const) {
      controller.set({ axis, amount: 0.5 });
      const display = local.clone().applyMatrix4(lid.matrixWorld);
      expect(display.sub(controller.offset(lid)).distanceTo(initialPoint)).toBeLessThan(1e-10);
      expect(controller.part(lid.children[0])).toBe(lid);
      controller.set(null);
      lid.matrixWorld.elements.forEach((v, i) => expect(v).toBeCloseTo(original.elements[i], 10));
    }
  });
  it('keeps manual matrices, original geometry and material colors unchanged', () => {
    const { scene, lid, base } = fixture();
    lid.updateMatrix(); lid.matrixAutoUpdate = false;
    const initial = lid.matrix.clone();
    const geometry = base.geometry.getAttribute('position').array.slice();
    const color = (base.material as MeshBasicMaterial).color.clone();
    const controller = createModelExplosion(scene);
    controller.set({ axis: 'y', amount: 1 });
    expect(controller.offset(lid).y).toBeGreaterThan(0);
    controller.set(null);
    expect(lid.matrix.equals(initial)).toBe(true);
    expect(base.geometry.getAttribute('position').array).toEqual(geometry);
    expect((base.material as MeshBasicMaterial).color.equals(color)).toBe(true);
  });
  it('records exploded state without presenting display offsets as source coordinates', () => {
    expect(modelViewDescription({ axis: 'y', amount: 0.65 }, null)).toContain('assembled coordinates');
    expect(modelViewDescription(null, null)).toBe('');
  });
});

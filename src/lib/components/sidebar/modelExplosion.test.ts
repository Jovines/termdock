import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { assemblyRoots, createModelExplosion, modelViewDescription } from './modelExplosion';

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

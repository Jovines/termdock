import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { createModelVisibility, isObjectVisible, partVisibilityReducer } from './modelVisibility';

function fixture() {
  const root = new Group();
  const back = new Mesh(new BoxGeometry(2, 2, 1), new MeshBasicMaterial());
  const front = new Group(); front.position.z = 3; front.name = 'same-name';
  const face = new Mesh(new BoxGeometry(2, 2, 1), new MeshBasicMaterial()); front.add(face);
  const detail = face.clone(); detail.visible = false; front.add(detail);
  back.name = front.name;
  root.add(back, front); root.updateMatrixWorld(true);
  return { root, front, face, back, detail };
}

describe('temporary assembly part visibility', () => {
  it('undoes individual changes and isolation without losing earlier hidden parts', () => {
    const first = partVisibilityReducer({ hidden: [], history: [] }, { type: 'toggle', id: 'lid' });
    const second = partVisibilityReducer(first, { type: 'toggle', id: 'base' });
    const restoredLid = partVisibilityReducer(second, { type: 'toggle', id: 'lid' });
    expect(restoredLid.hidden).toEqual(['base']);
    expect(partVisibilityReducer(restoredLid, { type: 'undo' }).hidden).toEqual(['lid', 'base']);
    const isolated = partVisibilityReducer(second, { type: 'set', hidden: ['lid', 'nut'] });
    expect(partVisibilityReducer(isolated, { type: 'undo' }).hidden).toEqual(['lid', 'base']);
    expect(partVisibilityReducer(isolated, { type: 'set', hidden: ['nut', 'lid'] })).toBe(isolated);
    expect(partVisibilityReducer(isolated, { type: 'reset' })).toEqual({ hidden: [], history: [] });
  });
  it('hides the complete part and lets picking pass through to the next surface', () => {
    const { root, front, face, back, detail } = fixture();
    const visibility = createModelVisibility(root);
    const ray = new Raycaster(new Vector3(0, 0, 10), new Vector3(0, 0, -1));
    const pick = () => ray.intersectObject(root, true).find((hit) => isObjectVisible(hit.object))?.object;
    expect(pick()).toBe(face);
    visibility.setHidden([visibility.id(face)!]);
    expect(front.visible).toBe(false);
    expect(pick()).toBe(back);
    expect(visibility.isPartVisible(front.uuid)).toBe(false);
    expect(visibility.isPartVisible(back.uuid)).toBe(true);
    visibility.setHidden([]);
    expect(pick()).toBe(face);
    expect(detail.visible).toBe(false);
  });
  it('preserves hiding across a remount despite new UUIDs and duplicate names', () => {
    const first = fixture(); const next = fixture();
    const a = createModelVisibility(first.root); const b = createModelVisibility(next.root);
    expect(first.front.uuid).not.toBe(next.front.uuid);
    b.setHidden([a.id(first.face)!]);
    expect(next.front.visible).toBe(false);
    expect(next.back.visible).toBe(true);
  });
  it('restores the original visibility without revealing exporter-hidden parts', () => {
    const { root, front, back } = fixture(); back.visible = false;
    const visibility = createModelVisibility(root);
    visibility.setHidden([visibility.id(front)!]);
    visibility.setHidden([]);
    expect(back.visible).toBe(false);
    expect(front.visible).toBe(true);
  });
});

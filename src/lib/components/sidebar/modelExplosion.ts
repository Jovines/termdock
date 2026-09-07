import { Box3, Matrix4, Mesh, type Object3D, Vector3 } from 'three';

export type ExplosionAxis = 'x' | 'y' | 'z';
export interface ExplosionState { axis: ExplosionAxis; amount: number }

/** Use scene assembly boundaries, never split a multi-material Mesh/part Group. */
export function assemblyRoots(root: Object3D): Object3D[] {
  const hasGeometry = (node: Object3D): boolean => {
    let found = false;
    node.traverse((child) => { if (child instanceof Mesh) found = true; });
    return found;
  };
  let node = root;
  while (!(node instanceof Mesh)) {
    const children = (node.children ?? []).filter(hasGeometry);
    if (children.length !== 1) return children;
    // GLTFLoader marks multi-primitive meshes with associations; their child
    // meshes are materials of ONE part, not an assembly.
    if (children[0].userData?.termdockSinglePart) return [children[0]];
    node = children[0];
  }
  return [node];
}

/** Volume centroid across all material primitives of a CAD part.
 * A screw's inserted shaft must not determine which side of a plate it occupies.
 * Open/degenerate surfaces fall back to their bounding-box center.
 */
export function partVolumeCenter(node: Object3D, box: Box3): Vector3 {
  const origin = box.getCenter(new Vector3());
  const moment = new Vector3();
  const closure = new Vector3();
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  const cross = new Vector3(), edge = new Vector3();
  let volume = 0;
  let area = 0;
  node.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const positions = child.geometry.getAttribute('position');
    if (!positions) return;
    const indices = child.geometry.index;
    const count = indices?.count ?? positions.count;
    for (let i = 0; i + 2 < count; i += 3) {
      a.fromBufferAttribute(positions, indices ? indices.getX(i) : i).applyMatrix4(child.matrixWorld).sub(origin);
      b.fromBufferAttribute(positions, indices ? indices.getX(i + 1) : i + 1).applyMatrix4(child.matrixWorld).sub(origin);
      c.fromBufferAttribute(positions, indices ? indices.getX(i + 2) : i + 2).applyMatrix4(child.matrixWorld).sub(origin);
      const weight = a.dot(cross.crossVectors(b, c));
      volume += weight;
      moment.addScaledVector(a, weight / 4).addScaledVector(b, weight / 4).addScaledVector(c, weight / 4);
      cross.subVectors(b, a).cross(edge.subVectors(c, a));
      closure.add(cross);
      area += cross.length();
    }
  });
  const size = box.getSize(new Vector3());
  if (Math.abs(volume) <= size.x * size.y * size.z * 1e-9 || closure.length() > area * 1e-5) return origin;
  const center = moment.divideScalar(volume).add(origin);
  return box.containsPoint(center) ? center : origin;
}

/** Display-only translation; the original matrices remain the coordinate authority. */
export function createModelExplosion(root: Object3D) {
  root.updateMatrixWorld(true);
  const parts = assemblyRoots(root).map((node) => {
    const box = new Box3().setFromObject(node);
    return {
    node,
    position: node.position.clone(),
    matrix: node.matrix.clone(),
    autoUpdate: node.matrixAutoUpdate,
    box,
    center: partVolumeCenter(node, box),
    offset: new Vector3(),
    };
  });
  const originalBox = new Box3().setFromObject(root);
  const size = originalBox.getSize(new Vector3());
  // Equal-height hardware is one display layer, independent of export order.
  // Compare both faces so a tall enclosure never absorbs a screw at its base.
  const tolerance = Math.max(size.x, size.y, size.z, 1e-6) * 0.002;
  const gap = Math.max(size.x, size.y, size.z, 1e-6) * 0.12;
  const plans = new Map<ExplosionAxis, Map<typeof parts[number], number>>();
  for (const axis of ['x', 'y', 'z'] as const) {
    const layers: Array<{ min: number; max: number; parts: typeof parts }> = [];
    const base = [...parts].sort((a, b) => a.box.min[axis] - b.box.min[axis]
      || b.box.max[axis] - a.box.max[axis])[0];
    // Keep the bottom support fixed; order its contents by solid volume,
    // not protruding shafts, skirts, or locating tabs at their lower faces.
    const ordered = [...parts].sort((a, b) => a === b ? 0 : a === base ? -1 : b === base ? 1
      : a.center[axis] - b.center[axis]
      || b.box.max[axis] - a.box.max[axis]);
    for (const part of ordered) {
      const layer = layers.find((entry) => Math.abs(entry.min - part.box.min[axis]) <= tolerance
        && Math.abs(entry.max - part.box.max[axis]) <= tolerance);
      if (layer) layer.parts.push(part);
      else layers.push({ min: part.box.min[axis], max: part.box.max[axis], parts: [part] });
    }
    const offsets = new Map<typeof parts[number], number>();
    let offset = 0;
    let previousMax = 0;
    for (const [index, layer] of layers.entries()) {
      const min = Math.min(...layer.parts.map((part) => part.box.min[axis]));
      const max = Math.max(...layer.parts.map((part) => part.box.max[axis]));
      // Clear the preceding layer's actual thickness, retaining existing gaps.
      // Extra screws within a layer must not increase the assembly's height.
      if (index > 0) offset += Math.max(gap, previousMax - min + gap);
      for (const part of layer.parts) offsets.set(part, offset);
      previousMax = max;
    }
    plans.set(axis, offsets);
  }
  const lookup = (node: Object3D | string | undefined) => {
    if (typeof node === 'string') {
      const exact = parts.filter((p) => p.node.uuid === node || p.node.name === node || p.node.userData.termdockPartName === node);
      return exact.length === 1 ? exact[0] : undefined;
    }
    for (let current = node; current; current = current.parent ?? undefined) {
      const part = parts.find((p) => p.node === current);
      if (part) return part;
    }
    return undefined;
  };
  return {
    count: parts.length,
    part: (node: Object3D) => lookup(node)?.node,
    offset: (node?: Object3D | string) => lookup(node)?.offset.clone() ?? new Vector3(),
    set(state: ExplosionState | null) {
      const amount = state && Number.isFinite(state.amount) ? Math.max(0, Math.min(1, state.amount)) : 0;
      const axis = state?.axis ?? 'y';
      for (const part of parts) {
        part.offset.set(0, 0, 0);
        part.offset[axis] = (plans.get(axis)?.get(part) ?? 0) * amount;
        part.node.position.copy(part.position);
        part.node.matrix.copy(part.matrix);
        if (amount > 0) {
          const inverse = part.node.parent?.matrixWorld.clone().invert() ?? new Matrix4();
          const localOffset = part.offset.clone().applyMatrix4(inverse).sub(new Vector3().applyMatrix4(inverse));
          part.node.position.add(localOffset);
          if (part.autoUpdate) part.node.updateMatrix();
          else part.node.matrix.premultiply(new Matrix4().makeTranslation(localOffset.x, localOffset.y, localOffset.z));
        }
      }
      root.updateMatrixWorld(true);
      return new Box3().setFromObject(root);
    },
  };
}

export function modelViewDescription(explosion: ExplosionState | null, clip: { axis: string; value01: number; flip: boolean } | null): string {
  return [
    explosion && explosion.amount > 0 ? `Exploded ${explosion.axis.toUpperCase()} ${Math.round(explosion.amount * 100)}%; assembled coordinates` : '',
    clip ? `Section ${clip.axis.toUpperCase()} ${Math.round(clip.value01 * 100)}%${clip.flip ? ' flipped' : ''}` : '',
  ].filter(Boolean).join(' / ');
}

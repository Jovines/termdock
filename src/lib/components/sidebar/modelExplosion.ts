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

/** Display-only translation; the original matrices remain the coordinate authority. */
export function createModelExplosion(root: Object3D) {
  root.updateMatrixWorld(true);
  const parts = assemblyRoots(root).map((node) => ({
    node,
    position: node.position.clone(),
    matrix: node.matrix.clone(),
    autoUpdate: node.matrixAutoUpdate,
    box: new Box3().setFromObject(node),
    offset: new Vector3(),
  }));
  const originalBox = new Box3().setFromObject(root);
  const size = originalBox.getSize(new Vector3());
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
      const step = Math.max(size.length() * 0.2 + Math.max(0, ...parts.map((p) => p.box.getSize(new Vector3())[axis])), 1e-6);
      // Lower bounding face retains the base-first order of nested enclosures.
      const ordered = [...parts].sort((a, b) => a.box.min[axis] - b.box.min[axis]);
      for (const [rank, part] of ordered.entries()) {
        part.offset.set(0, 0, 0);
        part.offset[axis] = parts.length > 1 ? rank * step * amount : 0;
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

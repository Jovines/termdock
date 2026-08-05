// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { MODEL_3D_EXTS, getModel3dExtForPath, isPreviewableModel3dPath } from './api';

describe('3D model preview path detection', () => {
  it('covers exactly .stl/.glb/.gltf', () => {
    expect([...MODEL_3D_EXTS].sort()).toEqual(['.glb', '.gltf', '.stl']);
  });

  it('accepts stl/glb/gltf regardless of case', () => {
    expect(isPreviewableModel3dPath('/repo/parts/gear.stl')).toBe(true);
    expect(isPreviewableModel3dPath('/repo/parts/gear.STL')).toBe(true);
    expect(isPreviewableModel3dPath('/repo/scene.glb')).toBe(true);
    expect(isPreviewableModel3dPath('/repo/scene.GLTF')).toBe(true);
  });

  it('rejects step/stp and other non-model files', () => {
    expect(isPreviewableModel3dPath('/repo/parts/gear.step')).toBe(false);
    expect(isPreviewableModel3dPath('/repo/parts/gear.stp')).toBe(false);
    expect(isPreviewableModel3dPath('/repo/parts/gear.obj')).toBe(false);
    expect(isPreviewableModel3dPath('/repo/readme.md')).toBe(false);
    expect(isPreviewableModel3dPath('/repo/no-extension')).toBe(false);
  });

  it('returns the lowercased extension for matched paths', () => {
    expect(getModel3dExtForPath('/repo/parts/gear.STL')).toBe('.stl');
    expect(getModel3dExtForPath('/repo/scene.Glb')).toBe('.glb');
    expect(getModel3dExtForPath('/repo/parts/gear.step')).toBeNull();
  });
});

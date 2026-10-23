// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
const scope = vi.hoisted(() => ({ peer: 'first' }));
vi.mock('../../federation/browserIntegration', () => ({ savedConnection: () => ({ targetPeerId: scope.peer }) }));
import { readFileReferenceDrag, writeFileReferenceDrag } from './fileReferenceTransfer';
it('only reuses a dragged file path in its owning service', () => {
  const values = new Map<string, string>(), transfer = { setData: (key: string, value: string) => values.set(key, value), getData: (key: string) => values.get(key) || '' };
  writeFileReferenceDrag(transfer, '/shared/spec.md '); expect(readFileReferenceDrag(transfer)).toBe('/shared/spec.md ');
  scope.peer = 'another'; expect(() => readFileReferenceDrag(transfer)).toThrow('文件所属的服务');
});

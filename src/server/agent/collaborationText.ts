import { stripVTControlCharacters } from 'node:util';
/** Snapshot rendering only. Message bodies are never normalized. */
export function plainCollaborationSnapshot(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

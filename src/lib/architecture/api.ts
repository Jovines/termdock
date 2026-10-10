import { readNativeArchitecture, listNativeArchitectures } from './native';
import { ARCHITECTURE_FILE, analysisFile, ArchitectureFormatError, type ArchitectureDocument } from './model';

/** Native project APIs inherit the active page's encrypted transport. */
export async function readArchitecture(root: string, signal: AbortSignal, file = ARCHITECTURE_FILE): Promise<ArchitectureDocument | null> {
  const { document } = await readNativeArchitecture(root, file, signal);
  if (document?.analysis && analysisFile(document.analysis) !== file) throw new ArchitectureFormatError('Architecture scope does not match its file');
  return document;
}
export async function listArchitectures(root: string, signal: AbortSignal): Promise<string[]> {
  return listNativeArchitectures(root, signal);
}

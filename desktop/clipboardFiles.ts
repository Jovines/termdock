import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Read file objects, not text that happens to look like a filesystem path.
 * No caller-supplied paths or uploads cross this native boundary. */
export async function readClipboardFiles(): Promise<Array<{ name: string; bytes: ArrayBuffer }>> {
  if (process.platform !== 'darwin') return [];
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
    ObjC.import('AppKit');
    const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions(
      $([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true })
    );
    const paths = [];
    if (urls) {
      for (let i = 0; i < urls.count; i++) {
        const url = urls.objectAtIndex(i);
        if (url.isFileURL) paths.push(ObjC.unwrap(url.path));
      }
    }
    JSON.stringify(paths);
  `], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  const paths: unknown = JSON.parse(stdout);
  if (!Array.isArray(paths) || paths.some(value => typeof value !== 'string' || !path.isAbsolute(value))) {
    throw new Error('无法读取剪贴板文件');
  }
  const files: Array<{ name: string; bytes: ArrayBuffer }> = [];
  for (const filePath of [...new Set(paths as string[])]) {
    if (!(await stat(filePath)).isFile()) throw new Error(`暂不支持粘贴文件夹或特殊文件：${path.basename(filePath)}`);
    const data = await readFile(filePath);
    files.push({ name: path.basename(filePath), bytes: Uint8Array.from(data).buffer });
  }
  return files;
}

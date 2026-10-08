import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ClipboardFile {
  name: string;
  bytes?: ArrayBuffer;
  type?: string;
  /** Original clipboard file path, only for this Mac's verified service. */
  path?: string;
}

interface ClipboardContents {
  paths: string[];
  videos: Array<{ path: string; type: string }>;
}

async function isLocalService(serviceId: unknown): Promise<boolean> {
  if (typeof serviceId !== 'string' || !/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/.test(serviceId)) return false;
  try {
    // Read the public half of our protobuf Ed25519 key. Desktop packages omit
    // node_modules, so encode the public identity without runtime dependencies.
    // No private key material is returned to the page.
    const encoded = await readFile(path.join(homedir(), '.termdock', 'federation', 'identity.key'), 'utf8');
    const key = Buffer.from(encoded, 'base64');
    // PrivateKey protobuf: Ed25519 enum (1), 64 bytes (seed + public key).
    if (key.length !== 68 || !key.subarray(0, 4).equals(Buffer.from([8, 1, 18, 64]))) return false;
    // Identity multihash of the 36-byte PublicKey protobuf.
    const publicIdentity = Buffer.concat([Buffer.from([0, 36, 8, 1, 18, 32]), key.subarray(36)]);
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let value = BigInt(`0x${publicIdentity.toString('hex')}`);
    let peerId = '';
    while (value > 0n) {
      peerId = alphabet[Number(value % 58n)] + peerId;
      value /= 58n;
    }
    for (const byte of publicIdentity) {
      if (byte !== 0) break;
      peerId = '1' + peerId;
    }
    return peerId === serviceId;
  } catch {
    // A different user/service directory cannot be proven local; upload bytes.
    return false;
  }
}

/** Read native file objects and movie data, never path-like clipboard text.
 * Original paths are reusable only by this Mac's service; all uploads stay in
 * the encrypted page. Old pages omit options and continue receiving bytes. */
export async function readClipboardFiles(options?: { localServiceId?: string }): Promise<ClipboardFile[]> {
  if (process.platform !== 'darwin') return [];
  // Keep large movie bytes out of osascript stdout/base64. The private directory
  // is removed after reading, including when the native reader fails.
  const directory = await mkdtemp(path.join(tmpdir(), 'termdock-clipboard-'));
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
    ObjC.import('AppKit');
    // ObjC.import depends on OS-specific BridgeSupport metadata. Load the
    // longstanding LaunchServices UTI API directly instead. CFString is
    // toll-free bridged to NSString; binding it as id returns wrapped objects
    // rather than opaque C pointers that cannot be unwrapped by JXA.
    if (!$.NSBundle.bundleWithPath(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework'
    ).load) throw new Error('无法加载剪贴板类型识别组件');
    ObjC.bindFunction('UTTypeConformsTo', ['bool', ['id', 'id']]);
    ObjC.bindFunction('UTTypeCreatePreferredIdentifierForTag', ['id', ['id', 'id', 'id']]);
    ObjC.bindFunction('UTTypeCopyPreferredTagWithClass', ['id', ['id', 'id']]);
    function isMovie(type) {
      return type && !type.isNil() &&
        ($.UTTypeConformsTo(type, $('public.movie')) || $.UTTypeConformsTo(type, $('public.video')));
    }
    function run(argv) {
      const pasteboard = $.NSPasteboard.generalPasteboard;
      const urls = pasteboard.readObjectsForClassesOptions(
        $([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true })
      );
      const paths = [];
      let hasVideoFile = false;
      if (urls && !urls.isNil()) {
        for (let i = 0; i < urls.count; i++) {
          const url = urls.objectAtIndex(i);
          if (!url.isFileURL) continue;
          paths.push(ObjC.unwrap(url.path));
          if (isMovie($.UTTypeCreatePreferredIdentifierForTag(
            $('public.filename-extension'), url.pathExtension, null
          ))) hasVideoFile = true;
        }
      }
      // Finder already supplies the original file. Avoid requesting another
      // representation or uploading its cover image instead of the video.
      if (hasVideoFile) return JSON.stringify({ paths: paths, videos: [] });
      const videos = [];
      const items = pasteboard.pasteboardItems;
      if (items && !items.isNil()) {
        for (let i = 0; i < items.count; i++) {
          const item = items.objectAtIndex(i);
          let advertisedMovie = false;
          let savedMovie = false;
          for (let j = 0; j < item.types.count; j++) {
            const identifier = item.types.objectAtIndex(j);
            const value = ObjC.unwrap(identifier);
            const type = value.indexOf('video/') === 0
              ? $.UTTypeCreatePreferredIdentifierForTag($('public.mime-type'), identifier, null)
              : identifier;
            if (!isMovie(type)) continue;
            advertisedMovie = true;
            const data = item.dataForType(identifier);
            if (!data || data.isNil() || !data.length) continue;
            const preferredExtension = ObjC.unwrap($.UTTypeCopyPreferredTagWithClass(type, $('public.filename-extension')));
            const extension = typeof preferredExtension === 'string' && /^[a-z0-9]+$/i.test(preferredExtension)
              ? preferredExtension : 'mov';
            const preferredMime = ObjC.unwrap($.UTTypeCopyPreferredTagWithClass(type, $('public.mime-type')));
            const mime = typeof preferredMime === 'string' && preferredMime.indexOf('video/') === 0
              ? preferredMime : 'application/octet-stream';
            const filePath = argv[0] + '/video-' + i + '.' + extension;
            if (!data.writeToFileAtomically(filePath, true)) throw new Error('无法读取剪贴板视频');
            videos.push({ path: filePath, type: mime });
            savedMovie = true;
            break;
          }
          if (advertisedMovie && !savedMovie) throw new Error('复制来源未提供可读取的视频数据，请重新复制视频或选择文件上传');
        }
      }
      // Other apps can publish a movie and a thumbnail file together.
      return JSON.stringify({ paths: videos.length ? [] : paths, videos: videos });
    }
  `, directory], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const contents: ClipboardContents = JSON.parse(stdout);
    if (!contents || !Array.isArray(contents.paths) || !Array.isArray(contents.videos)
      || contents.paths.some(value => typeof value !== 'string' || !path.isAbsolute(value))
      || contents.videos.some(video => !video || typeof video.path !== 'string'
        || path.dirname(video.path) !== directory || !/^video-\d+\.[a-z0-9]+$/i.test(path.basename(video.path))
        || typeof video.type !== 'string')) {
      throw new Error('无法读取剪贴板文件');
    }
    const files: ClipboardFile[] = [];
    const entries = [
      ...[...new Set(contents.paths)].map(filePath => ({ path: filePath, type: undefined })),
      ...contents.videos,
    ];
    const reusePaths = contents.paths.length > 0 && await isLocalService(options?.localServiceId);
    for (const entry of entries) {
      if (!(await stat(entry.path)).isFile()) throw new Error(`暂不支持粘贴文件夹或特殊文件：${path.basename(entry.path)}`);
      const generatedMovie = contents.videos.some(video => video.path === entry.path);
      if (reusePaths && !generatedMovie) {
        files.push({ name: path.basename(entry.path), path: entry.path });
        continue;
      }
      const data = await readFile(entry.path);
      const name = generatedMovie
        ? `${path.basename(directory)}-${path.basename(entry.path)}`
        : path.basename(entry.path);
      files.push({ name, bytes: Uint8Array.from(data).buffer, type: entry.type });
    }
    return files;
  } catch (error) {
    // execFile errors include the entire source and temporary path in message.
    // Surface only the script's diagnostic instead of flooding the terminal UI.
    if (error && typeof error === 'object' && 'stderr' in error) {
      const diagnostic = String(error.stderr).trim().split(/\r?\n/).at(-1);
      throw new Error(`无法读取剪贴板文件或视频${diagnostic ? `：${diagnostic}` : ''}`);
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

import { open } from 'node:fs/promises';

// Reads image dimensions from a small prefix of the file. Used by the blob
// endpoint to expose X-Image-Width/Height headers so the client can reserve
// the final display box before the image bytes arrive (no layout jump).
// Never throws — callers treat null as "dimensions unknown".

const READ_PREFIX_BYTES = 64 * 1024;

export interface ImageDimensions {
  width: number;
  height: number;
}

export async function getImageDimensions(filePath: string, mimeType: string): Promise<ImageDimensions | null> {
  try {
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(READ_PREFIX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return parseImageDimensions(buffer.subarray(0, bytesRead), mimeType);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export function parseImageDimensions(head: Buffer, mimeType: string): ImageDimensions | null {
  switch (mimeType) {
    case 'image/png':
      return parsePng(head);
    case 'image/gif':
      return parseGif(head);
    case 'image/bmp':
      return parseBmp(head);
    case 'image/jpeg':
      return parseJpeg(head);
    case 'image/webp':
      return parseWebp(head);
    case 'image/x-icon':
      return parseIco(head);
    case 'image/svg+xml':
      return parseSvg(head);
    default:
      return null;
  }
}

function toDimensions(width: number, height: number): ImageDimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

function parsePng(head: Buffer): ImageDimensions | null {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (head[i] !== PNG_SIGNATURE[i]) return null;
  }
  return toDimensions(head.readUInt32BE(16), head.readUInt32BE(20));
}

function parseGif(head: Buffer): ImageDimensions | null {
  if (head.length < 10) return null;
  if (head.toString('ascii', 0, 3) !== 'GIF') return null;
  return toDimensions(head.readUInt16LE(6), head.readUInt16LE(8));
}

function parseBmp(head: Buffer): ImageDimensions | null {
  if (head.length < 26) return null;
  if (head.toString('ascii', 0, 2) !== 'BM') return null;
  return toDimensions(head.readInt32LE(18), Math.abs(head.readInt32LE(22)));
}

function parseIco(head: Buffer): ImageDimensions | null {
  if (head.length < 8) return null;
  if (head.readUInt16LE(0) !== 0 || head.readUInt16LE(2) !== 1) return null;
  // Width/height bytes are 0 to mean 256.
  return toDimensions(head[6] || 256, head[7] || 256);
}

function parseJpeg(head: Buffer): ImageDimensions | null {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < head.length) {
    if (head[offset] !== 0xff) return null;
    const marker = head[offset + 1];
    // SOF0–SOF15 except DHT(C4), JPG(C8), DAC(CC) carry the frame dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return toDimensions(head.readUInt16BE(offset + 7), head.readUInt16BE(offset + 5));
    }
    const segmentLength = head.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

function parseWebp(head: Buffer): ImageDimensions | null {
  if (head.length < 30) return null;
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = head.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return toDimensions(head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    const b1 = head[21];
    const b2 = head[22];
    const b3 = head[23];
    const b4 = head[24];
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return toDimensions(width, height);
  }
  if (chunk === 'VP8X') {
    const width = 1 + head.readUIntLE(24, 3);
    const height = 1 + head.readUIntLE(27, 3);
    return toDimensions(width, height);
  }
  return null;
}

// SVG: numeric width/height attributes win; otherwise fall back to the
// browser's default object size (300×150) contain-fit to the viewBox ratio —
// this mirrors what Chrome reports as naturalWidth/naturalHeight for
// dimensionless SVGs (e.g. square viewBox → 150×150).
function parseSvg(head: Buffer): ImageDimensions | null {
  const text = head.toString('utf8');
  const svgTagMatch = text.match(/<svg\b[^>]*>/i);
  if (!svgTagMatch) return null;
  const tag = svgTagMatch[0];

  const numericAttr = (name: string): number | null => {
    const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])\\s*([0-9]*\\.?[0-9]+)\\s*(?:px)?\\1`, 'i'));
    if (!match) return null;
    const value = Number(match[2]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const width = numericAttr('width');
  const height = numericAttr('height');
  if (width && height) return toDimensions(width, height);

  const viewBoxMatch = tag.match(/\sviewBox\s*=\s*(["'])\s*[-0-9.,\s]+?\1/i);
  if (!viewBoxMatch) return null;
  const parts = viewBoxMatch[0].replace(/^\s*viewBox\s*=\s*["']/i, '').replace(/["']$/, '').trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4) return null;
  const [, , vbWidth, vbHeight] = parts;
  if (!Number.isFinite(vbWidth) || !Number.isFinite(vbHeight) || vbWidth <= 0 || vbHeight <= 0) return null;

  if (width) return toDimensions(width, (width * vbHeight) / vbWidth);
  if (height) return toDimensions((height * vbWidth) / vbHeight, height);

  const scale = Math.min(300 / vbWidth, 150 / vbHeight);
  return toDimensions(vbWidth * scale, vbHeight * scale);
}

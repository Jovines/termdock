import type { ImageDimension } from './mediaCompressionOptions';

export type ImageCompressionOptions = {
  maxDimension: ImageDimension;
  quality: number;
};

export async function compressImageLocally(file: File, options: ImageCompressionOptions): Promise<File> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) throw new Error('无法读取图片尺寸');

    const scale = Math.min(1, options.maxDimension / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('此浏览器无法处理图片');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    // WebP retains PNG transparency. Photos use JPEG for broad compatibility.
    const preferredType = /(?:image\/png|\.png$)/i.test(file.type) || /\.png$/i.test(file.name)
      ? 'image/webp'
      : 'image/jpeg';
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('图片压缩失败')), preferredType, options.quality);
    });
    if (blob.size >= file.size) return file;
    const type = blob.type || preferredType;
    const extension = type === 'image/webp' ? 'webp' : type === 'image/png' ? 'png' : 'jpg';
    const name = `${file.name.replace(/\.[^.]+$/, '') || 'image'}-compressed.${extension}`;
    return new File([blob], name, { type });
  } finally {
    URL.revokeObjectURL(url);
  }
}

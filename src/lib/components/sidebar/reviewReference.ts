export interface ReferenceEvidence {
  snapshot?: Promise<Blob | null>;
}

export type ReviewReferenceHandler = (text: string, key: string, evidence?: ReferenceEvidence) => void;

/** Freeze only the viewer, never surrounding chat or terminal content. */
export function captureReferenceCanvas(source: HTMLCanvasElement | HTMLImageElement, point?: { xPercent: number; yPercent: number }, label?: string): Promise<Blob | null> {
  try {
    const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    if (!width || !height) return Promise.resolve(null);
    // EDA images are vector SVGs whose intrinsic size may be only ~150 px.
    // Rasterize those at review resolution; never upscale the WebGL canvas.
    const scale = source instanceof HTMLImageElement ? 1400 / Math.max(width, height) : Math.min(1, 1400 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    const tokens = getComputedStyle(document.documentElement);
    ctx.fillStyle = tokens.getPropertyValue('--surface').trim() || 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (label) {
      // Bake display-state provenance into the image, not just a DOM overlay.
      const fontSize = Math.max(10, Math.min(16, canvas.width / 35));
      ctx.font = `${fontSize}px sans-serif`;
      const lines: string[] = [];
      let line = '';
      for (const word of label.split(' ')) {
        if (line && ctx.measureText(`${line} ${word}`).width > canvas.width - 20) {
          lines.push(line); line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      if (line) lines.push(line);
      ctx.fillStyle = tokens.getPropertyValue('--surface').trim() || 'white';
      ctx.fillRect(0, 0, canvas.width, lines.length * (fontSize + 4) + 12);
      ctx.fillStyle = tokens.getPropertyValue('--foreground').trim() || 'black';
      lines.forEach((text, index) => ctx.fillText(text, 10, 8 + fontSize + index * (fontSize + 4)));
    }
    if (point) {
      const x = point.xPercent * canvas.width / 100;
      const y = point.yPercent * canvas.height / 100;
      const radius = Math.max(4, Math.min(12, Math.min(canvas.width, canvas.height) * 0.015));
      const arm = radius * 1.6;
      ctx.strokeStyle = tokens.getPropertyValue('--primary').trim() || 'black';
      ctx.lineWidth = Math.max(1, radius / 3);
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y); ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm); ctx.stroke();
    }
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return Promise.resolve(null);
  }
}

export function formatReviewReference(text: string, note: string, _capturedAt: string, imagePath?: string): string {
  return [text.trim(), note.trim(), imagePath ? `截图：${imagePath}` : ''].filter(Boolean).join('\n');
}

/** Fit a sphere against the narrower field of view (phones are width-limited). */
export function modelFitDistance(radius: number, fovDegrees: number, aspect: number): number {
  const halfFov = fovDegrees * Math.PI / 360;
  const limitingHalfFov = Math.min(halfFov, Math.atan(Math.tan(halfFov) * Math.max(aspect, 0.05)));
  return Math.max(radius, 1e-6) / Math.sin(limitingHalfFov) * 1.15;
}

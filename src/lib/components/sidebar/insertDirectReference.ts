import { formatReviewReference, type ReferenceEvidence } from './reviewReference';

/** One click, one insertion. Optional evidence must never block a reference. */
export async function insertDirectReference(text: string, key: string, evidence: ReferenceEvidence | undefined, options: {
  insert: (text: string, key: string) => void;
  upload: (file: File, signal: AbortSignal) => Promise<string | undefined>;
  isCurrent: () => boolean;
}) {
  if (!evidence?.snapshot) {
    if (options.isCurrent()) options.insert(text, key);
    return;
  }
  const capturedAt = new Date().toISOString();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let imagePath: string | undefined;
  try {
    imagePath = await Promise.race([
      (async () => {
        const blob = await evidence.snapshot;
        if (!blob || controller.signal.aborted || !options.isCurrent()) return undefined;
        return options.upload(new File([blob], `termdock-review-${crypto.randomUUID()}.png`, { type: 'image/png' }), controller.signal);
      })(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, 3000); }),
    ]);
  } catch {
    // Preserve the useful original location even if optional evidence fails.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  if (options.isCurrent()) options.insert(imagePath ? formatReviewReference(text, '', capturedAt, imagePath) : text, key);
}

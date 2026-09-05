import { create } from 'zustand';
import type { PendingReviewReference } from './ReviewReferenceDialog';

/** Ephemeral, page-only state: responsive sidebar remounts must not discard an
 * unfinished review. Never serialize screenshots, promises or comments. */
export const useReviewReferenceStore = create<{
  pending: PendingReviewReference | null;
  note: string;
  owner: string | null;
  open: (pending: PendingReviewReference, owner: string | null) => void;
  setNote: (note: string) => void;
  close: () => void;
}>((set) => ({
  pending: null, note: '', owner: null,
  open: (pending, owner) => set({ pending, note: '', owner }),
  setNote: (note) => set({ note }),
  close: () => set({ pending: null, note: '', owner: null }),
}));

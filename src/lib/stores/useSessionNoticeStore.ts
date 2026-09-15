import { create } from 'zustand';

/** Each service workspace owns its unread state, just like its control socket. */
export const useSessionNoticeStore = create<{
  unread: Record<string, string[]>;
  viewing: string | null;
  receive(sessionId: string, noticeId: string): void;
  view(sessionId: string | null): void;
}>(set => ({
  unread: {},
  viewing: null,
  receive: (sessionId, noticeId) => set(state => {
    const previous = state.unread[sessionId] ?? [];
    if (state.viewing === sessionId || previous.includes(noticeId)) return state;
    return { unread: { ...state.unread, [sessionId]: [...previous, noticeId] } };
  }),
  view: sessionId => set(state => {
    if (!sessionId || !state.unread[sessionId]) return state.viewing === sessionId ? state : { viewing: sessionId };
    const unread = { ...state.unread };
    delete unread[sessionId];
    return { viewing: sessionId, unread };
  }),
}));

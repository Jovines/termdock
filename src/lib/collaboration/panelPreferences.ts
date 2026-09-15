import { updateSettings, type CollaborationPanelState } from '../terminal/api';

let fallbackClientId: string | undefined;
export function collaborationPanelClientId(): string {
  try {
    const key = 'termdock-collaboration-panel-client';
    const saved = localStorage.getItem(key);
    if (saved) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return fallbackClientId ??= crypto.randomUUID();
  }
}

// Serialize writes so an older draft cannot finish after its replacement.
let writes: Promise<unknown> = Promise.resolve();
export function saveCollaborationPanel(state: CollaborationPanelState, groupId?: string | null): Promise<void> {
  if (groupId) state = { groups: { [groupId]: state } };
  const clientId = collaborationPanelClientId();
  const request = writes.catch(() => {}).then(() => updateSettings({ collaborationPanel: { clientId, state } }));
  writes = request;
  return request.then(() => {});
}

export function relativePanelPosition(x: number, y: number, left: number, top: number, width: number, height: number) {
  return { x: width > 0 ? Math.max(0, Math.min(1, (x - left) / width)) : 0.5,
    y: height > 0 ? Math.max(0, Math.min(1, (y - top) / height)) : 0.5 };
}

export function collaborationGroupPreferences(state: CollaborationPanelState | undefined, groupId: string | null): CollaborationPanelState {
  if (!groupId) return { drafts: state?.drafts };
  const group = { ...(state?.floatingGroupId === groupId ? state : {}), ...state?.groups?.[groupId] };
  return { ...group, drafts: state?.drafts };
}
export function openCollaborationGroups(state: CollaborationPanelState | undefined): string[] {
  const ids = Object.entries(state?.groups ?? {}).filter(([, group]) => group.floatingGroupId).map(([id]) => id);
  if (state?.floatingGroupId && !state.groups?.[state.floatingGroupId]) ids.push(state.floatingGroupId);
  return ids;
}

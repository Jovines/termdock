export const OPEN_SERVICE_ACCESS_EVENT = 'termdock:open-services';
export function openServiceAccess(): void { window.dispatchEvent(new Event(OPEN_SERVICE_ACCESS_EVENT)); }
export function openSessionShare(options: { inviteSessionId: string; viewMode?: 'terminal' | 'chat' }): void { window.dispatchEvent(new CustomEvent(OPEN_SERVICE_ACCESS_EVENT, { detail: options })); }

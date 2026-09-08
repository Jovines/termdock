export const OPEN_SERVICE_ACCESS_EVENT = 'termdock:open-services';
export function openServiceAccess(): void {
  window.dispatchEvent(new Event(OPEN_SERVICE_ACCESS_EVENT));
}

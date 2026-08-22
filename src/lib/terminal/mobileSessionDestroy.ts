export const MOBILE_SESSION_DESTROY_DROPPABLE_ID = 'mobile-session-destroy';

interface SessionDropResult {
  type: string;
  destination: { droppableId: string } | null;
}

export function isMobileSessionDestroyDrop(
  result: SessionDropResult,
  mobileEnabled: boolean,
): boolean {
  return mobileEnabled
    && result.type === 'session'
    && result.destination?.droppableId === MOBILE_SESSION_DESTROY_DROPPABLE_ID;
}

import { useEffect, useState } from 'react';
import { scheduleInteractionIdle } from '../utils/interactionIdle';

/** Keep warm neighbours alive through a swipe; rotate the window after settling. */
export function useSettledViewportWindow(desired: ReadonlySet<string>): ReadonlySet<string> {
  const [settled, setSettled] = useState(desired);
  useEffect(() => scheduleInteractionIdle(() => setSettled(desired), 0), [desired]);
  return settled;
}

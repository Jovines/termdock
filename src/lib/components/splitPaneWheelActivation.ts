import { flushSync } from 'react-dom';

export function activateSplitPaneForWheel(
  isActive: boolean,
  activate: () => void,
): void {
  if (isActive) return;
  flushSync(activate);
}

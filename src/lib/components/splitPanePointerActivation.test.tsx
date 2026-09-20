// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { activateSplitPaneForWheel } from './splitPaneWheelActivation';
afterEach(cleanup);
it('delivers the first pointer gesture with the active-session gate already updated', () => {
  const delivered: string[] = [];
  function Pane({ active }: { active: boolean }) {
    const activeRef = useRef(active); activeRef.current = active;
    return <button onPointerDown={() => { if (activeRef.current) delivered.push('down'); }}
      onPointerUp={() => { if (activeRef.current) delivered.push('up'); }}>Screen</button>;
  }
  function Split() {
    const [active, setActive] = useState(false);
    return <div onPointerDownCapture={() => activateSplitPaneForWheel(active, () => setActive(true))}><Pane active={active} /></div>;
  }
  render(<Split />);
  fireEvent.pointerDown(screen.getByText('Screen'));
  fireEvent.pointerUp(screen.getByText('Screen'));
  expect(delivered).toEqual(['down', 'up']);
});

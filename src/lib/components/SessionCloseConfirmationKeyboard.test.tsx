// @vitest-environment jsdom
import { createRef } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionCloseConfirmationKeyboard } from './SessionCloseConfirmationKeyboard';
afterEach(cleanup);
it('focuses the real confirm button and consumes Enter once without forwarding it to terminal input', () => {
  const ref = createRef<HTMLButtonElement>(), confirm = vi.fn(), cancel = vi.fn(), terminal = vi.fn();
  const view = render(<><SessionCloseConfirmationKeyboard sessionId="one" confirmButton={ref} onConfirm={confirm} onCancel={cancel}/><button ref={ref}>Close one</button></>);
  expect(document.activeElement).toBe(ref.current);
  window.addEventListener('keydown', terminal);
  try {
    fireEvent.keyDown(window, { key: 'Enter', repeat: true });expect(confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(ref.current!, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(confirm).toHaveBeenCalledTimes(1);expect(cancel).not.toHaveBeenCalled();expect(terminal).not.toHaveBeenCalled();
    view.unmount();fireEvent.keyDown(window, { key: 'Enter' });expect(terminal).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener('keydown', terminal); }
});
it('keeps IME and modified Enter from destroying a session and Escape cancels only the current chooser', () => {
  const ref=createRef<HTMLButtonElement>(), old=vi.fn(), current=vi.fn(), cancel=vi.fn();
  const chooser=(id:string,onConfirm:()=>void)=><><SessionCloseConfirmationKeyboard sessionId={id} confirmButton={ref} onConfirm={onConfirm} onCancel={cancel}/><button ref={ref}>Close {id}</button></>;
  const view=render(chooser('one',old));
  for(const fields of [{isComposing:true},{keyCode:229},{metaKey:true},{ctrlKey:true},{altKey:true},{shiftKey:true}])fireEvent.keyDown(window,{key:'Enter',...fields});
  expect(old).not.toHaveBeenCalled();
  view.rerender(chooser('three',current));
  fireEvent.keyDown(window,{key:'Escape'});fireEvent.keyDown(window,{key:'Enter'});
  expect(cancel).toHaveBeenCalledTimes(1);expect(old).not.toHaveBeenCalled();expect(current).not.toHaveBeenCalled();
  view.unmount();
  const next=render(chooser('three',current));act(()=>{fireEvent.keyDown(window,{key:'Enter'});});expect(current).toHaveBeenCalledTimes(1);next.unmount();
});
it('blocks the focused button default Enter click for modifiers and IME, then confirms exactly once', async () => {
  const {default:userEvent}=await import('@testing-library/user-event');
  const user=userEvent.setup(),ref=createRef<HTMLButtonElement>(),confirm=vi.fn(),cancel=vi.fn();
  render(<><SessionCloseConfirmationKeyboard sessionId="one" confirmButton={ref} onConfirm={confirm} onCancel={cancel}/><button ref={ref} onClick={confirm}>Destroy one</button><input aria-label="IME editable"/></>);
  await user.keyboard('{Shift>}{Enter}{/Shift}{Control>}{Enter}{/Control}{Alt>}{Enter}{/Alt}{Meta>}{Enter}{/Meta}');
  expect(confirm).not.toHaveBeenCalled();
  // Model the browser's keydown default activation only if it was not cancelled.
  for(const fields of [{isComposing:true},{keyCode:229}]){
    const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...fields});
    if(ref.current!.dispatchEvent(event))ref.current!.click();
    expect(event.defaultPrevented).toBe(true);
  }
  const editable=document.querySelector('input')!;editable.focus();
  const editing=new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true});editable.dispatchEvent(editing);expect(editing.defaultPrevented).toBe(false);
  ref.current!.focus();await user.keyboard('{Enter}');expect(confirm).toHaveBeenCalledTimes(1);expect(cancel).not.toHaveBeenCalled();
});
it('a stale binding cancels instead of destroying the replacement even before React removes the chooser',()=>{
  const ref=createRef<HTMLButtonElement>(),confirm=vi.fn(),cancel=vi.fn();let current=true;
  render(<><SessionCloseConfirmationKeyboard sessionId="one" confirmButton={ref} onConfirm={confirm} onCancel={cancel} isCurrent={()=>current}/><button ref={ref} onClick={confirm}>Destroy one</button></>);
  current=false;fireEvent.keyDown(ref.current!,{key:'Enter'});expect(cancel).toHaveBeenCalledTimes(1);expect(confirm).not.toHaveBeenCalled();
});

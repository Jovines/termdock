export interface TerminalLogicalFocusInput {
  isActive: boolean;
  viewportFocused: boolean;
  documentVisible: boolean;
  windowFocused: boolean;
  streamReady: boolean;
}

export function computeTerminalLogicalFocus(input: TerminalLogicalFocusInput): boolean {
  return input.isActive &&
    input.viewportFocused &&
    input.documentVisible &&
    input.windowFocused &&
    input.streamReady;
}

export function computeTerminalLogicalViewing(
  input: Pick<TerminalLogicalFocusInput, 'isActive' | 'documentVisible' | 'windowFocused' | 'streamReady'> & {
    isDesktop: boolean;
  },
): boolean {
  return input.isActive &&
    input.documentVisible &&
    input.streamReady &&
    (!input.isDesktop || input.windowFocused);
}

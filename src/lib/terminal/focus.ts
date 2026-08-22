export interface TerminalLogicalFocusInput {
  isActive: boolean;
  viewportFocused: boolean;
  documentVisible: boolean;
  windowFocused: boolean;
  streamReady: boolean;
}

export interface TerminalFocusRestoreInput {
  isActive: boolean;
  isMobile: boolean;
  documentVisible: boolean;
  activeElementIsEditable: boolean;
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

/**
 * On desktop the terminal is the default keyboard owner after pointer
 * interactions. Real editors/search fields keep focus so typing into other UI
 * remains possible.
 */
export function shouldRestoreTerminalFocusAfterInteraction(
  input: TerminalFocusRestoreInput,
): boolean {
  return input.isActive &&
    !input.isMobile &&
    input.documentVisible &&
    !input.activeElementIsEditable;
}

export function shouldAutoFocusTerminalAfterInsert(isMobile: boolean, focusRequested: boolean): boolean {
  return !isMobile && focusRequested;
}

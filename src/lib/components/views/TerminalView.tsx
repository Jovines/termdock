import React from 'react';
import { createPortal } from 'react-dom';
import { v4 as uuidv4 } from 'uuid';
import { useTerminalStore } from '../../stores/useTerminalStore';
import type { TerminalMode, TerminalStreamEvent, TmuxActionPayload, TmuxLayout } from '../../terminal';
import { TerminalViewport, type RefreshReason, type TerminalController } from '../terminal/TerminalViewport';
import { getTerminalTheme, type TermdockColorTheme } from '../../terminal';
import { createTermdockAPI } from '../../terminal/factory';
import { TerminalApiError, listDirectory, openSessionInventoryEntry, probeTerminalConnection, reconnectTerminalConnectionNow, sendTerminalFlowControlState, sendTerminalFocusState, sendTerminalViewingState, updateSessionInventoryEntry, uploadFiles } from '../../terminal/api';
import {
  computeTerminalLogicalFocus,
  computeTerminalLogicalViewing,
  shouldAutoFocusTerminalAfterInsert,
  shouldRestoreTerminalFocusAfterInteraction,
} from '../../terminal/focus';
import { getTermdockDesktopBridge } from '../../desktop/nativeBridge';
import { isTmuxMouseOrFocusInput, shouldConsumeAfterTmuxCopyModeExit } from '../../terminal/copyModeInput';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { MobileKeyboard, getSequenceForKey } from '../terminal/MobileKeyboard';
import { buildDesktopToolbarPresetOptions, buildToolbarPresetOptions, decodeToolbarSequence, detectToolbarPreset, getToolbarActionLabel, getToolbarPreset, normalizeActiveProgram, sanitizeToolbarPresets, splitToolbarSequenceSegments, TOOLBAR_SEGMENT_DELAY_MS, type ToolbarPresetDefinition, type ToolbarPresetMode } from '../terminal/mobileKeyboardPresets';
import { DebugPanel } from '../terminal/DebugPanel';
import { ConnectionStatus } from '../terminal/ConnectionStatus';
import { createDebugLogger } from '../../utils/debug';
import { clientLog } from '../../utils/clientLog';
import { getDefaultTerminalSettings, type TerminalSettings } from '../../terminal/settings';
import { useViewportKeyboardState } from '../../hooks/useViewportKeyboardState';
import { useI18n } from '../../i18n';
import {
  getVisibleReconnectWatchdogDelayMs,
  isInitialContentWriteSettled,
  shouldRestartMissingTerminalConnection,
} from '../../terminal/resumeScheduling';
import {
  getActivationRefreshMode,
  shouldForceSettledRedraw,
} from '../../terminal/refreshRedraw';
import {
  CONFIRMED_SESSION_MISSING_MESSAGE,
  isConfirmedSessionMissing,
  isTransientBackendSessionMiss,
} from '../../terminal/sessionRecovery';
import { buildReferenceInputText } from '../sidebar/referencePaths';
import { uploadTemporaryFileAndInsertReference } from '../sidebar/temporaryImageUpload';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { resolveTerminalPath, TERMINAL_DIRECTORY_OPEN_EVENT } from '../../terminal/pathLinks';

const MODIFIER_DOUBLE_TAP_WINDOW_MS = 320;
const MOBILE_KEYBOARD_EXPANDED_STORAGE_KEY = 'termdock:mobile-keyboard-expanded';
const MOBILE_KEYBOARD_PRESET_MODE_STORAGE_KEY = 'termdock:mobile-keyboard-preset-mode';
const MOBILE_LONG_PRESS_MODE_STORAGE_KEY = 'termdock:mobile-long-press-mode';
const CURSOR_POSITION_SETTLE_MS = 80;
const KEYBOARD_CURSOR_REDRAW_FALLBACK_MS = 3000;

type Modifier = 'ctrl' | 'alt';

function detectMobileTerminalLayout(): boolean {
  if (typeof window === 'undefined') return false;
  const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  return hasTouch && window.innerWidth < 768;
}

const STREAM_OPTIONS = {
  retry: {
    // maxRetries 只作为指数退避阶数上限；达到 maxDelay 后仍持续重连。
    // 回前台时 visibility probe 会跳过旧退避，立即换新连接。
    maxRetries: 60,
    initialDelayMs: 1000,
    maxDelayMs: 20000,
  },
  connectionTimeoutMs: 15_000,
};

interface TerminalViewProps {
  sessionId?: string;
  mode?: TerminalMode;
  tmuxSessionName?: string | null;
  terminalSettings?: TerminalSettings;
  colorTheme?: TermdockColorTheme;
  toolbarPresets?: ToolbarPresetDefinition[];
  isActive?: boolean;
  focusSuspended?: boolean;
  deferCursorUntilPositioned?: boolean;
  isLayoutVisible?: boolean;
  focusRequestToken?: number;
  resumeRequestToken?: number;
  resumeRequestReason?: Extract<RefreshReason, 'visibility' | 'bfcache' | 'online'>;
  resumeRequestDelayMs?: number;
  forceResumeReconnect?: boolean;
  initialConnectDelayMs?: number;
  initialConnectEnabled?: boolean;
  resumeRequestEnabled?: boolean;
  onStreamReadyChange?: (sessionId: string, ready: boolean) => void;
  onStreamConnected?: (sessionId: string) => void;
  onViewportReadyChange?: (sessionId: string, ready: boolean) => void;
  onContentReadyChange?: (sessionId: string, ready: boolean) => void;
  onKeyboardVisibilityChange?: (sessionId: string, isOpen: boolean) => void;
  suppressKeyboard?: boolean;
  keyboardPortalTarget?: HTMLElement | null;
  sharedMobileKeyboardLayout?: boolean;
  suppressPageFlipRefresh?: boolean;
  showDebug?: boolean;
  onStatusChange?: (status: { isConnecting: boolean; isRestarting: boolean; hasError: boolean; sessionId: string | null }) => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  sessionId: initialSessionId,
  mode: expectedMode,
  tmuxSessionName: expectedTmuxSessionName = null,
  terminalSettings = getDefaultTerminalSettings(),
  colorTheme = 'dark',
  toolbarPresets: configuredToolbarPresets = [],
  isActive = true,
  focusSuspended = false,
  deferCursorUntilPositioned = false,
  isLayoutVisible = true,
  focusRequestToken = 0,
  resumeRequestToken = 0,
  resumeRequestReason = 'visibility',
  resumeRequestDelayMs = 0,
  forceResumeReconnect = false,
  initialConnectDelayMs = 0,
  initialConnectEnabled = true,
  resumeRequestEnabled = true,
  onStreamReadyChange,
  onStreamConnected,
  onViewportReadyChange,
  onContentReadyChange,
  onKeyboardVisibilityChange,
  suppressKeyboard = false,
  keyboardPortalTarget = null,
  sharedMobileKeyboardLayout = false,
  suppressPageFlipRefresh = false,
  showDebug: externalShowDebug,
  onStatusChange,
}) => {
  const { t } = useI18n();
  // Use external fontSize from props, with local override support for pinch-to-zoom
  const [fontSize, setFontSize] = React.useState(terminalSettings.fontSize);
  const terminal = React.useMemo(() => createTermdockAPI(), []);
  const debugSession = React.useMemo(() => createDebugLogger('session'), []);
  const debugKeyboard = React.useMemo(() => createDebugLogger('keyboard'), []);
  const resumeRequestDelayRef = React.useRef(resumeRequestDelayMs);
  resumeRequestDelayRef.current = resumeRequestDelayMs;
  const resumeAttemptRef = React.useRef<{ startedAt: number; strategy: 'reconnect' | 'probe'; reason: string } | null>(null);

  // Sync with external fontSize changes while allowing local pinch-to-zoom overrides
  React.useEffect(() => {
    setFontSize(terminalSettings.fontSize);
  }, [terminalSettings.fontSize]);

  const effectiveTerminalSettings = React.useMemo(() => ({
    ...terminalSettings,
    fontSize,
  }), [terminalSettings, fontSize]);

  const [sessionId] = React.useState(initialSessionId || uuidv4());
  // Must be correct on the first render. A false desktop default briefly sends
  // autoFocus=true to TerminalViewport when split panes are reparented, which
  // opens the soft keyboard before the mobile-detection effect can run.
  const [isMobile, setIsMobile] = React.useState(detectMobileTerminalLayout);
  const [isIOS, setIsIOS] = React.useState(false);
  const [isInputFocused, setIsInputFocused] = React.useState(false);
  const [isViewportFocused, setIsViewportFocused] = React.useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = React.useState(() => typeof document === 'undefined' ? true : !document.hidden);
  const [isWindowFocused, setIsWindowFocused] = React.useState(() => typeof document === 'undefined' ? true : document.hasFocus());
  const [isStreamReady, setIsStreamReady] = React.useState(false);
  const [isInitialContentReady, setIsInitialContentReady] = React.useState(false);
  const [isInitialSizeReady, setIsInitialSizeReady] = React.useState(false);
  const [isCursorPresentationReady, setIsCursorPresentationReady] = React.useState(true);
  const [isKeyboardResizeSettling, setIsKeyboardResizeSettling] = React.useState(false);
  const [isKeyboardCursorReady, setIsKeyboardCursorReady] = React.useState(true);
  const {
    isOpen: isViewportKeyboardOpen,
    keyboardHeight: viewportKeyboardHeight,
  } = useViewportKeyboardState({
    enabled: isMobile && isActive,
  });
  const [activeModifier, setActiveModifier] = React.useState<Modifier | null>(null);
  const [lockedModifier, setLockedModifier] = React.useState<Modifier | null>(null);
  const [showExtendedKeyboard, setShowExtendedKeyboard] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }

    return window.localStorage.getItem(MOBILE_KEYBOARD_EXPANDED_STORAGE_KEY) === 'true';
  });
  const [toolbarPresetMode, setToolbarPresetMode] = React.useState<ToolbarPresetMode>(() => {
    if (typeof window === 'undefined') {
      return 'auto';
    }

    const stored = window.localStorage.getItem(MOBILE_KEYBOARD_PRESET_MODE_STORAGE_KEY);
    return stored && stored.length > 0 ? stored : 'auto';
  });
  const [mobileLongPressMode, setMobileLongPressMode] = React.useState<'arrows' | 'copy'>(() => {
    if (typeof window === 'undefined') {
      return 'arrows';
    }

    return window.localStorage.getItem(MOBILE_LONG_PRESS_MODE_STORAGE_KEY) === 'copy' ? 'copy' : 'arrows';
  });
  const [mobileCopyFeedback, setMobileCopyFeedback] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const [mobileFileUploadState, setMobileFileUploadState] = React.useState<'idle' | 'uploading' | 'inserted' | 'failed'>('idle');
  const [mobileFileUploadProgress, setMobileFileUploadProgress] = React.useState(0);

  const terminalState = useTerminalStore((state) => state.sessions.get(sessionId));
  const {
    setTerminalSession,
    setConnecting,
    appendToBuffer,
    replaceBuffer,
    clearTerminalSession,
    removeTerminalSession,
    clearBuffer,
    setSessionActiveProgram,
    setSessionCwd,
    setSessionCopyMode,
    setSessionAgentStatus,
    setSessionShellTitle,
    setSessionPromptState,
    clearAgentNeedsReview,
  } = useTerminalStore.getState();

  const fallbackTmuxSessionName = React.useMemo(() => `wt-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12)}`, [sessionId]);

  const terminalSessionRef = terminalState?.terminalSessionId ?? null;
  const sessionMode = terminalState?.mode ?? 'shell';
  const detectedActiveProgram = terminalState?.activeProgram ?? null;
  const toolbarPresets = React.useMemo(() => sanitizeToolbarPresets(configuredToolbarPresets), [configuredToolbarPresets]);
  const isTmuxMode = sessionMode === 'tmux';
  const bufferChunks = terminalState?.bufferChunks ?? [];
  const isConnecting = terminalState?.isConnecting ?? false;
  const terminalSessionId = terminalSessionRef;
  const handleDirectoryLinkActivate = React.useCallback(async (pathText: string) => {
    const path = resolveTerminalPath(pathText, terminalState?.cwd || terminalState?.directory);
    if (!path) return;
    let targetPath = path;
    let kind: 'directory' | 'file' = 'directory';
    try {
      // Resolve symlinks/relative syntax through the same guarded endpoint as
      // the explorer. A regular file reaches the explicit "not a directory"
      // branch after stat succeeds, so it is safe to hand to FilePreview.
      const directory = await listDirectory(path);
      targetPath = directory.path;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Path is not a directory') return;
      kind = 'file';
    }

    try {
      const sidebar = useSidebarStore.getState();
      sidebar.setRightTab('files');
      sidebar.openRight();
      window.dispatchEvent(new CustomEvent(TERMINAL_DIRECTORY_OPEN_EVENT, {
        detail: { path: targetPath, kind },
      }));
    } catch {
      // Terminal output can outlive a deleted/moved path. Keep that stale text
      // harmless and leave the user's current sidebar context untouched.
    }
  }, [terminalState?.cwd, terminalState?.directory]);
  const desiredSessionMode: TerminalMode = expectedMode ?? terminalState?.mode ?? 'shell';
  const desiredTmuxSessionName = desiredSessionMode === 'tmux'
    ? (expectedTmuxSessionName ?? terminalState?.tmuxSessionName ?? null)
    : null;

  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  // isConnectionTransition 的 ref 镜像：事件监听回调（插入引用 ack 等）需要
  // 读到最新连接态，不能依赖闭包里的过期值
  const isConnectionTransitionRef = React.useRef(false);
  const [isFatalError, setIsFatalError] = React.useState(false);
  const [isRestarting, setIsRestarting] = React.useState(false);
  const [reconnectStartedAt, setReconnectStartedAt] = React.useState<number | null>(null);
  // 触发器：当后端 session 丢失（服务端重启 / idle 清理）后，bump 这个值
  // 让 ensureSession 的 useEffect 重新跑。只改 ref 没用，React 不会因此 re-run effect。
  const [restartTrigger, setRestartTrigger] = React.useState(0);
  const [_tmuxLayout, setTmuxLayout] = React.useState<TmuxLayout | null>(null);
  const showDebug = externalShowDebug !== undefined ? externalShowDebug : false;

  // 流清理和活动终端引用
  const streamCleanupRef = React.useRef<(() => void) | null>(null);
  const activeTerminalIdRef = React.useRef<string | null>(null);
  const terminalIdRef = React.useRef<string | null>(null);
  const sessionIdRef = React.useRef<string | null>(null);
  const terminalControllerRef = React.useRef<TerminalController | null>(null);
  const flowPausedRef = React.useRef(false);
  const lastSentFlowPausedRef = React.useRef<boolean | null>(null);
  const flowPausedBufferRef = React.useRef<string[]>([]);
  const suppressInputUntilRef = React.useRef(0);
  const shouldExitTmuxCopyModeOnInputRef = React.useRef(false);
  const tmuxScrollPendingRef = React.useRef<{ direction: 'up' | 'down'; lines: number } | null>(null);
  const tmuxScrollFlushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTmuxScreenSyncGenerationRef = React.useRef(-1);
  const modifierTapRef = React.useRef<{ modifier: Modifier; timestamp: number } | null>(null);
  const lastFocusRequestTokenRef = React.useRef(0);
  const lastSentLogicalFocusRef = React.useRef<boolean | null>(null);
  const lastSentViewingRef = React.useRef<boolean | null>(null);
  const streamVersionRef = React.useRef(0);
  const awaitingInitialWritesRef = React.useRef(false);
  const initialContentTargetChunkIdRef = React.useRef<number | null>(null);
  const pendingTmuxScreenSyncGenerationRef = React.useRef<number | null>(null);
  const initialConnectionPendingRef = React.useRef(false);
  const contentReadyGenerationRef = React.useRef(0);
  const cursorPositionGateRef = React.useRef(false);
  const cursorPositionRequestRef = React.useRef(false);
  const ptyRedrawRequestedRef = React.useRef(false);
  const lastCursorPositionRef = React.useRef<{ x: number; y: number; rows: number } | null>(null);
  const cursorPositionCandidateTimerRef = React.useRef<number | null>(null);
  const cursorPositionFallbackTimerRef = React.useRef<number | null>(null);
  const lastSettledChunkIdRef = React.useRef<number | null>(null);
  const keyboardCursorAwaitingPtyRef = React.useRef(false);
  const keyboardCursorAuthoritativeWriteReadyRef = React.useRef(false);
  const keyboardCursorBaselineChunkIdRef = React.useRef<number | null>(null);
  const keyboardCursorGenerationRef = React.useRef(0);
  const lastKeyboardCursorPositionRef = React.useRef<{ x: number; y: number; rows: number } | null>(null);
  const keyboardCursorCandidateTimerRef = React.useRef<number | null>(null);
  const keyboardCursorFallbackTimerRef = React.useRef<number | null>(null);
  const isActiveRef = React.useRef(isActive);
  // Interaction capture in MultiTerminalView can synchronously promote a split
  // pane while the original wheel event is still propagating into xterm. Keep
  // this gate current during render so that same event is accepted immediately.
  isActiveRef.current = isActive;
  const focusSuspendedRef = React.useRef(focusSuspended);
  focusSuspendedRef.current = focusSuspended;
  const isMobileRef = React.useRef(isMobile);
  const desktopResumeFocusTimerRef = React.useRef<number | null>(null);
  const desktopInteractionFocusTimerRef = React.useRef<number | null>(null);
  const pendingShellTitleRef = React.useRef<{ sessionId: string; title: string | null } | null>(null);
  const shellTitleRafRef = React.useRef<number | null>(null);
  const mobileCopyFeedbackTimerRef = React.useRef<number | null>(null);
  const mobileFileFeedbackTimerRef = React.useRef<number | null>(null);
  const mobileFileInputRef = React.useRef<HTMLInputElement | null>(null);

  const markInitialContentReadyAfterPaint = React.useCallback(() => {
    const generation = ++contentReadyGenerationRef.current;
    const settle = () => {
      if (generation !== contentReadyGenerationRef.current) return;
      setIsInitialContentReady(true);
    };
    if (typeof window === 'undefined') {
      settle();
      return;
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(settle));
  }, []);

  const handleViewportWritesSettled = React.useCallback((position: {
    x: number;
    y: number;
    rows: number;
    lastProcessedChunkId: number | null;
  }) => {
    lastSettledChunkIdRef.current = position.lastProcessedChunkId;
    if (
      keyboardCursorAwaitingPtyRef.current
      && keyboardCursorAuthoritativeWriteReadyRef.current
      && position.lastProcessedChunkId !== keyboardCursorBaselineChunkIdRef.current
    ) {
      if (keyboardCursorCandidateTimerRef.current !== null) {
        window.clearTimeout(keyboardCursorCandidateTimerRef.current);
        keyboardCursorCandidateTimerRef.current = null;
      }
      if (position.x !== 0 || position.y < position.rows - 1) {
        const generation = keyboardCursorGenerationRef.current;
        keyboardCursorCandidateTimerRef.current = window.setTimeout(() => {
          keyboardCursorCandidateTimerRef.current = null;
          if (generation !== keyboardCursorGenerationRef.current) return;
          keyboardCursorAwaitingPtyRef.current = false;
          keyboardCursorAuthoritativeWriteReadyRef.current = false;
          if (keyboardCursorFallbackTimerRef.current !== null) {
            window.clearTimeout(keyboardCursorFallbackTimerRef.current);
            keyboardCursorFallbackTimerRef.current = null;
          }
          setIsKeyboardCursorReady(true);
        }, CURSOR_POSITION_SETTLE_MS);
      }
    }
    if (!cursorPositionGateRef.current) return;
    if (cursorPositionCandidateTimerRef.current !== null) {
      window.clearTimeout(cursorPositionCandidateTimerRef.current);
      cursorPositionCandidateTimerRef.current = null;
    }
    if (position.x === 0 && position.y >= position.rows - 1) {
      setIsCursorPresentationReady(false);
      return;
    }
    cursorPositionCandidateTimerRef.current = window.setTimeout(() => {
      cursorPositionCandidateTimerRef.current = null;
      setIsCursorPresentationReady(true);
    }, CURSOR_POSITION_SETTLE_MS);
  }, []);

  const handleViewportWriteProgress = React.useCallback((writtenChunkId: number) => {
    if (!awaitingInitialWritesRef.current) return;
    if (!isInitialContentWriteSettled({
      writtenChunkId,
      initialTargetChunkId: initialContentTargetChunkIdRef.current,
    })) return;
    const synchronizedGeneration = pendingTmuxScreenSyncGenerationRef.current;
    pendingTmuxScreenSyncGenerationRef.current = null;
    if (synchronizedGeneration !== null) {
      // replaceBuffer only queues the authoritative tmux snapshot. Report it
      // as synchronized after xterm has actually consumed the target chunk,
      // otherwise the keyboard resize shield can expose an intermediate grid.
      terminalControllerRef.current?.notifyScreenSynchronized(synchronizedGeneration);
      keyboardCursorAuthoritativeWriteReadyRef.current = true;
    }
    awaitingInitialWritesRef.current = false;
    initialContentTargetChunkIdRef.current = null;
    markInitialContentReadyAfterPaint();
  }, [markInitialContentReadyAfterPaint]);

  const handleViewportCursorPositionChange = React.useCallback((position: { x: number; y: number; rows: number }) => {
    if (keyboardCursorAwaitingPtyRef.current) {
      const previousKeyboardPosition = lastKeyboardCursorPositionRef.current;
      if (
        !previousKeyboardPosition
        || previousKeyboardPosition.x !== position.x
        || previousKeyboardPosition.y !== position.y
        || previousKeyboardPosition.rows !== position.rows
      ) {
        lastKeyboardCursorPositionRef.current = position;
        if (keyboardCursorCandidateTimerRef.current !== null) {
          window.clearTimeout(keyboardCursorCandidateTimerRef.current);
          keyboardCursorCandidateTimerRef.current = null;
        }
      }
    }
    if (!cursorPositionGateRef.current) return;
    const previous = lastCursorPositionRef.current;
    if (
      previous
      && previous.x === position.x
      && previous.y === position.y
      && previous.rows === position.rows
    ) return;
    lastCursorPositionRef.current = position;
    if (cursorPositionCandidateTimerRef.current !== null) {
      window.clearTimeout(cursorPositionCandidateTimerRef.current);
      cursorPositionCandidateTimerRef.current = null;
    }
    if (position.x === 0 && position.y >= position.rows - 1) {
      setIsCursorPresentationReady(false);
    }
  }, []);

  const handleKeyboardResizeSettlingChange = React.useCallback((settling: boolean) => {
    setIsKeyboardResizeSettling(settling);
    if (desiredSessionMode !== 'tmux') {
      setIsKeyboardCursorReady(true);
      return;
    }

    if (settling) {
      keyboardCursorGenerationRef.current += 1;
      keyboardCursorAwaitingPtyRef.current = true;
      keyboardCursorAuthoritativeWriteReadyRef.current = false;
      keyboardCursorBaselineChunkIdRef.current = lastSettledChunkIdRef.current;
      lastKeyboardCursorPositionRef.current = null;
      if (keyboardCursorCandidateTimerRef.current !== null) {
        window.clearTimeout(keyboardCursorCandidateTimerRef.current);
        keyboardCursorCandidateTimerRef.current = null;
      }
      if (keyboardCursorFallbackTimerRef.current !== null) {
        window.clearTimeout(keyboardCursorFallbackTimerRef.current);
        keyboardCursorFallbackTimerRef.current = null;
      }
      setIsKeyboardCursorReady(false);
      return;
    }

    if (!keyboardCursorAwaitingPtyRef.current) return;
    // The resize screen-sync is already an authoritative tmux frame and now
    // reports completion only after xterm consumes it. Preserve that cursor
    // candidate instead of forcing a second same-size resize/snapshot cycle.
    // If it has not arrived, keep the post-fit baseline so a later sync can
    // still prove that the cursor belongs to the final row count.
    if (!keyboardCursorAuthoritativeWriteReadyRef.current) {
      keyboardCursorGenerationRef.current += 1;
      keyboardCursorBaselineChunkIdRef.current = lastSettledChunkIdRef.current;
      lastKeyboardCursorPositionRef.current = null;
      if (keyboardCursorCandidateTimerRef.current !== null) {
        window.clearTimeout(keyboardCursorCandidateTimerRef.current);
        keyboardCursorCandidateTimerRef.current = null;
      }
    }
    const generation = keyboardCursorGenerationRef.current;
    setIsKeyboardCursorReady(false);
    keyboardCursorFallbackTimerRef.current = window.setTimeout(() => {
      keyboardCursorFallbackTimerRef.current = null;
      if (generation !== keyboardCursorGenerationRef.current) return;
      keyboardCursorAwaitingPtyRef.current = false;
      keyboardCursorAuthoritativeWriteReadyRef.current = false;
      setIsKeyboardCursorReady(true);
    }, KEYBOARD_CURSOR_REDRAW_FALLBACK_MS);
  }, [desiredSessionMode]);

  React.useEffect(() => {
    if (!deferCursorUntilPositioned) {
      cursorPositionRequestRef.current = false;
      return;
    }
    if (cursorPositionRequestRef.current) return;
    cursorPositionRequestRef.current = true;
    ptyRedrawRequestedRef.current = false;
    cursorPositionGateRef.current = true;
    lastCursorPositionRef.current = null;
    setIsCursorPresentationReady(false);
    if (cursorPositionCandidateTimerRef.current !== null) {
      window.clearTimeout(cursorPositionCandidateTimerRef.current);
      cursorPositionCandidateTimerRef.current = null;
    }
    if (cursorPositionFallbackTimerRef.current !== null) {
      window.clearTimeout(cursorPositionFallbackTimerRef.current);
    }
    cursorPositionFallbackTimerRef.current = window.setTimeout(() => {
      cursorPositionFallbackTimerRef.current = null;
      if (cursorPositionCandidateTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(cursorPositionCandidateTimerRef.current);
      }
      cursorPositionCandidateTimerRef.current = null;
      cursorPositionGateRef.current = false;
      setIsCursorPresentationReady(true);
    }, 15000);
  }, [deferCursorUntilPositioned]);

  const flushPendingShellTitle = React.useCallback(() => {
    shellTitleRafRef.current = null;
    const pending = pendingShellTitleRef.current;
    pendingShellTitleRef.current = null;
    if (!pending) return;
    setSessionShellTitle(pending.sessionId, pending.title);
  }, [setSessionShellTitle]);

  const scheduleShellTitleUpdate = React.useCallback((targetSessionId: string, title: string | null) => {
    pendingShellTitleRef.current = { sessionId: targetSessionId, title };
    if (shellTitleRafRef.current !== null) return;
    if (typeof window === 'undefined') {
      flushPendingShellTitle();
      return;
    }
    shellTitleRafRef.current = window.requestAnimationFrame(flushPendingShellTitle);
  }, [flushPendingShellTitle]);

  const cancelPendingShellTitle = React.useCallback(() => {
    if (shellTitleRafRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(shellTitleRafRef.current);
    }
    shellTitleRafRef.current = null;
    pendingShellTitleRef.current = null;
  }, []);

  const openManagedBackendSession = React.useCallback(async () => {
    const modeForNewSession = desiredSessionMode;
    const tmuxSessionNameForNewSession = desiredTmuxSessionName || fallbackTmuxSessionName;
    const result = await openSessionInventoryEntry({
      preferredFrontendSessionId: sessionId,
      mode: modeForNewSession,
      tmuxSessionName: modeForNewSession === 'tmux' ? tmuxSessionNameForNewSession : undefined,
      termType: 'xterm-256color',
      requireExisting: true,
    });
    return result.terminalSession;
  }, [desiredSessionMode, desiredTmuxSessionName, fallbackTmuxSessionName, sessionId]);

  // Swiper 翻到本页（isActive 从 false→true）：让编排器走一遍刷新。
  //
  // 注意只在 isActive 由 false→true 时才跑。terminalSessionId 变化、初次 mount
  // 不应该触发——那些场景由 'connected' / 'session-key-change' / 'mount' 自己
  // 的 refresh 负责，page-flip 多来一次会让用户看到 connected 之后再"闪一下"。
  const wasActiveRef = React.useRef(false);
  React.useEffect(() => {
    if (!isActive) {
      terminalControllerRef.current?.blur();
      wasActiveRef.current = false;
      return;
    }
    if (wasActiveRef.current) {
      // 已经处于 active，依赖里其它值变化（terminalSessionId）触发的 effect，
      // 不是真正的翻页，直接跳过。
      return;
    }
    wasActiveRef.current = true;
    const activationRefreshMode = getActivationRefreshMode(isMobile, suppressPageFlipRefresh);
    // A visible split pane is stationary. Coalesce its activation repaint with
    // the focus event under the same reason instead of running the full Swiper
    // settle sequence. This also repairs a stale renderer when focus transfer
    // is intentionally unavailable (for example while another control owns it).
    if (activationRefreshMode === 'single') {
      terminalControllerRef.current?.requestRefresh('focus', {
        skipResizePush: true,
        skipScrollToBottom: true,
      });
      return;
    }
    // Mobile activation separately schedules a forced resize refresh below.
    if (activationRefreshMode === 'none') {
      return;
    }
    const pageFlipStartDimensions = terminalControllerRef.current?.getDimensions() ?? null;
    // 双 rAF 先等 swiper transform 收尾并校准尺寸。这里不完整重画、也不滚底；
    // 真正的稳定化刷新统一留给 transition 结束后的那一轮，避免可见的双重扫屏。
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        terminalControllerRef.current?.requestRefresh('page-flip', {
          reconcileServerSize: true,
          skipScrollToBottom: true,
        });
      });
    });
    const postTransitionTimer = window.setTimeout(() => {
      const controller = terminalControllerRef.current;
      const settledDimensions = controller?.getDimensions() ?? null;
      controller?.requestRefresh('page-flip', {
        // terminal.resize() already repaints when the swiper settle changed
        // rows/cols. Only force a full-buffer redraw when fit stayed unchanged.
        forceRedraw: shouldForceSettledRedraw(pageFlipStartDimensions, settledDimensions),
        reconcileServerSize: true,
      });
    }, 360);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(postTransitionTimer);
    };
  }, [isActive, isMobile, suppressPageFlipRefresh, terminalSessionId]);

  React.useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);

  const focusTerminalIfActive = React.useCallback(() => {
    if (!isActiveRef.current || focusSuspendedRef.current) {
      return;
    }
    terminalControllerRef.current?.focus();
  }, []);

  React.useLayoutEffect(() => {
    if (!focusSuspended) return;
    terminalControllerRef.current?.blur();
  }, [focusSuspended]);

  React.useEffect(() => {
    if (
      !isActive
      || focusSuspended
      || isCursorPresentationReady
      || ptyRedrawRequestedRef.current
    ) return;
    ptyRedrawRequestedRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      terminalControllerRef.current?.requestPtyRedraw();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusSuspended, isActive, isCursorPresentationReady]);

  const scheduleDesktopResumeFocus = React.useCallback((reason: string) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    if (!isActiveRef.current || focusSuspendedRef.current || isMobileRef.current || document.hidden) {
      return;
    }

    if (desktopResumeFocusTimerRef.current !== null) {
      window.clearTimeout(desktopResumeFocusTimerRef.current);
    }

    desktopResumeFocusTimerRef.current = window.setTimeout(() => {
      desktopResumeFocusTimerRef.current = null;
      if (!isActiveRef.current || focusSuspendedRef.current || isMobileRef.current || document.hidden) {
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const isTerminalInput = activeElement?.getAttribute('data-terminal-input-anchor') === 'true';
      const isEditableElement =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement instanceof HTMLSelectElement ||
        activeElement?.isContentEditable === true;

      if (isEditableElement && !isTerminalInput) {
        debugKeyboard('desktop resume focus skipped: editable active', { reason });
        return;
      }

      debugKeyboard('desktop resume focus', { reason });
      // Electron/macOS can keep document.activeElement on the terminal input
      // while the native window is occluded. Calling focus() again then emits
      // no DOM focus event, so the old code never asked xterm's DOM renderer to
      // repaint its stale backing surface. Refresh explicitly before restoring
      // keyboard focus; this remains scoped to the active terminal.
      terminalControllerRef.current?.requestRefresh('focus', {
        force: true,
        forceRedraw: true,
        skipResizePush: true,
        skipScrollToBottom: true,
      });
      terminalControllerRef.current?.focus();
    }, 50);
  }, [debugKeyboard]);

  React.useEffect(() => {
    return () => {
      if (desktopResumeFocusTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(desktopResumeFocusTimerRef.current);
      }
      desktopResumeFocusTimerRef.current = null;
      if (desktopInteractionFocusTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(desktopInteractionFocusTimerRef.current);
      }
      desktopInteractionFocusTimerRef.current = null;
      if (mobileCopyFeedbackTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(mobileCopyFeedbackTimerRef.current);
      }
      mobileCopyFeedbackTimerRef.current = null;
      if (mobileFileFeedbackTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(mobileFileFeedbackTimerRef.current);
      }
      mobileFileFeedbackTimerRef.current = null;
      if (cursorPositionFallbackTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(cursorPositionFallbackTimerRef.current);
      }
      cursorPositionFallbackTimerRef.current = null;
      if (cursorPositionCandidateTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(cursorPositionCandidateTimerRef.current);
      }
      cursorPositionCandidateTimerRef.current = null;
      if (keyboardCursorCandidateTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(keyboardCursorCandidateTimerRef.current);
      }
      keyboardCursorCandidateTimerRef.current = null;
      if (keyboardCursorFallbackTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(keyboardCursorFallbackTimerRef.current);
      }
      keyboardCursorFallbackTimerRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }

    const handleDesktopPointerUp = () => {
      if (desktopInteractionFocusTimerRef.current !== null) {
        window.clearTimeout(desktopInteractionFocusTimerRef.current);
      }
      // Wait until the click handler has opened/focused any real editor. Other
      // interactions normally leave focus on body or a button, in which case
      // the active terminal retakes keyboard ownership.
      desktopInteractionFocusTimerRef.current = window.setTimeout(() => {
        desktopInteractionFocusTimerRef.current = null;
        const activeElement = document.activeElement as HTMLElement | null;
        const isTerminalInput = activeElement?.getAttribute('data-terminal-input-anchor') === 'true';
        const activeElementIsEditable = !isTerminalInput && Boolean(activeElement && (
          activeElement instanceof HTMLInputElement ||
          activeElement instanceof HTMLTextAreaElement ||
          activeElement instanceof HTMLSelectElement ||
          activeElement.isContentEditable
        ));

        if (!shouldRestoreTerminalFocusAfterInteraction({
          isActive: isActiveRef.current && !focusSuspendedRef.current,
          isMobile: isMobileRef.current,
          documentVisible: !document.hidden,
          activeElementIsEditable,
        })) {
          return;
        }
        focusTerminalIfActive();
      }, 0);
    };

    document.addEventListener('pointerup', handleDesktopPointerUp);
    return () => {
      document.removeEventListener('pointerup', handleDesktopPointerUp);
      if (desktopInteractionFocusTimerRef.current !== null) {
        window.clearTimeout(desktopInteractionFocusTimerRef.current);
        desktopInteractionFocusTimerRef.current = null;
      }
    };
  }, [focusTerminalIfActive]);

  const restartEnsureSession = React.useCallback(() => {
    hasInitializedRef.current = false;
    setRestartTrigger((token) => token + 1);
  }, []);

  const probeOrRestartSession = React.useCallback((reason: string, forceReconnect: boolean) => {
    const tid = terminalIdRef.current;
    const startedAt = Date.now();
    if (tid && forceReconnect && reconnectTerminalConnectionNow(tid)) {
      resumeAttemptRef.current = { startedAt, strategy: 'reconnect', reason };
      clientLog('info', 'PWA_RESUME terminal-start', {
        frontendSessionId: sessionId,
        backendSessionId: tid,
        strategy: 'reconnect',
        reason,
        active: isActiveRef.current,
      });
      return;
    }
    if (tid && probeTerminalConnection(tid, () => {
      // A still-open socket answers with pong instead of emitting a fresh
      // `connected` event. Treat that health confirmation as foreground
      // completion so the orchestrator can release the background wave.
      const attempt = resumeAttemptRef.current;
      clientLog('info', 'PWA_RESUME terminal-responsive', {
        frontendSessionId: sessionId,
        backendSessionId: tid,
        durationMs: attempt ? Date.now() - attempt.startedAt : null,
        strategy: attempt?.strategy ?? 'probe',
        reason: attempt?.reason ?? reason,
      });
      resumeAttemptRef.current = null;
      onStreamConnected?.(sessionId);
    })) {
      resumeAttemptRef.current = { startedAt, strategy: 'probe', reason };
      clientLog('info', 'PWA_RESUME terminal-start', {
        frontendSessionId: sessionId,
        backendSessionId: tid,
        strategy: 'probe',
        reason,
        active: isActiveRef.current,
      });
      debugSession('[Terminal] resume probe sent', { reason, backendSessionId: tid, active: isActiveRef.current });
      return;
    }
    debugSession('[Terminal] resume probe missing connection, restarting ensureSession', {
      reason,
      backendSessionId: tid,
      active: isActiveRef.current,
    });
    if (!shouldRestartMissingTerminalConnection({
      initialConnectionPending: initialConnectionPendingRef.current,
    })) {
      debugSession('[Terminal] resume probe deferred during initial websocket handshake', {
        reason,
        backendSessionId: tid,
      });
      return;
    }
    restartEnsureSession();
  }, [debugSession, onStreamConnected, restartEnsureSession, sessionId]);

  const reportFlowControl = React.useCallback((paused: boolean, reason: string) => {
    const backendSessionId = terminalIdRef.current;
    if (!backendSessionId) return;
    if (lastSentFlowPausedRef.current === paused) return;
    lastSentFlowPausedRef.current = paused;
    sendTerminalFlowControlState(backendSessionId, paused, reason);
    debugSession('[Terminal] flow-control state sent', { backendSessionId, paused, reason });
  }, [debugSession]);

  const reportLogicalFocus = React.useCallback((focused: boolean, reason: string) => {
    const backendSessionId = terminalIdRef.current;
    if (!backendSessionId) return;
    if (lastSentLogicalFocusRef.current === focused) return;
    lastSentLogicalFocusRef.current = focused;
    sendTerminalFocusState(backendSessionId, focused, reason);
    debugSession('[Terminal] focus state sent', { backendSessionId, focused, reason });
  }, [debugSession]);

  const reportViewing = React.useCallback((viewing: boolean, reason: string) => {
    const backendSessionId = terminalIdRef.current;
    if (!backendSessionId) return;
    if (lastSentViewingRef.current === viewing) return;
    lastSentViewingRef.current = viewing;
    sendTerminalViewingState(backendSessionId, viewing, reason);
    debugSession('[Terminal] viewing state sent', { backendSessionId, viewing, reason });
  }, [debugSession]);

  const logicalFocus = computeTerminalLogicalFocus({
    isActive: isActive && !focusSuspended,
    viewportFocused: isViewportFocused,
    documentVisible: isDocumentVisible,
    windowFocused: isWindowFocused,
    streamReady: isStreamReady,
  });

  // 推送抑制的“正在看这个 session”：移动浏览器不要求 textarea/window focus，
  // 因为 iOS installed PWA 在用户交互前 hasFocus 经常是 false。Electron 则会
  // 为持续排空终端输出而关闭 workspace 的 backgroundThrottling；这会削弱 Page
  // Visibility 的后台信号，所以桌面版额外以原生窗口 focus 作为 viewing gate。
  const logicalViewing = computeTerminalLogicalViewing({
    isActive,
    documentVisible: isDocumentVisible,
    windowFocused: isWindowFocused,
    streamReady: isStreamReady,
    isDesktop: getTermdockDesktopBridge() !== null,
  });

  // Latest logical focus, kept in a ref so the WS 'connected' handler can
  // re-assert it after reconnects without a stale closure.
  const logicalFocusRef = React.useRef(logicalFocus);
  const logicalViewingRef = React.useRef(logicalViewing);

  React.useEffect(() => {
    logicalFocusRef.current = logicalFocus;
    reportLogicalFocus(logicalFocus, 'logical-focus-change');
  }, [logicalFocus, reportLogicalFocus, terminalSessionId]);

  React.useEffect(() => {
    logicalViewingRef.current = logicalViewing;
    reportViewing(logicalViewing, 'logical-viewing-change');
  }, [logicalViewing, reportViewing, terminalSessionId]);

  // Listen for font size changes from TerminalViewport (pinch-to-zoom)
  React.useEffect(() => {
    const handleFontChange = (event: Event) => {
      const customEvent = event as CustomEvent<number>;
      const newSize = customEvent.detail;
      if (typeof newSize === 'number' && newSize >= 8 && newSize <= 32) {
        setFontSize(newSize);
      }
    };

    document.addEventListener('termfontchange', handleFontChange);
    return () => document.removeEventListener('termfontchange', handleFontChange);
  }, []);

  // 页面可见性 / 窗口焦点只维护本组件的 focus 状态。真正的恢复刷新和 WS
  // 探测统一由下面的 resumeRequestToken 广播处理，所有 session 走同一条路径。
  React.useEffect(() => {
    const handleVisibility = () => {
      const visible = !document.hidden;
      setIsDocumentVisible(visible);
      if (visible && isActive) {
        scheduleDesktopResumeFocus('visibility');
      }
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (!isActive) return;
      scheduleDesktopResumeFocus(event.persisted ? 'bfcache' : 'pageshow');
    };
    const handleWindowFocus = () => {
      setIsWindowFocused(true);
      scheduleDesktopResumeFocus('window-focus');
    };
    const handleWindowBlur = () => setIsWindowFocused(false);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [isActive, scheduleDesktopResumeFocus]);

  // MultiTerminalView 在 visibility/pageshow/online 时给所有 TerminalView 广播。
  // 可见 slide 立即恢复；后台 session 带错峰 delay。timer 在 token 更新、组件
  // 卸载时会清掉，避免旧一轮恢复请求晚到后干扰新状态。
  React.useEffect(() => {
    if (!resumeRequestToken) return;
    if (!resumeRequestEnabled) return;
    // A cold background session is already queued by the initial-connection
    // scheduler. Do not start a second resume/restart path for the same tab.
    if (!hasStartedInitialConnectRef.current) return;
    const delayMs = resumeRequestDelayRef.current;
    const resume = () => {
      terminalControllerRef.current?.requestRefresh(resumeRequestReason);
      probeOrRestartSession(
        delayMs > 0 ? 'global-resume-background' : 'global-resume-visible',
        delayMs <= 0 && forceResumeReconnect,
      );
    };
    if (delayMs <= 0) {
      resume();
      return;
    }
    const timer = window.setTimeout(resume, delayMs);
    return () => window.clearTimeout(timer);
  }, [resumeRequestToken, resumeRequestReason, resumeRequestEnabled, forceResumeReconnect, probeOrRestartSession]);

  // ensureSession 自愈：HTTP 建连失败等发生在 WebSocket 之前的错误也必须持续恢复。
  // 普通网络错误始终显示 Reconnecting，并按封顶退避重跑；只有明确的鉴权失败
  // 停止自动恢复，等待登录流程处理。
  const fatalSelfHealAttemptRef = React.useRef(0);
  React.useEffect(() => {
    // 已连上（流就绪）：清零计数，结束自愈。
    if (isStreamReady) {
      fatalSelfHealAttemptRef.current = 0;
      return;
    }
    // 非 fatal 的 WebSocket 重连由底层持续处理。
    if (!isFatalError) return;
    if (connectionError === 'Authentication required') return;
    if (connectionError === CONFIRMED_SESSION_MISSING_MESSAGE) return;

    const attempt = fatalSelfHealAttemptRef.current;
    // 退避：2s, 4s, 8s … 上限 30s。给后端/网络恢复留时间，又不至于太久无响应。
    const delay = Math.min(2000 * Math.pow(2, Math.min(attempt, 4)), 30000);
    const timer = setTimeout(() => {
      fatalSelfHealAttemptRef.current += 1;
      debugSession('[Terminal] fatal self-heal: auto restarting ensureSession', {
        attempt: fatalSelfHealAttemptRef.current,
        backendSessionId: terminalIdRef.current,
      });
      setConnectionError('Reconnecting...');
      setIsFatalError(false);
      restartEnsureSession();
    }, delay);

    return () => clearTimeout(timer);
  }, [connectionError, isFatalError, isStreamReady, restartTrigger, debugSession, restartEnsureSession]);

  // iOS detection
  React.useEffect(() => {
    if (typeof window === 'undefined') {
      setIsIOS(false);
      return;
    }
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    setIsIOS(ios);
  }, []);

  React.useEffect(() => {
    if (!isActive || !isMobile) {
      setIsInputFocused(false);
    }
    if (!isActive) {
      setIsViewportFocused(false);
    }
  }, [isActive, isMobile]);

  React.useEffect(() => {
    terminalIdRef.current = terminalSessionId;
    lastTmuxScreenSyncGenerationRef.current = -1;
    pendingTmuxScreenSyncGenerationRef.current = null;
    lastSentLogicalFocusRef.current = null;
    lastSentViewingRef.current = null;
    lastSentFlowPausedRef.current = null;
  }, [terminalSessionId]);

  React.useEffect(() => {
    onStreamReadyChange?.(sessionId, isStreamReady);
  }, [isStreamReady, onStreamReadyChange, sessionId]);

  React.useEffect(() => {
    onContentReadyChange?.(
      sessionId,
      isStreamReady && isInitialContentReady && isInitialSizeReady,
    );
  }, [isInitialContentReady, isInitialSizeReady, isStreamReady, onContentReadyChange, sessionId]);

  React.useEffect(() => {
    if (!isTmuxMode) {
      shouldExitTmuxCopyModeOnInputRef.current = false;
      tmuxScrollPendingRef.current = null;
      if (tmuxScrollFlushTimerRef.current) {
        clearTimeout(tmuxScrollFlushTimerRef.current);
        tmuxScrollFlushTimerRef.current = null;
      }
    }
  }, [isTmuxMode]);

  // 后端 session 切换（auto-recreate / 显式重启）时通知编排器重置 lastServerSize，
  // 让下一个 first-fit 走 immediate 路径，把新 session 的真实尺寸告诉服务端。
  React.useEffect(() => {
    if (!terminalSessionId) return;
    terminalControllerRef.current?.requestRefresh('session-key-change', { force: true });
  }, [terminalSessionId]);

  React.useEffect(() => {
    const visible = isActive && isMobile && isViewportKeyboardOpen;

    debugKeyboard('visibility signal', {
      sessionId,
      isActive,
      isMobile,
      isInputFocused,
      isViewportKeyboardOpen,
      viewportKeyboardHeight,
      visible,
    });
    onKeyboardVisibilityChange?.(sessionId, visible);
  }, [
    onKeyboardVisibilityChange,
    sessionId,
    isActive,
    isMobile,
    isViewportKeyboardOpen,
    viewportKeyboardHeight,
    debugKeyboard,
  ]);

  React.useEffect(() => {
    if (!isActive) {
      return;
    }
    if (!focusRequestToken) {
      return;
    }
    if (focusRequestToken === lastFocusRequestTokenRef.current) {
      return;
    }
    lastFocusRequestTokenRef.current = focusRequestToken;
    focusTerminalIfActive();
  }, [focusRequestToken, focusTerminalIfActive, isActive]);

  React.useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  React.useEffect(() => {
    if (!isMobile && (activeModifier !== null || lockedModifier !== null)) {
      setActiveModifier(null);
      setLockedModifier(null);
      modifierTapRef.current = null;
    }
  }, [isMobile, activeModifier, lockedModifier]);

  React.useEffect(() => {
    if (!terminalSessionId && (activeModifier !== null || lockedModifier !== null)) {
      setActiveModifier(null);
      setLockedModifier(null);
      modifierTapRef.current = null;
    }
  }, [terminalSessionId, activeModifier, lockedModifier]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(MOBILE_KEYBOARD_EXPANDED_STORAGE_KEY, showExtendedKeyboard ? 'true' : 'false');
  }, [showExtendedKeyboard]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(MOBILE_KEYBOARD_PRESET_MODE_STORAGE_KEY, toolbarPresetMode);
  }, [toolbarPresetMode]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(MOBILE_LONG_PRESS_MODE_STORAGE_KEY, mobileLongPressMode);
  }, [mobileLongPressMode]);

  React.useEffect(() => {
    setIsMobile(detectMobileTerminalLayout());

    const handleResize = () => {
      setIsMobile(detectMobileTerminalLayout());
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const disconnectStream = React.useCallback(() => {
    streamVersionRef.current += 1;
    flushPendingShellTitle();
    cancelPendingShellTitle();
    const cleanup = streamCleanupRef.current;
    streamCleanupRef.current = null;
    activeTerminalIdRef.current = null;
    initialConnectionPendingRef.current = false;
    // 断开后立即把 sessionReady 复位：后续 resize push 会被编排器 gate 住，
    setIsStreamReady(false);
    // 直到下次 connected 事件再 setSessionReady(true)。
    // 这样避免把新 resize 用旧 terminalId 发出去。
    terminalControllerRef.current?.setSessionReady(false);
    const currentBackendSessionId = terminalIdRef.current;
    if (currentBackendSessionId) {
      sendTerminalFlowControlState(currentBackendSessionId, false, 'stream-disconnect');
    }
    flowPausedRef.current = false;
    lastSentFlowPausedRef.current = null;
    flowPausedBufferRef.current = [];
    cleanup?.();
  }, [cancelPendingShellTitle, flushPendingShellTitle]);

  const startStream = React.useCallback(
    (terminalId: string) => {
      if (activeTerminalIdRef.current === terminalId) {
        debugSession(`[startStream] Skipping - already connected to ${terminalId}`);
        return;
      }

      debugSession(`[startStream] Starting stream for frontendSessionId=${sessionId} backendSessionId=${terminalId}`);
      setReconnectStartedAt(null);
      contentReadyGenerationRef.current += 1;
      awaitingInitialWritesRef.current = false;
      initialContentTargetChunkIdRef.current = null;
      setIsInitialContentReady(false);
      setIsInitialSizeReady(false);
      disconnectStream();
      const streamVersion = streamVersionRef.current + 1;
      streamVersionRef.current = streamVersion;
      initialConnectionPendingRef.current = true;

      const subscription = terminal.connect(
        terminalId,
        {
          onEvent: (event: TerminalStreamEvent) => {
            if (streamVersionRef.current !== streamVersion) {
              return;
            }

            const storeSessionId = sessionId;
            if (!storeSessionId) return;

            switch (event.type) {
              case 'connected': {
                initialConnectionPendingRef.current = false;
                const resumeAttempt = resumeAttemptRef.current;
                if (resumeAttempt) {
                  clientLog('info', 'PWA_RESUME terminal-connected', {
                    frontendSessionId: storeSessionId,
                    backendSessionId: terminalIdRef.current,
                    durationMs: Date.now() - resumeAttempt.startedAt,
                    strategy: resumeAttempt.strategy,
                    reason: resumeAttempt.reason,
                  });
                  resumeAttemptRef.current = null;
                }
                onStreamConnected?.(storeSessionId);
                if (event.runtime || event.ptyBackend) {
                  debugSession(
                    `[Terminal] connected frontendSessionId=${storeSessionId} backendSessionId=${terminalIdRef.current} runtime=${event.runtime ?? 'unknown'} pty=${event.ptyBackend ?? 'unknown'} cwd=${event.cwd ?? 'unknown'}`
                  );
                }
                setConnecting(storeSessionId, false);
                setConnectionError(null);
                setIsFatalError(false);
                setReconnectStartedAt(null);

                // 标记 WS 已就绪：编排器从这一刻起才允许 push resize 给服务端。
                setIsStreamReady(true);
                // 重连后重新声明当前 focus / viewing：服务端分别用它做 tmux
                // focus tracking 和推送抑制（ref 去重会吞掉未变化的值）。
                if (terminalIdRef.current) {
                  sendTerminalFocusState(terminalIdRef.current, logicalFocusRef.current, 'stream-connected');
                  sendTerminalViewingState(terminalIdRef.current, logicalViewingRef.current, 'stream-connected');
                }
                // 之前没有这个 gate，reload 时 ResizeObserver 在 ensureSession
                // 跑完前就拿 OLD terminalId POST 出去，server 直接 404 + WS 4001
                // 触发 auto-recreate，必须完全重连才能用。
                terminalControllerRef.current?.setSessionReady(true);

                // WS 重连后服务端的 per-client flow 状态是新的，补发当前水位状态，
                // 避免前端仍处于 paused 而服务端继续灌输出。
                lastSentFlowPausedRef.current = null;
                reportFlowControl(flowPausedRef.current, 'stream-connected');

                // Agent status syncs via the dedicated agent-status message.
                if (event.tuiProgress !== undefined) {
                  useTerminalStore.getState().setSessionTuiProgress(storeSessionId, event.tuiProgress ?? null);
                }
                // 标题/prompt 状态连接即同步（广播只在变化时发，刷新后不会重发）。
                if (event.shellTitle !== undefined) {
                  useTerminalStore.getState().setSessionShellTitle(storeSessionId, event.shellTitle ?? null);
                }
                if (event.promptState !== undefined && event.promptState !== null) {
                  useTerminalStore.getState().setSessionPromptState(storeSessionId, event.promptState);
                }

                const sessionState = useTerminalStore.getState().getTerminalSession(storeSessionId);
                if (sessionState?.terminalSessionId && event.mode) {
                  useTerminalStore.getState().setTerminalSession(storeSessionId, {
                    sessionId: sessionState.terminalSessionId,
                    cols: 80,
                    rows: 24,
                    mode: event.mode,
                    tmuxSessionName: event.tmuxSessionName ?? null,
                    cwd: event.cwd ?? null,
                  });
                }

                // 首帧立即写入 activeProgram：connected 事件已携带服务端连接时
                // detect 的 activeProgram（terminal.ts:4348-4358 / 4402）。之前
                // 只写了 cwd，activeProgram 要白等到第一次 active-program 轮询
                // （1200ms）才到，tab 名会从默认名「迟一拍」跳成程序名。这里补上
                // 后，WS 一连上 tab 就能显示「coco termdock」，少一次可见跳变。
                if (event.activeProgram !== undefined) {
                  setSessionActiveProgram(
                    storeSessionId,
                    event.activeProgram ?? null,
                    event.activeProgramSource ?? null,
                    event.activeProgramRaw ?? null,
                  );
                }

                // 连接建立后只校准 fit / 服务端尺寸。history/replay 紧接着写入时
                // xterm 会自行重画；这里若再 full refresh，DOM renderer 会短暂拆空
                // 所有 row，手机切入 Session 时就表现为“内容闪一下再回来”。
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    terminalControllerRef.current?.requestRefresh('connected', {
                      force: true,
                      reconcileServerSize: isActiveRef.current,
                    });
                  });
                });
                if (event.mode !== 'tmux') {
                  setTmuxLayout(null);
                  setSessionCopyMode(storeSessionId, false);
                }
                // tmux 模式不需要单独复位：编排器内 session-key-change 已经
                // 处理了 lastServerSize 重置；tmux-layout 第一次到达时由 useEffect
                // 触发 candidateSize 防 shrink 路径。

                debugSession('[Terminal] Connected event received:', {
                  frontendSessionId: storeSessionId,
                  backendSessionId: terminalIdRef.current,
                  storeHasState: !!sessionState,
                  storeTerminalId: sessionState?.terminalSessionId,
                  hasHistoryInStore: !!(sessionState?.history?.length),
                  historyLength: sessionState?.history?.length ?? 0,
                });

                if (sessionState?.history && sessionState.history.length > 0) {
                  debugSession(`[Terminal] Restoring ${sessionState.history.length} history chunks to frontend session ${storeSessionId}`);
                  const totalHistoryBytes = sessionState.history.reduce((total, chunk) => total + chunk.length, 0);
                  const suppressionMs = Math.max(300, Math.min(2000, Math.ceil(totalHistoryBytes / 200)));
                  suppressInputUntilRef.current = Date.now() + suppressionMs;
                  sessionState.history.forEach((chunk) => {
                    appendToBuffer(storeSessionId, chunk, { markActivity: false });
                  });
                  useTerminalStore.getState().setSessionHistory(storeSessionId, []);
                  debugSession(`[Terminal] History restoration complete for ${storeSessionId}`);
                } else {
                  debugSession(`[Terminal] No history to restore for ${storeSessionId}`);
                }

                // 短线重连补帧：服务端按 sinceSeq 返回断线期间产生的输出。
                // - replayOutOfWindow 表示客户端基线已被服务端淘汰（环形 buffer
                //   覆盖），此时清屏 + 全量重放，避免错位拼接。
                // - 否则直接 append，与现有 buffer 衔接。
                const replayChunks = event.replayChunks;
                const hasInitialWrites = Boolean(sessionState?.history?.length)
                  || Boolean(replayChunks?.length);
                if (hasInitialWrites) {
                  awaitingInitialWritesRef.current = true;
                } else {
                  markInitialContentReadyAfterPaint();
                }
                if (replayChunks && replayChunks.length > 0) {
                  if (event.replayOutOfWindow) {
                    debugSession(`[Terminal] Replay out-of-window, clearing buffer before replay (${replayChunks.length} chunks)`);
                    clearBuffer(storeSessionId);
                    terminalControllerRef.current?.clear();
                  } else {
                    debugSession(`[Terminal] Replay incremental: ${replayChunks.length} chunks`);
                  }
                  // 抑制 replay 期间的用户输入，避免 echo 顺序错乱。
                  const replayBytes = replayChunks.reduce((total, chunk) => total + chunk.length, 0);
                  const suppressionMs = Math.max(200, Math.min(1500, Math.ceil(replayBytes / 200)));
                  suppressInputUntilRef.current = Math.max(suppressInputUntilRef.current, Date.now() + suppressionMs);
                  for (const chunk of replayChunks) {
                    appendToBuffer(storeSessionId, chunk);
                  }
                }
                if (hasInitialWrites) {
                  initialContentTargetChunkIdRef.current = useTerminalStore
                    .getState()
                    .flushPendingBufferWrites(storeSessionId);
                  if (initialContentTargetChunkIdRef.current === null) {
                    awaitingInitialWritesRef.current = false;
                    markInitialContentReadyAfterPaint();
                  }
                }
                break;
              }
              case 'reconnecting': {
                setReconnectStartedAt((startedAt) => startedAt ?? Date.now());
                setConnectionError('Reconnecting...');
                setIsFatalError(false);
                break;
              }
              case 'data': {
                if (event.data) {
                  if (flowPausedRef.current) {
                    flowPausedBufferRef.current.push(event.data);
                  } else {
                    appendToBuffer(storeSessionId, event.data);
                  }
                }
                break;
              }
              case 'tmux-layout': {
                setTmuxLayout(event.layout ?? null);
                if (event.layout) {
                  setSessionCopyMode(storeSessionId, event.layout.inCopyMode);
                }
                break;
              }
              case 'tmux-screen-sync': {
                const generation = event.generation ?? 0;
                if (generation < lastTmuxScreenSyncGenerationRef.current) {
                  break;
                }
                lastTmuxScreenSyncGenerationRef.current = generation;
                contentReadyGenerationRef.current += 1;
                awaitingInitialWritesRef.current = true;
                setIsInitialContentReady(false);
                // This is an authoritative tmux grid, not another diff chunk.
                // Reset xterm and replace the store atomically so stale lines
                // from the pre-resize column layout cannot survive at the top.
                flowPausedBufferRef.current = [];
                terminalControllerRef.current?.clear({ preserveKeyboardResizePresentation: true });
                pendingTmuxScreenSyncGenerationRef.current = generation;
                initialContentTargetChunkIdRef.current = replaceBuffer(storeSessionId, event.chunks ?? []);
                if (!event.chunks?.length || initialContentTargetChunkIdRef.current === null) {
                  pendingTmuxScreenSyncGenerationRef.current = null;
                  terminalControllerRef.current?.notifyScreenSynchronized(generation);
                  awaitingInitialWritesRef.current = false;
                  markInitialContentReadyAfterPaint();
                }
                if (typeof event.cols === 'number' && typeof event.rows === 'number') {
                  terminalControllerRef.current?.notifyServerSize(
                    event.cols,
                    event.rows,
                    'tmux-screen-sync',
                  );
                }
                break;
              }
              case 'active-program': {
                setSessionActiveProgram(
                  storeSessionId,
                  event.activeProgram ?? null,
                  event.activeProgramSource ?? null,
                  event.activeProgramRaw ?? null,
                );
                break;
              }
              case 'cwd': {
                setSessionCwd(storeSessionId, event.cwd ?? null);
                break;
              }
              case 'agent-status': {
                setSessionAgentStatus(storeSessionId, {
                  agentStatus: event.agentStatus ?? null,
                  agentIndicator: event.agentIndicator ?? null,
                  agentStatusDetail: event.agentStatusDetail ?? null,
                  agent: event.agent ?? null,
                  agentMessage: event.agentMessage ?? null,
                  agentNativeSessionId: event.agentNativeSessionId ?? null,
                  agentResumeRecovered: event.agentResumeRecovered === true,
                  agentRich: event.agentRich === true,
                  agentActivity: event.agentActivity ?? 0,
                  agentCwd: event.agentCwd ?? null,
                  reviewed: event.reviewed ?? null,
                });
                break;
              }
              case 'git-status': {
                useTerminalStore.getState().setSessionGitStatus(storeSessionId, event.gitStatus ?? null);
                break;
              }
              case 'focus-mode': {
                debugSession('[Terminal] focus tracking mode', {
                  backendSessionId: terminalIdRef.current,
                  requested: event.focusTrackingRequested === true,
                });
                break;
              }
              case 'resize-ack': {
                terminalControllerRef.current?.acknowledgeResize({
                  seq: event.seq,
                  ok: event.ok !== false,
                  cols: event.cols,
                  rows: event.rows,
                  screenSyncPending: event.screenSyncPending,
                  screenSyncGeneration: event.screenSyncGeneration,
                });
                break;
              }
              case 'pty-size': {
                // 服务端在任意 client resize 之后广播过来的真实 pty 尺寸。
                // 同步给 viewport 的 lastServerSize：多端切换后 ensureSizeMatches
                // 比对时才有正确的"服务端事实"。同时让本端进入 ~1.5s 冷却窗口
                // 不主动反推，避免双端互相覆盖（防拉扯）。
                if (typeof event.cols === 'number' && typeof event.rows === 'number') {
                  terminalControllerRef.current?.notifyServerSize(
                    event.cols,
                    event.rows,
                    event.source,
                  );
                }
                break;
              }
              case 'shell-title': {
                // Shell integration (OSC 2) reported title — cwd when idle, command when running.
                scheduleShellTitleUpdate(storeSessionId, event.title ?? null);
                break;
              }
              case 'prompt-state': {
                // Shell integration (OSC 133) reported prompt state — 'idle' or 'running'.
                setSessionPromptState(storeSessionId, event.state ?? 'idle', event.exitCode ?? null);
                break;
              }
              case 'tui-progress': {
                useTerminalStore.getState().setSessionTuiProgress(storeSessionId, event.tuiProgress ?? null);
                break;
              }
              case 'exit': {
                const exitCode =
                  typeof event.exitCode === 'number' ? event.exitCode : null;
                const signal = typeof event.signal === 'number' ? event.signal : null;
                appendToBuffer(
                  storeSessionId,
                  `\r\n[Process exited${
                    exitCode !== null ? ` with code ${exitCode}` : ''
                  }${signal !== null ? ` (signal ${signal})` : ''}]\r\n`
                );
                clearTerminalSession(storeSessionId);
                setConnecting(storeSessionId, false);
                setConnectionError('Terminal session ended');
                setIsStreamReady(false);
                setIsFatalError(false);
                setReconnectStartedAt(null);
                setTmuxLayout(null);
                setSessionCopyMode(storeSessionId, false);
                disconnectStream();
                break;
              }
            }
          },
          onError: (error, fatal) => {
            if (streamVersionRef.current !== streamVersion) {
              return;
            }

            const storeSessionId = sessionId;
            if (!storeSessionId) return;
            initialConnectionPendingRef.current = false;

            const isAuthenticationFailure = fatal && error.message === 'Authentication required';
            const isRecoverableBackendMiss = isTransientBackendSessionMiss(error);
            const errorMsg = isAuthenticationFailure
              ? error.message
              : isRecoverableBackendMiss
                ? 'Reconnecting...'
              : fatal
                ? 'Reconnecting...'
                : error.message || 'Terminal stream connection error';
            console.error(`[Terminal] Stream error (fatal=${fatal}):`, errorMsg);

            // 单独高亮 Session not found，方便 grep / 自动化检测
            if (isRecoverableBackendMiss) {
              // eslint-disable-next-line no-console
              console.warn('[Terminal] SESSION_NOT_FOUND_DETECTED', {
                terminalIdAtError: terminalIdRef.current,
                frontendSessionId: storeSessionId,
                isActive,
                isMobile,
                fatal,
                stack: new Error().stack,
              });
            }

            setConnectionError(errorMsg);
            setIsFatalError(!!fatal);

            if (fatal) {
              setReconnectStartedAt(null);
              setConnecting(storeSessionId, false);
              disconnectStream();

              // Session lost on server (e.g. server restart) — automatically
              // recreate instead of making the user manually refresh.
              if (isRecoverableBackendMiss) {
                debugSession(`[onError] Session lost, auto-recreating`);
                setConnectionError('Reconnecting...');
                setIsFatalError(false);
                clearTerminalSession(storeSessionId);
                clearBuffer(storeSessionId);
                terminalIdRef.current = null;
                hasInitializedRef.current = false;
                // 4001 only means this server process does not currently own
                // the old backend id. Restart recovery immediately; inventory
                // open remains in Reconnecting until persisted state is ready.
                restartEnsureSession();
              }
            }
          },
        },
        STREAM_OPTIONS
      );

      streamCleanupRef.current = () => {
        subscription.close();
        if (streamVersionRef.current === streamVersion) {
          activeTerminalIdRef.current = null;
        }
      };
      activeTerminalIdRef.current = terminalId;
    },
    [appendToBuffer, clearBuffer, clearTerminalSession, debugSession, disconnectStream, markInitialContentReadyAfterPaint, onStreamConnected, reportFlowControl, restartEnsureSession, scheduleShellTitleUpdate, setConnecting, setSessionActiveProgram, setSessionAgentStatus, setSessionCopyMode, setSessionCwd, setSessionPromptState, terminal, sessionId]
  );

  // 后台会话允许长时间退避，覆盖锁屏和系统冻结；可见会话连续重连超过 60 秒时，
  // 主动废弃可能卡死的连接并立即重建，但仍保持 Reconnecting 状态。
  React.useEffect(() => {
    const delayMs = getVisibleReconnectWatchdogDelayMs({
      isActive,
      isStreamReady,
      reconnectStartedAt,
      now: Date.now(),
    });
    if (delayMs === null) return;

    const timer = window.setTimeout(() => {
      debugSession('[Terminal] visible reconnect watchdog expired', {
        backendSessionId: terminalIdRef.current,
        reconnectStartedAt,
      });
      disconnectStream();
      setConnecting(sessionId, false);
      setConnectionError('Reconnecting...');
      setIsFatalError(false);
      setReconnectStartedAt(Date.now());
      restartEnsureSession();
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [debugSession, disconnectStream, isActive, isStreamReady, reconnectStartedAt, restartEnsureSession, sessionId, setConnecting]);

  const hasInitializedRef = React.useRef(false);
  const hasStartedInitialConnectRef = React.useRef(false);
  const currentRunIdRef = React.useRef(0);

  React.useEffect(() => {
    return () => {
      currentRunIdRef.current += 1;
      hasInitializedRef.current = false;
      disconnectStream();
    };
  }, [disconnectStream]);

  const desiredSessionModeRef = React.useRef<TerminalMode>(desiredSessionMode);
  const desiredTmuxSessionNameRef = React.useRef<string | null>(desiredTmuxSessionName);
  React.useEffect(() => {
    const previousMode = desiredSessionModeRef.current;
    const previousTmuxSessionName = desiredTmuxSessionNameRef.current;
    desiredSessionModeRef.current = desiredSessionMode;
    desiredTmuxSessionNameRef.current = desiredTmuxSessionName;
    if (sessionIdRef.current !== sessionId) return;
    if (previousMode === desiredSessionMode && previousTmuxSessionName === desiredTmuxSessionName) return;
    hasInitializedRef.current = false;
    disconnectStream();
    setRestartTrigger((token) => token + 1);
  }, [desiredSessionMode, desiredTmuxSessionName, disconnectStream, sessionId]);

  React.useEffect(() => {
    if (sessionIdRef.current !== sessionId) {
      debugSession(`[useEffect] sessionId changed from ${sessionIdRef.current} to ${sessionId}, allowing reinitialization`);
      hasInitializedRef.current = false;
      hasStartedInitialConnectRef.current = false;
    }

    if (hasInitializedRef.current && sessionIdRef.current === sessionId) {
      debugSession(`[useEffect] Already initialized for sessionId=${sessionId}, skipping`);
      return;
    }

    const ensureSession = async (runId: number) => {
      debugSession(`[ensureSession] Starting for sessionId=${sessionId}, runId=${runId}`);

      if (!sessionIdRef.current || sessionIdRef.current !== sessionId) {
        debugSession(`[ensureSession] SessionId mismatch or stale run (current=${sessionIdRef.current}, target=${sessionId}), skipping`);
        return;
      }

      if (runId !== currentRunIdRef.current) {
        debugSession(`[ensureSession] Stale run detected (runId=${runId}, currentRunId=${currentRunIdRef.current}), skipping`);
        return;
      }

      const store = useTerminalStore.getState();
      const currentState = store.getTerminalSession(sessionId);
      const currentMode = currentState?.mode ?? desiredSessionMode;
      debugSession(`[ensureSession] Current state from store:`, {
        terminalSessionId: currentState?.terminalSessionId,
        mode: currentState?.mode,
        tmuxSessionName: currentState?.tmuxSessionName,
        isConnecting: currentState?.isConnecting
      });

      let terminalId = currentState?.terminalSessionId ?? null;
      let shouldCreateNewSession = !terminalId;
      if (terminalId && currentMode !== desiredSessionMode) {
        debugSession(`[ensureSession] Store mode mismatch for ${terminalId}: current=${currentMode} desired=${desiredSessionMode}, will create new session`);
        shouldCreateNewSession = true;
        store.clearTerminalSession(sessionId);
        terminalId = null;
      } else if (
        terminalId &&
        desiredSessionMode === 'tmux' &&
        desiredTmuxSessionName &&
        currentState?.tmuxSessionName !== desiredTmuxSessionName
      ) {
        debugSession(`[ensureSession] Store tmux name mismatch for ${terminalId}: current=${currentState?.tmuxSessionName} desired=${desiredTmuxSessionName}, will create new session`);
        shouldCreateNewSession = true;
        store.clearTerminalSession(sessionId);
        terminalId = null;
      }

      // The selected terminal is latency-sensitive. Open its WebSocket
      // optimistically instead of paying an extra HTTP RTT first; a stale
      // backend id is still recovered by the existing WS 4001 path.
      if (terminalId && terminal.checkHealth && !isActiveRef.current) {
        debugSession(`[ensureSession] Checking health of existing session ${terminalId}`);
        try {
          const health = await terminal.checkHealth(terminalId);
          debugSession(`[ensureSession] Health check result:`, health);
          if (!health.healthy) {
            debugSession(`[ensureSession] Session ${terminalId} is NOT healthy (healthy=${health.healthy}), will create new session`);
            debugSession(`[ensureSession] Health check details:`, health);
            shouldCreateNewSession = true;
            // 404 响应现在也带 mode/tmuxSessionName（来自持久化 globalSessionState），
            // 修正 store 中的 session mode，避免 tmux 会话误重建为 shell。
            if (health.mode && currentState?.terminalSessionId) {
              store.setTerminalSession(sessionId, {
                sessionId: currentState.terminalSessionId,
                cols: 80,
                rows: 24,
                mode: health.mode,
                tmuxSessionName: health.tmuxSessionName ?? null,
              });
            }
            store.clearTerminalSession(sessionId);
            debugSession(`[ensureSession] Cleared unhealthy session from store`);
          } else {
            debugSession(`[ensureSession] Session ${terminalId} is healthy, reusing it, cwd=${health.cwd}, clients=${health.clients}, lastActivity=${Date.now() - (health.lastActivity || 0)}ms ago`);
            if (health.mode && currentState?.terminalSessionId) {
              store.setTerminalSession(sessionId, {
                sessionId: currentState.terminalSessionId,
                cols: 80,
                rows: 24,
                mode: health.mode,
                tmuxSessionName: health.tmuxSessionName ?? null,
              });
            }
            debugSession(`[ensureSession] Setting terminalIdRef to ${terminalId} and starting stream`);
            terminalIdRef.current = terminalId;
            startStream(terminalId);
            debugSession(`[ensureSession] Successfully reused healthy session ${terminalId}, returning early`);
            return;
          }
        } catch (error) {
          debugSession(`[ensureSession] Failed to check health of session ${terminalId}:`, error);
          debugSession(`[ensureSession] Health check API call failed, proceeding as if session might be unhealthy`);
        }
      }

      debugSession(`[ensureSession] Decision: shouldCreateNewSession=${shouldCreateNewSession}, terminalId=${terminalId}`);
      if (shouldCreateNewSession) {
        debugSession(`[ensureSession] Creating new session, shouldCreateNewSession=${shouldCreateNewSession}, runId=${runId}`);
        setConnectionError(null);
        setIsFatalError(false);
        store.setConnecting(sessionId, true);

        const currentStore = useTerminalStore.getState();
        const recheckedState = currentStore.getTerminalSession(sessionId);
        const recheckedMode = recheckedState?.mode ?? desiredSessionMode;
        const recheckedMatchesDesired =
          recheckedMode === desiredSessionMode &&
          (
            desiredSessionMode !== 'tmux' ||
            !desiredTmuxSessionName ||
            recheckedState?.tmuxSessionName === desiredTmuxSessionName
          );
        if (recheckedState?.terminalSessionId && recheckedMatchesDesired) {
          debugSession(`[ensureSession] Race condition avoided: another instance already created session ${recheckedState.terminalSessionId}`);
          store.setConnecting(sessionId, false);
          terminalId = recheckedState.terminalSessionId;
          shouldCreateNewSession = false;
        } else {
          try {
            const session = await openManagedBackendSession();
            debugSession(`[ensureSession] Opened managed backend session ${session.sessionId}`);

            if (runId !== currentRunIdRef.current) {
              // 这次 ensureSession 是 stale 的：另一个并发 run 已经接管了。
              // 关键：绝对不能 close 刚创建的 session！它可能正是 sibling 即将
              // 通过 store 里 recheckedState 拿到的同一个 ID（tmux-reuse 路径
              // 会让多个 ensureSession 拿到相同的 backend sessionId）。如果
              // 这里 close，sibling 的 WS 立刻 4001，整条 tmux 链路挂掉。
              // 正确做法：让 sibling 自然走自己的"复用"分支，session 留在服务端
              // 给所有人用。
              debugSession(`[ensureSession] Stale run after session creation (runId=${runId}, currentRunId=${currentRunIdRef.current}), leaving ${session.sessionId} for sibling`);
              return;
            }

            store.setTerminalSession(sessionId, session);
            debugSession(`[ensureSession] Updated store with new session ${session.sessionId}`);
            terminalId = session.sessionId;
          } catch (error) {
            if (runId !== currentRunIdRef.current) {
              debugSession(`[ensureSession] Stale run after session creation failed, skipping error handling`);
              return;
            }
            if (error instanceof TerminalApiError && isConfirmedSessionMissing(error)) {
              debugSession('[ensureSession] Confirmed missing persisted session:', { sessionId, error: error.message });
              store.clearTerminalSession(sessionId);
              setConnectionError(CONFIRMED_SESSION_MISSING_MESSAGE);
              setIsFatalError(true);
              store.setConnecting(sessionId, false);
              return;
            }
            setConnectionError('Reconnecting...');
            setIsFatalError(true);
            store.setConnecting(sessionId, false);
            return;
          }
        }
      }

      if (runId !== currentRunIdRef.current) {
        debugSession(`[ensureSession] Stale run before starting stream (runId=${runId}, currentRunId=${currentRunIdRef.current}), skipping`);
        return;
      }

      if (!terminalId) {
        debugSession(`[ensureSession] No terminalId, terminalId=${terminalId}`);
        return;
      }

      debugSession(`[ensureSession] Starting stream for session ${terminalId}`);
      terminalIdRef.current = terminalId;
      startStream(terminalId);
      debugSession(`[ensureSession] ensureSession completed for sessionId=${sessionId}, terminalId=${terminalId}`);
    };

    let scheduledRunId: number | null = null;
    let connectTimer: number | null = null;
    const beginEnsureSession = () => {
      connectTimer = null;
      if (hasInitializedRef.current && sessionIdRef.current === sessionId) {
        return;
      }

      debugSession(`[useEffect] Running ensureSession for sessionId=${sessionId}, hasInitialized=${hasInitializedRef.current}`);
      hasInitializedRef.current = true;
      hasStartedInitialConnectRef.current = true;
      scheduledRunId = ++currentRunIdRef.current;
      void ensureSession(scheduledRunId);
    };

    if (!initialConnectEnabled && !hasStartedInitialConnectRef.current) {
      debugSession(`[useEffect] Holding background connection until the selected session is ready: ${sessionId}`);
      return;
    }

    const connectDelayMs = hasStartedInitialConnectRef.current
      ? 0
      : Math.max(0, initialConnectDelayMs);
    if (connectDelayMs > 0) {
      debugSession(`[useEffect] Delaying initial connection for sessionId=${sessionId} by ${connectDelayMs}ms`);
      connectTimer = window.setTimeout(beginEnsureSession, connectDelayMs);
    } else {
      beginEnsureSession();
    }

    return () => {
      if (connectTimer !== null) {
        window.clearTimeout(connectTimer);
      }
      debugSession(`[useEffect] Cleanup for sessionId=${sessionId}, runId=${scheduledRunId ?? 'pending'}`);
    };
  }, [sessionId, restartTrigger, startStream, disconnectStream, terminal, debugSession, desiredSessionMode, desiredTmuxSessionName, fallbackTmuxSessionName, initialConnectDelayMs, initialConnectEnabled]);

  const handleHardRestart = React.useCallback(async () => {
    if (!sessionId) return;
    if (isRestarting) return;

    setIsRestarting(true);
    setConnectionError(null);
    setIsFatalError(false);
    setReconnectStartedAt(null);
    disconnectStream();

    try {
      if (terminal.forceKill) {
        await terminal.forceKill({ sessionId });
      }
    } catch { /* ignored */ }

    removeTerminalSession(sessionId);
    clearBuffer(sessionId);
    terminalControllerRef.current?.clear();

    await new Promise(r => setTimeout(r, 100));

    try {
      setConnecting(sessionId, true);
      const session = await openManagedBackendSession();
      setTerminalSession(sessionId, session);
      terminalIdRef.current = session.sessionId;
      startStream(session.sessionId);
    } catch (error) {
      setConnectionError(
        error instanceof TerminalApiError && isConfirmedSessionMissing(error)
          ? CONFIRMED_SESSION_MISSING_MESSAGE
          : 'Reconnecting...',
      );
      setIsFatalError(true);
      setConnecting(sessionId, false);
    } finally {
      setIsRestarting(false);
    }
  }, [sessionId, isRestarting, disconnectStream, terminal, removeTerminalSession, clearBuffer, setConnecting, setTerminalSession, startStream, openManagedBackendSession]);

  const handleViewportInput = React.useCallback(
    (data: string, options?: { skipModifierTransform?: boolean; consumeModifier?: boolean }) => {
      if (!isActiveRef.current) {
        return;
      }

      if (!data) {
        return;
      }

      // 桌面端：xterm 在 mouseTracking 模式下把触控板/滚轮上滑转成
      // SGR mouse wheel（按钮码 64/65）。命中后标记 ref，让下一次真正的
      // 键盘输入触发 tmux 退出 copy-mode（与移动端 onTmuxScroll 路径一致）。
      // 注意：wheel 事件本身不退出 copy-mode（连续滚动要继续生效），
      // 只是打个标记，等真正的键盘输入再退出。
      const isMouseOrFocusSeq = isTmuxMouseOrFocusInput(data);
      const isMouseWheelSeq = /^(\x1b\[<6[45];[0-9]+;[0-9]+M)+$/.test(data);
      if (isTmuxMode && isMouseWheelSeq) {
        shouldExitTmuxCopyModeOnInputRef.current = true;
      }

      if (Date.now() < suppressInputUntilRef.current) {
        return;
      }

      let payload = data;
      let modifierConsumed = options?.consumeModifier ?? false;

      if (!options?.skipModifierTransform && activeModifier && data.length > 0) {
        const firstChar = data[0];
        if (firstChar.length === 1 && /[a-zA-Z]/.test(firstChar)) {
          const upper = firstChar.toUpperCase();
          if (activeModifier === 'ctrl') {
            payload = String.fromCharCode(upper.charCodeAt(0) & 0b11111);
            modifierConsumed = true;
          } else if (activeModifier === 'alt') {
            payload = `\u001b${data}`;
            modifierConsumed = true;
          }
        }

        if (!modifierConsumed) {
          if (activeModifier === 'alt') {
            payload = `\u001b${data}`;
          }
          modifierConsumed = true;
        }
      }

      const terminalId = terminalIdRef.current;
      if (!terminalId) {
        return;
      }

      const sendPayload = async () => {
        try {
          // 只有非鼠标序列的真键盘输入才触发退出 copy-mode；
          // wheel/drag/select 事件自身不退出。
          if (
            isTmuxMode &&
            !isMouseOrFocusSeq &&
            shouldExitTmuxCopyModeOnInputRef.current &&
            terminal.tmuxAction
          ) {
            shouldExitTmuxCopyModeOnInputRef.current = false;
            try {
              await terminal.tmuxAction(terminalId, { action: 'copy-mode', enabled: false });
            } catch {
              // exit-copy-mode failure shouldn't block sending input
            }

            // tmuxAction already consumed Escape's intended effect by leaving
            // copy mode. Sending the byte again would leak Escape into the
            // foreground program in the pane.
            if (shouldConsumeAfterTmuxCopyModeExit(payload)) {
              return;
            }
          }

          await terminal.sendInput(terminalId, payload);
          // If user is on the session and agent just finished, user input = reviewed
          clearAgentNeedsReview(sessionId);
        } catch (error) {
          setConnectionError(error instanceof Error ? error.message : 'Failed to send input');
        }
      };

      void sendPayload();

      if (modifierConsumed) {
        if (!lockedModifier) {
          setActiveModifier(null);
        }
        focusTerminalIfActive();
      }
    },
    [activeModifier, clearAgentNeedsReview, focusTerminalIfActive, isTmuxMode, lockedModifier, terminal]
  );

  React.useEffect(() => {
    const handleInsertReference = (event: Event) => {
      if (!isActiveRef.current) return;
      const customEvent = event as CustomEvent<{ text?: string; focus?: boolean; paste?: boolean; nonce?: string }>;
      const text = customEvent.detail?.text;
      if (!text) return;
      const nonce = customEvent.detail?.nonce;
      // 断联/重连中的 session 插入会丢：带 nonce 的请求回 ack 失败，
      // 让发送方（上下文草稿坞）保留内容
      if (isConnectionTransitionRef.current) {
        if (nonce) {
          window.dispatchEvent(new CustomEvent('termdock-insert-reference-ack', {
            detail: { nonce, ok: false },
          }));
        }
        return;
      }
      // 引用插入也是带外输入：重置输入模型后发送，避免 textarea diff 拿
      // 过期基线算错
      terminalControllerRef.current?.sendSequence(text, { paste: customEvent.detail?.paste });
      if (nonce) {
        window.dispatchEvent(new CustomEvent('termdock-insert-reference-ack', {
          detail: { nonce, ok: true },
        }));
      }
      if (shouldAutoFocusTerminalAfterInsert(isMobileRef.current, customEvent.detail?.focus !== false)) {
        focusTerminalIfActive();
      }
    };

    window.addEventListener('termdock-insert-reference', handleInsertReference);
    return () => window.removeEventListener('termdock-insert-reference', handleInsertReference);
  }, [focusTerminalIfActive]);

  // 推 resize 给服务端。本组件不再做 debounce / skip-if-same —— 编排器在
  // TerminalViewport 内部已按动画帧合并并完成 skip-if-same，调用本函数说明
  // 编排器已经决策好了，直接通过当前 WebSocket 发送。
  const handleViewportResize = React.useCallback(
    (cols: number, rows: number, seq: number) => {
      const terminalId = terminalIdRef.current;
      if (!terminalId) {
        debugKeyboard('xterm resize push skipped: no terminalId', { cols, rows });
        return;
      }
      debugKeyboard('xterm resize push', { cols, rows });
      void terminal.resize({ sessionId: terminalId, cols, rows, seq }).catch((err) => {
        terminalControllerRef.current?.acknowledgeResize({ seq, ok: false });
        // 静默失败：resize 失败不影响终端渲染
        // 但需要知道是不是 session-not-found——这通常是后端 session 已被清掉
        // 而前端 ref 还指着旧 id，是 race 的明确信号。
        if (err && /session not found/i.test(String(err.message || err))) {
          // eslint-disable-next-line no-console
          console.warn('[Terminal] resize 404 session not found', {
            sessionId: terminalId,
            cols,
            rows,
            stack: new Error().stack,
          });
        }
      });
    },
    [terminal, debugKeyboard]
  );

  const sendTmuxAction = React.useCallback(async (payload: TmuxActionPayload) => {
    const terminalId = terminalIdRef.current;
    if (!terminalId || !terminal.tmuxAction) {
      return;
    }

    try {
      const result = await terminal.tmuxAction(terminalId, payload);
      if (result.layout) {
        setTmuxLayout(result.layout);
        if (payload.action === 'switch-session') {
          setTerminalSession(sessionId, {
            sessionId: terminalId,
            cols: 80,
            rows: 24,
            mode: 'tmux',
            tmuxSessionName: result.layout.sessionName,
          });
          void updateSessionInventoryEntry(sessionId, { tmuxSessionName: result.layout.sessionName }).catch((error) => {
            console.warn('[Terminal] failed to update inventory after tmux switch', error);
          });
        }
      }
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Failed to execute tmux action');
    }
  }, [sessionId, setTerminalSession, terminal]);

  // tmux-layout 事件：把"服务端报的尺寸"作为 candidate 交给编排器。
  // 编排器内部做：
  //   1) dedupe by sessionId+activePaneId（避免同会话内重复 resize）
  //   2) candidateSize 防 shrink：比当前 xterm 小就忽略
  //   3) skipScrollToBottom：tmux 模式下不应强制滚底（vim/less 位置）
  // 这样原来散在 useEffect 里的三个 ref 全部下沉到编排器内部。
  React.useEffect(() => {
    // 必须等 terminalSessionId 就绪后再用 dedupeKey：reload 期间 tmux-layout
    // 事件可能比 connected 事件先到，那时 terminalSessionId 还是 null/旧值，
    // 会用旧 key 调一次 requestRefresh，编排器会拿新 key 比对旧的 lastDedupeKeyRef
    // 直接判重复。等 terminalSessionId 更新后再用新 key 重跑。
    if (!_tmuxLayout || !terminalSessionId) return;
    const activeWindow = _tmuxLayout.windows.find((w) => w.id === _tmuxLayout.activeWindowId);
    const activePane = activeWindow?.panes.find((p) => p.id === _tmuxLayout.activePaneId);
    if (!activePane) return;

    terminalControllerRef.current?.requestRefresh('tmux-layout', {
      candidateSize: { cols: activePane.width, rows: activePane.height },
      skipScrollToBottom: true,
      dedupeKey: `${terminalSessionId}:${_tmuxLayout.sessionId}:${activePane.id}:${activePane.width}x${activePane.height}`,
    });
  }, [_tmuxLayout, terminalSessionId]);

  const handleTmuxScroll = React.useCallback((direction: 'up' | 'down', lines = 5) => {
    const normalizedLines = Math.max(1, Math.min(Math.floor(lines) || 1, 40));
    shouldExitTmuxCopyModeOnInputRef.current = true;

    // The tick loop already batches lines per rAF frame, so most calls
    // arrive with a meaningful line count.  We still merge consecutive
    // same-direction calls that happen synchronously (rare edge case),
    // but send immediately — no artificial timer delay.
    const pending = tmuxScrollPendingRef.current;
    if (pending && pending.direction === direction) {
      pending.lines += normalizedLines;
      return;
    }

    if (pending) {
      void sendTmuxAction({ action: 'scroll', direction: pending.direction, lines: pending.lines }).finally(() => {
        focusTerminalIfActive();
      });
    }
    tmuxScrollPendingRef.current = { direction, lines: normalizedLines };

    // Microtask drain: flush on the next microtask so synchronous batches
    // (rare with tick-level batching) are merged, but we don't block on
    // an arbitrary timer.
    if (tmuxScrollFlushTimerRef.current) clearTimeout(tmuxScrollFlushTimerRef.current);
    tmuxScrollFlushTimerRef.current = setTimeout(() => {
      const p = tmuxScrollPendingRef.current;
      if (p) {
        tmuxScrollPendingRef.current = null;
        void sendTmuxAction({ action: 'scroll', direction: p.direction, lines: p.lines }).finally(() => {
          focusTerminalIfActive();
        });
      }
    }, 0);
  }, [focusTerminalIfActive, sendTmuxAction]);

  const handleModifierToggle = React.useCallback(
    (modifier: Modifier) => {
      const now = Date.now();
      const lastTap = modifierTapRef.current;
      const isDoubleTap =
        lastTap !== null &&
        lastTap.modifier === modifier &&
        now - lastTap.timestamp <= MODIFIER_DOUBLE_TAP_WINDOW_MS;

      modifierTapRef.current = { modifier, timestamp: now };

      if (lockedModifier === modifier) {
        setLockedModifier(null);
        setActiveModifier(null);
        return;
      }

      if (isDoubleTap) {
        setLockedModifier(modifier);
        setActiveModifier(modifier);
        return;
      }

      if (lockedModifier !== null && lockedModifier !== modifier) {
        setLockedModifier(null);
      }

      setActiveModifier((current) => (current === modifier ? null : modifier));
    },
    [lockedModifier]
  );

  const handleInputFocusChange = React.useCallback((focused: boolean) => {
    setIsViewportFocused(focused && isActiveRef.current);
    debugKeyboard('input focus changed', {
      focused,
      isActive: isActiveRef.current,
      isMobile: isMobileRef.current,
    });
    if (!isMobileRef.current || !isActiveRef.current) {
      setIsInputFocused(false);
      return;
    }
    setIsInputFocused((current) => (current === focused ? current : focused));
  }, [debugKeyboard]);

  const handleFlowControl = React.useCallback((paused: boolean) => {
    flowPausedRef.current = paused;
    reportFlowControl(paused, 'viewport-watermark');
    if (!paused && flowPausedBufferRef.current.length > 0) {
      const storeSessionId = sessionId;
      if (storeSessionId) {
        const buffered = flowPausedBufferRef.current;
        flowPausedBufferRef.current = [];
        for (const chunk of buffered) {
          appendToBuffer(storeSessionId, chunk);
        }
      }
    }
  }, [appendToBuffer, reportFlowControl, sessionId]);

  const handleEnsureSizeMatches = React.useCallback((reason: string) => {
    if (!isActiveRef.current) return;
    terminalControllerRef.current?.ensureSizeMatches(reason);
  }, []);

  // 多端同步：用户在本端做交互（点击 / 按键 / 触摸 / 滚轮）时，让 viewport
  // 比对本端 xterm 尺寸与服务端最近广播的 pty-size。不一致就立即重推 resize。
  // 防拉扯逻辑（visibility gate + 服务端广播冷却 + 400ms 节流）在 viewport
  // 内部完成。
  //
  // 监听挂在 viewport 容器上而非 window：
  //  - 多 tab 时只有 active session 的容器在前台收到事件，避免 N 份监听都
  //    跑早退判断。
  //  - 容器外的工具栏 / 侧边栏交互不视为"对终端的操作"，不必触发尺寸比对。
  // wheel 必须包含——触控板滚动只触发 wheel，不会触发 pointer。
  const interactionHostRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!isActive) return;
    const host = interactionHostRef.current;
    if (!host) return;
    const onPointerDown = () => handleEnsureSizeMatches('pointerdown');
    const onKeyDown = () => handleEnsureSizeMatches('keydown');
    const onTouchStart = () => handleEnsureSizeMatches('touchstart');
    const onWheel = () => handleEnsureSizeMatches('wheel');
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('keydown', onKeyDown);
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('keydown', onKeyDown);
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('wheel', onWheel);
    };
  }, [isActive, handleEnsureSizeMatches]);

  const handleTerminalControllerRef = React.useCallback((controller: TerminalController | null) => {
    terminalControllerRef.current = controller;
  }, []);
  const handleViewportReadyChange = React.useCallback((ready: boolean) => {
    onViewportReadyChange?.(sessionId, ready);
  }, [onViewportReadyChange, sessionId]);

  const handleMobileKeyPress = React.useCallback(
    (key: 'esc' | 'enter' | 'home' | 'end' | 'ctrl-c' | 'ctrl-d' | 'ctrl-w' | 'ctrl-u') => {
      const sequence = getSequenceForKey(key, activeModifier);
      if (!sequence) {
        return;
      }
      const shouldConsumeModifier = activeModifier !== null;
      // 走 controller 的带外输入入口：先重置输入模型（textarea + 光标基线），
      // 再发 PTY。直接调 handleViewportInput 会让方向键移动 PTY 光标而
      // 模型不知情，后续删除/输入全部错位。
      terminalControllerRef.current?.sendSequence(sequence, {
        consumeModifier: shouldConsumeModifier,
      });
    },
    [activeModifier]
  );

  const handleToolbarTextPress = React.useCallback((sequence: string) => {
    const segments = splitToolbarSequenceSegments(sequence);
    if (segments.length === 0) {
      return;
    }
    const consumeModifier = activeModifier !== null;
    terminalControllerRef.current?.sendSequence(decodeToolbarSequence(segments[0]), {
      consumeModifier,
    });
    for (let i = 1; i < segments.length; i += 1) {
      const segment = segments[i];
      window.setTimeout(() => {
        terminalControllerRef.current?.sendSequence(decodeToolbarSequence(segment));
      }, TOOLBAR_SEGMENT_DELAY_MS * i);
    }
  }, [activeModifier]);

  const handleMobilePastePress = React.useCallback(() => {
    void terminalControllerRef.current?.pasteClipboardText();
  }, []);

  const showMobileFileUploadState = React.useCallback((state: 'idle' | 'uploading' | 'inserted' | 'failed') => {
    if (mobileFileFeedbackTimerRef.current !== null) {
      window.clearTimeout(mobileFileFeedbackTimerRef.current);
      mobileFileFeedbackTimerRef.current = null;
    }
    setMobileFileUploadState(state);
    if (state === 'inserted' || state === 'failed') {
      mobileFileFeedbackTimerRef.current = window.setTimeout(() => {
        mobileFileFeedbackTimerRef.current = null;
        setMobileFileUploadState('idle');
      }, 1400);
    }
  }, []);

  const handleMobileFilePress = React.useCallback(() => {
    showMobileFileUploadState('idle');
    setMobileFileUploadProgress(0);
    mobileFileInputRef.current?.click();
  }, [showMobileFileUploadState]);

  const handleMobileFileChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setMobileFileUploadProgress(0);
    showMobileFileUploadState('uploading');
    void uploadTemporaryFileAndInsertReference(file, (directory, files) => (
      uploadFiles(directory, files, undefined, setMobileFileUploadProgress)
    ), (uploadedPath) => {
      if (!isActiveRef.current || isConnectionTransitionRef.current) {
        throw new Error('Terminal unavailable');
      }
      window.dispatchEvent(new CustomEvent('termdock-insert-reference', {
        detail: { text: buildReferenceInputText(uploadedPath, null), focus: true },
      }));
    }).then(
      () => showMobileFileUploadState('inserted'),
      () => showMobileFileUploadState('failed'),
    );
  }, [showMobileFileUploadState]);

  // 重连抖动修复：auto-recreate / 短线重连过渡期 activeProgram 会被清成 null
  // （clearTerminalSession），随后 connected 事件再写回。若直接用它推导 preset，
  // 桌面工具条 showOnDesktop 会 true→false→true 跳变（max-h-24↔max-h-0 塌陷/撑开），
  // 作为 terminal flex 同级元素挤压高度，触发 ResizeObserver→fit，造成布局抖动。
  // 过渡期沿用上一次稳定的 activeProgram，让 preset/工具条高度保持不变。
  const isConnectionTransition = isConnecting || connectionError !== null;
  isConnectionTransitionRef.current = isConnectionTransition;
  const stableActiveProgramRef = React.useRef(detectedActiveProgram);
  if (!isConnectionTransition) {
    stableActiveProgramRef.current = detectedActiveProgram;
  }
  const presetActiveProgram = isConnectionTransition ? stableActiveProgramRef.current : detectedActiveProgram;
  const detectedPreset = React.useMemo(() => detectToolbarPreset(presetActiveProgram, toolbarPresets), [presetActiveProgram, toolbarPresets]);
  const storedPreset = React.useMemo(() => getToolbarPreset(toolbarPresets, toolbarPresetMode), [toolbarPresetMode, toolbarPresets]);
  const renderPresetMode = !isMobile && toolbarPresetMode !== 'auto' && storedPreset.showOnDesktop !== true
    ? 'auto'
    : toolbarPresetMode;
  const effectivePresetId = renderPresetMode === 'auto' ? detectedPreset : renderPresetMode;
  const toolbarPreset = React.useMemo(() => getToolbarPreset(toolbarPresets, effectivePresetId), [effectivePresetId, toolbarPresets]);
  const runtimeToolbarActions = React.useMemo(
    () => toolbarPreset.actions
      .filter((action: { sequence: string }) => action.sequence.trim().length > 0)
      .map((action: { id: string; label: string; sequence: string; doubleTapSequence?: string }, index: number) => ({
        ...action,
        label: getToolbarActionLabel(action, index),
      })),
    [toolbarPreset.actions]
  );
  const activeProgramLabel = React.useMemo(() => normalizeActiveProgram(detectedActiveProgram), [detectedActiveProgram]);
  const presetLabel = toolbarPreset.label;
  const presetModeLabel = React.useMemo(() => {
    if (renderPresetMode !== 'auto') {
      return `Manual preset: ${toolbarPreset.label}`;
    }

    return activeProgramLabel
      ? `Auto preset · ${toolbarPreset.label} (${activeProgramLabel})`
      : 'Auto preset';
  }, [activeProgramLabel, renderPresetMode, toolbarPreset.label]);
  const handlePresetSelect = React.useCallback((mode: ToolbarPresetMode) => {
    setToolbarPresetMode(mode);
  }, []);
  const handleLongPressModeToggle = React.useCallback(() => {
    setMobileLongPressMode((current) => current === 'copy' ? 'arrows' : 'copy');
    setMobileCopyFeedback('idle');
  }, []);
  const resetMobileCopyFeedbackSoon = React.useCallback(() => {
    if (typeof window === 'undefined') return;
    if (mobileCopyFeedbackTimerRef.current !== null) {
      window.clearTimeout(mobileCopyFeedbackTimerRef.current);
    }
    mobileCopyFeedbackTimerRef.current = window.setTimeout(() => {
      mobileCopyFeedbackTimerRef.current = null;
      setMobileCopyFeedback('idle');
    }, 1200);
  }, []);
  const handleMobileLongPressCopyResult = React.useCallback((ok: boolean) => {
    if (mobileCopyFeedbackTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(mobileCopyFeedbackTimerRef.current);
      mobileCopyFeedbackTimerRef.current = null;
    }
    setMobileCopyFeedback(ok ? 'copied' : 'failed');
    resetMobileCopyFeedbackSoon();
  }, [resetMobileCopyFeedbackSoon]);
  const handleExpandedChange = React.useCallback((nextExpanded: boolean) => {
    setShowExtendedKeyboard(nextExpanded);
  }, []);
  const presetOptions = React.useMemo(
    () => (isMobile ? buildToolbarPresetOptions(toolbarPresets) : buildDesktopToolbarPresetOptions(toolbarPresets)),
    [isMobile, toolbarPresets],
  );

  const xtermTheme = React.useMemo(() => getTerminalTheme(colorTheme), [colorTheme]);

  const terminalSessionKey = React.useMemo(() => {
    // 故意只用前端 sessionId（每个 tab 一个，整个生命周期不变），
    // 不绑后端 terminalSessionId。否则 auto-recreate（后端 session 被 idle 清掉后
    // 重建）会让 key 从 `terminal::abc` → `terminal::pending` → `terminal::xyz`
    // 走两次，TerminalViewport 整个被 unmount/remount，loadingState 回到 'loading'，
    // 用户看到一次"全屏 loading"。
    //
    // 改成前端 sessionId 后，viewport 实例稳定不动，xterm/WebGL 都不需要重建；
    // 后端 session 变更时由 'connected' 事件里的显式 clear() 处理画面同步。
    return `terminal::${sessionId}`;
  }, [sessionId]);

  React.useEffect(() => {
    onStatusChange?.({
      isConnecting,
      isRestarting,
      hasError: !!connectionError,
      sessionId: terminalSessionId,
    });
  }, [isConnecting, isRestarting, connectionError, terminalSessionId, onStatusChange]);

  const quickKeysDisabled = !terminalSessionId || isConnecting || isRestarting;
  const handleViewportTmuxScroll = React.useCallback((direction: 'up' | 'down', lines: number) => {
    if (quickKeysDisabled) {
      return;
    }

    const normalizedLines = Math.max(1, Math.min(Math.floor(lines) || 1, 40));
    handleTmuxScroll(direction, normalizedLines);
  }, [handleTmuxScroll, quickKeysDisabled]);

  React.useEffect(() => {
    if (!isActive || !isMobile) return;
    const controller = terminalControllerRef.current;
    controller?.requestRefresh('resize', {
      skipScrollToBottom: !isViewportKeyboardOpen,
      force: true,
    });
  }, [isActive, isMobile, isViewportKeyboardOpen, viewportKeyboardHeight, sessionId]);

  React.useEffect(() => {
    if (!isActive || !isMobile) return;
    const handleViewportKeyboardChange = (event: Event) => {
      const detail = (event as CustomEvent<{ isOpen?: boolean }>).detail;
      terminalControllerRef.current?.requestRefresh('resize', {
        skipScrollToBottom: detail?.isOpen !== true,
        force: true,
      });
    };
    document.addEventListener('termdock:viewport-keyboard-change', handleViewportKeyboardChange);
    return () => {
      document.removeEventListener('termdock:viewport-keyboard-change', handleViewportKeyboardChange);
    };
  }, [isActive, isMobile, sessionId]);
  // 桌面端工具条的「显隐」只看 preset 是否声明 showOnDesktop，不再绑 isActive。
  // 否则每个非激活 tab 的工具条会被收成 max-h-0，切到该 tab 时 isActive false→true
  // 重新从 0 撑开，重放 150ms 展开动画 + 终端回流，表现为「先消失再冒出来」。
  // 让非激活 slide（已在 Swiper 视图外，用户看不见）保持展开，切进来时直接就是
  // 展开态，同类 tab 间切换不再闪动。交互仍由 isKeyboardInteractive=isActive 控制，
  // 非激活 tab 的按钮照旧禁用，不会误触。
  const isKeyboardVisible = !suppressKeyboard && (isMobile || toolbarPreset.showOnDesktop === true);
  const isKeyboardInteractive = isActive;

  // Apply both values from the same CSS-variable update so the terminal top
  // remains visible while the toolbar moves above the soft keyboard.
  const wrapperStyle = isMobile && !sharedMobileKeyboardLayout
    ? {
        transform: 'translateY(var(--kb-translate-y, 0px))',
        transition: 'none',
      } as React.CSSProperties
    : undefined;

  const keyboardShrinkStyle = isMobile && !sharedMobileKeyboardLayout
    ? {
        marginTop: 'var(--kb-margin-top, 0px)',
        transition: 'none',
      } as React.CSSProperties
    : undefined;

  const keyboard = (
    <MobileKeyboard
      visible={isKeyboardVisible}
      interactive={isKeyboardInteractive}
      presentation={isMobile ? 'mobile' : 'desktop-actions'}
      activeModifier={activeModifier}
      lockedModifier={lockedModifier}
      disabled={quickKeysDisabled}
      defaultShowExtended={showExtendedKeyboard}
      presetLabel={presetLabel}
      presetModeLabel={presetModeLabel}
      presetMode={renderPresetMode}
      presetOptions={presetOptions}
      includeAlt={toolbarPreset.includeAlt}
      presetRowLayout={toolbarPreset.rowLayout}
      extraActions={runtimeToolbarActions}
      onKeyPress={handleMobileKeyPress}
      onTextPress={handleToolbarTextPress}
      onPastePress={isMobile ? handleMobilePastePress : undefined}
      onFilePress={isMobile ? handleMobileFilePress : undefined}
      fileUploadState={mobileFileUploadState}
      fileUploadProgress={mobileFileUploadProgress}
      longPressMode={mobileLongPressMode}
      copyFeedback={mobileCopyFeedback}
      onLongPressModeToggle={handleLongPressModeToggle}
      onModifierToggle={handleModifierToggle}
      onPresetSelect={handlePresetSelect}
      onExpandedChange={handleExpandedChange}
    />
  );
  const touchCapable = typeof window !== 'undefined' &&
    (navigator.maxTouchPoints > 0 || 'ontouchstart' in window);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden" style={wrapperStyle}>
      <input
        ref={mobileFileInputRef}
        type="file"
        className="hidden"
        onChange={handleMobileFileChange}
      />
      {showDebug && (
        <DebugPanel
          isMobile={isMobile}
          isInputFocused={isInputFocused}
          isIOS={isIOS}
          isConnecting={isConnecting}
          connectionError={connectionError}
          terminalSessionId={terminalSessionId}
        />
      )}

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{
          backgroundColor: xtermTheme.background,
          ...keyboardShrinkStyle,
        }}
      >
        <div ref={interactionHostRef} className="h-full w-full box-border">
          <ErrorBoundary
            fallback={
              <div className="flex h-full items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-3 text-center rounded-2xl bg-surface-2 px-6 py-5 shadow-sm">
                  <div className="w-10 h-10 rounded-full bg-destructive/15 flex items-center justify-center">
                    <svg className="w-5 h-5 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                  <span className="text-sm text-muted-foreground">{t('terminal.componentFailed')}</span>
                </div>
              </div>
            }
          >
            <TerminalViewport
              key={terminalSessionKey}
              ref={handleTerminalControllerRef}
              sessionKey={terminalSessionKey}
              isLayoutVisible={isLayoutVisible}
              chunks={bufferChunks}
              onInput={handleViewportInput}
              onResize={handleViewportResize}
              onFlowControl={handleFlowControl}
              onTmuxScroll={isTmuxMode ? handleViewportTmuxScroll : undefined}
              tmuxScrollSensitivity={0.38}
              onDoubleTap={isMobile ? () => {
                terminalControllerRef.current?.sendSequence('\t');
              } : undefined}
              onInputFocusChange={handleInputFocusChange}
              onMobileLongPressCopyResult={handleMobileLongPressCopyResult}
              onReadyChange={handleViewportReadyChange}
              onSizeSynchronizedChange={setIsInitialSizeReady}
              onKeyboardResizeSettlingChange={handleKeyboardResizeSettlingChange}
              onWritesSettled={handleViewportWritesSettled}
              onWriteProgress={handleViewportWriteProgress}
              onCursorPositionChange={handleViewportCursorPositionChange}
              onDirectoryLinkActivate={handleDirectoryLinkActivate}
              terminalSettings={effectiveTerminalSettings}
              theme={xtermTheme}
              enableTouchScroll={isMobile}
              mobileLongPressMode={mobileLongPressMode}
              autoFocus={!focusSuspended && !isMobile && !touchCapable}
              cursorVisible={
                !focusSuspended
                && isCursorPresentationReady
                && !isKeyboardResizeSettling
                && isKeyboardCursorReady
              }
              suppressSmoothScroll={!isInitialContentReady || !isInitialSizeReady}
              className={
                focusSuspended
                || !isCursorPresentationReady
                || isKeyboardResizeSettling
                || !isKeyboardCursorReady
                  ? 'terminal-focus-suspended'
                  : undefined
              }
            />
          </ErrorBoundary>
        </div>

        <ConnectionStatus
          connectionError={connectionError}
          isFatalError={isFatalError}
          isRestarting={isRestarting}
          isConnecting={isConnecting}
          onHardRestart={handleHardRestart}
        />

      </div>

      {keyboardPortalTarget
        ? (suppressKeyboard ? null : createPortal(keyboard, keyboardPortalTarget))
        : keyboard}
    </div>
  );
};

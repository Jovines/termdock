import { useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

// 「超长按」阈值：必须明显长于 @hello-pangea/dnd 触屏拖拽的 120ms 抬起，
// 让「按住并拖动排序」和「按住不动出菜单」两个手势可区分。期间 tab 会先
// 进入 dnd 抬起态（正好作为按压反馈），松手无移动时 dnd 自动取消、不排序。
const SUPER_LONG_PRESS_MS = 550;
const MOVE_TOLERANCE_PX = 10;

export interface SuperLongPressHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
}

/**
 * 触屏/手写笔「超长按」手势。系统 contextmenu 在移动端不可靠（全局禁用了
 * -webkit-touch-callout / user-select，iOS PWA 完全不触发），长按手势只能
 * 自己实现。触发后吞掉随后的 click，避免误触发元素本身的点击行为
 * （如切换会话）。dnd 拖拽抬起（120ms）后无移动松手不会产生排序，双方共存。
 *
 * 用法：const bindSuperLongPress = useSuperLongPress();
 *      <div {...bindSuperLongPress(() => openMenu(id))} />
 * 一个组件实例可安全地为多个元素 bind（内部按 pointerId 跟踪单点触摸）。
 */
export function useSuperLongPress() {
  const timerRef = useRef<number | null>(null);
  const pointerRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  const firedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const suppressClearTimerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    pointerRef.current = null;
  }, [clearTimer]);

  const bind = useCallback((onFire: () => void): SuperLongPressHandlers => ({
    onPointerDown: (event) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      reset();
      firedRef.current = false;
      pointerRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (!pointerRef.current) return;
        firedRef.current = true;
        onFire();
      }, SUPER_LONG_PRESS_MS);
    },
    onPointerMove: (event) => {
      const pointer = pointerRef.current;
      if (!pointer || pointer.pointerId !== event.pointerId || firedRef.current) return;
      const dx = event.clientX - pointer.startX;
      const dy = event.clientY - pointer.startY;
      // 移动即视为滚动/拖拽意图，取消长按计时
      if (Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) reset();
    },
    onPointerUp: (event) => {
      if (firedRef.current) {
        event.preventDefault();
        firedRef.current = false;
        // 吞掉紧随 touchend 的合成 click（防止误触发元素自身的点击行为）。
        // 但 click 可能落空——长按弹出的浮层盖住原元素时，合成 click 会派发到
        // 两者的公共祖先而非本元素。加兜底超时，否则残留标志会误吞下一次正常点击。
        suppressClickRef.current = true;
        if (suppressClearTimerRef.current != null) {
          window.clearTimeout(suppressClearTimerRef.current);
        }
        suppressClearTimerRef.current = window.setTimeout(() => {
          suppressClickRef.current = false;
          suppressClearTimerRef.current = null;
        }, 600);
      }
      reset();
    },
    onPointerCancel: reset,
    onPointerLeave: (event) => {
      const pointer = pointerRef.current;
      if (pointer?.pointerId === event.pointerId && !firedRef.current) reset();
    },
    onClickCapture: (event) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      if (suppressClearTimerRef.current != null) {
        window.clearTimeout(suppressClearTimerRef.current);
        suppressClearTimerRef.current = null;
      }
      event.preventDefault();
      event.stopPropagation();
    },
  }), [reset]);

  return bind;
}

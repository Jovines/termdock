// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type RFB from '@novnc/novnc';
import { vncPointer } from './pointer';
it('starts a VNC touchpad gesture at the latest physical cursor, including viewport scaling and clipping', () => {
  const vnc = { _fbWidth: 1000, _fbHeight: 600, _canvas: document.createElement('canvas'),
    _mousePos: { x: 40, y: 60 }, _display: { scale: 0.5, absX: (x: number) => 100 + x / 0.5, absY: (y: number) => 120 + y / 0.5 },
    _mouseMoveTimer: null, _sendMouse: vi.fn() };
  const pointer = vncPointer(vnc as unknown as RFB);
  expect(pointer.position?.()).toEqual({ x: 180, y: 240 });
  vnc._mousePos = { x: 200, y: 100 };
  expect(pointer.position?.()).toEqual({ x: 500, y: 320 });
});
it('uses the centre only while noVNC has not observed a cursor position yet', () => {
  const vnc = { _fbWidth: 1000, _fbHeight: 600, _mousePos: {}, _display: { absX: vi.fn(), absY: vi.fn() } };
  expect(vncPointer(vnc as unknown as RFB).position?.()).toEqual({ x: 500, y: 300 });
});

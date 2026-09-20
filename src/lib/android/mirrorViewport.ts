/** Local view coordinates; independent of device pixels and React rendering. */
export interface ViewPoint { x: number; y: number }
export interface MirrorViewport { zoom: number; pan: ViewPoint }
export interface ViewportGeometry {
  cx: number;
  cy: number;
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
}

export function constrainMirrorPan(pan: ViewPoint, zoom: number, box: ViewportGeometry): ViewPoint {
  // Preserve the fitted image's original margins. Using the whole stage here
  // locks letterboxed axes and pulls an off-centre pinch away from the fingers.
  const maxX = box.contentWidth * (zoom - 1) / 2;
  const maxY = box.contentHeight * (zoom - 1) / 2;
  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y)),
  };
}

/** Apply one input sample to the visible pose, discarding motion beyond bounds. */
export function moveMirrorViewport(
  view: MirrorViewport, box: ViewportGeometry,
  previousFocus: ViewPoint, focus: ViewPoint, ratio: number,
): MirrorViewport {
  const zoom = Math.max(1, Math.min(8, view.zoom * ratio));
  const scale = zoom / view.zoom;
  return {
    zoom,
    pan: constrainMirrorPan({
      x: focus.x - box.cx - (previousFocus.x - box.cx - view.pan.x) * scale,
      y: focus.y - box.cy - (previousFocus.y - box.cy - view.pan.y) * scale,
    }, zoom, box),
  };
}

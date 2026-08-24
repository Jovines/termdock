import { execFile } from 'child_process';

export interface KicadNearestObject {
  kind: 'footprint' | 'pad' | 'track' | 'via';
  label: string;
  reference?: string;
  pad?: string;
  net?: string;
  layer: string;
  distanceMm: number;
}

export interface KicadPointInspection {
  available: boolean;
  xMm?: number;
  yMm?: number;
  layer?: string;
  nearest?: KicadNearestObject;
  reason?: string;
}

const KICAD_INSPECTION_SCRIPT = String.raw`
import json, math, sys
import pcbnew

board_path, view, x_text, y_text = sys.argv[1:5]
x_percent = float(x_text)
y_percent = float(y_text)

if view not in ('pcb-front', 'pcb-back'):
    print(json.dumps({'available': False, 'reason': '该视图不支持精确 PCB 坐标'}))
    raise SystemExit(0)

board = pcbnew.LoadBoard(board_path)
box = board.GetBoardEdgesBoundingBox()
left = pcbnew.ToMM(box.GetLeft())
top = pcbnew.ToMM(box.GetTop())
width = pcbnew.ToMM(box.GetWidth())
height = pcbnew.ToMM(box.GetHeight())
source_x_percent = 100.0 - x_percent if view == 'pcb-back' else x_percent
x_mm = left + width * source_x_percent / 100.0
y_mm = top + height * y_percent / 100.0
visible_layer_id = pcbnew.F_Cu if view == 'pcb-front' else pcbnew.B_Cu
visible_layer = board.GetLayerName(visible_layer_id)
candidates = []

def distance(x, y):
    return math.hypot(x - x_mm, y - y_mm)

def add(kind, label, layer, x, y, reference=None, pad=None, net=None):
    item = {
        'kind': kind,
        'label': label,
        'layer': layer,
        'distanceMm': distance(x, y),
    }
    if reference:
        item['reference'] = reference
    if pad:
        item['pad'] = pad
    if net:
        item['net'] = net
    candidates.append(item)

for footprint in board.GetFootprints():
    reference = footprint.GetReference()
    value = footprint.GetValue()
    fp_layer = footprint.GetLayerName()
    if footprint.GetLayer() == visible_layer_id:
        pos = footprint.GetPosition()
        add('footprint', reference + (f' ({value})' if value else ''), fp_layer,
            pcbnew.ToMM(pos.x), pcbnew.ToMM(pos.y), reference=reference)
    for pad_item in footprint.Pads():
        if not pad_item.IsOnLayer(visible_layer_id):
            continue
        pos = pad_item.GetPosition()
        pad_number = pad_item.GetNumber()
        net_name = pad_item.GetNetname()
        label = reference + (f' 焊盘 {pad_number}' if pad_number else ' 焊盘')
        add('pad', label, visible_layer, pcbnew.ToMM(pos.x), pcbnew.ToMM(pos.y),
            reference=reference, pad=pad_number or None, net=net_name or None)

def segment_distance(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

for track in board.GetTracks():
    if isinstance(track, pcbnew.PCB_VIA):
        if not track.IsOnLayer(visible_layer_id):
            continue
        pos = track.GetPosition()
        net_name = track.GetNetname()
        add('via', '过孔', 'F.Cu↔B.Cu', pcbnew.ToMM(pos.x), pcbnew.ToMM(pos.y), net=net_name or None)
        continue
    if track.GetLayer() != visible_layer_id:
        continue
    start, end = track.GetStart(), track.GetEnd()
    ax, ay = pcbnew.ToMM(start.x), pcbnew.ToMM(start.y)
    bx, by = pcbnew.ToMM(end.x), pcbnew.ToMM(end.y)
    net_name = track.GetNetname()
    item = {
        'kind': 'track',
        'label': '走线',
        'layer': track.GetLayerName(),
        'distanceMm': segment_distance(x_mm, y_mm, ax, ay, bx, by),
    }
    if net_name:
        item['net'] = net_name
    candidates.append(item)

candidates.sort(key=lambda item: item['distanceMm'])
nearest = candidates[0] if candidates else None
if nearest:
    nearest['distanceMm'] = round(nearest['distanceMm'], 3)

result = {
    'available': True,
    'xMm': round(x_mm, 3),
    'yMm': round(y_mm, 3),
    'layer': visible_layer,
}
if nearest:
    result['nearest'] = nearest
print(json.dumps(result, ensure_ascii=False))
`;

export function inspectKicadBoardPoint(
  boardPath: string,
  view: string,
  xPercent: number,
  yPercent: number,
  signal: AbortSignal,
): Promise<KicadPointInspection> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(
      'python3',
      ['-c', KICAD_INSPECTION_SCRIPT, boardPath, view, String(xPercent), String(yPercent)],
      { maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abortHandler);
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as KicadPointInspection);
        } catch {
          reject(new Error('KiCad point inspection returned invalid JSON'));
        }
      },
    );
    const abortHandler = () => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(signal.reason instanceof Error ? signal.reason : new Error('KiCad point inspection aborted'));
    };
    if (signal.aborted) abortHandler();
    else signal.addEventListener('abort', abortHandler, { once: true });
  });
}

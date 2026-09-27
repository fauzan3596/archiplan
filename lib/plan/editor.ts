// Pure reducer for the 2D plan editor (WP3). Plan space is METRES, x right /
// y down (see type.d.ts). Every geometry commit (COMMIT_DRAG, ADD_WALL,
// DELETE_SELECTED on a wall, SPLIT_WALL, APPLY_FIX / APPLY_SAFE_FIXES that
// change walls, REBUILD_ROOMS) runs rebuildRooms() and adopts its walls, rooms
// AND openings, then normalizeWallOpenings() and planIssues(). Undo/redo keep
// snapshots of whole plans (cap UNDO_LIMIT), so UNDO restores plan identity.

import {
  normalizeDeg,
  planBounds,
  pointInPolygon,
  rescalePlan,
  wallLength,
} from "./convert";
import {
  AXIS_TOLERANCE_DEG,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  EDITOR_SNAP_M,
  MAX_WALL_THICKNESS,
  MIN_WALL_THICKNESS,
  REBUILD_EPS_M,
  defaultOpeningVertical,
  newId,
} from "./defaults";
import { applyFix, planIssues, rebuildRooms } from "./geometry";
import { normalizeWallOpenings } from "./validate";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type EditorTool =
  | "select"
  | "wall"
  | "door"
  | "window"
  | "opening"
  | "calibrate"
  | "north";

export type EditorSelection = {
  kind: "wall" | "opening" | "room";
  id: string;
} | null;

export type WallEnd = "a" | "b";

export interface EditorDrag {
  wallId: string;
  end: WallEnd;
  /** plan before the drag started (restored by CANCEL_DRAG, pushed on undo) */
  original: FloorPlan;
  /** other wall ends that coincided with the dragged end and move with it */
  linked: { wallId: string; end: WallEnd }[];
}

export interface EditorState {
  plan: FloorPlan;
  tool: EditorTool;
  selection: EditorSelection;
  /** wall tool preview (snapped) */
  draft: { a: PlanPoint; b: PlanPoint } | null;
  drag: EditorDrag | null;
  /** two-point calibration picks (metres of the current plan); {} while the tool is armed */
  calibration: { a?: PlanPoint; b?: PlanPoint } | null;
  past: FloorPlan[];
  future: FloorPlan[];
  /** planIssues(plan); APPLY_FIX indexes into this list */
  issues: PlanIssue[];
  /** editedAt the shell stamped on the last push (or of the last adopted plan) */
  lastPushedEditedAt: string | null;
  /** transient one-line message about the last commit (e.g. dropped openings) */
  notice: string | null;
}

export interface OpeningPatch {
  kind?: PlanOpeningKind;
  /** metres; re-centred on the current centre and fitted between neighbours */
  width?: number;
  bottom?: number;
  top?: number;
  doorSubtype?: PlanDoorSubtype | null;
}

export interface WallPatch {
  thickness?: number;
  height?: number;
}

export type EditorAction =
  | { type: "REPLACE_PLAN"; plan: FloorPlan }
  | { type: "SET_TOOL"; tool: EditorTool }
  | { type: "SELECT"; selection: EditorSelection }
  | { type: "BEGIN_DRAG"; wallId: string; end: WallEnd; detach?: boolean }
  | { type: "DRAG_ENDPOINT"; point: PlanPoint; snap?: boolean }
  | { type: "COMMIT_DRAG" }
  | { type: "CANCEL_DRAG" }
  | {
      type: "DRAFT_WALL";
      draft: { a: PlanPoint; b: PlanPoint } | null;
      snap?: boolean;
    }
  | {
      type: "ADD_WALL";
      a: PlanPoint;
      b: PlanPoint;
      snap?: boolean;
      thickness?: number;
      /** keep drawing: the new draft starts at the (snapped) end point */
      chain?: boolean;
    }
  | { type: "SPLIT_WALL"; wallId: string; point: PlanPoint }
  | { type: "DELETE_SELECTED" }
  | {
      type: "ADD_OPENING";
      wallId: string;
      kind: PlanOpeningKind;
      /** centre parameter along the wall a -> b */
      t: number;
      /** metres; defaults to OPENING_DEFAULT_WIDTH[kind] */
      width?: number;
    }
  | { type: "MOVE_OPENING"; id: string; t: number; wallId?: string }
  | { type: "SET_OPENING"; id: string; patch: OpeningPatch }
  | { type: "SET_WALL"; id: string; patch: WallPatch }
  | { type: "SET_WALL_HEIGHT"; height: number }
  | { type: "RENAME_ROOM"; id: string; name: string }
  | { type: "SET_ROOM_TYPE"; id: string; roomType: PlanRoomType | null }
  | { type: "SET_ROOM_FLOOR_MATERIAL"; id: string; materialId: string | null }
  | { type: "SET_ROOM_ANCHOR"; id: string; point: PlanPoint }
  | { type: "SET_DEFAULT_MATERIALS"; patch: Partial<PlanMaterials> }
  | { type: "SET_NORTH"; deg: number }
  | { type: "CALIBRATE_POINT"; point: PlanPoint }
  | { type: "CALIBRATE_APPLY"; metres: number }
  | { type: "CALIBRATE_TOTAL_WIDTH"; metres: number }
  | { type: "CALIBRATE_CANCEL" }
  | { type: "CONFIRM_SCALE" }
  | { type: "APPLY_FIX"; issueIndex: number }
  | { type: "APPLY_SAFE_FIXES" }
  | { type: "REBUILD_ROOMS" }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "MARK_PUSHED"; editedAt: string };

export type SnapKind = "endpoint" | "wall" | "axis" | "free";

export interface SnapResult {
  point: PlanPoint;
  kind: SnapKind;
  /** axis the point was locked to relative to `from` ("x" = vertical line) */
  locked: "x" | "y" | "both" | null;
  /** wall whose body the point was snapped onto */
  wallId?: string;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const UNDO_LIMIT = 50;

/** Tool order; keyboard shortcut = index + 1. */
export const EDITOR_TOOLS: readonly EditorTool[] = [
  "select",
  "wall",
  "door",
  "window",
  "opening",
  "calibrate",
  "north",
];

export const OPENING_DEFAULT_WIDTH: Record<PlanOpeningKind, number> = {
  door: 0.85,
  window: 1.2,
  opening: 0.9,
};

/** rebuildRooms drops walls shorter than 1.5 * eps, so refuse them up front */
export const MIN_WALL_LENGTH_M = 1.5 * REBUILD_EPS_M;
export const MIN_OPENING_WIDTH_M = 0.3;
export const MIN_WALL_HEIGHT_M = 2;
export const MAX_WALL_HEIGHT_M = 8;

const LINK_TOL_M = 1e-3;
const HEIGHT_MATCH_TOL_M = 1e-3;
const MIN_CALIBRATION_PX = 4;

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

const dist = (p: PlanPoint, q: PlanPoint): number =>
  Math.hypot(q.x - p.x, q.y - p.y);

const copy = (p: PlanPoint): PlanPoint => ({ x: p.x, y: p.y });

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

const lerp = (a: PlanPoint, b: PlanPoint, t: number): PlanPoint => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

const isFinitePoint = (p: PlanPoint | null | undefined): p is PlanPoint =>
  Boolean(p) && Number.isFinite(p!.x) && Number.isFinite(p!.y);

/** Tallest wall (DEFAULT_WALL_HEIGHT without walls): the "Tinggi dinding" value. */
export const planWallHeight = (plan: FloorPlan): number => {
  const h = plan.walls.reduce((max, w) => (w.height > max ? w.height : max), 0);
  return h > 0 ? h : DEFAULT_WALL_HEIGHT;
};

/** Closest point on the wall segment: parameter t in [0, 1] and its distance (m). */
export const projectOntoWall = (
  w: PlanWall,
  p: PlanPoint,
): { t: number; dist: number } => {
  const dx = w.b.x - w.a.x;
  const dy = w.b.y - w.a.y;
  const len2 = dx * dx + dy * dy;
  const raw =
    len2 < 1e-18 ? 0 : ((p.x - w.a.x) * dx + (p.y - w.a.y) * dy) / len2;
  const t = clamp(raw, 0, 1);
  return { t, dist: dist(p, lerp(w.a, w.b, t)) };
};

/** Nearest wall to p within maxDist metres (null when none). */
export const nearestWall = (
  plan: FloorPlan,
  p: PlanPoint,
  maxDist: number,
): { wall: PlanWall; t: number; dist: number } | null => {
  let best: { wall: PlanWall; t: number; dist: number } | null = null;
  for (const w of plan.walls) {
    if (wallLength(w) < 1e-9) continue;
    const proj = projectOntoWall(w, p);
    if (proj.dist > maxDist) continue;
    if (!best || proj.dist < best.dist) best = { wall: w, ...proj };
  }
  return best;
};

/**
 * northOffsetDeg for "this direction (from `center` towards `point`) is north".
 * The clicked direction is theta degrees clockwise from plan-up, so plan-up's
 * bearing is (360 - theta) % 360 (same convention as northOffsetFromExtraction).
 */
export const northOffsetFromDirection = (
  center: PlanPoint,
  point: PlanPoint,
): number | null => {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  if (Math.hypot(dx, dy) < 1e-9) return null;
  const theta = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return normalizeDeg(360 - theta);
};

// -----------------------------------------------------------------------------
// Snapping
// -----------------------------------------------------------------------------

interface AxisCandidate {
  axis: "x" | "y";
  value: number;
  disp: number;
  from: PlanPoint;
}

const axisCandidates = (p: PlanPoint, froms: PlanPoint[]): AxisCandidate[] => {
  const out: AxisCandidate[] = [];
  for (const from of froms) {
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    if (Math.hypot(dx, dy) < 1e-9) continue;
    const ang = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI); // 0..180
    const offHorizontal = Math.min(ang, 180 - ang);
    const offVertical = Math.abs(90 - ang);
    if (offHorizontal <= AXIS_TOLERANCE_DEG) {
      out.push({ axis: "y", value: from.y, disp: Math.abs(dy), from });
    } else if (offVertical <= AXIS_TOLERANCE_DEG) {
      out.push({ axis: "x", value: from.x, disp: Math.abs(dx), from });
    }
  }
  return out;
};

/** Moves `point` onto a nearby wall body: along the locked axis line when one
 *  is locked, else by perpendicular projection. */
const snapToWallBody = (
  walls: PlanWall[],
  point: PlanPoint,
  locked: AxisCandidate | null,
  froms: PlanPoint[],
): { point: PlanPoint; wallId: string } | null => {
  let best: { point: PlanPoint; wallId: string; d: number } | null = null;
  const isFrom = (q: PlanPoint) => froms.some((f) => dist(f, q) < 1e-6);

  for (const w of walls) {
    if (wallLength(w) < 1e-9) continue;
    let candidate: PlanPoint | null = null;

    if (locked) {
      // Intersect the locked line (x = value or y = value) with the segment.
      const along = locked.axis === "y" ? "y" : "x";
      const other = along === "y" ? "x" : "y";
      const span = w.b[along] - w.a[along];
      if (Math.abs(span) < 1e-9) continue; // parallel to the locked line
      const s = (locked.value - w.a[along]) / span;
      if (s < -1e-9 || s > 1 + 1e-9) continue;
      const cross = w.a[other] + (w.b[other] - w.a[other]) * s;
      candidate =
        along === "y"
          ? { x: cross, y: locked.value }
          : { x: locked.value, y: cross };
    } else {
      const { t } = projectOntoWall(w, point);
      candidate = lerp(w.a, w.b, t);
    }

    if (!candidate || isFrom(candidate)) continue;
    const d = dist(candidate, point);
    if (d > EDITOR_SNAP_M) continue;
    if (!best || d < best.d) best = { point: candidate, wallId: w.id, d };
  }

  return best ? { point: best.point, wallId: best.wallId } : null;
};

/**
 * Snap with several fixed "from" points (a dragged corner moves every wall
 * that meets there; each wall's fixed end is a from). Order: nearest endpoint
 * of a non-ignored wall within EDITOR_SNAP_M, then axis lock (<=
 * AXIS_TOLERANCE_DEG from any from; when an x and a y lock compete, only the
 * one needing the smaller shift wins unless both shifts are within
 * EDITOR_SNAP_M), then onto a nearby wall body, else free.
 */
export const snapPointMulti = (
  plan: FloorPlan,
  p: PlanPoint,
  froms: PlanPoint[],
  ignoreWallIds: ReadonlySet<string>,
): SnapResult => {
  const walls = plan.walls.filter((w) => !ignoreWallIds.has(w.id));
  const isFrom = (q: PlanPoint) => froms.some((f) => dist(f, q) < 1e-9);

  let bestEnd: PlanPoint | null = null;
  let bestEndDist = EDITOR_SNAP_M;
  for (const w of walls) {
    for (const q of [w.a, w.b]) {
      if (isFrom(q)) continue;
      const d = dist(p, q);
      if (d <= bestEndDist) {
        bestEnd = q;
        bestEndDist = d;
      }
    }
  }
  if (bestEnd) return { point: copy(bestEnd), kind: "endpoint", locked: null };

  const cands = axisCandidates(p, froms);
  const pick = (axis: "x" | "y"): AxisCandidate | null =>
    cands
      .filter((c) => c.axis === axis)
      .sort((c, d) => c.disp - d.disp)[0] ?? null;
  let lockX = pick("x");
  let lockY = pick("y");
  if (lockX && lockY) {
    const bothSmall =
      lockX.disp <= EDITOR_SNAP_M && lockY.disp <= EDITOR_SNAP_M;
    if (!bothSmall) {
      if (lockX.disp <= lockY.disp) lockY = null;
      else lockX = null;
    }
  }

  const point = copy(p);
  if (lockX) point.x = lockX.value;
  if (lockY) point.y = lockY.value;
  const locked: SnapResult["locked"] =
    lockX && lockY ? "both" : lockX ? "x" : lockY ? "y" : null;

  if (locked !== "both") {
    const body = snapToWallBody(walls, point, lockX ?? lockY, froms);
    if (body) {
      return { point: body.point, kind: "wall", locked, wallId: body.wallId };
    }
  }

  return { point, kind: locked ? "axis" : "free", locked };
};

/** Detailed variant of snapPoint (kind + lock info for the editor's snap marker). */
export const snapPointInfo = (
  plan: FloorPlan,
  p: PlanPoint,
  from?: PlanPoint | null,
  ignoreWallId?: string | null,
): SnapResult =>
  snapPointMulti(
    plan,
    p,
    from ? [from] : [],
    new Set(ignoreWallId ? [ignoreWallId] : []),
  );

/**
 * Nearest other wall endpoint within EDITOR_SNAP_M, else axis lock relative to
 * `from` when <= AXIS_TOLERANCE_DEG off-axis, then onto a wall body within
 * EDITOR_SNAP_M (so T-junctions land exactly on the wall), else free.
 */
export const snapPoint = (
  plan: FloorPlan,
  p: PlanPoint,
  from?: PlanPoint | null,
  ignoreWallId?: string | null,
): PlanPoint => snapPointInfo(plan, p, from, ignoreWallId).point;

// -----------------------------------------------------------------------------
// Opening placement
// -----------------------------------------------------------------------------

/** Free parameter interval on a wall around t (other openings excluded), or null
 *  when t lies inside another opening. */
const freeIntervalAt = (
  plan: FloorPlan,
  wallId: string,
  t: number,
  excludeId?: string,
): { lo: number; hi: number } | null => {
  let lo = 0;
  let hi = 1;
  for (const o of plan.openings) {
    if (o.wallId !== wallId || o.id === excludeId) continue;
    if (t > o.t0 + 1e-9 && t < o.t1 - 1e-9) return null;
    if (o.t1 <= t + 1e-9 && o.t1 > lo) lo = o.t1;
    if (o.t0 >= t - 1e-9 && o.t0 < hi) hi = o.t0;
  }
  return hi - lo > 1e-9 ? { lo, hi } : null;
};

const fitSpan = (
  free: { lo: number; hi: number },
  center: number,
  span: number,
): { t0: number; t1: number } => {
  const s = Math.min(span, free.hi - free.lo);
  const c = clamp(center, free.lo + s / 2, free.hi - s / 2);
  return { t0: c - s / 2, t1: c + s / 2 };
};

/**
 * Where an opening lands when its centre is moved to parameter `t` on
 * `wallId` (default: its own wall), keeping its width and staying clear of the
 * neighbours: on its own wall it slides inside the gap around its current
 * position, on another wall it needs a free gap at `t`. Null when it cannot go
 * there. Shared by MOVE_OPENING and the editor's drag preview.
 */
export const moveOpeningSpan = (
  plan: FloorPlan,
  id: string,
  t: number,
  wallId?: string,
): Pick<PlanOpening, "wallId" | "t0" | "t1" | "bottom" | "top"> | null => {
  const o = plan.openings.find((x) => x.id === id);
  if (!o || !Number.isFinite(t)) return null;
  const host = plan.walls.find((w) => w.id === o.wallId);
  const targetId = wallId ?? o.wallId;
  const target = plan.walls.find((w) => w.id === targetId);
  if (!host || !target) return null;
  const targetLen = wallLength(target);
  if (targetLen < 1e-9) return null;
  const span = ((o.t1 - o.t0) * wallLength(host)) / targetLen;
  const tc = clamp(t, 0, 1);
  const sameWall = targetId === o.wallId;
  const free = freeIntervalAt(plan, targetId, sameWall ? (o.t0 + o.t1) / 2 : tc, o.id);
  if (!free || (free.hi - free.lo) * targetLen < MIN_OPENING_WIDTH_M) return null;
  return {
    wallId: targetId,
    ...fitSpan(free, tc, span),
    bottom: sameWall ? o.bottom : Math.min(o.bottom, target.height),
    top: sameWall ? o.top : Math.min(o.top, target.height),
  };
};

// -----------------------------------------------------------------------------
// Commit helpers
// -----------------------------------------------------------------------------

const withNormalizedOpenings = (plan: FloorPlan): FloorPlan => ({
  ...plan,
  openings: normalizeWallOpenings(plan.openings, plan.walls),
});

const selectionExists = (plan: FloorPlan, sel: EditorSelection): boolean => {
  if (!sel) return true;
  if (sel.kind === "wall") return plan.walls.some((w) => w.id === sel.id);
  if (sel.kind === "opening") return plan.openings.some((o) => o.id === sel.id);
  return plan.rooms.some((r) => r.id === sel.id);
};

const sanitize = (state: EditorState): EditorState =>
  selectionExists(state.plan, state.selection)
    ? state
    : { ...state, selection: null };

/** Pushes `base` (default: the current plan) onto the undo stack and adopts `next`. */
const commit = (
  state: EditorState,
  next: FloorPlan,
  opts: { base?: FloorPlan; extra?: Partial<EditorState> } = {},
): EditorState => {
  const base = opts.base ?? state.plan;
  if (next === base) {
    return opts.extra ? sanitize({ ...state, ...opts.extra }) : state;
  }
  const plan = withNormalizedOpenings(next);
  return sanitize({
    ...state,
    notice: null,
    ...opts.extra,
    plan,
    past: [...state.past, base].slice(-UNDO_LIMIT),
    future: [],
    issues: planIssues(plan),
  });
};

/** rebuildRooms + adopt walls, rooms and openings (optionally dropping stale rooms). */
const rebuildPlan = (
  plan: FloorPlan,
  dropStale = false,
): { plan: FloorPlan; dropped: string[] } => {
  const r = rebuildRooms(plan);
  const rooms = dropStale ? r.rooms.filter((room) => !room.stale) : r.rooms;
  return {
    plan: {
      ...plan,
      walls: r.walls,
      rooms,
      openings: normalizeWallOpenings(r.openings, r.walls),
    },
    dropped: r.droppedOpenings,
  };
};

const droppedNotice = (dropped: string[]): string | null =>
  dropped.length === 0
    ? null
    : `${dropped.length} bukaan dilepas karena tidak lagi menempel pada dinding.`;

const sameGeometry = (p: FloorPlan, q: FloorPlan): boolean =>
  JSON.stringify([p.walls, p.rooms, p.openings]) ===
  JSON.stringify([q.walls, q.rooms, q.openings]);

const commitGeometry = (
  state: EditorState,
  next: FloorPlan,
  opts: {
    base?: FloorPlan;
    extra?: Partial<EditorState>;
    dropStale?: boolean;
  } = {},
): EditorState => {
  const base = opts.base ?? state.plan;
  const rebuilt = rebuildPlan(next, opts.dropStale);
  if (sameGeometry(rebuilt.plan, base)) {
    // Nothing changed after snapping / noding: no undo step, no push.
    return sanitize({ ...state, ...opts.extra, plan: base });
  }
  return commit(state, rebuilt.plan, {
    base,
    extra: { ...opts.extra, notice: droppedNotice(rebuilt.dropped) },
  });
};

const updateRoom = (
  state: EditorState,
  id: string,
  fn: (room: PlanRoom) => PlanRoom | null,
): EditorState => {
  const room = state.plan.rooms.find((r) => r.id === id);
  if (!room) return state;
  const nextRoom = fn(room);
  if (!nextRoom || nextRoom === room) return state;
  return commit(state, {
    ...state.plan,
    rooms: state.plan.rooms.map((r) => (r.id === id ? nextRoom : r)),
  });
};

const clampThickness = (t: number): number =>
  clamp(t, MIN_WALL_THICKNESS, MAX_WALL_THICKNESS);

const rescaleManual = (plan: FloorPlan, pxPerMeter: number): FloorPlan => {
  const scaled = rescalePlan(plan, pxPerMeter, "manual");
  return {
    ...scaled,
    walls: scaled.walls.map((w) => ({ ...w, thickness: clampThickness(w.thickness) })),
  };
};

const toolCalibration = (tool: EditorTool): EditorState["calibration"] =>
  tool === "calibrate" ? {} : null;

// -----------------------------------------------------------------------------
// State factory + queries
// -----------------------------------------------------------------------------

export const createEditorState = (plan: FloorPlan): EditorState => ({
  plan,
  tool: "select",
  selection: null,
  draft: null,
  drag: null,
  calibration: null,
  past: [],
  future: [],
  issues: planIssues(plan),
  lastPushedEditedAt: plan.editedAt ?? null,
  notice: null,
});

export const canUndo = (state: EditorState): boolean => state.past.length > 0;

export const canRedo = (state: EditorState): boolean => state.future.length > 0;

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const cancelDrag = (state: EditorState): EditorState =>
  state.drag ? { ...state, plan: state.drag.original, drag: null } : state;

export const editorReducer = (
  state: EditorState,
  action: EditorAction,
): EditorState => {
  switch (action.type) {
    case "REPLACE_PLAN": {
      const plan = action.plan;
      if (plan === state.plan && !state.drag) {
        return { ...state, lastPushedEditedAt: plan.editedAt ?? null };
      }
      return sanitize({
        ...state,
        plan,
        draft: null,
        drag: null,
        calibration: toolCalibration(state.tool),
        past: [],
        future: [],
        issues: planIssues(plan),
        lastPushedEditedAt: plan.editedAt ?? null,
        notice: null,
      });
    }

    case "SET_TOOL": {
      const base = cancelDrag(state);
      return {
        ...base,
        tool: action.tool,
        draft: null,
        calibration: toolCalibration(action.tool),
      };
    }

    case "SELECT":
      return sanitize({ ...state, selection: action.selection, notice: null });

    // --- endpoint drag ------------------------------------------------------
    case "BEGIN_DRAG": {
      const base = cancelDrag(state);
      const wall = base.plan.walls.find((w) => w.id === action.wallId);
      if (!wall) return base;
      const p = wall[action.end];
      const linked = action.detach
        ? []
        : base.plan.walls.flatMap((o) =>
            o.id === wall.id
              ? []
              : (["a", "b"] as const)
                  .filter((e) => dist(o[e], p) <= LINK_TOL_M)
                  .map((e) => ({ wallId: o.id, end: e })),
          );
      return {
        ...base,
        drag: { wallId: wall.id, end: action.end, original: base.plan, linked },
        selection: { kind: "wall", id: wall.id },
        draft: null,
      };
    }

    case "DRAG_ENDPOINT": {
      const drag = state.drag;
      if (!drag || !isFinitePoint(action.point)) return state;
      const original = drag.original;
      const movers = [{ wallId: drag.wallId, end: drag.end }, ...drag.linked];
      const moverIds = new Set(movers.map((m) => m.wallId));
      const froms: PlanPoint[] = [];
      for (const m of movers) {
        const w = original.walls.find((x) => x.id === m.wallId);
        if (w) froms.push(m.end === "a" ? w.b : w.a);
      }
      const target =
        action.snap === false
          ? copy(action.point)
          : snapPointMulti(original, action.point, froms, moverIds).point;

      const walls = original.walls.map((w) => {
        if (!moverIds.has(w.id)) return w;
        let next = w;
        for (const m of movers) {
          if (m.wallId === w.id) next = { ...next, [m.end]: copy(target) };
        }
        return next;
      });
      return { ...state, plan: { ...original, walls } };
    }

    case "COMMIT_DRAG": {
      const drag = state.drag;
      if (!drag) return state;
      const original = drag.original;
      const moved = state.plan.walls.some((w, i) => {
        const o = original.walls[i];
        return !o || dist(w.a, o.a) > 1e-9 || dist(w.b, o.b) > 1e-9;
      });
      if (!moved) return { ...state, plan: original, drag: null };
      const wall = state.plan.walls.find((w) => w.id === drag.wallId);
      if (wall && wallLength(wall) < MIN_WALL_LENGTH_M) {
        // Collapsing a wall by dragging is treated as a cancel.
        return { ...state, plan: original, drag: null };
      }
      return commitGeometry(
        { ...state, drag: null },
        state.plan,
        { base: original },
      );
    }

    case "CANCEL_DRAG":
      return cancelDrag(state);

    // --- walls --------------------------------------------------------------
    case "DRAFT_WALL": {
      if (!action.draft) return state.draft ? { ...state, draft: null } : state;
      const { a, b } = action.draft;
      if (!isFinitePoint(a) || !isFinitePoint(b)) return state;
      if (action.snap === false) {
        return { ...state, draft: { a: copy(a), b: copy(b) } };
      }
      const sa = snapPoint(state.plan, a);
      const sb = snapPoint(state.plan, b, sa);
      return { ...state, draft: { a: sa, b: sb } };
    }

    case "ADD_WALL": {
      if (!isFinitePoint(action.a) || !isFinitePoint(action.b)) return state;
      const base = cancelDrag(state);
      const a = action.snap === false ? copy(action.a) : snapPoint(base.plan, action.a);
      const b =
        action.snap === false ? copy(action.b) : snapPoint(base.plan, action.b, a);
      if (dist(a, b) < MIN_WALL_LENGTH_M) return base;
      const wall: PlanWall = {
        id: newId("wall"),
        a,
        b,
        thickness: clampThickness(action.thickness ?? DEFAULT_WALL_THICKNESS),
        height: planWallHeight(base.plan),
      };
      return commitGeometry(
        base,
        { ...base.plan, walls: [...base.plan.walls, wall] },
        {
          extra: {
            draft: action.chain ? { a: copy(b), b: copy(b) } : null,
            selection: { kind: "wall", id: wall.id },
          },
        },
      );
    }

    case "SPLIT_WALL": {
      const base = cancelDrag(state);
      const w = base.plan.walls.find((x) => x.id === action.wallId);
      if (!w || !isFinitePoint(action.point)) return base;
      const len = wallLength(w);
      let { t } = projectOntoWall(w, action.point);
      // Never cut through an opening: move the cut to the nearer opening edge.
      for (const o of base.plan.openings) {
        if (o.wallId !== w.id) continue;
        if (t > o.t0 && t < o.t1) t = t - o.t0 < o.t1 - t ? o.t0 : o.t1;
      }
      if (t * len < MIN_WALL_LENGTH_M || (1 - t) * len < MIN_WALL_LENGTH_M) {
        return base;
      }
      const p = lerp(w.a, w.b, t);
      const second: PlanWall = { ...w, id: newId("wall"), a: copy(p) };
      const first: PlanWall = { ...w, b: copy(p) };
      const walls = base.plan.walls.flatMap((x) => (x.id === w.id ? [first, second] : [x]));
      const openings = base.plan.openings.map((o) => {
        if (o.wallId !== w.id) return o;
        const c = (o.t0 + o.t1) / 2;
        if (c <= t) {
          return { ...o, t0: o.t0 / t, t1: Math.min(o.t1, t) / t };
        }
        return {
          ...o,
          wallId: second.id,
          t0: (Math.max(o.t0, t) - t) / (1 - t),
          t1: (o.t1 - t) / (1 - t),
        };
      });
      return commitGeometry(base, { ...base.plan, walls, openings });
    }

    case "DELETE_SELECTED": {
      const base = cancelDrag(state);
      const sel = base.selection;
      if (!sel) return base;
      const plan = base.plan;
      if (sel.kind === "wall") {
        if (!plan.walls.some((w) => w.id === sel.id)) return base;
        return commitGeometry(
          base,
          {
            ...plan,
            walls: plan.walls.filter((w) => w.id !== sel.id),
            openings: plan.openings.filter((o) => o.wallId !== sel.id),
          },
          { extra: { selection: null } },
        );
      }
      if (sel.kind === "opening") {
        if (!plan.openings.some((o) => o.id === sel.id)) return base;
        return commit(
          base,
          { ...plan, openings: plan.openings.filter((o) => o.id !== sel.id) },
          { extra: { selection: null } },
        );
      }
      if (!plan.rooms.some((r) => r.id === sel.id)) return base;
      return commit(
        base,
        { ...plan, rooms: plan.rooms.filter((r) => r.id !== sel.id) },
        { extra: { selection: null } },
      );
    }

    // --- openings -----------------------------------------------------------
    case "ADD_OPENING": {
      const base = cancelDrag(state);
      const w = base.plan.walls.find((x) => x.id === action.wallId);
      if (!w || !Number.isFinite(action.t)) return base;
      const len = wallLength(w);
      if (len < MIN_OPENING_WIDTH_M) return base;
      const t = clamp(action.t, 0, 1);
      const free = freeIntervalAt(base.plan, w.id, t);
      if (!free || (free.hi - free.lo) * len < MIN_OPENING_WIDTH_M) return base;
      const width = action.width ?? OPENING_DEFAULT_WIDTH[action.kind];
      const span = Math.max(width, MIN_OPENING_WIDTH_M) / len;
      const opening: PlanOpening = {
        id: newId("opening"),
        wallId: w.id,
        kind: action.kind,
        ...fitSpan(free, t, span),
        ...defaultOpeningVertical(action.kind, w.height),
      };
      return commit(
        base,
        { ...base.plan, openings: [...base.plan.openings, opening] },
        { extra: { selection: { kind: "opening", id: opening.id } } },
      );
    }

    case "MOVE_OPENING": {
      const plan = state.plan;
      const o = plan.openings.find((x) => x.id === action.id);
      const moved = moveOpeningSpan(plan, action.id, action.t, action.wallId);
      if (!o || !moved) return state;
      if (
        moved.wallId === o.wallId &&
        Math.abs(moved.t0 - o.t0) < 1e-9 &&
        Math.abs(moved.t1 - o.t1) < 1e-9
      ) {
        return state;
      }
      return commit(state, {
        ...plan,
        openings: plan.openings.map((x) => (x.id === o.id ? { ...x, ...moved } : x)),
      });
    }

    case "SET_OPENING": {
      const plan = state.plan;
      const o = plan.openings.find((x) => x.id === action.id);
      if (!o) return state;
      const w = plan.walls.find((x) => x.id === o.wallId);
      if (!w) return state;
      const { patch } = action;
      let next: PlanOpening = { ...o };

      if (patch.kind && patch.kind !== o.kind) {
        next.kind = patch.kind;
        Object.assign(next, defaultOpeningVertical(patch.kind, w.height));
        if (patch.kind !== "door") delete next.doorSubtype;
      }
      if (patch.width !== undefined && Number.isFinite(patch.width)) {
        const len = wallLength(w);
        const free = freeIntervalAt(plan, w.id, (o.t0 + o.t1) / 2, o.id);
        if (free && len > 1e-9) {
          const span = Math.max(patch.width, MIN_OPENING_WIDTH_M) / len;
          next = { ...next, ...fitSpan(free, (o.t0 + o.t1) / 2, span) };
        }
      }
      if (patch.bottom !== undefined && Number.isFinite(patch.bottom)) {
        next.bottom = clamp(patch.bottom, 0, w.height);
      }
      if (patch.top !== undefined && Number.isFinite(patch.top)) {
        next.top = clamp(patch.top, 0, w.height);
      }
      if (next.top - next.bottom < 0.05) return state;
      if (patch.doorSubtype !== undefined) {
        if (patch.doorSubtype === null) delete next.doorSubtype;
        else if (next.kind === "door") next.doorSubtype = patch.doorSubtype;
      }

      const same =
        next.kind === o.kind &&
        next.t0 === o.t0 &&
        next.t1 === o.t1 &&
        next.bottom === o.bottom &&
        next.top === o.top &&
        next.doorSubtype === o.doorSubtype;
      if (same) return state;
      return commit(state, {
        ...plan,
        openings: plan.openings.map((x) => (x.id === o.id ? next : x)),
      });
    }

    // --- wall properties ----------------------------------------------------
    case "SET_WALL": {
      const plan = state.plan;
      const w = plan.walls.find((x) => x.id === action.id);
      if (!w) return state;
      const next: PlanWall = { ...w };
      const { thickness, height } = action.patch;
      if (thickness !== undefined && Number.isFinite(thickness)) {
        next.thickness = clampThickness(thickness);
      }
      if (height !== undefined && Number.isFinite(height)) {
        next.height = clamp(height, MIN_WALL_HEIGHT_M, MAX_WALL_HEIGHT_M);
      }
      if (next.thickness === w.thickness && next.height === w.height) return state;
      const raise = next.height !== w.height;
      return commit(state, {
        ...plan,
        walls: plan.walls.map((x) => (x.id === w.id ? next : x)),
        openings: raise
          ? plan.openings.map((o) =>
              o.wallId === w.id && o.top >= w.height - HEIGHT_MATCH_TOL_M
                ? { ...o, top: next.height }
                : o,
            )
          : plan.openings,
      });
    }

    case "SET_WALL_HEIGHT": {
      if (!Number.isFinite(action.height)) return state;
      const height = clamp(action.height, MIN_WALL_HEIGHT_M, MAX_WALL_HEIGHT_M);
      const plan = state.plan;
      if (plan.walls.every((w) => w.height === height)) return state;
      const oldHeight = new Map(plan.walls.map((w) => [w.id, w.height]));
      return commit(state, {
        ...plan,
        walls: plan.walls.map((w) => (w.height === height ? w : { ...w, height })),
        openings: plan.openings.map((o) => {
          const old = oldHeight.get(o.wallId);
          return old !== undefined && o.top >= old - HEIGHT_MATCH_TOL_M
            ? { ...o, top: height }
            : o;
        }),
      });
    }

    // --- rooms --------------------------------------------------------------
    case "RENAME_ROOM":
      return updateRoom(state, action.id, (r) => {
        const name = action.name.trim();
        return name === r.name ? r : { ...r, name };
      });

    case "SET_ROOM_TYPE":
      return updateRoom(state, action.id, (r) => {
        if ((r.type ?? null) === action.roomType) return r;
        const next: PlanRoom = { ...r };
        if (action.roomType) next.type = action.roomType;
        else delete next.type;
        return next;
      });

    case "SET_ROOM_FLOOR_MATERIAL":
      return updateRoom(state, action.id, (r) => {
        const current = r.floorMaterialId ?? null;
        if (current === action.materialId) return r;
        const next: PlanRoom = { ...r };
        if (action.materialId) next.floorMaterialId = action.materialId;
        else delete next.floorMaterialId;
        return next;
      });

    case "SET_ROOM_ANCHOR":
      return updateRoom(state, action.id, (r) => {
        if (!isFinitePoint(action.point)) return r;
        // A live room's anchor must stay inside it (rebuildRooms matches by it).
        if (!r.stale && !pointInPolygon(action.point, r.polygon)) return r;
        if (dist(action.point, r.anchor) < 1e-9) return r;
        return { ...r, anchor: copy(action.point) };
      });

    case "SET_DEFAULT_MATERIALS": {
      const materials = { ...state.plan.materials, ...action.patch };
      if (
        materials.floor === state.plan.materials.floor &&
        materials.wall === state.plan.materials.wall
      ) {
        return state;
      }
      return commit(state, { ...state.plan, materials });
    }

    case "SET_NORTH": {
      if (!Number.isFinite(action.deg)) return state;
      const deg = normalizeDeg(action.deg);
      if (deg === state.plan.northOffsetDeg) return state;
      return commit(state, { ...state.plan, northOffsetDeg: deg });
    }

    // --- scale --------------------------------------------------------------
    case "CALIBRATE_POINT": {
      if (!isFinitePoint(action.point)) return state;
      const cal = state.calibration ?? {};
      const point = copy(action.point);
      if (!cal.a || cal.b) return { ...state, calibration: { a: point } };
      return { ...state, calibration: { a: cal.a, b: point } };
    }

    case "CALIBRATE_APPLY": {
      const cal = state.calibration;
      if (!cal?.a || !cal.b) return state;
      if (!Number.isFinite(action.metres) || action.metres <= 0) return state;
      const plan = state.plan;
      const px = dist(cal.a, cal.b) * plan.scale.pxPerMeter;
      if (px < MIN_CALIBRATION_PX) return state;
      return commit(state, rescaleManual(plan, px / action.metres), {
        extra: { calibration: null, tool: "select" },
      });
    }

    case "CALIBRATE_TOTAL_WIDTH": {
      if (!Number.isFinite(action.metres) || action.metres <= 0) return state;
      const plan = state.plan;
      const width = planBounds(plan).width;
      if (width < 1e-6) return state;
      const px = width * plan.scale.pxPerMeter;
      if (px < MIN_CALIBRATION_PX) return state;
      return commit(state, rescaleManual(plan, px / action.metres), {
        extra: { calibration: toolCalibration(state.tool) },
      });
    }

    case "CALIBRATE_CANCEL":
      return {
        ...state,
        calibration: null,
        tool: state.tool === "calibrate" ? "select" : state.tool,
      };

    case "CONFIRM_SCALE": {
      if (state.plan.scale.confirmed) return state;
      return commit(state, {
        ...state.plan,
        scale: { ...state.plan.scale, confirmed: true },
      });
    }

    // --- fixes --------------------------------------------------------------
    case "APPLY_FIX": {
      const base = cancelDrag(state);
      const fix = base.issues[action.issueIndex]?.fix;
      if (!fix) return base;
      const next = applyFix(base.plan, fix);
      if (next === base.plan) return base;
      return next.walls !== base.plan.walls
        ? commitGeometry(base, next)
        : commit(base, next);
    }

    case "APPLY_SAFE_FIXES": {
      const base = cancelDrag(state);
      let next = base.plan;
      for (const issue of base.issues) {
        if (issue.fix?.safe) next = applyFix(next, issue.fix);
      }
      if (next === base.plan) return base;
      return next.walls !== base.plan.walls
        ? commitGeometry(base, next)
        : commit(base, next);
    }

    case "REBUILD_ROOMS": {
      const base = cancelDrag(state);
      return commitGeometry(base, base.plan, { dropStale: true });
    }

    // --- history ------------------------------------------------------------
    case "UNDO": {
      if (state.drag) return cancelDrag(state);
      if (state.past.length === 0) return state;
      const plan = state.past[state.past.length - 1];
      return sanitize({
        ...state,
        plan,
        past: state.past.slice(0, -1),
        future: [state.plan, ...state.future].slice(0, UNDO_LIMIT),
        issues: planIssues(plan),
        draft: null,
        notice: null,
      });
    }

    case "REDO": {
      if (state.drag || state.future.length === 0) return state;
      const plan = state.future[0];
      return sanitize({
        ...state,
        plan,
        past: [...state.past, state.plan].slice(-UNDO_LIMIT),
        future: state.future.slice(1),
        issues: planIssues(plan),
        draft: null,
        notice: null,
      });
    }

    case "MARK_PUSHED":
      return state.lastPushedEditedAt === action.editedAt
        ? state
        : { ...state, lastPushedEditedAt: action.editedAt };

    default:
      return state;
  }
};

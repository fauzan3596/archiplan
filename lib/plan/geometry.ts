// Geometry core for the floor-plan model.
//
// Part 1 is a VERBATIM port of the verified research sketch (only the renames
// Wall -> GeoWall and Room -> GeoRoom). It is unit-agnostic: `eps`, lengths
// and areas are in whatever unit the caller passes (pixels in the extraction
// pipeline, metres in the plan-level helpers below).
//
// Part 2 holds the plan-level helpers (METRES, x right / y down) consumed by
// the editor, extraction, RAB and sun packages: rebuildRooms, wallAdjacency,
// planIssues and applyFix. All of them are pure and never mutate their input.

import {
  openingCenter,
  openingWidth,
  polygonArea,
  polygonCentroid,
  wallAngleDeg,
  wallLength,
  wallOffAxisDeg,
} from "./convert";
import {
  AXIS_TOLERANCE_DEG,
  DOOR_WIDTH_PRIOR,
  OPENING_REATTACH_M,
  REBUILD_EPS_M,
  newId,
} from "./defaults";
import { normalizeWallOpenings } from "./validate";

// =============================================================================
// Part 1 — verbatim port (renames only)
// =============================================================================

// Floor-plan geometry post-processing. All coordinates are PIXELS of the image that was sent to the model
// (convert normalized 0..1000 -> px first so that x/y units are isotropic on non-square images).
export type Pt = { x: number; y: number };

export interface GeoWall {
  id: string;
  a: Pt;
  b: Pt;
  thickness: number; // px
  exterior: boolean;
  confidence: number; // 0..1
  sources: string[]; // raw model wall ids merged into this segment
}

export interface GeoRoom {
  id: string;
  polygon: Pt[];
  areaPx: number; // px^2 (unsigned)
  perimeterPx: number;
  centroid: Pt;
  name: string | null;
  kind: string | null;
  confidence: number;
}

export interface RoomLabel {
  id: string;
  name: string;
  kind: string;
  polygon: Pt[];
  confidence: number;
}

export interface SnapOptions {
  angleTolDeg?: number; // walls within this angle of an axis are forced to 0/90 deg (default 8)
  eps?: number; // endpoint / line clustering radius in px (default 12 @ 1024px ~ 1.2% of frame)
  minLength?: number; // walls shorter than this are dropped before noding (default 1.5*eps)
}

const deg = (r: number) => (r * 180) / Math.PI;
export const length = (w: GeoWall) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);

/** 1-D clustering by consecutive gap; returns a function mapping each input value to its cluster mean. */
function cluster1D(values: number[], eps: number): (v: number) => number {
  const sorted = [...new Set(values)].sort((p, q) => p - q);
  const groups: number[][] = [];
  for (const v of sorted) {
    const g = groups[groups.length - 1];
    if (g && v - g[g.length - 1] <= eps) g.push(v);
    else groups.push([v]);
  }
  const rep = new Map<number, number>();
  for (const g of groups) {
    const mean = g.reduce((s, v) => s + v, 0) / g.length;
    for (const v of g) rep.set(v, mean);
  }
  return (v) => rep.get(v) ?? v;
}

function mergeCollinear(ws: GeoWall[], along: "x" | "y", across: "x" | "y", eps: number): GeoWall[] {
  const byLine = new Map<number, GeoWall[]>();
  for (const w of ws) {
    const k = w.a[across];
    const list = byLine.get(k) ?? [];
    list.push(w);
    byLine.set(k, list);
  }
  const out: GeoWall[] = [];
  for (const [line, group] of byLine) {
    const segs = group
      .map((w) => ({ lo: Math.min(w.a[along], w.b[along]), hi: Math.max(w.a[along], w.b[along]), w }))
      .sort((p, q) => p.lo - q.lo);
    const mk = (lo: number, hi: number, parts: GeoWall[]): GeoWall => ({
      id: parts.map((w) => w.id).join("+"),
      a: along === "x" ? { x: lo, y: line } : { x: line, y: lo },
      b: along === "x" ? { x: hi, y: line } : { x: line, y: hi },
      thickness: Math.max(...parts.map((w) => w.thickness)),
      exterior: parts.some((w) => w.exterior),
      confidence: parts.reduce((s, w) => s + w.confidence, 0) / parts.length,
      sources: parts.flatMap((w) => w.sources),
    });
    let cur = { lo: segs[0].lo, hi: segs[0].hi, parts: [segs[0].w] };
    for (const s of segs.slice(1)) {
      if (s.lo <= cur.hi + eps) {
        cur.hi = Math.max(cur.hi, s.hi);
        cur.parts.push(s.w);
      } else {
        out.push(mk(cur.lo, cur.hi, cur.parts));
        cur = { lo: s.lo, hi: s.hi, parts: [s.w] };
      }
    }
    out.push(mk(cur.lo, cur.hi, cur.parts));
  }
  return out;
}

const isH = (w: GeoWall) => w.a.y === w.b.y;

/** Split axis-aligned walls at every crossing and T-junction so the result is a properly noded planar graph. */
function nodeManhattan(ws: GeoWall[], eps: number): GeoWall[] {
  const H = ws.filter(isH);
  const V = ws.filter((w) => !isH(w));
  const cuts = new Map<GeoWall, number[]>();
  const addCut = (w: GeoWall, t: number) => {
    const list = cuts.get(w) ?? [];
    list.push(t);
    cuts.set(w, list);
  };
  const d = eps * 0.5; // "strictly interior" margin
  for (const h of H) {
    const hx0 = Math.min(h.a.x, h.b.x), hx1 = Math.max(h.a.x, h.b.x);
    for (const v of V) {
      const vy0 = Math.min(v.a.y, v.b.y), vy1 = Math.max(v.a.y, v.b.y);
      const touches = v.a.x >= hx0 - d && v.a.x <= hx1 + d && h.a.y >= vy0 - d && h.a.y <= vy1 + d;
      if (!touches) continue;
      if (v.a.x > hx0 + d && v.a.x < hx1 - d) addCut(h, v.a.x);
      if (h.a.y > vy0 + d && h.a.y < vy1 - d) addCut(v, h.a.y);
    }
  }
  const out: GeoWall[] = [];
  for (const w of ws) {
    const c = cuts.get(w);
    if (!c?.length) {
      out.push(w);
      continue;
    }
    const along = isH(w) ? "x" : "y";
    const lo = Math.min(w.a[along], w.b[along]), hi = Math.max(w.a[along], w.b[along]);
    const stops = [lo, ...[...new Set(c)].sort((p, q) => p - q), hi];
    const pt = (v: number): Pt => (along === "x" ? { x: v, y: w.a.y } : { x: w.a.x, y: v });
    for (let i = 0; i + 1 < stops.length; i++) out.push({ ...w, id: `${w.id}#${i}`, a: pt(stops[i]), b: pt(stops[i + 1]) });
  }
  return out;
}

/**
 * 1. force near-axis walls to exactly horizontal/vertical, 2. cluster wall lines and endpoints onto shared axis
 * lines, 3. merge collinear overlapping/touching segments, 4. split at crossings/T-junctions (noding).
 * Diagonal walls (beyond angleTolDeg) are returned separately and must be handled by the user in the editor.
 */
export function snapAndMerge(raw: GeoWall[], o: SnapOptions = {}): { walls: GeoWall[]; diagonals: GeoWall[]; dropped: GeoWall[] } {
  const angleTol = o.angleTolDeg ?? 8;
  const eps = o.eps ?? 12;
  const minLen = o.minLength ?? eps * 1.5;
  const H: GeoWall[] = [], V: GeoWall[] = [], diagonals: GeoWall[] = [], dropped: GeoWall[] = [];
  for (const w of raw) {
    if (length(w) < minLen) {
      dropped.push(w);
      continue;
    }
    const ang = deg(Math.atan2(Math.abs(w.b.y - w.a.y), Math.abs(w.b.x - w.a.x))); // 0..90
    if (ang <= angleTol) {
      const y = (w.a.y + w.b.y) / 2;
      H.push({ ...w, a: { x: w.a.x, y }, b: { x: w.b.x, y } });
    } else if (ang >= 90 - angleTol) {
      const x = (w.a.x + w.b.x) / 2;
      V.push({ ...w, a: { x, y: w.a.y }, b: { x, y: w.b.y } });
    } else diagonals.push(w);
  }
  const snapX = cluster1D([...V.map((w) => w.a.x), ...H.flatMap((w) => [w.a.x, w.b.x])], eps);
  const snapY = cluster1D([...H.map((w) => w.a.y), ...V.flatMap((w) => [w.a.y, w.b.y])], eps);
  for (const w of H) {
    const y = snapY(w.a.y);
    w.a = { x: snapX(w.a.x), y };
    w.b = { x: snapX(w.b.x), y };
  }
  for (const w of V) {
    const x = snapX(w.a.x);
    w.a = { x, y: snapY(w.a.y) };
    w.b = { x, y: snapY(w.b.y) };
  }
  const merged = [...mergeCollinear(H, "x", "y", eps), ...mergeCollinear(V, "y", "x", eps)].filter((w) => length(w) > 0);
  return { walls: nodeManhattan(merged, eps), diagonals, dropped };
}

/** Signed shoelace area. With y-down screen coordinates a clockwise-on-screen polygon is positive. */
export function shoelaceArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

export function perimeter(p: Pt[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}

export function centroid(p: Pt[]): Pt {
  const A = shoelaceArea(p);
  if (Math.abs(A) < 1e-9) return { x: p.reduce((s, q) => s + q.x, 0) / p.length, y: p.reduce((s, q) => s + q.y, 0) / p.length };
  let cx = 0, cy = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const f = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * f;
    cy += (a.y + b.y) * f;
  }
  return { x: cx / (6 * A), y: cy / (6 * A) };
}

export function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Remove back-and-forth spikes (bridges traversed twice) and consecutive duplicates. */
function removeSpikes(p: Pt[]): Pt[] {
  const same = (a: Pt, b: Pt) => a.x === b.x && a.y === b.y;
  const out = p.slice();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const prev = out[(i - 1 + out.length) % out.length], next = out[(i + 1) % out.length];
      if (same(prev, next) || same(out[i], next)) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Drop vertices that lie on a straight line between their neighbours (junction points along a room edge). */
export function simplifyCollinear(p: Pt[]): Pt[] {
  if (p.length <= 4) return p;
  return p.filter((_, i) => {
    const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
    return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) > 1e-6;
  });
}

/**
 * Extract the bounded faces (rooms) of the planar wall graph by half-edge traversal.
 * At node v, arriving from u, the next edge is the neighbour immediately before u in the angle-sorted list
 * (= tightest turn). With this rule every bounded face comes out with POSITIVE shoelace area in the same
 * coordinate handedness used for atan2, and the unbounded face of each component comes out negative.
 * Dangling walls (dead ends) are pruned first and returned so the UI can flag them.
 */
export function polygonizeRooms(walls: GeoWall[], o: { minArea?: number } = {}): { rooms: GeoRoom[]; dangling: GeoWall[] } {
  const minArea = o.minArea ?? 0;
  const key = (p: Pt) => `${Math.round(p.x * 100) / 100},${Math.round(p.y * 100) / 100}`;
  const nodes: Pt[] = [];
  const idx = new Map<string, number>();
  const nid = (p: Pt) => {
    const k = key(p);
    let i = idx.get(k);
    if (i === undefined) {
      i = nodes.length;
      idx.set(k, i);
      nodes.push({ x: p.x, y: p.y });
    }
    return i;
  };
  type E = { u: number; v: number; wall: GeoWall };
  let edges: E[] = walls.map((w) => ({ u: nid(w.a), v: nid(w.b), wall: w })).filter((e) => e.u !== e.v);

  const dangling: GeoWall[] = [];
  for (;;) {
    const degree = new Map<number, number>();
    for (const e of edges) {
      degree.set(e.u, (degree.get(e.u) ?? 0) + 1);
      degree.set(e.v, (degree.get(e.v) ?? 0) + 1);
    }
    const keep = edges.filter((e) => (degree.get(e.u) ?? 0) > 1 && (degree.get(e.v) ?? 0) > 1);
    if (keep.length === edges.length) break;
    for (const e of edges) if (!keep.includes(e)) dangling.push(e.wall);
    edges = keep;
  }

  const adj = new Map<number, { to: number; ang: number; wall: GeoWall }[]>();
  const push = (u: number, v: number, wall: GeoWall) => {
    const a = nodes[u], b = nodes[v];
    let ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (ang < 0) ang += 2 * Math.PI;
    const list = adj.get(u) ?? [];
    list.push({ to: v, ang, wall });
    adj.set(u, list);
  };
  for (const e of edges) {
    push(e.u, e.v, e.wall);
    push(e.v, e.u, e.wall);
  }
  for (const list of adj.values()) list.sort((p, q) => p.ang - q.ang);

  const visited = new Set<string>();
  const rooms: GeoRoom[] = [];
  for (const [u0, list] of adj) {
    for (const first of list) {
      if (visited.has(`${u0}>${first.to}`)) continue;
      const poly: number[] = [];
      let u = u0, v = first.to, guard = 0;
      while (!visited.has(`${u}>${v}`) && guard++ < 100000) {
        visited.add(`${u}>${v}`);
        poly.push(u);
        const nb = adj.get(v)!;
        const i = nb.findIndex((n) => n.to === u);
        const nx = nb[(i - 1 + nb.length) % nb.length];
        u = v;
        v = nx.to;
      }
      const pts = removeSpikes(poly.map((i) => nodes[i]));
      const area = shoelaceArea(pts);
      if (area <= minArea) continue; // <= 0 is the unbounded face of a component
      rooms.push({
        id: `room-${rooms.length + 1}`,
        polygon: pts,
        areaPx: area,
        perimeterPx: perimeter(pts),
        centroid: centroid(pts),
        name: null,
        kind: null,
        confidence: 0,
      });
    }
  }
  return { rooms, dangling };
}

/** Assign model room labels to polygonized faces by centroid containment. */
export function assignRoomNames(rooms: GeoRoom[], labels: RoomLabel[]): { rooms: GeoRoom[]; unmatched: RoomLabel[]; multi: { roomId: string; labels: string[] }[] } {
  const unmatched: RoomLabel[] = [];
  const hits = new Map<string, RoomLabel[]>();
  for (const l of labels) {
    const c = centroid(l.polygon);
    const r = rooms.find((r) => pointInPolygon(c, r.polygon));
    if (!r) {
      unmatched.push(l);
      continue;
    }
    const list = hits.get(r.id) ?? [];
    list.push(l);
    hits.set(r.id, list);
  }
  const multi: { roomId: string; labels: string[] }[] = []; // >1 label in one face => probably a missing wall
  const out = rooms.map((r) => {
    const ls = (hits.get(r.id) ?? []).sort((a, b) => b.confidence - a.confidence);
    if (ls.length > 1) multi.push({ roomId: r.id, labels: ls.map((l) => l.name) });
    const best = ls[0];
    return best ? { ...r, name: best.name, kind: best.kind, confidence: best.confidence } : r;
  });
  return { rooms: out, unmatched, multi };
}

/** Rooms-only fallback: turn model rectangles into wall edges; snapAndMerge() then welds shared edges. */
export function rectsToWalls(rects: { id: string; x0: number; y0: number; x1: number; y1: number }[]): GeoWall[] {
  const walls: GeoWall[] = [];
  for (const r of rects) {
    const c = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
    for (let i = 0; i < 4; i++) walls.push({ id: `${r.id}-e${i}`, a: c[i], b: c[(i + 1) % 4], thickness: 0, exterior: false, confidence: 0.5, sources: [r.id] });
  }
  return walls;
}

// =============================================================================
// Part 2 — plan-level helpers (metres)
// =============================================================================

export interface RebuildOptions {
  /** snap / merge / noding radius in metres (default REBUILD_EPS_M = 0.12) */
  eps?: number;
}

export interface RebuildResult {
  /** snapped + noded walls; ids preserved via `sources` (one segment per original
   *  wall keeps its id, extra split pieces get newId("wall")); thickness, height,
   *  isExterior and confidence are carried from the source wall; a -> b keeps the
   *  source direction. Diagonal walls are kept (not noded) and listed below. */
  walls: PlanWall[];
  /** old rooms re-matched to faces (anchor containment, then centroid); unmatched
   *  old rooms kept with `stale: true` and their frozen polygon; new faces appended
   *  as "Ruangan" with anchor = centroid (an interior point for concave faces). */
  rooms: PlanRoom[];
  /** openings re-attached to the nearest resulting wall within OPENING_REATTACH_M
   *  (t0/t1 recomputed from the original width), passed through normalizeWallOpenings */
  openings: PlanOpening[];
  /** opening ids whose wallId changed */
  reattached: string[];
  /** opening ids dropped (no wall within OPENING_REATTACH_M, or merged away) */
  droppedOpenings: string[];
  /** result wall ids that bound no room (dead ends and everything hanging off them) */
  danglingWallIds: string[];
  /** result wall ids more than AXIS_TOLERANCE_DEG off-axis (not polygonised) */
  diagonalWallIds: string[];
  /** original wall ids removed because they were shorter than 1.5 * eps */
  droppedWallIds: string[];
}

export interface WallAdjacency {
  /** non-stale rooms touching either face of the wall, in plan.rooms order */
  roomIds: string[];
  /** true when one face has no room on any probe (both faces empty counts too) */
  isExterior: boolean;
}

const ADJACENCY_TS = [0.25, 0.5, 0.75];
const ADJACENCY_PROBE_M = 0.05;
const REATTACH_MAX_ANGLE_DEG = 30;
const SAFE_SNAP_AXIS_DEG = 15;
const MERGE_FIX_LIMIT_M = 4 * REBUILD_EPS_M;
const WALL_SHORT_M = 0.3;
const DOOR_WIDTH_MIN_M = 0.6;
const DOOR_WIDTH_MAX_M = 1.8;
const WINDOW_WIDTH_MIN_M = 0.3;
const WINDOW_WIDTH_MAX_M = 4;
const ROOM_TINY_M2 = 1;
const ROOM_HUGE_M2 = 150;
const TOTAL_AREA_MIN_M2 = 9;
const TOTAL_AREA_MAX_M2 = 1000;
const LUAS_MISMATCH_RATIO = 0.15;
const DEFAULT_ROOM_NAME = "Ruangan";

type WallEnd = "a" | "b";

const dist = (p: Pt, q: Pt): number => Math.hypot(q.x - p.x, q.y - p.y);

const copyPoint = (p: Pt): PlanPoint => ({ x: p.x, y: p.y });

const samePoint = (p: Pt, q: Pt): boolean => p.x === q.x && p.y === q.y;

/** Closest point on segment ab to p: parameter t in [0, 1], the point and its distance. */
const projectOnSegment = (
  p: Pt,
  a: Pt,
  b: Pt,
): { t: number; point: PlanPoint; dist: number } => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const raw = len2 < 1e-18 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const t = Math.min(1, Math.max(0, raw));
  const point = { x: a.x + dx * t, y: a.y + dy * t };
  return { t, point, dist: dist(p, point) };
};

/** Acute angle between two wall directions, 0..90 degrees. */
const angleBetweenWalls = (p: PlanWall, q: PlanWall): number => {
  const d = Math.abs(wallAngleSigned(p) - wallAngleSigned(q)) % 180;
  return d > 90 ? 180 - d : d;
};

const wallAngleSigned = (w: PlanWall): number =>
  (Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x) * 180) / Math.PI;

const fmt = (n: number, digits = 2): string =>
  n.toLocaleString("id-ID", { maximumFractionDigits: digits });

const unique = <T>(items: T[]): T[] => [...new Set(items)];

/** Widest horizontal chord of a polygon at height y (even-odd pairing). */
const chordAt = (poly: PlanPoint[], y: number): { x0: number; x1: number } | null => {
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
  }
  xs.sort((p, q) => p - q);
  let best: { x0: number; x1: number } | null = null;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    if (!best || xs[k + 1] - xs[k] > best.x1 - best.x0) best = { x0: xs[k], x1: xs[k + 1] };
  }
  return best;
};

/** Label point: the centroid when it lies inside, else the middle of the widest
 *  horizontal chord (through the centroid first, then between vertex rows). */
const interiorPoint = (poly: PlanPoint[]): PlanPoint => {
  const c = polygonCentroid(poly);
  if (poly.length < 3 || pointInPolygon(c, poly)) return copyPoint(c);

  const atCentroid = chordAt(poly, c.y);
  if (atCentroid && atCentroid.x1 - atCentroid.x0 > 1e-9) {
    return { x: (atCentroid.x0 + atCentroid.x1) / 2, y: c.y };
  }

  const ys = [...new Set(poly.map((p) => p.y))].sort((p, q) => p - q);
  let best: { x: number; y: number; w: number } | null = null;
  for (let i = 0; i + 1 < ys.length; i += 1) {
    const y = (ys[i] + ys[i + 1]) / 2;
    const chord = chordAt(poly, y);
    if (chord && (!best || chord.x1 - chord.x0 > best.w)) {
      best = { x: (chord.x0 + chord.x1) / 2, y, w: chord.x1 - chord.x0 };
    }
  }
  return best ? { x: best.x, y: best.y } : copyPoint(c);
};

/** t0/t1 for an opening of `width` metres centred at parameter t on a wall of
 *  length `len`, shifted to stay inside 0..1 (clamped when wider than the wall). */
const fitOpening = (t: number, width: number, len: number): { t0: number; t1: number } => {
  if (len < 1e-9) return { t0: 0, t1: 1 };
  const span = Math.min(Math.max(width, 0), len) / len;
  let t0 = t - span / 2;
  let t1 = t + span / 2;
  if (t0 < 0) {
    t1 -= t0;
    t0 = 0;
  }
  if (t1 > 1) {
    t0 -= t1 - 1;
    t1 = 1;
  }
  return { t0: Math.max(0, t0), t1: Math.min(1, t1) };
};

const toGeoWall = (w: PlanWall): GeoWall => ({
  id: w.id,
  a: copyPoint(w.a),
  b: copyPoint(w.b),
  thickness: w.thickness,
  exterior: w.isExterior === true,
  confidence: w.confidence ?? 1,
  sources: [w.id],
});

interface NodedPlan {
  /** axis-aligned, noded segments (sources = plan wall ids) */
  segments: GeoWall[];
  /** walls beyond the axis tolerance; endpoints snapped onto nearby nodes */
  diagonals: GeoWall[];
  /** walls shorter than 1.5 * eps */
  dropped: GeoWall[];
}

/** Keeps every original wall endpoint that lies strictly inside a merged segment
 *  as a node, so user splits and collinear joints survive the merge step and a
 *  rebuild of an already noded plan is the identity. */
const splitAtSourceEndpoints = (
  segments: GeoWall[],
  byId: Map<string, PlanWall>,
  eps: number,
): GeoWall[] =>
  segments.flatMap((s) => {
    const horizontal = s.a.y === s.b.y;
    const line = horizontal ? s.a.y : s.a.x;
    const lo = horizontal ? Math.min(s.a.x, s.b.x) : Math.min(s.a.y, s.b.y);
    const hi = horizontal ? Math.max(s.a.x, s.b.x) : Math.max(s.a.y, s.b.y);
    const cuts: number[] = [];
    for (const id of s.sources) {
      const w = byId.get(id);
      if (!w) continue;
      for (const p of [w.a, w.b]) {
        const across = horizontal ? p.y : p.x;
        const along = horizontal ? p.x : p.y;
        if (Math.abs(across - line) > eps) continue;
        if (along <= lo + eps || along >= hi - eps) continue;
        if (cuts.some((c) => Math.abs(c - along) <= eps)) continue;
        cuts.push(along);
      }
    }
    if (cuts.length === 0) return [s];
    const stops = [lo, ...cuts.sort((p, q) => p - q), hi];
    const pt = (v: number): Pt => (horizontal ? { x: v, y: line } : { x: line, y: v });
    return stops.slice(1).map((v, i) => ({ ...s, id: `${s.id}~${i}`, a: pt(stops[i]), b: pt(v) }));
  });

const nodePlanWalls = (walls: PlanWall[], eps: number): NodedPlan => {
  const byId = new Map(walls.map((w) => [w.id, w]));
  const snapped = snapAndMerge(walls.map(toGeoWall), {
    eps,
    angleTolDeg: AXIS_TOLERANCE_DEG,
  });
  const segments = splitAtSourceEndpoints(snapped.walls, byId, eps);
  const nodes = segments.flatMap((s) => [s.a, s.b]);
  const snapEnd = (p: Pt): Pt => {
    let best: Pt | null = null;
    let bestDist = eps;
    for (const n of nodes) {
      const d = dist(p, n);
      if (d <= bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best ? copyPoint(best) : copyPoint(p);
  };
  const diagonals = snapped.diagonals.map((d) => ({ ...d, a: snapEnd(d.a), b: snapEnd(d.b) }));
  return { segments, diagonals, dropped: snapped.dropped };
};

/** Length of the part of plan wall w that projects onto segment s. */
const overlapAlong = (s: GeoWall, w: PlanWall): number => {
  const len = length(s);
  if (len < 1e-12) return 0;
  const ux = (s.b.x - s.a.x) / len;
  const uy = (s.b.y - s.a.y) / len;
  const pa = (w.a.x - s.a.x) * ux + (w.a.y - s.a.y) * uy;
  const pb = (w.b.x - s.a.x) * ux + (w.b.y - s.a.y) * uy;
  return Math.max(0, Math.min(len, Math.max(pa, pb)) - Math.max(0, Math.min(pa, pb)));
};

const orientLike = (wall: PlanWall, src: PlanWall): PlanWall => {
  const dot =
    (wall.b.x - wall.a.x) * (src.b.x - src.a.x) +
    (wall.b.y - wall.a.y) * (src.b.y - src.a.y);
  return dot < 0 ? { ...wall, a: wall.b, b: wall.a } : wall;
};

/** Maps noded segments back to PlanWalls: greedy by overlap, each original id is
 *  kept by the segment that covers most of it; other pieces get fresh ids. */
const toPlanWalls = (
  noded: NodedPlan,
  planWalls: PlanWall[],
): { walls: PlanWall[]; idOf: Map<GeoWall, string> } => {
  const byId = new Map(planWalls.map((w) => [w.id, w]));
  const index = new Map(planWalls.map((w, i) => [w.id, i]));
  const { segments } = noded;

  const pairs: { seg: number; src: string; overlap: number }[] = [];
  segments.forEach((s, seg) => {
    for (const src of unique(s.sources)) {
      const w = byId.get(src);
      if (!w) continue;
      const overlap = overlapAlong(s, w);
      if (overlap > 1e-9) pairs.push({ seg, src, overlap });
    }
  });
  pairs.sort(
    (p, q) =>
      q.overlap - p.overlap ||
      p.seg - q.seg ||
      (index.get(p.src) ?? 0) - (index.get(q.src) ?? 0),
  );

  const kept = new Map<number, string>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (kept.has(p.seg) || used.has(p.src)) continue;
    kept.set(p.seg, p.src);
    used.add(p.src);
  }

  const entries: { wall: PlanWall; order: number; along: number }[] = [];
  const idOf = new Map<GeoWall, string>();

  segments.forEach((s, seg) => {
    const keptId = kept.get(seg);
    let src = keptId ? byId.get(keptId) : undefined;
    if (!src) {
      let bestOverlap = -1;
      for (const id of unique(s.sources)) {
        const w = byId.get(id);
        if (!w) continue;
        const overlap = overlapAlong(s, w);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          src = w;
        }
      }
    }
    if (!src) return;
    const id = keptId ?? newId("wall");
    const wall = orientLike({ ...src, id, a: copyPoint(s.a), b: copyPoint(s.b) }, src);
    idOf.set(s, id);
    const len = wallLength(src);
    const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
    const along =
      len < 1e-12
        ? 0
        : ((mid.x - src.a.x) * (src.b.x - src.a.x) + (mid.y - src.a.y) * (src.b.y - src.a.y)) / len;
    entries.push({ wall, order: index.get(src.id) ?? 0, along });
  });

  for (const d of noded.diagonals) {
    const src = byId.get(d.id);
    if (!src) continue;
    idOf.set(d, src.id);
    entries.push({
      wall: { ...src, a: copyPoint(d.a), b: copyPoint(d.b) },
      order: index.get(src.id) ?? 0,
      along: 0,
    });
  }

  entries.sort((p, q) => p.order - q.order || p.along - q.along);
  return { walls: entries.map((e) => e.wall), idOf };
};

/** Old rooms claim faces by anchor containment first, centroid second. On a
 *  conflict non-stale beats stale, then the larger old polygon, then list order. */
const matchRooms = (oldRooms: PlanRoom[], faces: PlanPoint[][]): PlanRoom[] => {
  const owner: number[] = faces.map(() => -1);
  const ownerPass: number[] = faces.map(() => 0);
  const faceOf: number[] = oldRooms.map(() => -1);
  const areas = oldRooms.map((r) => polygonArea(r.polygon));

  const better = (i: number, j: number): boolean => {
    const si = oldRooms[i].stale ? 1 : 0;
    const sj = oldRooms[j].stale ? 1 : 0;
    if (si !== sj) return si < sj;
    if (Math.abs(areas[i] - areas[j]) > 1e-9) return areas[i] > areas[j];
    return i < j;
  };

  const claim = (pass: number, probe: (r: PlanRoom) => PlanPoint | null) => {
    oldRooms.forEach((room, i) => {
      if (faceOf[i] !== -1) return;
      const p = probe(room);
      if (!p) return;
      const f = faces.findIndex((poly) => pointInPolygon(p, poly));
      if (f === -1) return;
      const cur = owner[f];
      if (cur === -1) {
        owner[f] = i;
        ownerPass[f] = pass;
        faceOf[i] = f;
      } else if (ownerPass[f] === pass && better(i, cur)) {
        faceOf[cur] = -1;
        owner[f] = i;
        faceOf[i] = f;
      }
    });
  };

  claim(1, (r) => r.anchor);
  claim(2, (r) => (r.polygon.length >= 3 ? interiorPoint(r.polygon) : null));

  const rooms: PlanRoom[] = oldRooms.map((room, i) => {
    const f = faceOf[i];
    if (f === -1) return room.stale ? room : { ...room, stale: true };
    const polygon = faces[f];
    const next: PlanRoom = {
      ...room,
      polygon,
      anchor: pointInPolygon(room.anchor, polygon)
        ? copyPoint(room.anchor)
        : interiorPoint(polygon),
    };
    delete next.stale;
    return next;
  });

  faces.forEach((polygon, f) => {
    if (owner[f] !== -1) return;
    rooms.push({
      id: newId("room"),
      name: DEFAULT_ROOM_NAME,
      polygon,
      anchor: interiorPoint(polygon),
    });
  });

  return rooms;
};

/** Nearest wall (roughly parallel to the old host) within OPENING_REATTACH_M of
 *  the opening centre; ties prefer the wall that kept the old id. */
const nearestWallFor = (
  center: PlanPoint,
  host: PlanWall,
  walls: PlanWall[],
): { wall: PlanWall; t: number } | null => {
  const hostHasDirection = wallLength(host) > 1e-9;
  let best: { wall: PlanWall; t: number; dist: number } | null = null;
  for (const w of walls) {
    if (wallLength(w) < 1e-9) continue;
    if (hostHasDirection && angleBetweenWalls(host, w) > REATTACH_MAX_ANGLE_DEG) continue;
    const proj = projectOnSegment(center, w.a, w.b);
    if (proj.dist > OPENING_REATTACH_M) continue;
    if (
      !best ||
      proj.dist < best.dist - 1e-9 ||
      (Math.abs(proj.dist - best.dist) <= 1e-9 && w.id === host.id)
    ) {
      best = { wall: w, t: proj.t, dist: proj.dist };
    }
  }
  return best ? { wall: best.wall, t: best.t } : null;
};

const reattachOpenings = (
  openings: PlanOpening[],
  oldWalls: PlanWall[],
  newWalls: PlanWall[],
): { openings: PlanOpening[]; reattached: string[]; dropped: string[] } => {
  const oldById = new Map(oldWalls.map((w) => [w.id, w]));
  const newById = new Map(newWalls.map((w) => [w.id, w]));
  const placed: PlanOpening[] = [];
  const reattached: string[] = [];
  const dropped: string[] = [];

  for (const o of openings) {
    const host = oldById.get(o.wallId);
    if (!host) {
      dropped.push(o.id);
      continue;
    }
    const same = newById.get(o.wallId);
    if (same && samePoint(same.a, host.a) && samePoint(same.b, host.b)) {
      placed.push(o);
      continue;
    }
    const target = nearestWallFor(openingCenter(o, host), host, newWalls);
    if (!target) {
      dropped.push(o.id);
      continue;
    }
    placed.push({
      ...o,
      wallId: target.wall.id,
      ...fitOpening(target.t, openingWidth(o, host), wallLength(target.wall)),
    });
    if (target.wall.id !== o.wallId) reattached.push(o.id);
  }

  const normalized = normalizeWallOpenings(placed, newWalls);
  const keptIds = new Set(normalized.map((o) => o.id));
  for (const o of placed) if (!keptIds.has(o.id)) dropped.push(o.id);

  return {
    openings: normalized,
    reattached: reattached.filter((id) => keptIds.has(id)),
    dropped,
  };
};

/**
 * Snap/merge/node the walls (eps metres, axis lock AXIS_TOLERANCE_DEG),
 * polygonise the axis-aligned walls into faces and re-match the existing rooms.
 * The editor adopts `walls`, `rooms` AND `openings` on every geometry commit.
 */
export const rebuildRooms = (plan: FloorPlan, o: RebuildOptions = {}): RebuildResult => {
  const eps = o.eps ?? REBUILD_EPS_M;
  const noded = nodePlanWalls(plan.walls, eps);
  const { walls, idOf } = toPlanWalls(noded, plan.walls);
  const { rooms: faces, dangling } = polygonizeRooms(noded.segments, {
    minArea: 4 * eps * eps,
  });
  const rooms = matchRooms(
    plan.rooms,
    faces.map((f) => simplifyCollinear(f.polygon).map(copyPoint)),
  );
  const attached = reattachOpenings(plan.openings, plan.walls, walls);

  return {
    walls,
    rooms,
    openings: attached.openings,
    reattached: attached.reattached,
    droppedOpenings: attached.dropped,
    danglingWallIds: unique(
      dangling.map((d) => idOf.get(d)).filter((id): id is string => Boolean(id)),
    ),
    diagonalWallIds: noded.diagonals.map((d) => d.id),
    droppedWallIds: noded.dropped.map((d) => d.id),
  };
};

/**
 * Single authority for exterior faces: probes both sides of every wall at
 * t = 0.25 / 0.5 / 0.75, `thickness / 2 + 0.05` m from the centre line, against
 * non-stale rooms. Exterior = one side has no room on all probes.
 */
export const wallAdjacency = (plan: FloorPlan): Record<string, WallAdjacency> => {
  const rooms = plan.rooms.filter((r) => !r.stale && r.polygon.length >= 3);
  const roomAt = (p: PlanPoint) => rooms.find((r) => pointInPolygon(p, r.polygon)) ?? null;
  const out: Record<string, WallAdjacency> = {};

  for (const w of plan.walls) {
    const len = wallLength(w);
    if (len < 1e-9) {
      out[w.id] = { roomIds: [], isExterior: false };
      continue;
    }
    const dx = (w.b.x - w.a.x) / len;
    const dy = (w.b.y - w.a.y) / len;
    const offset = w.thickness / 2 + ADJACENCY_PROBE_M;
    const left = new Set<string>();
    const right = new Set<string>();
    for (const t of ADJACENCY_TS) {
      const px = w.a.x + (w.b.x - w.a.x) * t;
      const py = w.a.y + (w.b.y - w.a.y) * t;
      const r1 = roomAt({ x: px + dy * offset, y: py - dx * offset });
      const r2 = roomAt({ x: px - dy * offset, y: py + dx * offset });
      if (r1) left.add(r1.id);
      if (r2) right.add(r2.id);
    }
    out[w.id] = {
      roomIds: rooms.filter((r) => left.has(r.id) || right.has(r.id)).map((r) => r.id),
      isExterior: left.size === 0 || right.size === 0,
    };
  }

  return out;
};

const makeIssue = (
  code: PlanIssueCode,
  severity: PlanIssueSeverity,
  message: string,
  ids?: string[],
  fix?: PlanFix,
): PlanIssue => {
  const out: PlanIssue = { code, severity, message };
  if (ids && ids.length > 0) out.ids = ids;
  if (fix) out.fix = fix;
  return out;
};

const roomLabel = (r: PlanRoom): string => r.name.trim() || "tanpa nama";

/** True when p touches another wall (endpoint or segment) within eps. */
const endConnected = (p: Pt, self: PlanWall, walls: PlanWall[], eps: number): boolean =>
  walls.some(
    (o) =>
      o.id !== self.id &&
      (dist(o.a, p) <= eps ||
        dist(o.b, p) <= eps ||
        projectOnSegment(p, o.a, o.b).dist <= eps),
  );

interface FreeEnd {
  wall: PlanWall;
  end: WallEnd;
  p: PlanPoint;
  target: { point: PlanPoint; wallId: string; end?: WallEnd; d: number } | null;
}

const perpendicularShift = (fe: FreeEnd): number => {
  if (!fe.target) return Infinity;
  const len = wallLength(fe.wall);
  if (len < 1e-12) return 0;
  const ux = (fe.wall.b.x - fe.wall.a.x) / len;
  const uy = (fe.wall.b.y - fe.wall.a.y) / len;
  const mx = fe.target.point.x - fe.p.x;
  const my = fe.target.point.y - fe.p.y;
  return Math.abs(mx * uy - my * ux);
};

/** WALL_DANGLING: a free end gets merge_nodes (safe) when another endpoint, or a
 *  point on another wall, is within 2 * eps; otherwise delete_wall (unsafe). */
const danglingIssues = (walls: PlanWall[], eps: number): PlanIssue[] => {
  const freeEnds: FreeEnd[] = [];
  for (const w of walls) {
    if (wallLength(w) < 1e-9) continue;
    for (const end of ["a", "b"] as const) {
      const p = w[end];
      if (endConnected(p, w, walls, eps)) continue;
      let target: FreeEnd["target"] = null;
      for (const o of walls) {
        if (o.id === w.id) continue;
        for (const oe of ["a", "b"] as const) {
          const d = dist(p, o[oe]);
          if (d <= 2 * eps && (!target || d < target.d - 1e-9)) {
            target = { point: copyPoint(o[oe]), wallId: o.id, end: oe, d };
          }
        }
      }
      for (const o of walls) {
        if (o.id === w.id) continue;
        const proj = projectOnSegment(p, o.a, o.b);
        if (proj.dist <= 2 * eps && (!target || proj.dist < target.d - 1e-9)) {
          target = { point: proj.point, wallId: o.id, d: proj.dist };
        }
      }
      freeEnds.push({ wall: w, end, p: copyPoint(p), target });
    }
  }

  const issues: PlanIssue[] = [];
  const handled = new Set<FreeEnd>();
  const deleted = new Set<string>();
  const find = (wallId: string, end: WallEnd) =>
    freeEnds.find((fe) => fe.wall.id === wallId && fe.end === end);

  for (const fe of freeEnds) {
    if (handled.has(fe)) continue;
    handled.add(fe);

    if (!fe.target) {
      if (deleted.has(fe.wall.id)) continue;
      deleted.add(fe.wall.id);
      issues.push(
        makeIssue(
          "WALL_DANGLING",
          "warn",
          "Dinding menggantung: ujungnya tidak tersambung ke dinding lain.",
          [fe.wall.id],
          { kind: "delete_wall", label: "Hapus", safe: false, ids: [fe.wall.id] },
        ),
      );
      continue;
    }

    let mover = fe;
    if (fe.target.end) {
      const other = find(fe.target.wallId, fe.target.end);
      if (
        other &&
        !handled.has(other) &&
        other.target &&
        other.target.wallId === fe.wall.id &&
        other.target.end === fe.end
      ) {
        handled.add(other);
        if (perpendicularShift(other) < perpendicularShift(fe) - 1e-9) mover = other;
      }
    }
    const target = mover.target!;
    issues.push(
      makeIssue(
        "WALL_DANGLING",
        "warn",
        `Ujung dinding terputus ${fmt(target.d)} m dari dinding lain.`,
        [mover.wall.id, target.wallId],
        {
          kind: "merge_nodes",
          label: "Sambungkan",
          safe: true,
          ids: [mover.wall.id],
          point: copyPoint(target.point),
        },
      ),
    );
  }

  return issues;
};

/**
 * Metric / topology checks with typed one-click fixes (metres). Structural
 * checks live in validate.ts (validatePlan). Deterministic order: scale,
 * topology, walls, openings, rooms, area.
 */
export const planIssues = (plan: FloorPlan): PlanIssue[] => {
  const eps = REBUILD_EPS_M;
  const issues: PlanIssue[] = [];
  const wallById = new Map(plan.walls.map((w) => [w.id, w]));
  const liveRooms = plan.rooms.filter((r) => !r.stale);

  if (!plan.scale.confirmed) {
    issues.push(
      makeIssue(
        "SCALE_UNCONFIRMED",
        "warn",
        "Skala denah belum dikonfirmasi. Kalibrasi 2 titik, isi lebar bangunan, atau pilih \"Skala sudah benar\".",
      ),
    );
  }

  // --- topology -------------------------------------------------------------
  if (plan.walls.length > 0) {
    const noded = nodePlanWalls(plan.walls, eps);
    const faces = polygonizeRooms(noded.segments, { minArea: 4 * eps * eps }).rooms;
    if (faces.length === 0) {
      issues.push(
        makeIssue(
          "NOT_WATERTIGHT",
          "error",
          "Dinding belum membentuk ruangan tertutup. Sambungkan ujung dinding yang terbuka.",
        ),
      );
    } else {
      const open = liveRooms.filter(
        (r) => !faces.some((f) => pointInPolygon(r.anchor, f.polygon)),
      );
      if (open.length > 0) {
        issues.push(
          makeIssue(
            "NOT_WATERTIGHT",
            "warn",
            `Ruangan belum tertutup dinding: ${open.map(roomLabel).join(", ")}.`,
            open.map((r) => r.id),
          ),
        );
      }
    }
  }

  issues.push(...danglingIssues(plan.walls, eps));

  // --- walls ----------------------------------------------------------------
  for (const w of plan.walls) {
    if (wallLength(w) < 1e-9) continue;
    const off = wallOffAxisDeg(w);
    if (off <= AXIS_TOLERANCE_DEG) continue;
    issues.push(
      makeIssue(
        "WALL_DIAGONAL",
        "warn",
        `Dinding miring ${fmt(off, 1)}° dari sumbu; ruangan di sekitarnya tidak dapat dibentuk otomatis.`,
        [w.id],
        {
          kind: "snap_axis",
          label: "Luruskan",
          safe: off <= SAFE_SNAP_AXIS_DEG,
          ids: [w.id],
        },
      ),
    );
  }

  for (const w of plan.walls) {
    const len = wallLength(w);
    if (len >= WALL_SHORT_M) continue;
    issues.push(
      makeIssue(
        "WALL_SHORT",
        "warn",
        `Dinding sangat pendek (${fmt(len)} m).`,
        [w.id],
        { kind: "delete_wall", label: "Hapus", safe: false, ids: [w.id] },
      ),
    );
  }

  // --- openings -------------------------------------------------------------
  let adjacency: Record<string, WallAdjacency> | null = null;
  const byWall = new Map<string, PlanOpening[]>();

  for (const o of plan.openings) {
    const w = wallById.get(o.wallId);
    if (!w) {
      issues.push(
        makeIssue(
          "OPENING_OFF_WALL",
          "error",
          "Bukaan tidak menempel pada dinding mana pun.",
          [o.id],
          { kind: "delete_opening", label: "Hapus", safe: false, ids: [o.id] },
        ),
      );
      continue;
    }

    const list = byWall.get(w.id) ?? [];
    list.push(o);
    byWall.set(w.id, list);

    if (o.t0 < -1e-6 || o.t1 > 1 + 1e-6 || o.bottom < -1e-6 || o.top > w.height + 1e-6) {
      issues.push(
        makeIssue(
          "OPENING_OFF_WALL",
          "warn",
          "Bukaan melewati batas dinding.",
          [o.id, w.id],
          { kind: "clamp_opening", label: "Rapikan", safe: true, ids: [o.id] },
        ),
      );
    } else if (liveRooms.length > 0) {
      adjacency ??= wallAdjacency(plan);
      if ((adjacency[w.id]?.roomIds.length ?? 0) === 0) {
        const center = openingCenter(o, w);
        const candidates = plan.walls.filter(
          (c) => c.id !== w.id && (adjacency?.[c.id]?.roomIds.length ?? 0) > 0,
        );
        const target = nearestWallFor(center, w, candidates);
        if (target) {
          issues.push(
            makeIssue(
              "OPENING_OFF_WALL",
              "warn",
              "Bukaan berada pada dinding yang tidak membatasi ruangan.",
              [o.id, target.wall.id],
              {
                kind: "attach_opening",
                label: "Lekatkan",
                safe: true,
                ids: [o.id, target.wall.id],
              },
            ),
          );
        }
      }
    }

    const width = openingWidth(o, w);
    if (o.kind === "door" && (width < DOOR_WIDTH_MIN_M || width > DOOR_WIDTH_MAX_M)) {
      issues.push(
        makeIssue(
          "DOOR_WIDTH",
          "warn",
          `Lebar pintu ${fmt(width)} m di luar kisaran wajar (${fmt(DOOR_WIDTH_MIN_M)}–${fmt(DOOR_WIDTH_MAX_M)} m); periksa skala.`,
          [o.id],
        ),
      );
    }
    if (o.kind === "window" && (width < WINDOW_WIDTH_MIN_M || width > WINDOW_WIDTH_MAX_M)) {
      issues.push(
        makeIssue(
          "WINDOW_WIDTH",
          "warn",
          `Lebar jendela ${fmt(width)} m di luar kisaran wajar (${fmt(WINDOW_WIDTH_MIN_M)}–${fmt(WINDOW_WIDTH_MAX_M)} m); periksa skala.`,
          [o.id],
        ),
      );
    }
  }

  for (const w of plan.walls) {
    const sorted = [...(byWall.get(w.id) ?? [])].sort((p, q) => p.t0 - q.t0);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      if (next.t0 >= prev.t1 - 1e-9) continue;
      issues.push(
        makeIssue(
          "OPENING_OVERLAP",
          "warn",
          "Dua bukaan saling tumpang tindih.",
          [prev.id, next.id],
          { kind: "clamp_opening", label: "Rapikan", safe: true, ids: [prev.id, next.id] },
        ),
      );
    }
  }

  // --- rooms ----------------------------------------------------------------
  const stale = plan.rooms.filter((r) => r.stale);
  if (stale.length > 0) {
    issues.push(
      makeIssue(
        "ROOMS_STALE",
        "warn",
        `${stale.length} ruangan terputus dari dinding. Sambungkan kembali dindingnya atau pilih "Bangun ulang ruangan".`,
        stale.map((r) => r.id),
      ),
    );
  }

  let total = 0;
  for (const r of liveRooms) {
    const area = polygonArea(r.polygon);
    total += area;
    if (area < ROOM_TINY_M2) {
      issues.push(
        makeIssue("ROOM_TINY", "warn", `Ruangan "${roomLabel(r)}" sangat kecil (${fmt(area)} m²).`, [r.id]),
      );
    } else if (area > ROOM_HUGE_M2) {
      issues.push(
        makeIssue(
          "ROOM_HUGE",
          "warn",
          `Ruangan "${roomLabel(r)}" sangat besar (${fmt(area)} m²); periksa skala.`,
          [r.id],
        ),
      );
    }
    const name = r.name.trim();
    if (!name || (name === DEFAULT_ROOM_NAME && !r.type)) {
      issues.push(
        makeIssue("ROOM_UNNAMED", "warn", "Ruangan belum diberi nama dan jenis.", [r.id]),
      );
    }
  }

  if (liveRooms.length === 0) {
    if (plan.walls.length > 0) {
      issues.push(
        makeIssue(
          "TOTAL_AREA",
          "warn",
          "Belum ada ruangan pada denah. Tutup dinding lalu pilih \"Bangun ulang ruangan\".",
        ),
      );
    }
  } else if (total < TOTAL_AREA_MIN_M2 || total > TOTAL_AREA_MAX_M2) {
    issues.push(
      makeIssue("TOTAL_AREA", "warn", `Total luas ${fmt(total)} m² tidak wajar; periksa skala.`),
    );
  }

  const luas = plan.rab?.luasBangunanM2;
  if (typeof luas === "number" && luas > 0 && total > 0) {
    const deviation = Math.abs(total - luas) / luas;
    if (deviation > LUAS_MISMATCH_RATIO) {
      issues.push(
        makeIssue(
          "LUAS_MISMATCH",
          "warn",
          `Luas denah ${fmt(total)} m² berbeda ${fmt(deviation * 100, 0)}% dari luas bangunan ${fmt(luas)} m²; periksa skala.`,
        ),
      );
    }
  }

  return issues;
};

// --- fixes ------------------------------------------------------------------

const mergeNodes = (plan: FloorPlan, fix: PlanFix): FloorPlan => {
  const target = fix.point;
  if (!target) return plan;
  const ids = new Set(fix.ids);
  let changed = false;
  const walls = plan.walls.map((w) => {
    if (!ids.has(w.id)) return w;
    const da = dist(w.a, target);
    const db = dist(w.b, target);
    if (Math.min(da, db) > MERGE_FIX_LIMIT_M) return w;
    changed = true;
    return da <= db ? { ...w, a: copyPoint(target) } : { ...w, b: copyPoint(target) };
  });
  return changed ? { ...plan, walls } : plan;
};

/** Straightens a wall onto the nearest axis. A connected end stays put (the free
 *  end moves); with both or neither connected it rotates about its midpoint.
 *  Other walls' endpoints that coincided with a moved end follow it. */
const snapAxis = (plan: FloorPlan, fix: PlanFix): FloorPlan => {
  const eps = REBUILD_EPS_M;
  const w = plan.walls.find((x) => x.id === fix.ids[0]);
  if (!w || wallLength(w) < 1e-9) return plan;

  const horizontal = wallAngleDeg(w) <= 45;
  const aFixed = endConnected(w.a, w, plan.walls, eps);
  const bFixed = endConnected(w.b, w, plan.walls, eps);
  let a = copyPoint(w.a);
  let b = copyPoint(w.b);
  if (aFixed && !bFixed) {
    b = horizontal ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
  } else if (bFixed && !aFixed) {
    a = horizontal ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
  } else if (horizontal) {
    const y = (a.y + b.y) / 2;
    a = { x: a.x, y };
    b = { x: b.x, y };
  } else {
    const x = (a.x + b.x) / 2;
    a = { x, y: a.y };
    b = { x, y: b.y };
  }

  const follow = (p: PlanPoint): PlanPoint => {
    if (dist(p, w.a) <= eps) return copyPoint(a);
    if (dist(p, w.b) <= eps) return copyPoint(b);
    return p;
  };
  const walls = plan.walls.map((o) => {
    if (o.id === w.id) return { ...o, a, b };
    const na = follow(o.a);
    const nb = follow(o.b);
    return na === o.a && nb === o.b ? o : { ...o, a: na, b: nb };
  });
  return { ...plan, walls };
};

const attachOpening = (plan: FloorPlan, fix: PlanFix): FloorPlan => {
  const [openingId, wallId] = fix.ids;
  const o = plan.openings.find((x) => x.id === openingId);
  const target = plan.walls.find((x) => x.id === wallId);
  if (!o || !target) return plan;
  const len = wallLength(target);
  if (len < 1e-9) return plan;

  const host = plan.walls.find((x) => x.id === o.wallId);
  const center = host
    ? openingCenter(o, host)
    : { x: (target.a.x + target.b.x) / 2, y: (target.a.y + target.b.y) / 2 };
  const width = host ? openingWidth(o, host) : o.kind === "window" ? 1.2 : DOOR_WIDTH_PRIOR;
  const t = projectOnSegment(center, target.a, target.b).t;
  const top = Math.min(o.top, target.height);
  const bottom = Math.min(o.bottom, top);

  return {
    ...plan,
    openings: plan.openings.map((x) =>
      x.id === o.id
        ? { ...x, wallId: target.id, ...fitOpening(t, width, len), bottom, top }
        : x,
    ),
  };
};

/** One id: clamp the opening to its wall (0..1, 0..height). Two ids on the same
 *  wall: move the second so it starts where the first ends (keeping its width
 *  when possible, else placing it before the first). */
const clampOpening = (plan: FloorPlan, fix: PlanFix): FloorPlan => {
  const byId = new Map(plan.openings.map((o) => [o.id, o]));
  const clampUnit = (v: number) => Math.min(1, Math.max(0, v));

  if (fix.ids.length === 1) {
    const o = byId.get(fix.ids[0]);
    const w = o ? plan.walls.find((x) => x.id === o.wallId) : undefined;
    if (!o || !w) return plan;
    const t0 = clampUnit(Math.min(o.t0, o.t1));
    const t1 = clampUnit(Math.max(o.t0, o.t1));
    const bottom = Math.min(Math.max(0, Math.min(o.bottom, o.top)), w.height);
    const top = Math.min(Math.max(0, Math.max(o.bottom, o.top)), w.height);
    return {
      ...plan,
      openings: plan.openings.map((x) => (x.id === o.id ? { ...x, t0, t1, bottom, top } : x)),
    };
  }

  const first = byId.get(fix.ids[0]);
  const second = byId.get(fix.ids[1]);
  if (!first || !second || first.wallId !== second.wallId) return plan;
  const span = second.t1 - second.t0;
  let t0 = Math.max(second.t0, first.t1);
  let t1 = second.t1;
  if (t1 - t0 <= 1e-6) {
    t0 = first.t1;
    t1 = Math.min(1, first.t1 + span);
    if (t1 - t0 <= 1e-6) {
      t1 = first.t0;
      t0 = Math.max(0, first.t0 - span);
    }
  }
  if (t1 - t0 <= 1e-6) return plan;
  return {
    ...plan,
    openings: plan.openings.map((x) =>
      x.id === second.id ? { ...x, t0: clampUnit(t0), t1: clampUnit(t1) } : x,
    ),
  };
};

/**
 * Applies one typed fix and returns a NEW plan (input untouched; the same
 * reference when the fix no longer applies). Rooms are not rebuilt here: the
 * editor runs rebuildRooms after APPLY_FIX like after any geometry commit.
 */
export const applyFix = (plan: FloorPlan, fix: PlanFix): FloorPlan => {
  switch (fix.kind) {
    case "merge_nodes":
      return mergeNodes(plan, fix);
    case "snap_axis":
      return snapAxis(plan, fix);
    case "attach_opening":
      return attachOpening(plan, fix);
    case "clamp_opening":
      return clampOpening(plan, fix);
    case "delete_wall": {
      const ids = new Set(fix.ids);
      if (!plan.walls.some((w) => ids.has(w.id))) return plan;
      return {
        ...plan,
        walls: plan.walls.filter((w) => !ids.has(w.id)),
        openings: plan.openings.filter((o) => !ids.has(o.wallId)),
      };
    }
    case "delete_opening": {
      const ids = new Set(fix.ids);
      if (!plan.openings.some((o) => ids.has(o.id))) return plan;
      return { ...plan, openings: plan.openings.filter((o) => !ids.has(o.id)) };
    }
    default:
      return plan;
  }
};

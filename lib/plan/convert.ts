// The only module that crosses frames: natural px <-> metres, plan -> scene,
// extraction north -> plan north, and rescaling. Plan space is metres, x right
// / y DOWN, origin at the image top-left. Scene: plan (x, y) -> world (x, 0, z = y).

import { DEFAULT_WALL_HEIGHT } from "./defaults";

export interface PlanBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  center: PlanPoint;
}

export interface SceneOpening {
  id: string;
  kind: PlanOpeningKind;
  t0: number;
  t1: number;
  bottom: number;
  top: number;
}

/** Plan metres verbatim: x1/y1/x2/y2 are world x / z. */
export interface WallSpec {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  height: number;
  openings: SceneOpening[];
}

export interface RoomSpec {
  id: string;
  name: string;
  type: PlanRoomType;
  polygon: [number, number][];
  floorMaterialId: string;
}

export interface SceneModel {
  walls: WallSpec[];
  /** non-stale rooms only */
  rooms: RoomSpec[];
  bounds: PlanBounds;
  /** [x, 0, z] */
  center: [number, number, number];
  /** [x extent, z extent] in metres */
  size: [number, number];
  /** [x, z] spawn point for walk mode: centroid of the largest room */
  spawn: [number, number];
  /** three.js rotation.y (radians) facing the nearest door; yaw 0 looks toward -Z,
   *  forward = (-sin yaw, 0, -cos yaw) */
  spawnYaw: number;
  /** tallest wall height (DEFAULT_WALL_HEIGHT without walls) */
  height: number;
}

export const normalizeDeg = (d: number): number => {
  if (!Number.isFinite(d)) return 0;
  const r = ((d % 360) + 360) % 360;
  return r === 360 ? 0 : r;
};

/** Extraction north_deg (compass north, clockwise from image-up) -> plan northOffsetDeg. */
export const northOffsetFromExtraction = (n: number): number =>
  normalizeDeg(360 - n);

export const pxToM = (px: number, scale: PlanScale): number =>
  px / scale.pxPerMeter;

export const mToPx = (m: number, scale: PlanScale): number =>
  m * scale.pxPerMeter;

export const pointPxToM = (p: PlanPoint, scale: PlanScale): PlanPoint => ({
  x: pxToM(p.x, scale),
  y: pxToM(p.y, scale),
});

export const pointMToPx = (p: PlanPoint, scale: PlanScale): PlanPoint => ({
  x: mToPx(p.x, scale),
  y: mToPx(p.y, scale),
});

/** Multiplies every x/y, anchor and thickness by old/new; heights and
 *  bottom/top untouched; confirmed only when method === "manual". */
export const rescalePlan = (
  plan: FloorPlan,
  pxPerMeter: number,
  method: PlanScaleMethod,
): FloorPlan => {
  const factor = plan.scale.pxPerMeter / pxPerMeter;
  const scalePoint = (p: PlanPoint): PlanPoint => ({
    x: p.x * factor,
    y: p.y * factor,
  });
  const confirmed = method === "manual";

  return {
    ...plan,
    scale: {
      pxPerMeter,
      confirmed,
      method,
      confidence: confirmed ? 1 : plan.scale.confidence,
    },
    walls: plan.walls.map((w) => ({
      ...w,
      a: scalePoint(w.a),
      b: scalePoint(w.b),
      thickness: w.thickness * factor,
    })),
    rooms: plan.rooms.map((r) => ({
      ...r,
      polygon: r.polygon.map(scalePoint),
      anchor: scalePoint(r.anchor),
    })),
    extraction: plan.extraction
      ? {
          ...plan.extraction,
          rawRooms: (plan.extraction.rawRooms ?? []).map((r) => ({
            ...r,
            polygon: r.polygon.map(scalePoint),
          })),
        }
      : plan.extraction,
  };
};

export const wallLength = (w: PlanWall): number =>
  Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);

/** Angle from the x axis folded into 0..90 (0 = horizontal, 90 = vertical). */
export const wallAngleDeg = (w: PlanWall): number => {
  const deg = Math.abs(
    (Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x) * 180) / Math.PI,
  );
  return deg > 90 ? 180 - deg : deg;
};

/** Degrees off the nearest axis, 0..45. */
export const wallOffAxisDeg = (w: PlanWall): number => {
  const a = wallAngleDeg(w);
  return Math.min(a, 90 - a);
};

export const openingWidth = (o: PlanOpening, w: PlanWall): number =>
  (o.t1 - o.t0) * wallLength(w);

export const openingCenter = (o: PlanOpening, w: PlanWall): PlanPoint => {
  const t = (o.t0 + o.t1) / 2;
  return {
    x: w.a.x + (w.b.x - w.a.x) * t,
    y: w.a.y + (w.b.y - w.a.y) * t,
  };
};

const signedArea = (poly: PlanPoint[]): number => {
  let sum = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
};

export const polygonArea = (poly: PlanPoint[]): number =>
  poly.length < 3 ? 0 : Math.abs(signedArea(poly));

export const polygonPerimeter = (poly: PlanPoint[]): number => {
  if (poly.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    sum += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return sum;
};

export const polygonCentroid = (poly: PlanPoint[]): PlanPoint => {
  if (poly.length === 0) return { x: 0, y: 0 };

  const area = signedArea(poly);
  if (poly.length < 3 || Math.abs(area) < 1e-9) {
    const sum = poly.reduce(
      (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
      { x: 0, y: 0 },
    );
    return { x: sum.x / poly.length, y: sum.y / poly.length };
  }

  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const cross = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
};

/** Ray casting; points on the boundary are not guaranteed either way. */
export const pointInPolygon = (pt: PlanPoint, poly: PlanPoint[]): boolean => {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i];
    const b = poly[j];
    const crosses =
      a.y > pt.y !== b.y > pt.y &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
};

const boundsFromPoints = (points: PlanPoint[]): PlanBounds => {
  if (points.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0,
      center: { x: 0, y: 0 },
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
  };
};

/** Bounding box of wall endpoints (room polygons when there are no walls). */
export const planBounds = (plan: FloorPlan): PlanBounds => {
  const points: PlanPoint[] = [];
  for (const w of plan.walls) points.push(w.a, w.b);
  if (points.length === 0) {
    for (const r of plan.rooms) {
      if (!r.stale) points.push(...r.polygon);
    }
  }
  return boundsFromPoints(points);
};

/** Largest non-stale room by polygon area, or null. */
export const largestRoom = (plan: FloorPlan): PlanRoom | null => {
  let best: PlanRoom | null = null;
  let bestArea = -1;
  for (const r of plan.rooms) {
    if (r.stale) continue;
    const area = polygonArea(r.polygon);
    if (area > bestArea) {
      best = r;
      bestArea = area;
    }
  }
  return best;
};

export const planToScene = (plan: FloorPlan): SceneModel => {
  const wallById = new Map(plan.walls.map((w) => [w.id, w]));
  const openingsByWall = new Map<string, SceneOpening[]>();

  for (const o of plan.openings) {
    if (!wallById.has(o.wallId)) continue;
    const list = openingsByWall.get(o.wallId) ?? [];
    list.push({
      id: o.id,
      kind: o.kind,
      t0: o.t0,
      t1: o.t1,
      bottom: o.bottom,
      top: o.top,
    });
    openingsByWall.set(o.wallId, list);
  }

  const walls: WallSpec[] = plan.walls.map((w) => ({
    id: w.id,
    x1: w.a.x,
    y1: w.a.y,
    x2: w.b.x,
    y2: w.b.y,
    thickness: w.thickness,
    height: w.height,
    openings: (openingsByWall.get(w.id) ?? []).sort((a, b) => a.t0 - b.t0),
  }));

  const rooms: RoomSpec[] = plan.rooms
    .filter((r) => !r.stale)
    .map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type ?? "lainnya",
      polygon: r.polygon.map((p) => [p.x, p.y] as [number, number]),
      floorMaterialId: r.floorMaterialId || plan.materials.floor,
    }));

  const bounds = planBounds(plan);
  const height = plan.walls.reduce(
    (max, w) => (w.height > max ? w.height : max),
    0,
  );

  const spawnRoom = largestRoom(plan);
  const spawnPoint = spawnRoom
    ? polygonCentroid(spawnRoom.polygon)
    : bounds.center;

  // Face the nearest door (any opening as a fallback) from the spawn point.
  let target: PlanPoint | null = null;
  let bestDist = Infinity;
  const candidates = plan.openings.filter((o) => o.kind === "door");
  const pool = candidates.length > 0 ? candidates : plan.openings;
  for (const o of pool) {
    const w = wallById.get(o.wallId);
    if (!w) continue;
    const c = openingCenter(o, w);
    const d = Math.hypot(c.x - spawnPoint.x, c.y - spawnPoint.y);
    if (d < bestDist) {
      bestDist = d;
      target = c;
    }
  }

  const spawnYaw =
    target && bestDist > 1e-6
      ? Math.atan2(-(target.x - spawnPoint.x), -(target.y - spawnPoint.y))
      : 0;

  return {
    walls,
    rooms,
    bounds,
    center: [bounds.center.x, 0, bounds.center.y],
    size: [bounds.width, bounds.height],
    spawn: [spawnPoint.x, spawnPoint.y],
    spawnYaw,
    height: height > 0 ? height : DEFAULT_WALL_HEIGHT,
  };
};

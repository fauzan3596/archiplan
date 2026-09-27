// lib/sun/sunlightHours.ts
// "Direct sunlight hours per room" heuristic on the extracted 2D geometry.
// PLAN coordinates: metres, x to the right, y DOWN (SVG convention). Plan-up (-y) is the
// direction with compass bearing `northOffsetDeg`. Plan (x, y) maps to scene (x, 0, z=y).
import * as SunCalc from "suncalc";
import { localToInstant, type IndoZone, type LocalDay } from "./geo";
import { bearingToLabelId, planDirToBearing } from "./sunDirection";
import { openingWidth } from "../plan/convert";

export interface Vec2 {
  x: number;
  y: number;
}

export interface Wall {
  id: string;
  a: Vec2;
  b: Vec2;
  /** metres */
  thickness: number;
  /** metres, top of wall above floor */
  height: number;
}

export interface Room {
  id: string;
  name: string;
  /** simple polygon, plan metres */
  polygon: Vec2[];
}

export interface Opening {
  id: string;
  wallId: string;
  kind: "window" | "door";
  /** centre position along wall a->b, 0..1 */
  t: number;
  width: number;
  /** metres above floor to the bottom of the opening */
  sillHeight: number;
  /** metres, opening height */
  height: number;
}

export interface FloorPlanGeometry {
  walls: Wall[];
  rooms: Room[];
  openings: Opening[];
}

export interface ResolvedWindow {
  opening: Opening;
  wall: Wall;
  centre: Vec2;
  /** unit normal pointing OUT of the building, plan coords */
  normal: Vec2;
  roomId: string;
  /** compass bearing the window faces (deg cw from true N) */
  facingBearing: number;
  facingLabel: string;
}

export interface SkippedOpening {
  id: string;
  reason: "door" | "interior-wall" | "no-adjacent-room" | "missing-wall";
}

// even-odd point in polygon
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Exterior-side test: probe a point just beyond each face of the wall. A wall is exterior
 * when exactly one side lies inside a room; the room-less side is outside.
 */
export function resolveExteriorWindows(
  plan: FloorPlanGeometry,
  northOffsetDeg = 0,
): { windows: ResolvedWindow[]; skipped: SkippedOpening[] } {
  const windows: ResolvedWindow[] = [];
  const skipped: SkippedOpening[] = [];
  const roomAt = (p: Vec2) => plan.rooms.find((r) => pointInPolygon(p, r.polygon)) ?? null;

  for (const op of plan.openings) {
    if (op.kind !== "window") {
      skipped.push({ id: op.id, reason: "door" });
      continue;
    }
    const wall = plan.walls.find((w) => w.id === op.wallId);
    if (!wall) {
      skipped.push({ id: op.id, reason: "missing-wall" });
      continue;
    }
    const dx = wall.b.x - wall.a.x;
    const dy = wall.b.y - wall.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const d = { x: dx / len, y: dy / len };
    const centre = { x: wall.a.x + dx * op.t, y: wall.a.y + dy * op.t };
    const probe = wall.thickness / 2 + 0.05;
    const n1 = { x: d.y, y: -d.x };
    const n2 = { x: -d.y, y: d.x };
    const r1 = roomAt({ x: centre.x + n1.x * probe, y: centre.y + n1.y * probe });
    const r2 = roomAt({ x: centre.x + n2.x * probe, y: centre.y + n2.y * probe });
    if (r1 && r2) {
      skipped.push({ id: op.id, reason: "interior-wall" });
      continue;
    }
    if (!r1 && !r2) {
      skipped.push({ id: op.id, reason: "no-adjacent-room" });
      continue;
    }
    const normal = r1 ? n2 : n1;
    const room = (r1 ?? r2)!;
    const facingBearing = planDirToBearing(normal.x, normal.y, northOffsetDeg);
    windows.push({ opening: op, wall, centre, normal, roomId: room.id, facingBearing, facingLabel: bearingToLabelId(facingBearing) });
  }
  return { windows, skipped };
}

/** Ray (o, dir) vs segment ab. Returns distance along the ray (>0) or null. */
export function raySegmentDistance(o: Vec2, dir: Vec2, a: Vec2, b: Vec2): number | null {
  const v1 = { x: o.x - a.x, y: o.y - a.y };
  const v2 = { x: b.x - a.x, y: b.y - a.y };
  const v3 = { x: -dir.y, y: dir.x };
  const dot = v2.x * v3.x + v2.y * v3.y;
  if (Math.abs(dot) < 1e-9) return null;
  const t1 = (v2.x * v1.y - v2.y * v1.x) / dot;
  const t2 = (v1.x * v3.x + v1.y * v3.y) / dot;
  return t1 > 1e-6 && t2 >= 0 && t2 <= 1 ? t1 : null;
}

export interface SunlightHoursOptions {
  /** default 15 */
  stepMinutes?: number;
  /** ignore the sun below this altitude (haze / neighbours), default 3 deg */
  minAltitudeDeg?: number;
  /** weight each step by cos(incidence) instead of 0/1, default false */
  cosineWeighted?: boolean;
  /** 2D raycast against the building's own walls (L-shapes, wings), default true */
  selfShadow?: boolean;
  /** metres, default 60 */
  maxRayDistance?: number;
}

export interface RoomSunlight {
  roomId: string;
  name: string;
  hours: number;
  /** first / last instant a window of this room is lit (null when never) */
  first: Date | null;
  last: Date | null;
  windows: { id: string; hours: number; facingBearing: number; facingLabel: string }[];
}

export interface SunlightHoursResult {
  rooms: RoomSunlight[];
  byRoom: Record<string, number>;
  byWindow: Record<string, number>;
  skipped: SkippedOpening[];
  stepMinutes: number;
}

export function sunlightHoursPerRoom(
  plan: FloorPlanGeometry,
  day: LocalDay,
  lat: number,
  lng: number,
  zone: IndoZone,
  northOffsetDeg = 0,
  opts: SunlightHoursOptions = {},
): SunlightHoursResult {
  const stepMinutes = opts.stepMinutes ?? 15;
  const minAlt = opts.minAltitudeDeg ?? 3;
  const weighted = opts.cosineWeighted ?? false;
  const selfShadow = opts.selfShadow ?? true;
  const maxRay = opts.maxRayDistance ?? 60;
  const dtHours = stepMinutes / 60;

  const { windows, skipped } = resolveExteriorWindows(plan, northOffsetDeg);
  const byWindow: Record<string, number> = Object.fromEntries(windows.map((w) => [w.opening.id, 0]));
  const byRoom: Record<string, number> = Object.fromEntries(plan.rooms.map((r) => [r.id, 0]));
  const firstLast = new Map<string, { first: Date | null; last: Date | null }>(
    plan.rooms.map((r) => [r.id, { first: null, last: null }]),
  );

  const steps = Math.round(1440 / stepMinutes);
  for (let i = 0; i < steps; i++) {
    const date = localToInstant(day, i * stepMinutes, zone);
    const { azimuth, altitude } = SunCalc.getPosition(date, lat, lng);
    if (altitude < minAlt) continue;

    // horizontal unit vector toward the sun in plan coords (east=+x, north=-y), rotated by the north offset
    const az = ((azimuth - northOffsetDeg) * Math.PI) / 180;
    const sunPlan = { x: Math.sin(az), y: -Math.cos(az) };
    const tanAlt = Math.tan((altitude * Math.PI) / 180);
    const litRooms = new Set<string>();

    for (const w of windows) {
      const cosI = sunPlan.x * w.normal.x + sunPlan.y * w.normal.y;
      if (cosI <= 0) continue; // sun behind the wall

      if (selfShadow) {
        const origin = {
          x: w.centre.x + w.normal.x * (w.wall.thickness / 2 + 0.01),
          y: w.centre.y + w.normal.y * (w.wall.thickness / 2 + 0.01),
        };
        const hMid = w.opening.sillHeight + w.opening.height / 2;
        let blocked = false;
        for (const wall of plan.walls) {
          if (wall.id === w.wall.id) continue;
          const dist = raySegmentDistance(origin, sunPlan, wall.a, wall.b);
          // blocked if the wall top subtends a larger angle than the sun's altitude
          if (dist !== null && dist < maxRay && (wall.height - hMid) / dist > tanAlt) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
      }

      byWindow[w.opening.id] += dtHours * (weighted ? cosI : 1);
      litRooms.add(w.roomId);
    }

    for (const roomId of litRooms) {
      byRoom[roomId] += dtHours;
      const fl = firstLast.get(roomId)!;
      if (!fl.first) fl.first = date;
      fl.last = date;
    }
  }

  const rooms: RoomSunlight[] = plan.rooms.map((r) => ({
    roomId: r.id,
    name: r.name,
    hours: byRoom[r.id],
    first: firstLast.get(r.id)!.first,
    last: firstLast.get(r.id)!.last,
    windows: windows
      .filter((w) => w.roomId === r.id)
      .map((w) => ({ id: w.opening.id, hours: byWindow[w.opening.id], facingBearing: w.facingBearing, facingLabel: w.facingLabel })),
  }));

  return { rooms, byRoom, byWindow, skipped, stepMinutes };
}

// ---------------------------------------------------------------------------
// Archiplan glue (not part of the verified sketch)
// ---------------------------------------------------------------------------

/** Aliases used by callers that also import the global plan types. */
export type SunWall = Wall;
export type SunRoom = Room;
export type SunOpening = Opening;

/**
 * FloorPlan (metres) -> the heuristic's geometry. Openings keep their id; the centre
 * t = (t0 + t1) / 2, width = (t1 - t0) * wall length, sill = bottom, height = top - bottom.
 * Passages (kind "opening") are treated like doors (never counted as windows). Stale rooms
 * are excluded, so a window whose room went stale is skipped as "no-adjacent-room".
 */
export function planToSunGeometry(plan: FloorPlan): FloorPlanGeometry {
  const wallById = new Map(plan.walls.map((w) => [w.id, w]));
  return {
    walls: plan.walls.map((w) => ({
      id: w.id,
      a: { x: w.a.x, y: w.a.y },
      b: { x: w.b.x, y: w.b.y },
      thickness: w.thickness,
      height: w.height,
    })),
    rooms: plan.rooms
      .filter((r) => !r.stale)
      .map((r) => ({
        id: r.id,
        name: r.name,
        polygon: r.polygon.map((p) => ({ x: p.x, y: p.y })),
      })),
    openings: plan.openings.map((o) => {
      const wall = wallById.get(o.wallId);
      return {
        id: o.id,
        wallId: o.wallId,
        kind: o.kind === "window" ? "window" : "door",
        t: (o.t0 + o.t1) / 2,
        width: wall ? openingWidth(o, wall) : 0,
        sillHeight: o.bottom,
        height: o.top - o.bottom,
      };
    }),
  };
}

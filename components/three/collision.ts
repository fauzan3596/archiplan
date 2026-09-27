// Cheap 2D circle-vs-thick-segment collision on the XZ plane with door
// pass-through (port of the verified three-stack sketch). Openings key on
// bottom/top, not kind: anything starting at the floor and at least
// DOOR_MIN_CLEAR_HEIGHT tall (doors and passages) is walkable.

import type { WallSpec } from "../../lib/plan/convert";

/** Precomputed 2D segment collider (XZ plane). */
export interface WallCollider {
  x1: number;
  z1: number;
  /** unit direction */
  ux: number;
  uz: number;
  len: number;
  /** thickness / 2 (player radius added at resolve time) */
  half: number;
  /** passable intervals in metres along the wall */
  doors: [number, number][];
}

const DOOR_MAX_SILL = 0.05;
const DOOR_MIN_CLEAR_HEIGHT = 1.8;

export const buildColliders = (walls: WallSpec[]): WallCollider[] => {
  const out: WallCollider[] = [];
  for (const w of walls) {
    const dx = w.x2 - w.x1;
    const dz = w.y2 - w.y1;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    const doors: [number, number][] = [];
    for (const o of w.openings ?? []) {
      if (o.bottom <= DOOR_MAX_SILL && o.top >= DOOR_MIN_CLEAR_HEIGHT) {
        doors.push([Math.min(o.t0, o.t1) * len, Math.max(o.t0, o.t1) * len]);
      }
    }
    out.push({
      x1: w.x1,
      z1: w.y1,
      ux: dx / len,
      uz: dz / len,
      len,
      half: w.thickness / 2,
      doors,
    });
  }
  return out;
};

/**
 * Circle (player, radius r) vs thick segments. Two relaxation passes handle
 * inside corners. Mutates pos.x / pos.z. O(walls) per frame, trivially cheap
 * for < 500 walls.
 */
export const resolveCollisions = (
  pos: { x: number; z: number },
  colliders: WallCollider[],
  radius: number,
): void => {
  for (let pass = 0; pass < 2; pass += 1) {
    for (const c of colliders) {
      const px = pos.x - c.x1;
      const pz = pos.z - c.z1;
      const t = px * c.ux + pz * c.uz; // projection along the wall
      const tc = t < 0 ? 0 : t > c.len ? c.len : t; // clamped -> closest point on segment
      const cx = c.x1 + c.ux * tc;
      const cz = c.z1 + c.uz * tc;
      let dx = pos.x - cx;
      let dz = pos.z - cz;
      const minDist = c.half + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minDist * minDist) continue;
      // Walking through a doorway: skip this wall while the player is inside
      // the opening (minus their radius).
      let inDoor = false;
      for (const [a, b] of c.doors) {
        if (t >= a + radius && t <= b - radius) {
          inDoor = true;
          break;
        }
      }
      if (inDoor) continue;
      const d = Math.sqrt(d2);
      if (d < 1e-6) {
        // exactly on the line: push along the normal
        dx = -c.uz;
        dz = c.ux;
      } else {
        dx /= d;
        dz /= d;
      }
      const push = minDist - d;
      pos.x += dx * push;
      pos.z += dz * push;
    }
  }
};

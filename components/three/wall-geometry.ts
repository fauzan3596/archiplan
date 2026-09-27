// Wall elevation profiles -> extruded wall meshes (port of the verified
// three-stack sketch). Local wall frame: u = metres along a -> b, v = metres
// up, extrusion depth = thickness centred on the wall line. Openings key on
// bottom/top (never on kind): bottom ~ 0 -> notch in the bottom edge, top ~ H
// -> notch in the top edge, both -> the wall is split, otherwise -> hole.

import * as THREE from "three";
import type { WallSpec } from "../../lib/plan/convert";

const EPS = 1e-3;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** The part of an opening the geometry needs; SceneOpening satisfies it. */
export interface OpeningExtent {
  t0: number;
  t1: number;
  bottom: number;
  top: number;
}

type Pt = [number, number];

/** Clamp, sort by t0 and union overlapping openings so the outline walk never
 *  self-intersects. Touching (not overlapping) openings are kept apart. */
export const normalizeOpenings = <T extends OpeningExtent>(
  openings: readonly T[] | undefined,
  height: number,
): T[] => {
  if (!openings?.length) return [];

  const clean = openings
    .map((o) => ({
      ...o,
      t0: clamp(Math.min(o.t0, o.t1), 0, 1),
      t1: clamp(Math.max(o.t0, o.t1), 0, 1),
      bottom: clamp(Math.min(o.bottom, o.top), 0, height),
      top: clamp(Math.max(o.bottom, o.top), 0, height),
    }))
    .filter((o) => o.t1 - o.t0 > EPS && o.top - o.bottom > EPS)
    .sort((a, b) => a.t0 - b.t0);

  const merged: T[] = [];
  for (const o of clean) {
    const last = merged[merged.length - 1];
    if (last && o.t0 < last.t1 - EPS) {
      last.t1 = Math.max(last.t1, o.t1);
      last.bottom = Math.min(last.bottom, o.bottom);
      last.top = Math.max(last.top, o.top);
    } else {
      merged.push({ ...o });
    }
  }
  return merged;
};

/** Drops repeated and collinear (including back-tracking spike) vertices of a
 *  closed ring, e.g. the duplicate corner left by a door flush with the wall end. */
const cleanRing = (ring: Pt[]): Pt[] => {
  const pts = ring.slice();
  let changed = true;
  while (changed && pts.length > 2) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 2; i += 1) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const cur = pts[i];
      const next = pts[(i + 1) % pts.length];
      const cross =
        (cur[0] - prev[0]) * (next[1] - cur[1]) -
        (cur[1] - prev[1]) * (next[0] - cur[0]);
      const duplicate =
        Math.abs(cur[0] - prev[0]) < EPS && Math.abs(cur[1] - prev[1]) < EPS;
      if (duplicate || Math.abs(cross) < EPS * EPS) {
        pts.splice(i, 1);
        changed = true;
        i -= 1;
      }
    }
  }
  return pts;
};

const ringToShape = (ring: Pt[]): THREE.Shape => {
  const shape = new THREE.Shape();
  shape.moveTo(ring[0][0], ring[0][1]);
  for (let i = 1; i < ring.length; i += 1) shape.lineTo(ring[i][0], ring[i][1]);
  shape.closePath();
  return shape;
};

/**
 * Builds the wall's elevation profile(s) in local (u = along wall, v = up) space.
 * - Doors (bottom == 0)         -> notch cut into the bottom edge of the contour
 * - Windows (0 < bottom, top<H) -> THREE.Path hole inside the contour
 * - Top-touching openings       -> notch cut into the top edge
 * - Full-height openings        -> the wall is split into separate shapes (one per span)
 */
export const buildWallShapes = (spec: WallSpec): THREE.Shape[] => {
  const L = Math.hypot(spec.x2 - spec.x1, spec.y2 - spec.y1);
  const H = spec.height;
  if (L < EPS || H < EPS) return [];

  const ops = normalizeOpenings(spec.openings, H);
  const isFull = (o: OpeningExtent) => o.bottom <= EPS && o.top >= H - EPS;
  const isDoor = (o: OpeningExtent) => o.bottom <= EPS && !isFull(o);
  const isTopNotch = (o: OpeningExtent) => o.top >= H - EPS && o.bottom > EPS;
  const isWindow = (o: OpeningExtent) => o.bottom > EPS && o.top < H - EPS;

  // Split into spans [a, b] (metres) around full-height openings.
  const spans: [number, number][] = [];
  let cursor = 0;
  for (const o of ops.filter(isFull)) {
    if (o.t0 * L - cursor > EPS) spans.push([cursor, o.t0 * L]);
    cursor = o.t1 * L;
  }
  if (L - cursor > EPS) spans.push([cursor, L]);

  const shapes: THREE.Shape[] = [];
  for (const [a, b] of spans) {
    const inSpan = ops
      .filter(
        (o) => o.t0 * L >= a - EPS && o.t1 * L <= b + EPS && !isFull(o),
      )
      .map((o) => ({
        o,
        u0: Math.max(a, o.t0 * L),
        u1: Math.min(b, o.t1 * L),
      }));

    const ring: Pt[] = [[a, 0]];
    // bottom edge, left -> right, notching doors
    for (const { o, u0, u1 } of inSpan.filter((x) => isDoor(x.o))) {
      ring.push([u0, 0], [u0, o.top], [u1, o.top], [u1, 0]);
    }
    ring.push([b, 0], [b, H]);
    // top edge, right -> left, notching top-touching openings
    for (const { o, u0, u1 } of inSpan
      .filter((x) => isTopNotch(x.o))
      .reverse()) {
      ring.push([u1, H], [u1, o.bottom], [u0, o.bottom], [u0, H]);
    }
    ring.push([a, H]);

    const outline = cleanRing(ring);
    if (outline.length < 3) continue;
    const shape = ringToShape(outline);

    // Holes may touch the outline or each other: earcut triangulates those
    // correctly (covered by wall-geometry.test.ts).
    for (const { o, u0, u1 } of inSpan.filter((x) => isWindow(x.o))) {
      const hole = new THREE.Path();
      hole.moveTo(u0, o.bottom);
      hole.lineTo(u1, o.bottom);
      hole.lineTo(u1, o.top);
      hole.lineTo(u0, o.top);
      hole.closePath();
      shape.holes.push(hole); // winding is auto-corrected by ExtrudeGeometry
    }
    shapes.push(shape);
  }
  return shapes;
};

/**
 * ExtrudeGeometry extrudes along local +Z from 0..depth; it is centred on the
 * wall line (translate -thickness/2) so the mesh is placed with
 * position = (x1, 0, y1) and rotation.y = -atan2(dy, dx). Groups:
 * materialIndex 0 = the two large faces, 1 = the thin edges. Face UVs are
 * local metres (u, v), so texture.repeat = 1 / tileSize tiles correctly.
 */
export const buildWallGeometry = (spec: WallSpec): THREE.BufferGeometry => {
  const shapes = buildWallShapes(spec);
  if (!shapes.length) return new THREE.BufferGeometry();
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: spec.thickness,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -spec.thickness / 2);
  geometry.computeBoundingSphere();
  return geometry;
};

export const wallTransform = (
  spec: WallSpec,
): { position: [number, number, number]; rotationY: number } => {
  const dx = spec.x2 - spec.x1;
  const dz = spec.y2 - spec.y1;
  // rotation about Y maps local +X -> (cos t, 0, -sin t); we need (dx, dz)/L => t = -atan2(dz, dx)
  return { position: [spec.x1, 0, spec.y1], rotationY: -Math.atan2(dz, dx) };
};

// Room floor / ceiling slabs from (possibly concave) plan polygons (port of
// the verified three-stack sketch). Polygon points are plan metres [x, y],
// which are world [x, z].

import * as THREE from "three";

/** Drops consecutive duplicates and a repeated closing vertex (earcut copes,
 *  but degenerate triangles are wasteful). */
const dedupe = (polygon: [number, number][]): [number, number][] => {
  const out: [number, number][] = [];
  for (const p of polygon) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4) out.push(p);
  }
  if (out.length > 2) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) <= 1e-4) out.pop();
  }
  return out;
};

/**
 * ShapeGeometry lies in the XY plane with a +Z normal and UVs == raw (x, y)
 * vertex coords ("world uvs"). rotateX(-PI/2) maps (x, y, 0) -> (x, 0, -y), so
 * feed (x, -z) to land at world (x, 0, z) with a +Y normal. UVs are metres:
 * texture.repeat = 1 / tileSize.
 */
export const buildFloorGeometry = (
  polygon: [number, number][],
): THREE.ShapeGeometry => {
  const pts = dedupe(polygon).map(([x, z]) => new THREE.Vector2(x, -z));
  const shape = new THREE.Shape(pts); // winding auto-corrected inside ShapeGeometry
  const geometry = new THREE.ShapeGeometry(shape, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingSphere();
  return geometry;
};

/** Same polygon, normal facing down, for a ceiling slab (position it at y = height). */
export const buildCeilingGeometry = (
  polygon: [number, number][],
): THREE.ShapeGeometry => {
  const pts = dedupe(polygon).map(([x, z]) => new THREE.Vector2(x, z));
  const geometry = new THREE.ShapeGeometry(new THREE.Shape(pts), 1);
  geometry.rotateX(Math.PI / 2); // (x, z, 0) -> (x, 0, z), normal -> (0, -1, 0)
  geometry.computeBoundingSphere();
  return geometry;
};

export const polygonCentroid = (
  polygon: [number, number][],
): [number, number] => {
  const n = polygon.length;
  if (n === 0) return [0, 0];
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i += 1) {
    const [x0, z0] = polygon[i];
    const [x1, z1] = polygon[(i + 1) % n];
    const cross = x0 * z1 - x1 * z0;
    a += cross;
    cx += (x0 + x1) * cross;
    cz += (z0 + z1) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    return [
      polygon.reduce((s, p) => s + p[0], 0) / n,
      polygon.reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  a *= 0.5;
  return [cx / (6 * a), cz / (6 * a)];
};

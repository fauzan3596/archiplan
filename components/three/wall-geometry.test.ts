import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { SceneOpening, WallSpec } from "../../lib/plan/convert";
import {
  buildWallGeometry,
  buildWallShapes,
  normalizeOpenings,
  wallTransform,
} from "./wall-geometry";

const opening = (
  kind: PlanOpeningKind,
  t0: number,
  t1: number,
  bottom: number,
  top: number,
): SceneOpening => ({ id: `o-${kind}-${t0}`, kind, t0, t1, bottom, top });

// 4 m long, 3 m tall wall along +X.
const wall = (openings: SceneOpening[], over: Partial<WallSpec> = {}): WallSpec => ({
  id: "w1",
  x1: 0,
  y1: 0,
  x2: 4,
  y2: 0,
  thickness: 0.15,
  height: 3,
  openings,
  ...over,
});

/** Outline vertex count without the closing duplicate. */
const outlineCount = (shape: THREE.Shape): number => {
  const pts = shape.extractPoints(1).shape;
  const closed = pts.length > 1 && pts[0].equals(pts[pts.length - 1]);
  return closed ? pts.length - 1 : pts.length;
};

/** Area of the triangulated face (what the extruded cap actually covers). */
const extracted = (s: THREE.Shape) => {
  const { shape, holes } = s.extractPoints(1);
  return { shape: shape.slice(), holes: holes.map((h) => h.slice()) };
};

const capArea = (shapeIn: THREE.Shape): number => {
  const { shape, holes } = extracted(shapeIn);
  // triangulateShape strips closing duplicates in place; index into the same arrays.
  const faces = THREE.ShapeUtils.triangulateShape(shape, holes);
  const all = shape.concat(...holes);
  let sum = 0;
  for (const [a, b, c] of faces) {
    const A = all[a];
    const B = all[b];
    const C = all[c];
    sum += Math.abs((B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y)) / 2;
  }
  return sum;
};

describe("normalizeOpenings", () => {
  it("merges overlapping openings into their union", () => {
    const merged = normalizeOpenings(
      [opening("window", 0.4, 0.7, 0.9, 2.4), opening("door", 0.2, 0.5, 0, 2.1)],
      3,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].t0).toBeCloseTo(0.2);
    expect(merged[0].t1).toBeCloseTo(0.7);
    expect(merged[0].bottom).toBeCloseTo(0);
    expect(merged[0].top).toBeCloseTo(2.4);
  });

  it("clamps, sorts, drops empty openings and keeps touching ones apart", () => {
    const out = normalizeOpenings(
      [
        opening("window", 0.8, 1.3, 0.9, 5),
        opening("door", 0.5, 0.8, -1, 2.1),
        opening("window", 0.1, 0.1, 0.9, 2.1),
      ],
      3,
    );
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("door");
    expect(out[0].bottom).toBe(0);
    expect(out[1].t1).toBe(1);
    expect(out[1].top).toBe(3);
  });

  it("returns an empty list for no openings", () => {
    expect(normalizeOpenings(undefined, 3)).toEqual([]);
  });
});

describe("buildWallShapes", () => {
  it("returns a plain rectangle without openings", () => {
    const shapes = buildWallShapes(wall([]));
    expect(shapes).toHaveLength(1);
    expect(outlineCount(shapes[0])).toBe(4);
    expect(capArea(shapes[0])).toBeCloseTo(12);
  });

  it("cuts a door as a notch in the bottom edge (8 outline vertices, no hole)", () => {
    const shapes = buildWallShapes(wall([opening("door", 0.25, 0.5, 0, 2.1)]));
    expect(shapes).toHaveLength(1);
    expect(shapes[0].holes).toHaveLength(0);
    expect(outlineCount(shapes[0])).toBe(8);
    expect(capArea(shapes[0])).toBeCloseTo(12 - 1 * 2.1);
  });

  it("drops the degenerate corner of a door flush with the wall start (6 vertices)", () => {
    const shapes = buildWallShapes(wall([opening("door", 0, 0.25, 0, 2.1)]));
    expect(shapes).toHaveLength(1);
    expect(outlineCount(shapes[0])).toBe(6);
    expect(capArea(shapes[0])).toBeCloseTo(12 - 1 * 2.1);
  });

  it("cuts a window as a hole", () => {
    const shapes = buildWallShapes(
      wall([opening("window", 0.5, 0.75, 0.9, 2.1)]),
    );
    expect(shapes).toHaveLength(1);
    expect(outlineCount(shapes[0])).toBe(4);
    expect(shapes[0].holes).toHaveLength(1);
    expect(shapes[0].holes[0].getPoints().length).toBeGreaterThanOrEqual(4);
    expect(capArea(shapes[0])).toBeCloseTo(12 - 1 * 1.2);
  });

  it("splits the wall into 2 shapes around a full-height opening", () => {
    const shapes = buildWallShapes(
      wall([opening("opening", 0.25, 0.5, 0, 3)]),
    );
    expect(shapes).toHaveLength(2);
    expect(capArea(shapes[0]) + capArea(shapes[1])).toBeCloseTo(12 - 3);
  });

  it("cuts a top-touching opening as a notch in the top edge", () => {
    const shapes = buildWallShapes(wall([opening("window", 0.5, 0.75, 2, 3)]));
    expect(shapes).toHaveLength(1);
    expect(shapes[0].holes).toHaveLength(0);
    expect(outlineCount(shapes[0])).toBe(8);
  });

  it("keeps a window touching a door from being filled by the triangulation", () => {
    // Door 1..2 m, window 2..3 m: the hole would share the notch's edge.
    const shapes = buildWallShapes(
      wall([
        opening("door", 0.25, 0.5, 0, 2.1),
        opening("window", 0.5, 0.75, 0.9, 2.1),
      ]),
    );
    expect(shapes).toHaveLength(1);
    expect(shapes[0].holes).toHaveLength(1);
    expect(capArea(shapes[0])).toBeCloseTo(12 - 2.1 - 1.2, 2);
  });

  it("keeps a window flush with the wall end from being filled", () => {
    const shapes = buildWallShapes(wall([opening("window", 0, 0.25, 0.9, 2.1)]));
    expect(capArea(shapes[0])).toBeCloseTo(12 - 1.2, 2);
  });

  it("returns nothing for a zero-length wall", () => {
    expect(buildWallShapes(wall([], { x2: 0 }))).toEqual([]);
  });
});

describe("buildWallGeometry", () => {
  it("is centred on the wall line and spans length x height", () => {
    const g = buildWallGeometry(wall([opening("door", 0.25, 0.5, 0, 2.1)]));
    g.computeBoundingBox();
    const box = g.boundingBox as THREE.Box3;
    expect(box.min.x).toBeCloseTo(0);
    expect(box.max.x).toBeCloseTo(4);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.max.y).toBeCloseTo(3);
    expect(box.min.z).toBeCloseTo(-0.075);
    expect(box.max.z).toBeCloseTo(0.075);
  });
});

describe("wallTransform", () => {
  it("rotates a wall along +y (world +Z) by -PI/2 so local +X maps to +Z", () => {
    const spec = wall([], { x1: 1, y1: 2, x2: 1, y2: 6 });
    const { position, rotationY } = wallTransform(spec);
    expect(position).toEqual([1, 0, 2]);
    expect(rotationY).toBeCloseTo(-Math.PI / 2);
    const dir = new THREE.Vector3(1, 0, 0).applyEuler(
      new THREE.Euler(0, rotationY, 0),
    );
    expect(dir.x).toBeCloseTo(0);
    expect(dir.z).toBeCloseTo(1);
  });

  it("keeps a wall along +x unrotated", () => {
    expect(wallTransform(wall([])).rotationY).toBeCloseTo(0);
  });
});

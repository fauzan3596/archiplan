import { describe, expect, it } from "vitest";
import type { SceneOpening, WallSpec } from "../../lib/plan/convert";
import { buildColliders, resolveCollisions } from "./collision";

const RADIUS = 0.3;

const opening = (
  kind: PlanOpeningKind,
  t0: number,
  t1: number,
  bottom: number,
  top: number,
): SceneOpening => ({ id: `o-${kind}-${t0}`, kind, t0, t1, bottom, top });

// Wall along +X from (0, 0) to (4, 0), 0.2 m thick; door at 1.6 m .. 2.4 m.
const wall = (openings: SceneOpening[]): WallSpec => ({
  id: "w1",
  x1: 0,
  y1: 0,
  x2: 4,
  y2: 0,
  thickness: 0.2,
  height: 3,
  openings,
});

const withDoor = buildColliders([wall([opening("door", 0.4, 0.6, 0, 2.1)])]);

describe("buildColliders", () => {
  it("records doors and full-height passages as passable intervals, not windows", () => {
    const [c] = buildColliders([
      wall([
        opening("door", 0.1, 0.3, 0, 2.1),
        opening("window", 0.4, 0.6, 0.9, 2.1),
        opening("opening", 0.7, 0.9, 0, 3),
      ]),
    ]);
    expect(c.len).toBeCloseTo(4);
    expect(c.half).toBeCloseTo(0.1);
    expect(c.doors).toHaveLength(2);
    expect(c.doors[0][0]).toBeCloseTo(0.4);
    expect(c.doors[0][1]).toBeCloseTo(1.2);
    expect(c.doors[1][0]).toBeCloseTo(2.8);
    expect(c.doors[1][1]).toBeCloseTo(3.6);
  });

  it("skips zero-length walls", () => {
    const zero: WallSpec = { ...wall([]), x2: 0, y2: 0 };
    expect(buildColliders([zero])).toHaveLength(0);
  });
});

describe("resolveCollisions", () => {
  it("pushes the player out of a wall to thickness/2 + radius", () => {
    const p = { x: 1, z: 0.2 };
    resolveCollisions(p, withDoor, RADIUS);
    expect(p.x).toBeCloseTo(1);
    expect(p.z).toBeCloseTo(0.4);
  });

  it("pushes out on the other side too", () => {
    const p = { x: 3, z: -0.1 };
    resolveCollisions(p, withDoor, RADIUS);
    expect(p.z).toBeCloseTo(-0.4);
  });

  it("lets the player pass inside the door interval", () => {
    const p = { x: 2, z: 0.05 };
    resolveCollisions(p, withDoor, RADIUS);
    expect(p).toEqual({ x: 2, z: 0.05 });
  });

  it("blocks the player beside the door (at the jamb)", () => {
    const p = { x: 1.65, z: 0.05 };
    resolveCollisions(p, withDoor, RADIUS);
    expect(p.z).toBeCloseTo(0.4);
  });

  it("does not let the player through a window", () => {
    const colliders = buildColliders([
      wall([opening("window", 0.4, 0.6, 0.9, 2.1)]),
    ]);
    const p = { x: 2, z: 0.05 };
    resolveCollisions(p, colliders, RADIUS);
    expect(p.z).toBeCloseTo(0.4);
  });

  it("leaves a player far from every wall untouched", () => {
    const p = { x: 2, z: 2 };
    resolveCollisions(p, withDoor, RADIUS);
    expect(p).toEqual({ x: 2, z: 2 });
  });
});

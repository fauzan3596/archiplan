import { describe, expect, it } from "vitest";
import {
  largestRoom,
  mToPx,
  normalizeDeg,
  northOffsetFromExtraction,
  openingCenter,
  planBounds,
  planToScene,
  pointInPolygon,
  pointPxToM,
  polygonArea,
  polygonCentroid,
  pxToM,
  rescalePlan,
  wallAngleDeg,
  wallLength,
  wallOffAxisDeg,
} from "./convert";

// 10 x 8 m house at origin (1, 1) m: 4 exterior walls, a partition at x = 6,
// a south door in the east room and a north window in the west room.
const makePlan = (): FloorPlan => ({
  version: 1,
  source: "sample",
  imageSize: { w: 1000, h: 800 },
  scale: { pxPerMeter: 80, confirmed: true, method: "manual", confidence: 1 },
  northOffsetDeg: 0,
  walls: [
    { id: "wN", a: { x: 1, y: 1 }, b: { x: 11, y: 1 }, thickness: 0.15, height: 3 },
    { id: "wE", a: { x: 11, y: 1 }, b: { x: 11, y: 9 }, thickness: 0.15, height: 3 },
    { id: "wS", a: { x: 11, y: 9 }, b: { x: 1, y: 9 }, thickness: 0.15, height: 3 },
    { id: "wW", a: { x: 1, y: 9 }, b: { x: 1, y: 1 }, thickness: 0.15, height: 3 },
    { id: "wMid", a: { x: 6, y: 1 }, b: { x: 6, y: 9 }, thickness: 0.1, height: 3.2 },
  ],
  openings: [
    { id: "doorS", wallId: "wS", kind: "door", t0: 0.2, t1: 0.3, bottom: 0, top: 2.1 },
    { id: "winN", wallId: "wN", kind: "window", t0: 0.1, t1: 0.25, bottom: 0.9, top: 2.1 },
  ],
  rooms: [
    {
      id: "rA",
      name: "Kamar A",
      type: "kamar_tidur",
      polygon: [
        { x: 1, y: 1 },
        { x: 6, y: 1 },
        { x: 6, y: 9 },
        { x: 1, y: 9 },
      ],
      anchor: { x: 3.5, y: 5 },
    },
    {
      id: "rB",
      name: "Ruang B",
      type: "ruang_tamu",
      polygon: [
        { x: 6, y: 1 },
        { x: 11, y: 1 },
        { x: 11, y: 9 },
        { x: 6, y: 9 },
      ],
      anchor: { x: 8.5, y: 5 },
      floorMaterialId: "parket_kayu",
    },
  ],
  materials: { floor: "keramik_putih", wall: "cat_putih" },
  sun: {
    dateISO: "2026-06-21",
    minutesOfDay: 600,
    cityId: "jakarta",
    showPath: true,
    showCompass: true,
  },
  rab: {
    paket: "ringan",
    grade: "mid",
    region: "jabodetabek",
    contractorFeePct: 10,
    includePpn: false,
    demolition: false,
    luasBangunanM2: null,
    overrides: {},
  },
  extraction: null,
  editedAt: "2026-01-01T00:00:00.000Z",
});

describe("px <-> m", () => {
  const scale: PlanScale = {
    pxPerMeter: 80,
    confirmed: false,
    method: "bbox_prior",
    confidence: 0,
  };

  it("round-trips through pxToM / mToPx", () => {
    expect(pxToM(160, scale)).toBeCloseTo(2, 9);
    expect(mToPx(2, scale)).toBeCloseTo(160, 9);
    expect(mToPx(pxToM(123.4, scale), scale)).toBeCloseTo(123.4, 9);
    const p = pointPxToM({ x: 400, y: 80 }, scale);
    expect(p).toEqual({ x: 5, y: 1 });
  });
});

describe("rescalePlan", () => {
  it("scales x/y, anchors, polygons and thickness by old/new and keeps heights and bottom/top", () => {
    const plan = makePlan();
    const rescaled = rescalePlan(plan, 40, "manual");

    // 80 -> 40 px/m: every metre value doubles.
    expect(rescaled.walls[0].a).toEqual({ x: 2, y: 2 });
    expect(rescaled.walls[0].b).toEqual({ x: 22, y: 2 });
    expect(rescaled.walls[0].thickness).toBeCloseTo(0.3, 9);
    expect(rescaled.walls[4].height).toBe(3.2);
    expect(rescaled.rooms[0].anchor).toEqual({ x: 7, y: 10 });
    expect(rescaled.rooms[0].polygon[2]).toEqual({ x: 12, y: 18 });
    expect(rescaled.openings[1].bottom).toBe(0.9);
    expect(rescaled.openings[1].top).toBe(2.1);
    expect(rescaled.openings[1].t0).toBe(0.1);
    expect(rescaled.scale.pxPerMeter).toBe(40);
  });

  it("confirms the scale only for the manual method", () => {
    const plan = makePlan();
    const manual = rescalePlan(plan, 100, "manual");
    expect(manual.scale.confirmed).toBe(true);
    expect(manual.scale.method).toBe("manual");
    expect(manual.scale.confidence).toBe(1);

    const prior = rescalePlan(plan, 100, "door_prior");
    expect(prior.scale.confirmed).toBe(false);
    expect(prior.scale.method).toBe("door_prior");
  });

  it("does not mutate the input", () => {
    const plan = makePlan();
    rescalePlan(plan, 40, "manual");
    expect(plan.walls[0].b).toEqual({ x: 11, y: 1 });
    expect(plan.scale.pxPerMeter).toBe(80);
  });
});

describe("wall / opening helpers", () => {
  it("measures walls and openings", () => {
    const plan = makePlan();
    expect(wallLength(plan.walls[0])).toBeCloseTo(10, 9);
    expect(wallAngleDeg(plan.walls[0])).toBeCloseTo(0, 9);
    expect(wallAngleDeg(plan.walls[1])).toBeCloseTo(90, 9);
    const diagonal: PlanWall = {
      id: "d",
      a: { x: 0, y: 0 },
      b: { x: 10, y: -1 },
      thickness: 0.15,
      height: 3,
    };
    expect(wallOffAxisDeg(diagonal)).toBeCloseTo(5.71, 1);
    expect(openingCenter(plan.openings[0], plan.walls[2])).toEqual({
      x: 8.5,
      y: 9,
    });
  });

  it("computes polygon area, centroid and containment", () => {
    const square = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ];
    expect(polygonArea(square)).toBe(4);
    expect(polygonCentroid(square)).toEqual({ x: 1, y: 1 });
    expect(pointInPolygon({ x: 1, y: 1 }, square)).toBe(true);
    expect(pointInPolygon({ x: 3, y: 1 }, square)).toBe(false);
  });

  it("bounds cover the wall endpoints", () => {
    const bounds = planBounds(makePlan());
    expect(bounds).toMatchObject({ minX: 1, minY: 1, maxX: 11, maxY: 9 });
    expect(bounds.width).toBe(10);
    expect(bounds.height).toBe(8);
    expect(bounds.center).toEqual({ x: 6, y: 5 });
  });
});

describe("planToScene", () => {
  it("maps plan (x, y) -> (x1, y1) and nests openings per wall", () => {
    const scene = planToScene(makePlan());
    const north = scene.walls.find((w) => w.id === "wN");
    expect(north).toMatchObject({ x1: 1, y1: 1, x2: 11, y2: 1, thickness: 0.15, height: 3 });
    expect(north?.openings).toEqual([
      { id: "winN", kind: "window", t0: 0.1, t1: 0.25, bottom: 0.9, top: 2.1 },
    ]);
    const south = scene.walls.find((w) => w.id === "wS");
    expect(south?.openings.map((o) => o.id)).toEqual(["doorS"]);
    expect(scene.walls.find((w) => w.id === "wE")?.openings).toEqual([]);
    expect(scene.height).toBe(3.2);
    expect(scene.center).toEqual([6, 0, 5]);
    expect(scene.size).toEqual([10, 8]);
  });

  it("maps rooms with their floor material and polygon tuples", () => {
    const scene = planToScene(makePlan());
    expect(scene.rooms).toHaveLength(2);
    expect(scene.rooms[1]).toMatchObject({
      id: "rB",
      type: "ruang_tamu",
      floorMaterialId: "parket_kayu",
    });
    expect(scene.rooms[0].floorMaterialId).toBe("keramik_putih");
    expect(scene.rooms[0].polygon[1]).toEqual([6, 1]);
  });

  it("spawns at the centroid of the largest non-stale room facing the nearest door", () => {
    const plan = makePlan();
    // Make room B larger than A, then mark it stale: spawn must fall back to A.
    plan.rooms[1].polygon = [
      { x: 6, y: 1 },
      { x: 20, y: 1 },
      { x: 20, y: 9 },
      { x: 6, y: 9 },
    ];
    expect(largestRoom(plan)?.id).toBe("rB");
    plan.rooms[1].stale = true;
    expect(largestRoom(plan)?.id).toBe("rA");

    const scene = planToScene(plan);
    expect(scene.rooms.map((r) => r.id)).toEqual(["rA"]);
    expect(scene.spawn[0]).toBeCloseTo(3.5, 9);
    expect(scene.spawn[1]).toBeCloseTo(5, 9);

    // The only door is at (8.5, 9): south-east of the spawn. With yaw 0
    // facing -Z, forward = (-sin yaw, -cos yaw) must point toward +x / +z.
    const forward = [-Math.sin(scene.spawnYaw), -Math.cos(scene.spawnYaw)];
    expect(forward[0]).toBeGreaterThan(0);
    expect(forward[1]).toBeGreaterThan(0);
    expect(forward[0] / forward[1]).toBeCloseTo(5 / 4, 6);
  });
});

describe("north conversion", () => {
  it("inverts the extraction bearing", () => {
    expect(northOffsetFromExtraction(90)).toBe(270);
    expect(northOffsetFromExtraction(0)).toBe(0);
    expect(northOffsetFromExtraction(360)).toBe(0);
    expect(normalizeDeg(-30)).toBe(330);
    expect(normalizeDeg(725)).toBe(5);
  });
});

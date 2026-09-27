import { describe, expect, it } from "vitest";
import {
  gateForRabExport,
  normalizePlan,
  normalizeWallOpenings,
  validatePlan,
} from "./validate";

const WALLS: PlanWall[] = [
  { id: "wN", a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, thickness: 0.15, height: 3 },
  { id: "wE", a: { x: 10, y: 0 }, b: { x: 10, y: 8 }, thickness: 0.15, height: 3 },
  { id: "wS", a: { x: 10, y: 8 }, b: { x: 0, y: 8 }, thickness: 0.15, height: 3 },
  { id: "wW", a: { x: 0, y: 8 }, b: { x: 0, y: 0 }, thickness: 0.15, height: 3 },
];

const ROOM: PlanRoom = {
  id: "r1",
  name: "Ruang",
  polygon: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 8 },
    { x: 0, y: 8 },
  ],
  anchor: { x: 5, y: 4 },
};

const makePlan = (): FloorPlan => ({
  version: 1,
  source: "manual",
  imageSize: { w: 1000, h: 800 },
  scale: { pxPerMeter: 80, confirmed: true, method: "manual", confidence: 1 },
  northOffsetDeg: 0,
  walls: WALLS.map((w) => ({ ...w })),
  openings: [
    { id: "d1", wallId: "wS", kind: "door", t0: 0.2, t1: 0.3, bottom: 0, top: 2.1 },
  ],
  rooms: [{ ...ROOM }],
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

describe("normalizePlan", () => {
  it("fills defaults and room anchors from a minimal stored object", () => {
    const raw = {
      version: 1,
      imageSize: { w: 1000, h: 800 },
      scale: { pxPerMeter: 80 },
      walls: WALLS,
      rooms: [{ id: "r1", name: "Ruang", polygon: ROOM.polygon }],
    };

    const plan = normalizePlan(raw);
    expect(plan).not.toBeNull();
    expect(plan?.source).toBe("manual");
    expect(plan?.scale).toEqual({
      pxPerMeter: 80,
      confirmed: false,
      method: "bbox_prior",
      confidence: 0,
    });
    expect(plan?.northOffsetDeg).toBe(0);
    expect(plan?.openings).toEqual([]);
    expect(plan?.rooms[0].anchor).toEqual({ x: 5, y: 4 });
    expect(plan?.materials).toEqual({ floor: "keramik_putih", wall: "cat_putih" });
    expect(plan?.sun.cityId).toBe("jakarta");
    expect(plan?.sun.minutesOfDay).toBe(600);
    expect(plan?.rab.paket).toBe("ringan");
    expect(plan?.rab.overrides).toEqual({});
    expect(plan?.extraction).toBeNull();
    expect(typeof plan?.editedAt).toBe("string");
  });

  it("rejects garbage", () => {
    expect(normalizePlan(null)).toBeNull();
    expect(normalizePlan("plan")).toBeNull();
    expect(normalizePlan({})).toBeNull();
    expect(normalizePlan({ version: 2, imageSize: { w: 1, h: 1 }, walls: [] })).toBeNull();
    expect(normalizePlan({ version: 1, walls: [] })).toBeNull();
    expect(
      normalizePlan({ version: 1, imageSize: { w: 1000, h: 800 }, walls: "nope" }),
    ).toBeNull();
    expect(
      normalizePlan({
        version: 1,
        imageSize: { w: 1000, h: 800 },
        scale: { pxPerMeter: 0 },
        walls: [],
      }),
    ).toBeNull();
  });

  it("drops openings on missing walls, broken members and duplicate ids", () => {
    const plan = makePlan();
    const raw = {
      ...plan,
      walls: [...plan.walls, { id: "wN", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }, { id: "broken", a: { x: "x" } }],
      openings: [
        ...plan.openings,
        { id: "ghost", wallId: "nope", kind: "window", t0: 0.1, t1: 0.2, bottom: 0.9, top: 2.1 },
      ],
      rooms: [...plan.rooms, { id: "tiny", name: "x", polygon: [{ x: 0, y: 0 }] }],
    };

    const normalized = normalizePlan(raw);
    expect(normalized?.walls.map((w) => w.id)).toEqual(["wN", "wE", "wS", "wW"]);
    expect(normalized?.openings.map((o) => o.id)).toEqual(["d1"]);
    expect(normalized?.rooms.map((r) => r.id)).toEqual(["r1"]);
  });

  it("is idempotent on a normalised plan", () => {
    const once = normalizePlan(makePlan());
    const twice = normalizePlan(once);
    expect(twice).toEqual(once);
  });

  it("coerces numbers: clamps thickness, north and confidence", () => {
    const plan = makePlan();
    plan.walls[0].thickness = 5;
    plan.northOffsetDeg = -90;
    plan.scale.confidence = 4;
    const normalized = normalizePlan(plan);
    expect(normalized?.walls[0].thickness).toBe(0.4);
    expect(normalized?.northOffsetDeg).toBe(270);
    expect(normalized?.scale.confidence).toBe(1);
  });
});

describe("normalizeWallOpenings", () => {
  it("clamps t and vertical extents to the wall", () => {
    const openings: PlanOpening[] = [
      { id: "o1", wallId: "wN", kind: "window", t0: -0.2, t1: 1.2, bottom: -1, top: 9 },
    ];
    const result = normalizeWallOpenings(openings, WALLS);
    expect(result).toEqual([
      { id: "o1", wallId: "wN", kind: "window", t0: 0, t1: 1, bottom: 0, top: 3 },
    ]);
  });

  it("merges overlapping openings on the same wall and keeps others apart", () => {
    const openings: PlanOpening[] = [
      { id: "o2", wallId: "wN", kind: "window", t0: 0.3, t1: 0.5, bottom: 0.9, top: 2.1 },
      { id: "o1", wallId: "wN", kind: "door", t0: 0.1, t1: 0.35, bottom: 0, top: 2.1 },
      { id: "o3", wallId: "wN", kind: "window", t0: 0.7, t1: 0.8, bottom: 0.9, top: 2.1 },
      { id: "o4", wallId: "wS", kind: "door", t0: 0.1, t1: 0.2, bottom: 0, top: 2.1 },
    ];
    const result = normalizeWallOpenings(openings, WALLS);
    expect(result.map((o) => o.id)).toEqual(["o1", "o3", "o4"]);
    expect(result[0]).toMatchObject({ t0: 0.1, t1: 0.5, bottom: 0, top: 2.1, kind: "door" });
  });

  it("drops openings on missing walls or with an empty extent", () => {
    const openings: PlanOpening[] = [
      { id: "ghost", wallId: "nope", kind: "door", t0: 0.1, t1: 0.2, bottom: 0, top: 2.1 },
      { id: "flat", wallId: "wN", kind: "door", t0: 0.2, t1: 0.2, bottom: 0, top: 2.1 },
      { id: "swap", wallId: "wN", kind: "door", t0: 0.4, t1: 0.3, bottom: 0, top: 2.1 },
    ];
    const result = normalizeWallOpenings(openings, WALLS);
    expect(result.map((o) => o.id)).toEqual(["swap"]);
    expect(result[0]).toMatchObject({ t0: 0.3, t1: 0.4 });
  });
});

describe("validatePlan", () => {
  it("returns no issues for a healthy plan", () => {
    expect(validatePlan(makePlan())).toEqual([]);
  });

  it("flags bad openings, thickness and north", () => {
    const plan = makePlan();
    plan.openings = [
      { id: "bad-t", wallId: "wS", kind: "door", t0: 0.5, t1: 0.5, bottom: 0, top: 2.1 },
      { id: "bad-v", wallId: "wN", kind: "window", t0: 0.1, t1: 0.2, bottom: 2.1, top: 2.1 },
    ];
    plan.walls[0].thickness = 1.2;
    plan.northOffsetDeg = 400;

    const codes = validatePlan(plan).map((i) => i.code);
    expect(codes).toContain("OPENING_T");
    expect(codes).toContain("OPENING_VERTICAL");
    expect(codes).toContain("WALL_THICKNESS");
    expect(codes).toContain("NORTH_RANGE");
  });

  it("flags duplicate ids, zero walls, missing opening walls and overlaps", () => {
    const plan = makePlan();
    plan.walls.push({ id: "wN", a: { x: 1, y: 1 }, b: { x: 1, y: 1 }, thickness: 0.15, height: 3 });
    plan.openings.push(
      { id: "ghost", wallId: "nope", kind: "door", t0: 0.1, t1: 0.2, bottom: 0, top: 2.1 },
      { id: "d2", wallId: "wS", kind: "door", t0: 0.25, t1: 0.4, bottom: 0, top: 2.1 },
    );
    plan.rooms.push({ id: "r2", name: "x", polygon: [{ x: 0, y: 0 }, { x: 1, y: 1 }], anchor: { x: 0, y: 0 } });

    const codes = validatePlan(plan).map((i) => i.code);
    expect(codes).toContain("DUP_ID");
    expect(codes).toContain("WALL_ZERO");
    expect(codes).toContain("OPENING_WALL");
    expect(codes).toContain("OPENING_OVERLAP");
    expect(codes).toContain("ROOM_POLY");
  });
});

describe("gateForRabExport", () => {
  it("passes a confirmed plan with live rooms", () => {
    expect(gateForRabExport(makePlan())).toEqual({ ok: true, reasons: [] });
  });

  it("fails while the scale is unconfirmed", () => {
    const plan = makePlan();
    plan.scale.confirmed = false;
    const gate = gateForRabExport(plan);
    expect(gate.ok).toBe(false);
    expect(gate.reasons.map((r) => r.code)).toEqual(["SCALE_UNCONFIRMED"]);
  });

  it("fails with stale rooms", () => {
    const plan = makePlan();
    plan.rooms.push({ ...ROOM, id: "r2", stale: true });
    const gate = gateForRabExport(plan);
    expect(gate.ok).toBe(false);
    expect(gate.reasons.map((r) => r.code)).toEqual(["ROOMS_STALE"]);
    expect(gate.reasons[0].ids).toEqual(["r2"]);
  });

  it("fails without rooms", () => {
    const plan = makePlan();
    plan.rooms = [];
    const gate = gateForRabExport(plan);
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toHaveLength(1);
  });
});

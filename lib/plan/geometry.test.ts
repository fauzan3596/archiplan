import { describe, expect, it } from "vitest";
import { polygonArea, wallOffAxisDeg } from "./convert";
import { SAMPLE_PLAN } from "./fixtures/sample-plan";
import { TWO_ROOM_PLAN } from "./fixtures/two-room-plan";
import {
  applyFix,
  assignRoomNames,
  planIssues,
  polygonizeRooms,
  rebuildRooms,
  rectsToWalls,
  shoelaceArea,
  snapAndMerge,
  wallAdjacency,
  type GeoWall,
  type RebuildResult,
} from "./geometry";
import { normalizePlan } from "./validate";

const clone = <T>(v: T): T => structuredClone(v);

const adopt = (plan: FloorPlan, r: RebuildResult = rebuildRooms(plan)): FloorPlan => ({
  ...plan,
  walls: r.walls,
  rooms: r.rooms,
  openings: r.openings,
});

const codes = (plan: FloorPlan): PlanIssueCode[] => planIssues(plan).map((i) => i.code);

const withWall = (plan: FloorPlan, id: string, patch: Partial<PlanWall>): FloorPlan => ({
  ...plan,
  walls: plan.walls.map((w) => (w.id === id ? { ...w, ...patch } : w)),
});

// -----------------------------------------------------------------------------
// Port of the research geometry test (scratchpad test.ts)
// -----------------------------------------------------------------------------
describe("verbatim geometry port", () => {
  const W = (id: string, x0: number, y0: number, x1: number, y1: number): GeoWall => ({
    id, a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, thickness: 12, exterior: false, confidence: 0.8, sources: [id],
  });

  // Noisy 2-room house, 800x600 px: outer box (100,100)-(700,500), partition at x~400, plus a dangling stub and
  // a short sliver. Coordinates jittered by up to 6 px and a 3-degree tilt to mimic VLM output.
  const raw: GeoWall[] = [
    W("top", 103, 98, 698, 104),
    W("right", 702, 100, 699, 503),
    W("bottom-a", 700, 498, 405, 501),
    W("bottom-b", 398, 502, 96, 499),
    W("left", 100, 505, 104, 97),
    W("mid", 402, 102, 397, 497),
    W("stub", 250, 300, 250, 360),
    W("sliver", 500, 300, 507, 300),
  ];

  const { walls, diagonals, dropped } = snapAndMerge(raw, { eps: 12, angleTolDeg: 8 });
  const { rooms, dangling } = polygonizeRooms(walls);

  it("snaps, merges and nodes into 8 walls, dropping the sliver", () => {
    expect(walls).toHaveLength(8);
    expect(dropped.map((w) => w.id)).toEqual(["sliver"]);
    expect(diagonals).toHaveLength(0);
  });

  it("polygonises 2 rooms of ~300x400 px with 4 points and prunes the stub", () => {
    expect(rooms).toHaveLength(2);
    for (const r of rooms) {
      expect(r.areaPx).toBeGreaterThan(100_000);
      expect(r.areaPx).toBeLessThan(130_000);
      expect(r.polygon).toHaveLength(4);
    }
    expect(dangling.map((w) => w.id)).toEqual(["stub"]);
  });

  it("assigns room names by centroid containment", () => {
    const named = assignRoomNames(rooms, [
      { id: "r1", name: "R. Tamu", kind: "living", polygon: [{ x: 110, y: 110 }, { x: 390, y: 110 }, { x: 390, y: 490 }, { x: 110, y: 490 }], confidence: 0.9 },
      { id: "r2", name: "K. Tidur", kind: "bedroom", polygon: [{ x: 410, y: 110 }, { x: 690, y: 110 }, { x: 690, y: 490 }, { x: 410, y: 490 }], confidence: 0.85 },
      { id: "r3", name: "Gudang", kind: "storage", polygon: [{ x: 900, y: 900 }, { x: 950, y: 900 }, { x: 950, y: 950 }, { x: 900, y: 950 }], confidence: 0.4 },
    ]);
    expect(named.rooms.map((r) => r.name).sort()).toEqual(["K. Tidur", "R. Tamu"]);
    expect(named.unmatched.map((l) => l.name)).toEqual(["Gudang"]);
    expect(named.multi).toEqual([]);
  });

  it("shoelace area of the unit square (y-down clockwise on screen) is 1", () => {
    expect(shoelaceArea([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }])).toBe(1);
  });

  it("rooms-only fallback welds touching rectangles into 2 rooms", () => {
    const fb = snapAndMerge(
      rectsToWalls([{ id: "A", x0: 0, y0: 0, x1: 300, y1: 200 }, { id: "B", x0: 303, y0: 0, x1: 600, y1: 200 }]),
      { eps: 10, minLength: 1 },
    );
    expect(polygonizeRooms(fb.walls).rooms.map((r) => r.areaPx)).toEqual([60300, 59700]);
  });
});

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------
describe("fixtures", () => {
  it("SAMPLE_PLAN matches the contract and survives normalizePlan unchanged", () => {
    expect(SAMPLE_PLAN.walls).toHaveLength(12);
    expect(SAMPLE_PLAN.rooms).toHaveLength(5);
    expect(SAMPLE_PLAN.openings).toHaveLength(7);
    expect(SAMPLE_PLAN.rooms.map((r) => r.type).sort()).toEqual(
      ["dapur", "kamar_mandi", "kamar_tidur", "kamar_tidur", "ruang_tamu"],
    );
    expect(SAMPLE_PLAN.scale).toMatchObject({ pxPerMeter: 80, confirmed: true });
    expect(SAMPLE_PLAN.imageSize).toEqual({ w: 1000, h: 800 });
    expect(SAMPLE_PLAN.source).toBe("sample");
    const total = SAMPLE_PLAN.rooms.reduce((s, r) => s + polygonArea(r.polygon), 0);
    expect(total).toBeCloseTo(80, 9);
    expect(normalizePlan(SAMPLE_PLAN)).toEqual(SAMPLE_PLAN);
  });

  it("SAMPLE_PLAN has one exterior door and one kamar mandi door", () => {
    const adj = wallAdjacency(SAMPLE_PLAN);
    const doors = SAMPLE_PLAN.openings.filter((o) => o.kind === "door");
    expect(doors.filter((o) => adj[o.wallId].isExterior).map((o) => o.id)).toEqual(["o-pintu-utama"]);
    expect(doors.filter((o) => adj[o.wallId].roomIds.includes("r-km")).map((o) => o.id)).toEqual(["o-pintu-km"]);
  });

  it("TWO_ROOM_PLAN reproduces the sun-spec house", () => {
    const wall = (id: string) => TWO_ROOM_PLAN.walls.find((w) => w.id === id)!;
    const centre = (id: string) => {
      const o = TWO_ROOM_PLAN.openings.find((x) => x.id === id)!;
      const w = wall(o.wallId);
      const t = (o.t0 + o.t1) / 2;
      const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      return { t, width: (o.t1 - o.t0) * len, x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
    };
    expect(centre("winN_A")).toMatchObject({ t: expect.closeTo(0.25, 9), width: expect.closeTo(1.2, 9), x: expect.closeTo(2.5, 9) });
    expect(centre("winS_A")).toMatchObject({ t: expect.closeTo(0.75, 9), x: expect.closeTo(2.5, 9), y: 8 });
    expect(centre("doorS_B")).toMatchObject({ t: expect.closeTo(0.25, 9), width: expect.closeTo(0.9, 9), x: expect.closeTo(7.5, 9) });
    expect(centre("winW_A")).toMatchObject({ t: expect.closeTo(0.5, 9), width: expect.closeTo(1.2, 9) });
    expect(centre("winE_B")).toMatchObject({ t: expect.closeTo(0.5, 9), width: expect.closeTo(1.2, 9) });
    expect(centre("winMid")).toMatchObject({ t: expect.closeTo(0.5, 9), x: 5 });
    expect(TWO_ROOM_PLAN.openings.map((o) => o.id)).toEqual(["winN_A", "winS_A", "winW_A", "winE_B", "winMid", "doorS_B"]);
    const normalized = normalizePlan(TWO_ROOM_PLAN)!;
    const byId = (os: PlanOpening[]) => [...os].sort((a, b) => a.id.localeCompare(b.id));
    expect({ ...normalized, openings: byId(normalized.openings) }).toEqual({
      ...TWO_ROOM_PLAN,
      openings: byId(TWO_ROOM_PLAN.openings),
    });
  });

  it("both fixtures are clean for planIssues", () => {
    expect(planIssues(SAMPLE_PLAN)).toEqual([]);
    expect(planIssues(TWO_ROOM_PLAN)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// rebuildRooms
// -----------------------------------------------------------------------------
describe("rebuildRooms", () => {
  it("returns the same 5 rooms with original ids / names / types for SAMPLE_PLAN", () => {
    const before = clone(SAMPLE_PLAN);
    const r = rebuildRooms(SAMPLE_PLAN);
    expect(SAMPLE_PLAN).toEqual(before); // pure
    expect(r.rooms.map((x) => [x.id, x.name, x.type, x.stale ?? false])).toEqual(
      SAMPLE_PLAN.rooms.map((x) => [x.id, x.name, x.type, false]),
    );
    r.rooms.forEach((room, i) => {
      expect(polygonArea(room.polygon)).toBeCloseTo(polygonArea(SAMPLE_PLAN.rooms[i].polygon), 9);
      expect(room.anchor).toEqual(SAMPLE_PLAN.rooms[i].anchor);
    });
    expect(r.rooms[0].floorMaterialId).toBe("granit_abu");
    // noded at the T-junctions: 16 walls, every original id kept once
    expect(r.walls).toHaveLength(16);
    const ids = r.walls.map((w) => w.id);
    expect(new Set(ids).size).toBe(16);
    for (const w of SAMPLE_PLAN.walls) expect(ids).toContain(w.id);
    expect(r.diagonalWallIds).toEqual([]);
    expect(r.danglingWallIds).toEqual([]);
    expect(r.droppedWallIds).toEqual([]);
    // every opening survives; the Ruang Tamu window moves to the new piece of w-w
    expect(r.droppedOpenings).toEqual([]);
    expect(r.openings.map((o) => o.id).sort()).toEqual(SAMPLE_PLAN.openings.map((o) => o.id).sort());
    expect(r.reattached).toEqual(["o-jendela-tamu"]);
    const door = r.openings.find((o) => o.id === "o-pintu-utama")!;
    expect(door).toEqual(SAMPLE_PLAN.openings.find((o) => o.id === "o-pintu-utama"));
  });

  it("keeps wall direction, thickness, height and exterior hint from the source wall", () => {
    const r = rebuildRooms(SAMPLE_PLAN);
    const s2 = r.walls.find((w) => w.id === "w-s2")!;
    expect(s2).toEqual(SAMPLE_PLAN.walls.find((w) => w.id === "w-s2"));
    const westPieces = r.walls.filter((w) => w.a.x === 1.25 && w.b.x === 1.25);
    expect(westPieces).toHaveLength(2);
    for (const w of westPieces) {
      expect(w.b.y).toBeLessThan(w.a.y); // w-w runs south -> north
      expect(w).toMatchObject({ thickness: 0.15, height: 3, isExterior: true });
    }
  });

  it("re-attached openings keep their width and centre", () => {
    const r = rebuildRooms(SAMPLE_PLAN);
    const o = r.openings.find((x) => x.id === "o-jendela-tamu")!;
    const w = r.walls.find((x) => x.id === o.wallId)!;
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    expect((o.t1 - o.t0) * len).toBeCloseTo(1.2, 9);
    const t = (o.t0 + o.t1) / 2;
    expect(w.a.y + (w.b.y - w.a.y) * t).toBeCloseTo(1 + 6, 9);
    expect(w.id).not.toBe("w-w");
  });

  it("is idempotent on an already noded plan", () => {
    const p1 = adopt(SAMPLE_PLAN);
    const r2 = rebuildRooms(p1);
    expect(r2.walls).toEqual(p1.walls);
    expect(r2.rooms).toEqual(p1.rooms);
    expect(r2.openings).toEqual(p1.openings);
    expect(r2.reattached).toEqual([]);
  });

  it("moving one endpoint by 0.05 m preserves room and wall ids", () => {
    // straight on the fixture: room ids
    const moved = clone(SAMPLE_PLAN);
    const dp = moved.walls.find((w) => w.id === "w-dp")!;
    dp.b = { x: dp.b.x + 0.05, y: dp.b.y };
    const r = rebuildRooms(moved);
    expect(r.rooms.map((x) => x.id)).toEqual(SAMPLE_PLAN.rooms.map((x) => x.id));
    expect(r.rooms.some((x) => x.stale)).toBe(false);

    // on the noded plan: wall ids too
    const p1 = adopt(SAMPLE_PLAN);
    for (const [id, end, dx, dy] of [
      ["w-dp", "b", 0.05, 0],
      ["w-n", "a", 0, 0.05],
      ["w-p2", "a", 0.05, 0],
    ] as const) {
      const shifted = clone(p1);
      const w = shifted.walls.find((x) => x.id === id)!;
      w[end] = { x: w[end].x + dx, y: w[end].y + dy };
      const r2 = rebuildRooms(shifted);
      expect(r2.walls.map((x) => x.id)).toEqual(p1.walls.map((x) => x.id));
      expect(r2.rooms.map((x) => x.id)).toEqual(p1.rooms.map((x) => x.id));
      expect(r2.rooms.some((x) => x.stale)).toBe(false);
      expect(r2.openings.map((x) => x.id).sort()).toEqual(p1.openings.map((x) => x.id).sort());
      expect(r2.droppedOpenings).toEqual([]);
    }
  });

  it("deleting a partition merges faces and keeps the unmatched room stale; re-adding re-attaches it", () => {
    const p1 = adopt(SAMPLE_PLAN);
    const partition = p1.walls.find((w) => w.id === "w-kt")!;
    const deleted: FloorPlan = { ...p1, walls: p1.walls.filter((w) => w.id !== "w-kt") };

    const r2 = rebuildRooms(deleted);
    expect(r2.rooms).toHaveLength(5); // no new "Ruangan"
    const bedrooms = r2.rooms.filter((r) => r.id === "r-kt1" || r.id === "r-kt2");
    const stale = bedrooms.filter((r) => r.stale);
    const live = bedrooms.filter((r) => !r.stale);
    expect(stale).toHaveLength(1);
    expect(live).toHaveLength(1);
    expect(polygonArea(live[0].polygon)).toBeCloseTo(36, 9);
    expect(polygonArea(stale[0].polygon)).toBeCloseTo(18, 9); // frozen polygon
    expect(stale[0].name).toMatch(/^Kamar Tidur/);

    const p2 = adopt(deleted, r2);
    expect(codes(p2)).toContain("ROOMS_STALE");

    const readded: FloorPlan = { ...p2, walls: [...p2.walls, { ...partition, id: "w-kt-baru" }] };
    const r3 = rebuildRooms(readded);
    expect(r3.rooms.map((r) => r.id)).toEqual(p1.rooms.map((r) => r.id));
    expect(r3.rooms.every((r) => !r.stale)).toBe(true);
    r3.rooms.forEach((room, i) => {
      expect(room.name).toBe(p1.rooms[i].name);
      expect(room.type).toBe(p1.rooms[i].type);
      expect(polygonArea(room.polygon)).toBeCloseTo(polygonArea(p1.rooms[i].polygon), 9);
    });
    expect(codes(adopt(readded, r3))).not.toContain("ROOMS_STALE");
  });

  it("gives a new face the default name and an interior anchor", () => {
    const split: FloorPlan = {
      ...TWO_ROOM_PLAN,
      walls: [...TWO_ROOM_PLAN.walls, { id: "wSplit", a: { x: 5, y: 3 }, b: { x: 10, y: 3 }, thickness: 0.12, height: 3 }],
    };
    const r = rebuildRooms(split);
    expect(r.rooms).toHaveLength(3);
    expect(r.rooms.slice(0, 2).map((x) => [x.id, x.stale ?? false])).toEqual([["rA", false], ["rB", false]]);
    const added = r.rooms[2];
    expect(added.name).toBe("Ruangan");
    expect(added.id).toMatch(/^room-/);
    expect(polygonArea(added.polygon)).toBeCloseTo(15, 9); // 5 x 3 north part of room B
    expect(added.anchor.x).toBeCloseTo(7.5, 9);
    expect(added.anchor.y).toBeCloseTo(1.5, 9);
  });

  it("flags dangling and diagonal walls and drops openings far from any wall", () => {
    const plan: FloorPlan = {
      ...TWO_ROOM_PLAN,
      walls: [
        ...TWO_ROOM_PLAN.walls,
        { id: "stub", a: { x: 2, y: 2 }, b: { x: 2, y: 3 }, thickness: 0.12, height: 3 },
        { id: "diag", a: { x: 6, y: 2 }, b: { x: 8, y: 4 }, thickness: 0.12, height: 3 },
      ],
      openings: [
        ...TWO_ROOM_PLAN.openings,
        { id: "o-stub", wallId: "stub", kind: "door", t0: 0.1, t1: 0.9, bottom: 0, top: 2.1 },
      ],
    };
    const r = rebuildRooms(plan);
    expect(r.danglingWallIds).toEqual(["stub"]);
    expect(r.diagonalWallIds).toEqual(["diag"]);
    expect(r.walls.find((w) => w.id === "diag")).toEqual(plan.walls.find((w) => w.id === "diag"));
    expect(r.droppedOpenings).toEqual([]);
    expect(r.openings.find((o) => o.id === "o-stub")?.wallId).toBe("stub");

    const withoutStub = { ...plan, walls: plan.walls.filter((w) => w.id !== "stub") };
    const r2 = rebuildRooms(withoutStub);
    expect(r2.droppedOpenings).toEqual(["o-stub"]);
    expect(r2.openings.some((o) => o.id === "o-stub")).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// wallAdjacency
// -----------------------------------------------------------------------------
describe("wallAdjacency", () => {
  it("marks the TWO_ROOM_PLAN outline exterior and wMid interior between rA and rB", () => {
    const adj = wallAdjacency(TWO_ROOM_PLAN);
    for (const id of ["wN", "wE", "wS", "wW"]) expect(adj[id].isExterior).toBe(true);
    expect(adj.wMid).toEqual({ roomIds: ["rA", "rB"], isExterior: false });
    expect(adj.wN.roomIds).toEqual(["rA", "rB"]);
    expect(adj.wE.roomIds).toEqual(["rB"]);
    expect(adj.wW.roomIds).toEqual(["rA"]);
  });

  it("classifies SAMPLE_PLAN walls and ignores stale rooms", () => {
    const adj = wallAdjacency(SAMPLE_PLAN);
    for (const w of SAMPLE_PLAN.walls) expect(adj[w.id].isExterior).toBe(w.isExterior);
    expect(adj["w-p4"].roomIds).toEqual(["r-km", "r-dapur"]);

    const staleA: FloorPlan = {
      ...TWO_ROOM_PLAN,
      rooms: TWO_ROOM_PLAN.rooms.map((r) => (r.id === "rA" ? { ...r, stale: true } : r)),
    };
    expect(wallAdjacency(staleA).wMid).toEqual({ roomIds: ["rB"], isExterior: true });
  });
});

// -----------------------------------------------------------------------------
// planIssues
// -----------------------------------------------------------------------------
describe("planIssues", () => {
  it("flags SCALE_UNCONFIRMED when the scale is not confirmed", () => {
    const plan = { ...SAMPLE_PLAN, scale: { ...SAMPLE_PLAN.scale, confirmed: false } };
    expect(codes(plan)).toEqual(["SCALE_UNCONFIRMED"]);
  });

  it("flags WALL_DIAGONAL with a safe snap_axis fix for a 10 degree wall", () => {
    const dx = 8 * Math.tan((10 * Math.PI) / 180);
    const plan = withWall(TWO_ROOM_PLAN, "wMid", { b: { x: 5 + dx, y: 8 } });
    const diag = planIssues(plan).find((i) => i.code === "WALL_DIAGONAL")!;
    expect(diag.ids).toEqual(["wMid"]);
    expect(diag.fix).toMatchObject({ kind: "snap_axis", label: "Luruskan", safe: true, ids: ["wMid"] });

    const fixed = applyFix(plan, diag.fix!);
    expect(wallOffAxisDeg(fixed.walls.find((w) => w.id === "wMid")!)).toBeCloseTo(0, 9);
    expect(codes(fixed)).not.toContain("WALL_DIAGONAL");
    expect(plan.walls.find((w) => w.id === "wMid")!.b.x).toBeCloseTo(5 + dx, 9); // pure

    const steep = withWall(TWO_ROOM_PLAN, "wMid", { b: { x: 5 + 8 * Math.tan((30 * Math.PI) / 180), y: 8 } });
    expect(planIssues(steep).find((i) => i.code === "WALL_DIAGONAL")?.fix?.safe).toBe(false);
  });

  it("flags NOT_WATERTIGHT for an open plan", () => {
    const open: FloorPlan = { ...TWO_ROOM_PLAN, walls: TWO_ROOM_PLAN.walls.filter((w) => w.id !== "wN") };
    const issues = planIssues(open);
    expect(issues.find((i) => i.code === "NOT_WATERTIGHT")?.severity).toBe("error");
    expect(issues.filter((i) => i.code === "WALL_DANGLING").length).toBeGreaterThan(0);
  });

  it("flags ROOMS_STALE when a room is stale", () => {
    const plan: FloorPlan = {
      ...TWO_ROOM_PLAN,
      rooms: TWO_ROOM_PLAN.rooms.map((r) => (r.id === "rA" ? { ...r, stale: true } : r)),
    };
    const stale = planIssues(plan).find((i) => i.code === "ROOMS_STALE");
    expect(stale?.ids).toEqual(["rA"]);
  });

  it("flags LUAS_MISMATCH at 20 % deviation but not at 6 %", () => {
    const off20 = { ...SAMPLE_PLAN, rab: { ...SAMPLE_PLAN.rab, luasBangunanM2: 100 } };
    expect(codes(off20)).toEqual(["LUAS_MISMATCH"]);
    const off6 = { ...SAMPLE_PLAN, rab: { ...SAMPLE_PLAN.rab, luasBangunanM2: 85 } };
    expect(codes(off6)).toEqual([]);
  });

  it("offers delete_wall (unsafe) for a stub with no nearby wall", () => {
    const plan: FloorPlan = {
      ...TWO_ROOM_PLAN,
      walls: [...TWO_ROOM_PLAN.walls, { id: "stub", a: { x: 2, y: 2 }, b: { x: 2, y: 3 }, thickness: 0.12, height: 3 }],
    };
    const dangling = planIssues(plan).filter((i) => i.code === "WALL_DANGLING");
    expect(dangling).toHaveLength(1);
    expect(dangling[0].fix).toMatchObject({ kind: "delete_wall", safe: false, ids: ["stub"] });
    expect(applyFix(plan, dangling[0].fix!).walls.map((w) => w.id)).toEqual(TWO_ROOM_PLAN.walls.map((w) => w.id));
  });

  it("offers clamp_opening for overlapping openings and fixes them", () => {
    const plan: FloorPlan = {
      ...TWO_ROOM_PLAN,
      openings: [
        ...TWO_ROOM_PLAN.openings,
        { id: "winN_A2", wallId: "wN", kind: "window", t0: 0.25, t1: 0.4, bottom: 0.9, top: 2.1 },
      ],
    };
    const overlap = planIssues(plan).find((i) => i.code === "OPENING_OVERLAP")!;
    expect(overlap.fix).toMatchObject({ kind: "clamp_opening", safe: true, ids: ["winN_A", "winN_A2"] });
    const fixed = applyFix(plan, overlap.fix!);
    expect(fixed.openings.find((o) => o.id === "winN_A2")).toMatchObject({ t0: 0.31, t1: 0.4 });
    expect(codes(fixed)).not.toContain("OPENING_OVERLAP");
  });

  it("flags unnamed, tiny and door-width problems", () => {
    const plan: FloorPlan = {
      ...TWO_ROOM_PLAN,
      rooms: TWO_ROOM_PLAN.rooms.map((r) => (r.id === "rB" ? { ...r, name: "Ruangan", type: undefined } : r)),
      openings: TWO_ROOM_PLAN.openings.map((o) => (o.id === "doorS_B" ? { ...o, t0: 0.2, t1: 0.4 } : o)),
    };
    expect(codes(plan)).toEqual(["DOOR_WIDTH", "ROOM_UNNAMED"]);
  });
});

// -----------------------------------------------------------------------------
// applyFix
// -----------------------------------------------------------------------------
describe("applyFix", () => {
  it("merge_nodes closes a 0.2 m gap", () => {
    const gap = withWall(TWO_ROOM_PLAN, "wW", { b: { x: 0, y: 0.2 } });
    const before = clone(gap);
    const issues = planIssues(gap);
    expect(issues.map((i) => i.code)).toContain("NOT_WATERTIGHT");
    const dangling = issues.filter((i) => i.code === "WALL_DANGLING");
    expect(dangling).toHaveLength(1);
    expect(dangling[0].fix).toEqual({
      kind: "merge_nodes",
      label: "Sambungkan",
      safe: true,
      ids: ["wW"],
      point: { x: 0, y: 0 },
    });

    const fixed = applyFix(gap, dangling[0].fix!);
    expect(gap).toEqual(before); // pure
    expect(fixed.walls.find((w) => w.id === "wW")!.b).toEqual({ x: 0, y: 0 });
    expect(planIssues(fixed)).toEqual([]);
    const r = rebuildRooms(fixed);
    expect(r.rooms.map((x) => [x.id, x.stale ?? false])).toEqual([["rA", false], ["rB", false]]);

    // the gap left as is: room A loses its face and goes stale
    expect(rebuildRooms(gap).rooms.find((x) => x.id === "rA")?.stale).toBe(true);
  });

  it("merge_nodes to a point on another wall closes a T gap", () => {
    const gap = withWall(TWO_ROOM_PLAN, "wMid", { a: { x: 5, y: 0.2 } });
    const dangling = planIssues(gap).filter((i) => i.code === "WALL_DANGLING");
    expect(dangling).toHaveLength(1);
    expect(dangling[0].fix).toMatchObject({ kind: "merge_nodes", safe: true, ids: ["wMid"], point: { x: 5, y: 0 } });
    expect(planIssues(applyFix(gap, dangling[0].fix!))).toEqual([]);
  });

  it("attach_opening moves an opening onto the target wall keeping its width", () => {
    const plan: FloorPlan = {
      ...TWO_ROOM_PLAN,
      walls: [...TWO_ROOM_PLAN.walls, { id: "dup", a: { x: 1, y: -0.2 }, b: { x: 4, y: -0.2 }, thickness: 0.12, height: 3 }],
      openings: [{ id: "o1", wallId: "dup", kind: "window", t0: 0.3, t1: 0.7, bottom: 0.9, top: 2.1 }],
    };
    const issue = planIssues(plan).find((i) => i.code === "OPENING_OFF_WALL")!;
    expect(issue.fix).toMatchObject({ kind: "attach_opening", safe: true, ids: ["o1", "wN"] });
    const fixed = applyFix(plan, issue.fix!);
    const o = fixed.openings[0];
    expect(o.wallId).toBe("wN");
    expect((o.t1 - o.t0) * 10).toBeCloseTo(1.2, 9);
    expect(((o.t0 + o.t1) / 2) * 10).toBeCloseTo(2.5, 9);
  });

  it("delete_opening and unknown targets are pure no-ops where nothing applies", () => {
    const fix: PlanFix = { kind: "delete_opening", label: "Hapus", safe: false, ids: ["winMid"] };
    expect(applyFix(TWO_ROOM_PLAN, fix).openings.map((o) => o.id)).not.toContain("winMid");
    expect(TWO_ROOM_PLAN.openings.map((o) => o.id)).toContain("winMid");
    const missing: PlanFix = { kind: "delete_wall", label: "Hapus", safe: false, ids: ["nope"] };
    expect(applyFix(TWO_ROOM_PLAN, missing)).toBe(TWO_ROOM_PLAN);
  });
});

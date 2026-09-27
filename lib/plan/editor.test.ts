import { describe, expect, it } from "vitest";
import { polygonArea } from "./convert";
import {
  canRedo,
  canUndo,
  createEditorState,
  editorReducer,
  northOffsetFromDirection,
  projectOntoWall,
  snapPoint,
  snapPointInfo,
  type EditorAction,
  type EditorState,
} from "./editor";
import { SAMPLE_PLAN } from "./fixtures/sample-plan";
import { TWO_ROOM_PLAN } from "./fixtures/two-room-plan";

const clone = <T>(v: T): T => structuredClone(v);

const run = (state: EditorState, ...actions: EditorAction[]): EditorState =>
  actions.reduce(editorReducer, state);

const wallById = (plan: FloorPlan, id: string) => plan.walls.find((w) => w.id === id);
const roomById = (plan: FloorPlan, id: string) => plan.rooms.find((r) => r.id === id);

const withWall = (plan: FloorPlan, id: string, patch: Partial<PlanWall>): FloorPlan => ({
  ...plan,
  walls: plan.walls.map((w) => (w.id === id ? { ...w, ...patch } : w)),
});

describe("snapPoint", () => {
  it("snaps to the nearest other endpoint within 0.15 m", () => {
    expect(snapPoint(TWO_ROOM_PLAN, { x: 10.1, y: 0.05 })).toEqual({ x: 10, y: 0 });
    expect(snapPointInfo(TWO_ROOM_PLAN, { x: 0.08, y: 7.9 }).kind).toBe("endpoint");
    // 0.2 m away from every endpoint and every wall body: free
    const free = snapPointInfo(TWO_ROOM_PLAN, { x: 2.2, y: 2.2 });
    expect(free).toMatchObject({ kind: "free", point: { x: 2.2, y: 2.2 } });
  });

  it("ignores the endpoints of ignoreWallId and the from point itself", () => {
    const plan: FloorPlan = {
      ...TWO_ROOM_PLAN,
      walls: [
        ...TWO_ROOM_PLAN.walls,
        { id: "stub", a: { x: 2, y: 2 }, b: { x: 2, y: 3 }, thickness: 0.12, height: 3 },
      ],
    };
    expect(snapPoint(plan, { x: 2.05, y: 3.05 })).toEqual({ x: 2, y: 3 });
    expect(snapPoint(plan, { x: 2.05, y: 3.05 }, null, "stub")).toEqual({ x: 2.05, y: 3.05 });
    // from = (2, 3): that endpoint is not a snap target, the axis lock is
    expect(snapPoint(plan, { x: 3, y: 3.05 }, { x: 2, y: 3 }, "stub")).toEqual({
      x: 3,
      y: 3,
    });
  });

  it("locks to the axis when <= 8 degrees off, stays free beyond", () => {
    const from = { x: 2, y: 2 };
    // 5.7 degrees off horizontal -> y locked to from.y
    const locked = snapPointInfo(TWO_ROOM_PLAN, { x: 4, y: 2.2 }, from);
    expect(locked.point).toEqual({ x: 4, y: 2 });
    expect(locked.kind).toBe("axis");
    expect(locked.locked).toBe("y");
    // 5.7 degrees off vertical -> x locked to from.x
    expect(snapPoint(TWO_ROOM_PLAN, { x: 2.2, y: 4 }, from)).toEqual({ x: 2, y: 4 });
    // ~14 degrees: free (diagonal allowed)
    const diag = snapPointInfo(TWO_ROOM_PLAN, { x: 4, y: 2.5 }, from);
    expect(diag.kind).toBe("free");
    expect(diag.point).toEqual({ x: 4, y: 2.5 });
  });

  it("lands an axis-locked point exactly on a nearby wall body (T-junction)", () => {
    const r = snapPointInfo(TWO_ROOM_PLAN, { x: 2.1, y: 7.9 }, { x: 2, y: 4 });
    expect(r.point).toEqual({ x: 2, y: 8 });
    expect(r.kind).toBe("wall");
    expect(r.wallId).toBe("wS");
  });

  it("projectOntoWall returns the clamped parameter and distance", () => {
    const wN = wallById(TWO_ROOM_PLAN, "wN")!;
    expect(projectOntoWall(wN, { x: 2.5, y: 1 })).toEqual({ t: 0.25, dist: 1 });
    const beyond = projectOntoWall(wN, { x: 12, y: 0 });
    expect(beyond.t).toBe(1);
    expect(beyond.dist).toBeCloseTo(2, 12);
  });

  it("northOffsetFromDirection matches the extraction convention", () => {
    const c = { x: 5, y: 4 };
    expect(northOffsetFromDirection(c, { x: 5, y: 0 })).toBe(0);
    // north is to the right of the image -> plan-up points west -> 270
    expect(northOffsetFromDirection(c, { x: 9, y: 4 })).toBeCloseTo(270, 9);
    expect(northOffsetFromDirection(c, { x: 1, y: 4 })).toBeCloseTo(90, 9);
    expect(northOffsetFromDirection(c, c)).toBeNull();
  });
});

describe("geometry commits", () => {
  it("ADD_WALL snaps, rebuilds rooms and adopts the noded walls", () => {
    const s0 = createEditorState(TWO_ROOM_PLAN);
    const s1 = run(s0, { type: "ADD_WALL", a: { x: 5.05, y: 3 }, b: { x: 10.08, y: 3.05 } });

    expect(s1.plan).not.toBe(s0.plan);
    const added = s1.plan.walls.find((w) => !TWO_ROOM_PLAN.walls.some((o) => o.id === w.id) && w.a.y === 3 && w.b.y === 3);
    expect(added).toBeDefined();
    expect(added!.a).toEqual({ x: 5, y: 3 });
    expect(added!.b).toEqual({ x: 10, y: 3 });
    expect(added!.height).toBe(3);
    expect(s1.selection).toEqual({ kind: "wall", id: added!.id });

    // wMid / wE are noded at y = 3 and wN / wS at the wMid T-junctions
    // (5 walls + the new one + 4 extra pieces; ids kept by one piece each)
    expect(s1.plan.walls.length).toBe(TWO_ROOM_PLAN.walls.length + 5);
    expect(wallById(s1.plan, "wMid")).toBeDefined();
    expect(wallById(s1.plan, "wE")).toBeDefined();

    expect(s1.plan.rooms).toHaveLength(3);
    expect(polygonArea(roomById(s1.plan, "rA")!.polygon)).toBeCloseTo(40, 9);
    expect(polygonArea(roomById(s1.plan, "rB")!.polygon)).toBeCloseTo(25, 9);
    const fresh = s1.plan.rooms.find((r) => r.id !== "rA" && r.id !== "rB")!;
    expect(fresh.name).toBe("Ruangan");
    expect(polygonArea(fresh.polygon)).toBeCloseTo(15, 9);
    expect(s1.plan.rooms.some((r) => r.stale)).toBe(false);

    // openings survive and history grows
    expect(s1.plan.openings.map((o) => o.id).sort()).toEqual(
      TWO_ROOM_PLAN.openings.map((o) => o.id).sort(),
    );
    expect(canUndo(s1)).toBe(true);
    expect(s1.issues.some((i) => i.code === "ROOM_UNNAMED")).toBe(true);
  });

  it("ADD_WALL refuses a wall shorter than the rebuild minimum", () => {
    const s0 = createEditorState(TWO_ROOM_PLAN);
    const s1 = run(s0, { type: "ADD_WALL", a: { x: 2, y: 2 }, b: { x: 2.1, y: 2 } });
    expect(s1.plan).toBe(s0.plan);
  });

  it("COMMIT_DRAG snaps the dragged end onto the wall and re-forms both rooms", () => {
    // wMid's south end is off by 0.8 m: the plan has one face, both rooms are data only
    const broken = withWall(TWO_ROOM_PLAN, "wMid", { b: { x: 5.4, y: 7.2 } });
    const s0 = createEditorState(broken);
    const s1 = run(
      s0,
      { type: "BEGIN_DRAG", wallId: "wMid", end: "b" },
      { type: "DRAG_ENDPOINT", point: { x: 5.2, y: 7.5 } },
      { type: "DRAG_ENDPOINT", point: { x: 5.05, y: 7.94 } },
    );
    expect(s1.drag).not.toBeNull();
    // live preview: snapped (axis lock to x = 5, then onto wS)
    expect(wallById(s1.plan, "wMid")!.b).toEqual({ x: 5, y: 8 });
    expect(s1.past).toHaveLength(0);

    const s2 = run(s1, { type: "COMMIT_DRAG" });
    expect(s2.drag).toBeNull();
    expect(s2.past).toEqual([broken]);
    expect(wallById(s2.plan, "wMid")!.b).toEqual({ x: 5, y: 8 });
    // wN and wS are split at x = 5 -> 7 walls, original ids kept
    expect(s2.plan.walls).toHaveLength(7);
    for (const id of ["wN", "wE", "wS", "wW", "wMid"]) expect(wallById(s2.plan, id)).toBeDefined();
    expect(s2.plan.rooms.map((r) => [r.id, r.name, r.stale ?? false])).toEqual([
      ["rA", "Kamar A", false],
      ["rB", "Ruang B", false],
    ]);
    expect(polygonArea(roomById(s2.plan, "rA")!.polygon)).toBeCloseTo(40, 9);
    // the interior window moved with the wall and stays attached
    expect(s2.plan.openings.find((o) => o.id === "winMid")?.wallId).toBe("wMid");
  });

  it("dragging a shared corner moves every wall that meets there; CANCEL_DRAG restores", () => {
    const s0 = createEditorState(TWO_ROOM_PLAN);
    const s1 = run(
      s0,
      { type: "BEGIN_DRAG", wallId: "wE", end: "b" },
      { type: "DRAG_ENDPOINT", point: { x: 10.3, y: 9.02 } },
    );
    // wS starts at (10, 8) too and follows the corner
    expect(wallById(s1.plan, "wE")!.b).toEqual(wallById(s1.plan, "wS")!.a);
    expect(wallById(s1.plan, "wE")!.b.y).toBeCloseTo(9.02, 9);
    const s2 = run(s1, { type: "CANCEL_DRAG" });
    expect(s2.plan).toBe(s0.plan);
    expect(s2.drag).toBeNull();
  });

  it("a drag without movement commits nothing", () => {
    const s0 = createEditorState(TWO_ROOM_PLAN);
    const s1 = run(
      s0,
      { type: "BEGIN_DRAG", wallId: "wMid", end: "a" },
      { type: "COMMIT_DRAG" },
    );
    expect(s1.plan).toBe(s0.plan);
    expect(s1.past).toHaveLength(0);
  });

  it("DELETE_SELECTED on a wall removes its openings and marks the orphan room stale", () => {
    const s0 = createEditorState(TWO_ROOM_PLAN);
    const s1 = run(
      s0,
      { type: "SELECT", selection: { kind: "wall", id: "wMid" } },
      { type: "DELETE_SELECTED" },
    );
    expect(wallById(s1.plan, "wMid")).toBeUndefined();
    expect(s1.plan.openings.some((o) => o.id === "winMid")).toBe(false);
    expect(s1.plan.openings.some((o) => o.wallId === "wMid")).toBe(false);
    expect(s1.plan.openings).toHaveLength(TWO_ROOM_PLAN.openings.length - 1);
    expect(s1.selection).toBeNull();
    expect(s1.plan.rooms.filter((r) => r.stale)).toHaveLength(1);
    expect(s1.issues.some((i) => i.code === "ROOMS_STALE")).toBe(true);
  });

  it("SPLIT_WALL keeps the original id on the first piece and re-hosts openings", () => {
    const s0 = createEditorState(TWO_ROOM_PLAN);
    const s1 = run(s0, { type: "SPLIT_WALL", wallId: "wS", point: { x: 5, y: 8.1 } });
    const pieces = s1.plan.walls.filter((w) => w.a.y === 8 && w.b.y === 8);
    expect(pieces).toHaveLength(2);
    expect(wallById(s1.plan, "wS")!.b).toEqual({ x: 5, y: 8 });
    // doorS_B (x 7.05..7.95) stays on wS, winS_A (x 1.9..3.1) moves to the new piece
    const door = s1.plan.openings.find((o) => o.id === "doorS_B")!;
    const win = s1.plan.openings.find((o) => o.id === "winS_A")!;
    expect(door.wallId).toBe("wS");
    expect(win.wallId).not.toBe("wS");
    const winWall = wallById(s1.plan, win.wallId)!;
    expect((win.t1 - win.t0) * 5).toBeCloseTo(1.2, 9);
    expect(winWall.a).toEqual({ x: 5, y: 8 });
    expect(s1.plan.rooms.every((r) => !r.stale)).toBe(true);
  });

  it("RENAME_ROOM survives a delete-then-redraw of the bounding wall", () => {
    const s0 = createEditorState(TWO_ROOM_PLAN);
    const s1 = run(
      s0,
      { type: "RENAME_ROOM", id: "rA", name: "Kamar Utama" },
      { type: "SET_ROOM_TYPE", id: "rB", roomType: "ruang_makan" },
      { type: "SET_ROOM_FLOOR_MATERIAL", id: "rB", materialId: "parket_kayu" },
      { type: "SELECT", selection: { kind: "wall", id: "wMid" } },
      { type: "DELETE_SELECTED" },
    );
    expect(s1.plan.rooms.some((r) => r.stale)).toBe(true);

    const s2 = run(s1, { type: "ADD_WALL", a: { x: 5, y: 0.03 }, b: { x: 5.1, y: 7.95 } });
    const rA = roomById(s2.plan, "rA")!;
    const rB = roomById(s2.plan, "rB")!;
    expect(rA.name).toBe("Kamar Utama");
    expect(rA.stale).toBeUndefined();
    expect(rB.name).toBe("Ruang B");
    expect(rB.type).toBe("ruang_makan");
    expect(rB.floorMaterialId).toBe("parket_kayu");
    expect(rB.stale).toBeUndefined();
    expect(s2.plan.rooms).toHaveLength(2);
    expect(polygonArea(rA.polygon)).toBeCloseTo(40, 9);
    expect(polygonArea(rB.polygon)).toBeCloseTo(40, 9);
    expect(s2.issues.some((i) => i.code === "ROOMS_STALE")).toBe(false);
  });

  it("REBUILD_ROOMS drops stale rooms", () => {
    const s1 = run(
      createEditorState(TWO_ROOM_PLAN),
      { type: "SELECT", selection: { kind: "wall", id: "wMid" } },
      { type: "DELETE_SELECTED" },
      { type: "REBUILD_ROOMS" },
    );
    expect(s1.plan.rooms).toHaveLength(1);
    expect(s1.plan.rooms[0].stale).toBeUndefined();
    // rebuilding an already clean plan is a no-op (no empty undo step)
    const s2 = run(s1, { type: "REBUILD_ROOMS" });
    expect(s2.plan).toBe(s1.plan);
    expect(s2.past).toHaveLength(s1.past.length);
  });
});

describe("calibration", () => {
  const unconfirmed: FloorPlan = {
    ...TWO_ROOM_PLAN,
    scale: { pxPerMeter: 50, confirmed: false, method: "bbox_prior", confidence: 0 },
  };

  it("CALIBRATE_APPLY rescales from two points and confirms (method manual)", () => {
    const s1 = run(
      createEditorState(unconfirmed),
      { type: "SET_TOOL", tool: "calibrate" },
      { type: "CALIBRATE_POINT", point: { x: 0, y: 0 } },
      { type: "CALIBRATE_POINT", point: { x: 10, y: 0 } },
    );
    expect(s1.calibration).toEqual({ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
    // 10 m at 50 px/m = 500 px measures 5 m -> 100 px/m, geometry halves
    const s2 = run(s1, { type: "CALIBRATE_APPLY", metres: 5 });
    expect(s2.plan.scale).toEqual({ pxPerMeter: 100, confirmed: true, method: "manual", confidence: 1 });
    expect(wallById(s2.plan, "wN")!.b).toEqual({ x: 5, y: 0 });
    expect(wallById(s2.plan, "wN")!.height).toBe(3);
    expect(wallById(s2.plan, "wN")!.thickness).toBeCloseTo(0.08, 9); // 0.075 clamped
    expect(roomById(s2.plan, "rA")!.anchor).toEqual({ x: 1.25, y: 2 });
    expect(s2.plan.openings.find((o) => o.id === "winN_A")).toMatchObject({ bottom: 0.9, top: 2.1 });
    expect(s2.calibration).toBeNull();
    expect(s2.tool).toBe("select");
    expect(s2.issues.some((i) => i.code === "SCALE_UNCONFIRMED")).toBe(false);
  });

  it("CALIBRATE_TOTAL_WIDTH rescales from the building width and confirms", () => {
    const s0 = createEditorState(unconfirmed);
    expect(s0.issues.some((i) => i.code === "SCALE_UNCONFIRMED")).toBe(true);
    const s1 = run(s0, { type: "CALIBRATE_TOTAL_WIDTH", metres: 12 });
    expect(s1.plan.scale.confirmed).toBe(true);
    expect(s1.plan.scale.method).toBe("manual");
    expect(s1.plan.scale.pxPerMeter).toBeCloseTo((50 * 10) / 12, 9);
    expect(wallById(s1.plan, "wN")!.b.x).toBeCloseTo(12, 9);
    expect(wallById(s1.plan, "wE")!.b.y).toBeCloseTo(9.6, 9);
    expect(polygonArea(roomById(s1.plan, "rA")!.polygon)).toBeCloseTo(40 * 1.44, 9);
  });

  it("CONFIRM_SCALE keeps the method; invalid metres are ignored", () => {
    const s0 = createEditorState(unconfirmed);
    expect(run(s0, { type: "CALIBRATE_TOTAL_WIDTH", metres: 0 }).plan).toBe(s0.plan);
    expect(run(s0, { type: "CALIBRATE_APPLY", metres: 5 }).plan).toBe(s0.plan);
    const s1 = run(s0, { type: "CONFIRM_SCALE" });
    expect(s1.plan.scale).toEqual({ ...unconfirmed.scale, confirmed: true });
  });
});

describe("history", () => {
  it("UNDO / REDO restore plan identity", () => {
    const s0 = createEditorState(TWO_ROOM_PLAN);
    expect(canUndo(s0)).toBe(false);
    const s1 = run(s0, { type: "RENAME_ROOM", id: "rA", name: "Kamar Utama" });
    const s2 = run(s1, { type: "SET_NORTH", deg: 90 });
    expect(s2.past).toEqual([s0.plan, s1.plan]);

    const u1 = run(s2, { type: "UNDO" });
    expect(u1.plan).toBe(s1.plan);
    const u2 = run(u1, { type: "UNDO" });
    expect(u2.plan).toBe(s0.plan);
    expect(u2.plan).toBe(TWO_ROOM_PLAN);
    expect(canUndo(u2)).toBe(false);
    expect(canRedo(u2)).toBe(true);

    const r1 = run(u2, { type: "REDO" });
    expect(r1.plan).toBe(s1.plan);
    const r2 = run(r1, { type: "REDO" });
    expect(r2.plan).toBe(s2.plan);
    expect(canRedo(r2)).toBe(false);

    // a new edit clears the redo stack
    const branched = run(u1, { type: "SET_NORTH", deg: 45 });
    expect(canRedo(branched)).toBe(false);
  });

  it("caps the undo stack at 50 snapshots", () => {
    let s = createEditorState(TWO_ROOM_PLAN);
    for (let i = 1; i <= 60; i += 1) s = run(s, { type: "SET_NORTH", deg: i });
    expect(s.past).toHaveLength(50);
    expect(s.past[0].northOffsetDeg).toBe(10);
  });

  it("REPLACE_PLAN adopts an outside plan and clears history; MARK_PUSHED records editedAt", () => {
    const s1 = run(createEditorState(TWO_ROOM_PLAN), { type: "SET_NORTH", deg: 10 });
    const outside = { ...clone(SAMPLE_PLAN), editedAt: "2026-02-01T00:00:00.000Z" };
    const s2 = run(s1, { type: "REPLACE_PLAN", plan: outside });
    expect(s2.plan).toBe(outside);
    expect(s2.past).toEqual([]);
    expect(s2.lastPushedEditedAt).toBe("2026-02-01T00:00:00.000Z");
    const s3 = run(s2, { type: "MARK_PUSHED", editedAt: "2026-02-02T00:00:00.000Z" });
    expect(s3.lastPushedEditedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(s3.plan).toBe(s2.plan);
  });
});

describe("wall height, openings and rooms", () => {
  it("SET_WALL_HEIGHT 3.0 -> 3.5 raises passage tops and leaves door/window tops", () => {
    const s0 = createEditorState(SAMPLE_PLAN);
    const s1 = run(s0, { type: "SET_WALL_HEIGHT", height: 3.5 });
    expect(s1.plan.walls.every((w) => w.height === 3.5)).toBe(true);
    const byId = new Map(s1.plan.openings.map((o) => [o.id, o]));
    expect(byId.get("o-lorong")!.top).toBe(3.5);
    expect(byId.get("o-lorong")!.bottom).toBe(0);
    expect(byId.get("o-pintu-utama")!.top).toBe(2.1);
    expect(byId.get("o-jendela-kt1")).toMatchObject({ bottom: 0.9, top: 2.1 });
    // and back down: the passage follows, doors stay
    const s2 = run(s1, { type: "SET_WALL_HEIGHT", height: 2.8 });
    expect(s2.plan.openings.find((o) => o.id === "o-lorong")!.top).toBe(2.8);
    expect(s2.plan.openings.find((o) => o.id === "o-pintu-kt1")!.top).toBe(2.1);
  });

  it("ADD_OPENING centres a default-sized opening at the click with kind defaults", () => {
    const s0 = createEditorState(TWO_ROOM_PLAN);
    // wN is 10 m: a door at t = 0.6 -> 0.85 m wide centred at x = 6
    const s1 = run(s0, { type: "ADD_OPENING", wallId: "wN", kind: "door", t: 0.6 });
    const added = s1.plan.openings.find((o) => !TWO_ROOM_PLAN.openings.some((x) => x.id === o.id))!;
    expect(added).toMatchObject({ wallId: "wN", kind: "door", bottom: 0, top: 2.1 });
    expect((added.t1 - added.t0) * 10).toBeCloseTo(0.85, 9);
    expect((added.t0 + added.t1) / 2).toBeCloseTo(0.6, 9);
    expect(s1.selection).toEqual({ kind: "opening", id: added.id });

    const s2 = run(s0, { type: "ADD_OPENING", wallId: "wE", kind: "opening", t: 0.2 });
    const passage = s2.plan.openings.find((o) => o.kind === "opening")!;
    expect(passage).toMatchObject({ bottom: 0, top: 3 });
    expect((passage.t1 - passage.t0) * 8).toBeCloseTo(0.9, 9);

    // clicking inside an existing opening adds nothing
    expect(run(s0, { type: "ADD_OPENING", wallId: "wN", kind: "window", t: 0.25 }).plan).toBe(s0.plan);
  });

  it("MOVE_OPENING and SET_OPENING stay clear of neighbours", () => {
    const s0 = createEditorState(TWO_ROOM_PLAN);
    // doorS_B (t 0.205..0.295) slides towards winS_A (t 0.69..0.81) but stops at it
    const s1 = run(s0, { type: "MOVE_OPENING", id: "doorS_B", t: 0.7 });
    const door = s1.plan.openings.find((o) => o.id === "doorS_B")!;
    expect(door.t1).toBeCloseTo(0.69, 9);
    expect(door.t1 - door.t0).toBeCloseTo(0.09, 9);
    const s2 = run(s1, { type: "SET_OPENING", id: "doorS_B", patch: { width: 1.2 } });
    const wider = s2.plan.openings.find((o) => o.id === "doorS_B")!;
    expect((wider.t1 - wider.t0) * 10).toBeCloseTo(1.2, 9);
    expect(wider.t1).toBeLessThanOrEqual(0.69 + 1e-9);
    const s3 = run(s2, { type: "SET_OPENING", id: "doorS_B", patch: { kind: "window" } });
    expect(s3.plan.openings.find((o) => o.id === "doorS_B")).toMatchObject({
      kind: "window",
      bottom: 0.9,
      top: 2.1,
    });
  });

  it("SET_ROOM_ANCHOR keeps a live room's anchor inside it", () => {
    const s0 = createEditorState(TWO_ROOM_PLAN);
    const inside = run(s0, { type: "SET_ROOM_ANCHOR", id: "rA", point: { x: 1, y: 1 } });
    expect(roomById(inside.plan, "rA")!.anchor).toEqual({ x: 1, y: 1 });
    const outside = run(s0, { type: "SET_ROOM_ANCHOR", id: "rA", point: { x: 7, y: 1 } });
    expect(outside.plan).toBe(s0.plan);
  });
});

describe("fixes", () => {
  it("APPLY_SAFE_FIXES applies only safe fixes", () => {
    const plan: FloorPlan = {
      ...withWall(TWO_ROOM_PLAN, "wMid", { b: { x: 5, y: 7.8 } }),
      walls: [
        ...withWall(TWO_ROOM_PLAN, "wMid", { b: { x: 5, y: 7.8 } }).walls,
        { id: "stub", a: { x: 2, y: 2 }, b: { x: 2, y: 3 }, thickness: 0.12, height: 3 },
      ],
    };
    const s0 = createEditorState(plan);
    const merge = s0.issues.find((i) => i.fix?.kind === "merge_nodes");
    const del = s0.issues.find((i) => i.fix?.kind === "delete_wall");
    expect(merge?.fix?.safe).toBe(true);
    expect(del?.fix?.safe).toBe(false);

    const s1 = run(s0, { type: "APPLY_SAFE_FIXES" });
    expect(wallById(s1.plan, "wMid")!.b).toEqual({ x: 5, y: 8 });
    expect(wallById(s1.plan, "stub")).toBeDefined();
    expect(s1.issues.some((i) => i.fix?.kind === "merge_nodes")).toBe(false);
    expect(s1.issues.some((i) => i.fix?.kind === "delete_wall" && i.ids?.includes("stub"))).toBe(true);
    expect(s1.plan.rooms.map((r) => [r.id, r.stale ?? false])).toEqual([
      ["rA", false],
      ["rB", false],
    ]);
    expect(s1.past).toEqual([plan]);
  });

  it("APPLY_FIX applies the fix at an issue index (unsafe delete included)", () => {
    const plan: FloorPlan = {
      ...TWO_ROOM_PLAN,
      walls: [
        ...TWO_ROOM_PLAN.walls,
        { id: "stub", a: { x: 2, y: 2 }, b: { x: 2, y: 3 }, thickness: 0.12, height: 3 },
      ],
    };
    const s0 = createEditorState(plan);
    const index = s0.issues.findIndex((i) => i.fix?.kind === "delete_wall");
    expect(index).toBeGreaterThanOrEqual(0);
    const s1 = run(s0, { type: "APPLY_FIX", issueIndex: index });
    expect(wallById(s1.plan, "stub")).toBeUndefined();
    expect(run(s0, { type: "APPLY_FIX", issueIndex: 999 })).toBe(s0);
  });
});

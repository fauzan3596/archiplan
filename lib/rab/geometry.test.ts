import { describe, expect, it } from "vitest";
import { SAMPLE_PLAN } from "../plan/fixtures/sample-plan";
import { TWO_ROOM_PLAN } from "../plan/fixtures/two-room-plan";
import { DEFAULT_RAB_INPUTS } from "../plan/defaults";
import {
  computeQuantities,
  lampPointsFor,
  planWallHeight,
  setPlanWallHeight,
} from "./geometry";

const inputs = (patch: Partial<RabInputs> = {}): RabInputs => ({
  ...DEFAULT_RAB_INPUTS,
  overrides: {},
  ...patch,
});

const sumValues = (rec: Record<string, number>) =>
  Object.values(rec).reduce((s, v) => s + v, 0);

describe("computeQuantities — SAMPLE_PLAN (10 x 8 m, 5 rooms, h = 3 m)", () => {
  const q = computeQuantities(SAMPLE_PLAN, inputs());

  it("sums the live room areas; ceiling = floor", () => {
    // tamu 6x3.5 + kt1 4x4.5 + kt2 4x4.5 + km 2x4.5 + dapur 4x3.5
    expect(q.floor_area).toBeCloseTo(21 + 18 + 18 + 9 + 14, 9);
    expect(q.ceiling_area).toBeCloseTo(q.floor_area, 9);
    expect(q.perRoom).toHaveLength(5);
  });

  it("counts partitions twice and exterior walls once plus an exterior face", () => {
    // exterior nets: w-n 30-1.44, w-e 24, w-s1 12, w-s2 18-1.89 (door .9x2.1), w-w 24-1.44
    const exterior = 28.56 + 24 + 12 + 16.11 + 22.56;
    // partitions: p1 12-1.68, p2 6-1.68, p3 6, p4 6-1.47, kt 13.5, km 13.5, dp 10.5-4.2 (passage 1.4x3)
    const partitions = 10.32 + 4.32 + 6 + 4.53 + 13.5 + 13.5 + 6.3;
    expect(q.wall_exterior_area).toBeCloseTo(exterior, 6);
    expect(q.wall_interior_area).toBeCloseTo(exterior + 2 * partitions, 6);
    expect(q.wall_both_area).toBeCloseTo(2 * exterior + 2 * partitions, 6);
    expect(q.wallAreaByItem).toEqual({ cat_interior: q.wall_interior_area });
  });

  it("plint = Σ perimeter − floor-level opening widths on each side", () => {
    // perimeters 19 + 17 + 17 + 13 + 15 = 81; utama .9 (tamu), kt1 .8 x2, kt2 .8 x2,
    // km .7 x2 (km + dapur), passage 1.4 x2 (tamu + dapur)
    expect(q.plint_length).toBeCloseTo(81 - (0.9 + 1.6 + 1.6 + 1.4 + 2.8), 6);
  });

  it("derives door subtypes utama / kamar_mandi / kamar", () => {
    expect(q.doorSubtypes).toEqual({
      "o-pintu-utama": "utama",
      "o-pintu-kt1": "kamar",
      "o-pintu-kt2": "kamar",
      "o-pintu-km": "kamar_mandi",
    });
    expect(q.door_main_count).toBe(1);
    expect(q.door_bath_count).toBe(1);
    expect(q.door_room_count).toBe(2);
  });

  it("an explicit doorSubtype wins over the derived one", () => {
    const plan = structuredClone(SAMPLE_PLAN);
    plan.openings = plan.openings.map((o) =>
      o.id === "o-pintu-kt1" ? { ...o, doorSubtype: "utama" } : o,
    );
    const q2 = computeQuantities(plan, inputs());
    expect(q2.doorSubtypes["o-pintu-kt1"]).toBe("utama");
    expect(q2.door_main_count).toBe(2);
    expect(q2.door_room_count).toBe(1);
  });

  it("window area = Σ width × (top − bottom)", () => {
    expect(q.window_count).toBe(2);
    expect(q.window_area).toBeCloseTo(1.2 * 1.2 * 2, 6);
  });

  it("groups floor area by the room floor material's RAB item and sums to floor_area", () => {
    expect(q.floorAreaByItem.lantai_granit_60).toBeCloseTo(21, 9);
    expect(q.floorAreaByItem.lantai_keramik_40).toBeCloseTo(59, 9);
    expect(sumValues(q.floorAreaByItem)).toBeCloseTo(q.floor_area, 9);
  });

  it("applies the lamp and socket heuristics per room type", () => {
    // lamps: tamu 21 -> 2, kt 18 -> 2 (x2), km 9 -> 1, dapur 14 -> 2
    expect(q.lamp_points).toBe(9);
    // sockets: tamu 4, kt 3 + 3, km 1, dapur 5
    expect(q.socket_points).toBe(16);
    expect(lampPointsFor(0.5)).toBe(1);
    expect(lampPointsFor(13)).toBe(2);
    expect(lampPointsFor(25)).toBe(3);
  });

  it("has no demolition volume unless demolition is on", () => {
    expect(q.demolition_floor_area).toBe(0);
    expect(q.debris_trips).toBe(0);
    const d = computeQuantities(SAMPLE_PLAN, inputs({ demolition: true }));
    expect(d.demolition_floor_area).toBeCloseTo(80, 9);
    expect(d.demolition_ceiling_area).toBeCloseTo(80, 9);
    // 80 m² x 0.05 m = 4 m³ -> 1 rit
    expect(d.debris_trips).toBe(1);
  });

  it("zeroes the paint area for bata ekspos walls", () => {
    const plan = structuredClone(SAMPLE_PLAN);
    plan.materials = { ...plan.materials, wall: "bata_ekspos" };
    const q2 = computeQuantities(plan, inputs());
    expect(q2.wallAreaByItem.cat_interior ?? 0).toBe(0);
    expect(q2.wall_interior_area).toBeCloseTo(q.wall_interior_area, 9);
  });

  it("flags an unconfirmed scale and a luas mismatch", () => {
    expect(q.scaleUnconfirmed).toBe(false);
    expect(q.luasMismatchPct).toBeNull();
    const plan = structuredClone(SAMPLE_PLAN);
    plan.scale = { ...plan.scale, confirmed: false };
    const q2 = computeQuantities(plan, inputs({ luasBangunanM2: 100 }));
    expect(q2.scaleUnconfirmed).toBe(true);
    expect(q2.luasMismatchPct).toBeCloseTo(20, 9);
  });

  it("excludes stale rooms", () => {
    const plan = structuredClone(SAMPLE_PLAN);
    plan.rooms = plan.rooms.map((r) => (r.id === "r-dapur" ? { ...r, stale: true } : r));
    const q2 = computeQuantities(plan, inputs());
    expect(q2.floor_area).toBeCloseTo(66, 9);
    expect(q2.perRoom.map((r) => r.roomId)).not.toContain("r-dapur");
    expect(q2.socket_points).toBe(11);
    expect(q2.floorAreaByItem.lantai_keramik_40).toBeCloseTo(45, 9);
    expect(sumValues(q2.floorAreaByItem)).toBeCloseTo(q2.floor_area, 9);
  });
});

describe("computeQuantities — TWO_ROOM_PLAN (sun spec house)", () => {
  const q = computeQuantities(TWO_ROOM_PLAN, inputs());

  it("computes faces with the partition counted twice", () => {
    // wN 30-1.44, wE 24-1.44, wS 30-1.44-1.89, wW 24-1.44
    const exterior = 28.56 + 22.56 + 26.67 + 22.56;
    // wMid 24 - 1.44 (winMid), both faces
    const partition = 22.56;
    expect(q.wall_exterior_area).toBeCloseTo(exterior, 6);
    expect(q.wall_interior_area).toBeCloseTo(exterior + 2 * partition, 6);
  });

  it("computes floor, plint, doors, windows and electrical points", () => {
    expect(q.floor_area).toBeCloseTo(80, 9);
    // perimeters 26 + 26, door doorS_B 0.9 wide opens into Ruang B only
    expect(q.plint_length).toBeCloseTo(52 - 0.9, 6);
    expect(q.doorSubtypes).toEqual({ doorS_B: "utama" });
    expect(q.door_main_count).toBe(1);
    expect(q.window_count).toBe(5);
    expect(q.window_area).toBeCloseTo(5 * 1.44, 6);
    // 40 m² rooms -> 4 lamps each; kamar_tidur 3 + ruang_keluarga 4 sockets
    expect(q.lamp_points).toBe(8);
    expect(q.socket_points).toBe(7);
    expect(q.floorAreaByItem).toEqual({ lantai_keramik_40: 80 });
  });
});

describe("setPlanWallHeight", () => {
  it("rewrites every wall and raises only full-height openings", () => {
    const next = setPlanWallHeight(SAMPLE_PLAN, 3.5);
    expect(next.walls.every((w) => w.height === 3.5)).toBe(true);
    const byId = new Map(next.openings.map((o) => [o.id, o]));
    expect(byId.get("o-lorong")?.top).toBe(3.5);
    expect(byId.get("o-pintu-utama")?.top).toBe(2.1);
    expect(byId.get("o-jendela-kt1")?.top).toBe(2.1);
    expect(next.openings).toHaveLength(SAMPLE_PLAN.openings.length);
    // input untouched
    expect(SAMPLE_PLAN.walls[0].height).toBe(3);
    expect(planWallHeight(next)).toBe(3.5);
  });

  it("feeds the new height into the wall quantities", () => {
    const next = setPlanWallHeight(TWO_ROOM_PLAN, 3.5);
    const q = computeQuantities(next, inputs());
    // exterior gross grows by 36 m perimeter x 0.5 m
    expect(q.wall_exterior_area).toBeCloseTo(28.56 + 22.56 + 26.67 + 22.56 + 36 * 0.5, 6);
  });

  it("ignores an invalid height", () => {
    expect(setPlanWallHeight(SAMPLE_PLAN, Number.NaN)).toBe(SAMPLE_PLAN);
  });
});

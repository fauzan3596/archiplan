import { describe, expect, it } from "vitest";
import {
  FLOOR_MATERIALS,
  MATERIALS,
  materialById,
  planWallMaterial,
  roomFloorMaterial,
  WALL_MATERIALS,
} from "./materials";
import { DEFAULT_MATERIALS } from "./defaults";

// RAB line ids from lib/rab/data.ts that a material may point at.
const RAB_MATERIAL_ITEM_IDS = [
  "lantai_keramik_40",
  "lantai_granit_60",
  "lantai_parket",
  "lantai_vinyl",
  "cat_interior",
];

const EXPECTED: Record<string, string | null> = {
  keramik_putih: "lantai_keramik_40",
  granit_abu: "lantai_granit_60",
  parket_kayu: "lantai_parket",
  vinyl_oak: "lantai_vinyl",
  cat_putih: "cat_interior",
  cat_krem: "cat_interior",
  cat_abu: "cat_interior",
  bata_ekspos: null,
};

describe("MATERIALS catalog", () => {
  it("has unique ids and exactly the agreed entries", () => {
    const ids = MATERIALS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("partitions into floor and wall lists", () => {
    expect(FLOOR_MATERIALS.length + WALL_MATERIALS.length).toBe(MATERIALS.length);
    expect(FLOOR_MATERIALS.every((m) => m.category === "floor")).toBe(true);
    expect(WALL_MATERIALS.every((m) => m.category === "wall")).toBe(true);
    expect(FLOOR_MATERIALS.map((m) => m.id)).toEqual([
      "keramik_putih",
      "granit_abu",
      "parket_kayu",
      "vinyl_oak",
    ]);
    expect(WALL_MATERIALS.map((m) => m.id)).toEqual([
      "cat_putih",
      "cat_krem",
      "cat_abu",
      "bata_ekspos",
    ]);
  });

  it("maps every material to the agreed RAB item id (or null)", () => {
    for (const m of MATERIALS) {
      expect(m.rabItemId).toBe(EXPECTED[m.id]);
      if (m.rabItemId !== null) {
        expect(RAB_MATERIAL_ITEM_IDS).toContain(m.rabItemId);
      }
    }
  });

  it("carries sane texture parameters", () => {
    for (const m of MATERIALS) {
      expect(m.tileSize).toBeGreaterThan(0);
      expect(m.roughness).toBeGreaterThanOrEqual(0);
      expect(m.roughness).toBeLessThanOrEqual(1);
      expect(m.baseColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(m.accentColor).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(materialById("keramik_putih", "floor").tileSize).toBe(0.4);
    expect(materialById("granit_abu", "floor").tileSize).toBe(0.6);
    expect(materialById("bata_ekspos", "wall").pattern).toBe("brick");
  });
});

describe("materialById", () => {
  it("finds a material within its category", () => {
    expect(materialById("parket_kayu", "floor").id).toBe("parket_kayu");
    expect(materialById("cat_abu", "wall").id).toBe("cat_abu");
  });

  it("falls back to the category default for unknown ids, wrong categories and null", () => {
    expect(materialById("nope", "floor").id).toBe(DEFAULT_MATERIALS.floor);
    expect(materialById("cat_putih", "floor").id).toBe(DEFAULT_MATERIALS.floor);
    expect(materialById("keramik_putih", "wall").id).toBe(DEFAULT_MATERIALS.wall);
    expect(materialById(null, "wall").id).toBe(DEFAULT_MATERIALS.wall);
    expect(materialById(undefined, "floor").id).toBe(DEFAULT_MATERIALS.floor);
  });
});

describe("plan helpers", () => {
  const plan = {
    materials: { floor: "granit_abu", wall: "bata_ekspos" },
  } as FloorPlan;

  it("resolves the room floor material with the plan default as fallback", () => {
    const room = { id: "r", name: "x", polygon: [], anchor: { x: 0, y: 0 } } as PlanRoom;
    expect(roomFloorMaterial(room, plan).id).toBe("granit_abu");
    expect(roomFloorMaterial({ ...room, floorMaterialId: "vinyl_oak" }, plan).id).toBe("vinyl_oak");
    expect(roomFloorMaterial({ ...room, floorMaterialId: null }, plan).id).toBe("granit_abu");
    expect(roomFloorMaterial({ ...room, floorMaterialId: "ghost" }, plan).id).toBe(
      DEFAULT_MATERIALS.floor,
    );
  });

  it("resolves the plan-wide wall material", () => {
    expect(planWallMaterial(plan).id).toBe("bata_ekspos");
    expect(planWallMaterial({ materials: { floor: "x", wall: "y" } } as FloorPlan).id).toBe(
      DEFAULT_MATERIALS.wall,
    );
  });
});

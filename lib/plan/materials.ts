// Pure material catalog shared by the 3D scene (textures), the editor (room
// floor select) and the RAB (rabItemId -> lib/rab/data.ts line).

import { DEFAULT_MATERIALS } from "./defaults";

export const MATERIALS: readonly MaterialDef[] = [
  {
    id: "keramik_putih",
    name: "Keramik putih 40x40",
    category: "floor",
    pattern: "tile",
    tileSize: 0.4,
    baseColor: "#f3f1ec",
    accentColor: "#d6d3cc",
    roughness: 0.35,
    rabItemId: "lantai_keramik_40",
  },
  {
    id: "granit_abu",
    name: "Granit abu 60x60",
    category: "floor",
    pattern: "tile",
    tileSize: 0.6,
    baseColor: "#9a9a9a",
    accentColor: "#6f6f6f",
    roughness: 0.25,
    rabItemId: "lantai_granit_60",
  },
  {
    id: "parket_kayu",
    name: "Parket kayu",
    category: "floor",
    pattern: "planks",
    // 4 strips per repeat -> 10 x 40 cm parquet boards
    tileSize: 0.4,
    baseColor: "#a8763e",
    accentColor: "#7a5227",
    roughness: 0.6,
    rabItemId: "lantai_parket",
  },
  {
    id: "vinyl_oak",
    name: "Vinyl oak",
    category: "floor",
    pattern: "planks",
    // 4 strips per repeat -> 20 x 80 cm vinyl planks
    tileSize: 0.8,
    baseColor: "#c9a87c",
    accentColor: "#a98a5f",
    roughness: 0.5,
    rabItemId: "lantai_vinyl",
  },
  {
    id: "cat_putih",
    name: "Cat putih",
    category: "wall",
    pattern: "plaster",
    tileSize: 1,
    baseColor: "#f7f6f2",
    accentColor: "#e9e7e1",
    roughness: 0.9,
    rabItemId: "cat_interior",
  },
  {
    id: "cat_krem",
    name: "Cat krem",
    category: "wall",
    pattern: "plaster",
    tileSize: 1,
    baseColor: "#f1e6cf",
    accentColor: "#e2d4b8",
    roughness: 0.9,
    rabItemId: "cat_interior",
  },
  {
    id: "cat_abu",
    name: "Cat abu",
    category: "wall",
    pattern: "plaster",
    tileSize: 1,
    baseColor: "#cfd2d6",
    accentColor: "#b8bcc2",
    roughness: 0.9,
    rabItemId: "cat_interior",
  },
  {
    id: "bata_ekspos",
    name: "Bata ekspos",
    category: "wall",
    pattern: "brick",
    tileSize: 0.25,
    baseColor: "#b5583a",
    accentColor: "#d9cfc4",
    roughness: 0.95,
    rabItemId: null,
  },
];

export const FLOOR_MATERIALS: readonly MaterialDef[] = MATERIALS.filter(
  (m) => m.category === "floor",
);

export const WALL_MATERIALS: readonly MaterialDef[] = MATERIALS.filter(
  (m) => m.category === "wall",
);

const defaultFor = (category: MaterialCategory): MaterialDef => {
  const wanted =
    category === "floor" ? DEFAULT_MATERIALS.floor : DEFAULT_MATERIALS.wall;
  const list = category === "floor" ? FLOOR_MATERIALS : WALL_MATERIALS;
  return list.find((m) => m.id === wanted) ?? list[0];
};

/** Looks a material up by id within a category; falls back to the category default. */
export const materialById = (
  id: string | null | undefined,
  category: MaterialCategory,
): MaterialDef => {
  const found = id
    ? MATERIALS.find((m) => m.id === id && m.category === category)
    : undefined;
  return found ?? defaultFor(category);
};

export const roomFloorMaterial = (
  room: PlanRoom,
  plan: FloorPlan,
): MaterialDef =>
  materialById(room.floorMaterialId || plan.materials.floor, "floor");

export const planWallMaterial = (plan: FloorPlan): MaterialDef =>
  materialById(plan.materials.wall, "wall");

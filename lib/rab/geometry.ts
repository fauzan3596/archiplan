// Quantity takeoff (volume) for the RAB from the corrected FloorPlan (METRES).
// Faces come from wallAdjacency() (the single exterior authority): a partition
// has 2 interior faces, an exterior wall 1 interior + 1 exterior face. Openings
// are normalised first and deducted from every face of their wall. Stale rooms
// are excluded everywhere.

import {
  openingWidth,
  pointInPolygon,
  polygonArea,
  polygonPerimeter,
  wallLength,
} from "../plan/convert";
import { wallAdjacency } from "../plan/geometry";
import { planWallMaterial, roomFloorMaterial } from "../plan/materials";
import { normalizeWallOpenings } from "../plan/validate";

export interface RoomQuantity {
  roomId: string;
  name: string;
  type: PlanRoomType;
  area: number;
  perimeter: number;
  lamp: number;
  socket: number;
  /** RabItem id of the room's floor material (null when it carries no RAB line) */
  floorItemId: string | null;
}

export interface Quantities {
  floor_area: number;
  ceiling_area: number;
  wall_interior_area: number;
  wall_exterior_area: number;
  wall_both_area: number;
  plint_length: number;
  door_room_count: number;
  door_bath_count: number;
  door_main_count: number;
  window_area: number;
  window_count: number;
  lamp_points: number;
  socket_points: number;
  demolition_floor_area: number;
  demolition_ceiling_area: number;
  debris_trips: number;
  /** floor area grouped by the room floor material's rabItemId */
  floorAreaByItem: Record<string, number>;
  /** interior wall area keyed by the plan wall material's rabItemId ({} for bata ekspos) */
  wallAreaByItem: Record<string, number>;
  /** resolved subtype per door id */
  doorSubtypes: Record<string, PlanDoorSubtype>;
  perRoom: RoomQuantity[];
  scaleUnconfirmed: boolean;
  /** |Σ area − luasBangunanM2| / luasBangunanM2 × 100, null without a luas input */
  luasMismatchPct: number | null;
}

/** LUAS_MISMATCH threshold (same 15 % rule as planIssues). */
export const LUAS_MISMATCH_PCT = 15;

/** ~5 cm of tile + screed per m² of demolished floor (assumption). */
export const DEBRIS_M3_PER_M2 = 0.05;

/** Truk engkel 6–7 m³ per rit (https://jasabuangpuing.co.id/harga-jasa-buang-puing-per-rit/). */
export const TRUCK_M3_PER_TRIP = 6.5;

/** Openings whose bottom is at most this high interrupt the plint (doors, passages). */
export const FLOOR_LEVEL_MAX_BOTTOM_M = 0.05;

const PROBE_OFFSET_M = 0.05;

// Stop kontak per room — https://www.mitra10.com/blog/berapa-banyak-stop-kontak-untuk-rumah (2025-08-27):
// dapur 4–6, ruang keluarga 3–5, kamar tidur 2–3, kamar mandi 1–2; general rule "minimal 1 titik lampu
// dan 2 stop kontak per ruangan".
export const SOCKETS_BY_ROOM_TYPE: Record<PlanRoomType, number> = {
  kamar_tidur: 3,
  kamar_mandi: 1,
  dapur: 5,
  ruang_tamu: 4,
  ruang_keluarga: 4,
  ruang_makan: 2,
  teras: 2,
  garasi: 2,
  gudang: 2,
  koridor: 2,
  servis: 2,
  lainnya: 2,
};

/** Lamp points: ASSUMPTION (no published per-m² rule; SNI lux targets only):
 *  1 + one extra per 12 m², minimum 1. */
export const lampPointsFor = (area: number): number =>
  Math.max(1, 1 + Math.floor(Math.max(0, area - 1) / 12));

export const socketPointsFor = (type: PlanRoomType | undefined): number =>
  SOCKETS_BY_ROOM_TYPE[type ?? "lainnya"] ?? 2;

const liveRoomsOf = (plan: FloorPlan): PlanRoom[] =>
  plan.rooms.filter((r) => !r.stale && r.polygon.length >= 3);

/** Rooms on either side of an opening's centre, probed just outside the wall faces. */
const roomsBesideOpening = (
  o: PlanOpening,
  w: PlanWall,
  rooms: PlanRoom[],
): PlanRoom[] => {
  const len = wallLength(w);
  if (len < 1e-9) return [];
  const t = (o.t0 + o.t1) / 2;
  const cx = w.a.x + (w.b.x - w.a.x) * t;
  const cy = w.a.y + (w.b.y - w.a.y) * t;
  const nx = -(w.b.y - w.a.y) / len;
  const ny = (w.b.x - w.a.x) / len;
  const offset = w.thickness / 2 + PROBE_OFFSET_M;
  const found: PlanRoom[] = [];
  for (const sign of [1, -1]) {
    const p = { x: cx + nx * offset * sign, y: cy + ny * offset * sign };
    const room = rooms.find((r) => pointInPolygon(p, r.polygon));
    if (room && !found.includes(room)) found.push(room);
  }
  return found;
};

/** `doorSubtype ?? (adjacent kamar_mandi ? "kamar_mandi" : exterior ? "utama" : "kamar")`. */
export const resolveDoorSubtype = (
  door: PlanOpening,
  besideRooms: PlanRoom[],
  wallIsExterior: boolean,
): PlanDoorSubtype => {
  if (door.doorSubtype) return door.doorSubtype;
  if (besideRooms.some((r) => r.type === "kamar_mandi")) return "kamar_mandi";
  return wallIsExterior ? "utama" : "kamar";
};

export const computeQuantities = (
  plan: FloorPlan,
  inputs: RabInputs,
): Quantities => {
  const rooms = liveRoomsOf(plan);
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const adjacency = wallAdjacency(plan);
  const openings = normalizeWallOpenings(plan.openings, plan.walls);
  const wallById = new Map(plan.walls.map((w) => [w.id, w]));

  const openingsByWall = new Map<string, PlanOpening[]>();
  for (const o of openings) {
    const list = openingsByWall.get(o.wallId) ?? [];
    list.push(o);
    openingsByWall.set(o.wallId, list);
  }

  // --- walls: net area per face ---------------------------------------------
  let wallInterior = 0;
  let wallExterior = 0;
  for (const w of plan.walls) {
    const len = wallLength(w);
    if (len < 1e-9) continue;
    const gross = len * w.height;
    const openArea = (openingsByWall.get(w.id) ?? []).reduce(
      (sum, o) => sum + openingWidth(o, w) * (o.top - o.bottom),
      0,
    );
    const net = Math.max(0, gross - openArea);
    if (adjacency[w.id]?.isExterior ?? true) {
      wallInterior += net;
      wallExterior += net;
    } else {
      wallInterior += 2 * net;
    }
  }

  // --- rooms ------------------------------------------------------------------
  const perRoom: RoomQuantity[] = rooms.map((r) => {
    const area = polygonArea(r.polygon);
    const type = r.type ?? "lainnya";
    return {
      roomId: r.id,
      name: r.name,
      type,
      area,
      perimeter: polygonPerimeter(r.polygon),
      lamp: lampPointsFor(area),
      socket: socketPointsFor(type),
      floorItemId: roomFloorMaterial(r, plan).rabItemId,
    };
  });

  const floorArea = perRoom.reduce((sum, r) => sum + r.area, 0);
  const floorAreaByItem: Record<string, number> = {};
  for (const r of perRoom) {
    if (!r.floorItemId) continue;
    floorAreaByItem[r.floorItemId] = (floorAreaByItem[r.floorItemId] ?? 0) + r.area;
  }

  // --- openings: plint deductions, door subtypes, windows -----------------------
  // Plint: Σ (keliling ruangan − lebar bukaan setinggi lantai pada ruangan itu)
  // https://www.arsitur.com/2020/07/biaya-pemasangan-plin-keramik.html
  const plintDeduction = new Map<string, number>();
  const doorSubtypes: Record<string, PlanDoorSubtype> = {};
  let windowArea = 0;
  let windowCount = 0;

  for (const o of openings) {
    const w = wallById.get(o.wallId);
    if (!w) continue;
    const width = openingWidth(o, w);
    const adj = adjacency[w.id];
    let beside = roomsBesideOpening(o, w, rooms);
    if (beside.length === 0 && adj) {
      beside = adj.roomIds
        .map((id) => roomById.get(id))
        .filter((r): r is PlanRoom => r !== undefined);
    }

    if (o.kind === "window") {
      windowArea += width * (o.top - o.bottom);
      windowCount += 1;
      continue;
    }

    if (o.bottom <= FLOOR_LEVEL_MAX_BOTTOM_M) {
      for (const r of beside) {
        plintDeduction.set(r.id, (plintDeduction.get(r.id) ?? 0) + width);
      }
    }

    if (o.kind === "door") {
      doorSubtypes[o.id] = resolveDoorSubtype(o, beside, adj?.isExterior ?? false);
    }
  }

  const plintLength = perRoom.reduce(
    (sum, r) => sum + Math.max(0, r.perimeter - (plintDeduction.get(r.roomId) ?? 0)),
    0,
  );

  const subtypeCounts: Record<PlanDoorSubtype, number> = {
    kamar: 0,
    kamar_mandi: 0,
    utama: 0,
  };
  for (const subtype of Object.values(doorSubtypes)) subtypeCounts[subtype] += 1;

  // --- wall finish keyed by material (bata ekspos carries no paint line) ------------
  const wallItemId = planWallMaterial(plan).rabItemId;
  const wallAreaByItem: Record<string, number> = wallItemId
    ? { [wallItemId]: wallInterior }
    : {};

  // --- demolition -------------------------------------------------------------------
  const demolition = inputs.demolition === true;
  const debrisM3 = demolition ? floorArea * DEBRIS_M3_PER_M2 : 0;

  // --- luas sanity check ----------------------------------------------------------------
  const luas = inputs.luasBangunanM2;
  const luasMismatchPct =
    typeof luas === "number" && Number.isFinite(luas) && luas > 0 && floorArea > 0
      ? (Math.abs(floorArea - luas) / luas) * 100
      : null;

  return {
    floor_area: floorArea,
    ceiling_area: floorArea,
    wall_interior_area: wallInterior,
    wall_exterior_area: wallExterior,
    wall_both_area: wallInterior + wallExterior,
    plint_length: plintLength,
    door_room_count: subtypeCounts.kamar,
    door_bath_count: subtypeCounts.kamar_mandi,
    door_main_count: subtypeCounts.utama,
    window_area: windowArea,
    window_count: windowCount,
    lamp_points: perRoom.reduce((sum, r) => sum + r.lamp, 0),
    socket_points: perRoom.reduce((sum, r) => sum + r.socket, 0),
    demolition_floor_area: demolition ? floorArea : 0,
    demolition_ceiling_area: demolition ? floorArea : 0,
    debris_trips: debrisM3 > 0 ? Math.ceil(debrisM3 / TRUCK_M3_PER_TRIP) : 0,
    floorAreaByItem,
    wallAreaByItem,
    doorSubtypes,
    perRoom,
    scaleUnconfirmed: !plan.scale.confirmed,
    luasMismatchPct,
  };
};

/** Most common wall height (2 decimals) for the "Tinggi dinding" control. */
export const planWallHeight = (plan: FloorPlan, fallback = 3): number => {
  const counts = new Map<number, number>();
  for (const w of plan.walls) {
    if (!Number.isFinite(w.height) || w.height <= 0) continue;
    const h = Math.round(w.height * 100) / 100;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  let best = fallback;
  let bestCount = 0;
  for (const [h, count] of counts) {
    if (count > bestCount) {
      best = h;
      bestCount = count;
    }
  }
  return best;
};

/** Same rule as the editor's SET_WALL_HEIGHT: every wall gets height h and every
 *  opening whose top reached its wall's old height (passages) is raised/lowered
 *  to h; other openings keep their top (clamped by normalizeWallOpenings). */
export const setPlanWallHeight = (plan: FloorPlan, h: number): FloorPlan => {
  if (!Number.isFinite(h) || h <= 0) {
    console.error("setPlanWallHeight: invalid height", h);
    return plan;
  }
  const oldHeight = new Map(plan.walls.map((w) => [w.id, w.height]));
  const walls = plan.walls.map((w) => ({ ...w, height: h }));
  const raised = plan.openings.map((o) => {
    const old = oldHeight.get(o.wallId);
    return old !== undefined && o.top >= old - 1e-3 ? { ...o, top: h } : o;
  });
  return { ...plan, walls, openings: normalizeWallOpenings(raised, walls) };
};

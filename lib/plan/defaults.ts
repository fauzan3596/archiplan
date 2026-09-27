// Shared constants and default factories for the FloorPlan model. Every
// geometry value here is in METRES (see type.d.ts for the frame conventions).

export const DEFAULT_WALL_HEIGHT = 3.0;
export const DEFAULT_WALL_THICKNESS = 0.15;
export const MIN_WALL_THICKNESS = 0.08;
export const MAX_WALL_THICKNESS = 0.4;
export const DOOR_WIDTH_PRIOR = 0.85;
export const DOOR_TOP = 2.1;
export const WINDOW_BOTTOM = 0.9;
export const WINDOW_TOP = 2.1;
export const EDITOR_SNAP_M = 0.15;
export const AXIS_TOLERANCE_DEG = 8;
export const REBUILD_EPS_M = 0.12;
export const OPENING_REATTACH_M = 0.3;
export const AUTOSAVE_DEBOUNCE_MS = 1500;

export const DEFAULT_MATERIALS: PlanMaterials = {
  floor: "keramik_putih",
  wall: "cat_putih",
};

export const DEFAULT_RAB_INPUTS: RabInputs = {
  paket: "ringan",
  grade: "mid",
  region: "jabodetabek",
  contractorFeePct: 10,
  includePpn: false,
  demolition: false,
  luasBangunanM2: null,
  overrides: {},
};

export const ROOM_TYPE_LABELS: Record<PlanRoomType, string> = {
  kamar_tidur: "Kamar Tidur",
  kamar_mandi: "Kamar Mandi",
  dapur: "Dapur",
  ruang_tamu: "Ruang Tamu",
  ruang_keluarga: "Ruang Keluarga",
  ruang_makan: "Ruang Makan",
  teras: "Teras",
  garasi: "Garasi",
  gudang: "Gudang",
  koridor: "Koridor",
  servis: "Area Servis",
  lainnya: "Lainnya",
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local calendar day as "YYYY-MM-DD". */
export const todayISO = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

export const createDefaultSun = (): SunSettings => ({
  dateISO: todayISO(),
  minutesOfDay: 600,
  cityId: "jakarta",
  showPath: true,
  showCompass: true,
});

export const defaultOpeningVertical = (
  kind: PlanOpeningKind,
  wallHeight: number,
): { bottom: number; top: number } => {
  const height =
    Number.isFinite(wallHeight) && wallHeight > 0
      ? wallHeight
      : DEFAULT_WALL_HEIGHT;

  if (kind === "window") {
    return {
      bottom: Math.min(WINDOW_BOTTOM, height),
      top: Math.min(WINDOW_TOP, height),
    };
  }

  if (kind === "opening") return { bottom: 0, top: height };

  return { bottom: 0, top: Math.min(DOOR_TOP, height) };
};

const KIND_TO_TYPE: Record<string, PlanRoomType> = {
  bedroom: "kamar_tidur",
  kamar_tidur: "kamar_tidur",
  bathroom: "kamar_mandi",
  toilet: "kamar_mandi",
  wc: "kamar_mandi",
  kamar_mandi: "kamar_mandi",
  kitchen: "dapur",
  dapur: "dapur",
  living: "ruang_tamu",
  living_room: "ruang_tamu",
  ruang_tamu: "ruang_tamu",
  family: "ruang_keluarga",
  family_room: "ruang_keluarga",
  ruang_keluarga: "ruang_keluarga",
  dining: "ruang_makan",
  dining_room: "ruang_makan",
  ruang_makan: "ruang_makan",
  terrace: "teras",
  porch: "teras",
  balcony: "teras",
  teras: "teras",
  garage: "garasi",
  carport: "garasi",
  garasi: "garasi",
  storage: "gudang",
  gudang: "gudang",
  corridor: "koridor",
  hall: "koridor",
  hallway: "koridor",
  koridor: "koridor",
  service: "servis",
  laundry: "servis",
  utility: "servis",
  servis: "servis",
  other: "lainnya",
  lainnya: "lainnya",
};

const NAME_HINTS: [RegExp, PlanRoomType][] = [
  [/k\.?\s*mandi|kamar\s*mandi|\bkm\b|\bwc\b|toilet|bath/i, "kamar_mandi"],
  [/k\.?\s*tidur|kamar\s*tidur|\bkt\b|bed|kamar\b/i, "kamar_tidur"],
  [/dapur|kitchen|pantry/i, "dapur"],
  [/r\.?\s*tamu|ruang\s*tamu|living/i, "ruang_tamu"],
  [/r\.?\s*keluarga|ruang\s*keluarga|family/i, "ruang_keluarga"],
  [/r\.?\s*makan|ruang\s*makan|dining/i, "ruang_makan"],
  [/teras|porch|balkon|balcony|patio/i, "teras"],
  [/garasi|garage|carport/i, "garasi"],
  [/gudang|storage|store/i, "gudang"],
  [/koridor|corridor|hall|lorong/i, "koridor"],
  [/servis|service|laundry|cuci|jemur|utility/i, "servis"],
];

/** Maps an extractor room kind (and, as a fallback, its label) to a PlanRoomType. */
export const roomTypeFromExtraction = (
  kind: string,
  name: string,
): PlanRoomType => {
  const normalizedKind = (kind || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const byKind = KIND_TO_TYPE[normalizedKind];
  if (byKind && byKind !== "lainnya") return byKind;

  for (const [pattern, type] of NAME_HINTS) {
    if (pattern.test(name || "")) return type;
  }

  return "lainnya";
};

let idCounter = 0;

/** `${prefix}-${base36 time}${random}`; never reuse ids across kinds. */
export const newId = (prefix: string): string => {
  idCounter = (idCounter + 1) % 1296;
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  const counter = idCounter.toString(36).padStart(2, "0");
  return `${prefix}-${time}${random}${counter}`;
};

/** Stamps a fresh, strictly increasing editedAt. */
export const touchPlan = (plan: FloorPlan): FloorPlan => {
  let editedAt = new Date().toISOString();
  if (plan.editedAt && editedAt <= plan.editedAt) {
    const previous = Date.parse(plan.editedAt);
    editedAt = new Date(
      (Number.isFinite(previous) ? previous : Date.now()) + 1,
    ).toISOString();
  }
  return { ...plan, editedAt };
};

const EMPTY_PLAN_WIDTH_M = 10;
const EMPTY_PLAN_DEPTH_M = 8;
const EMPTY_PLAN_MARGIN = 0.8;

/** A 10 x 8 m rectangle centred in the image: 4 exterior walls, one room "Ruangan". */
export const createEmptyPlan = ({
  imageSize,
}: {
  imageSize: PlanImageSize;
}): FloorPlan => {
  const w = Number.isFinite(imageSize.w) && imageSize.w > 0 ? imageSize.w : 1000;
  const h = Number.isFinite(imageSize.h) && imageSize.h > 0 ? imageSize.h : 800;

  const pxPerMeter = Math.max(
    1,
    Math.min(
      (w * EMPTY_PLAN_MARGIN) / EMPTY_PLAN_WIDTH_M,
      (h * EMPTY_PLAN_MARGIN) / EMPTY_PLAN_DEPTH_M,
    ),
  );

  const cx = w / pxPerMeter / 2;
  const cy = h / pxPerMeter / 2;
  const x0 = cx - EMPTY_PLAN_WIDTH_M / 2;
  const x1 = cx + EMPTY_PLAN_WIDTH_M / 2;
  const y0 = cy - EMPTY_PLAN_DEPTH_M / 2;
  const y1 = cy + EMPTY_PLAN_DEPTH_M / 2;

  const corners: PlanPoint[] = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];

  const walls: PlanWall[] = corners.map((a, i) => ({
    id: newId("wall"),
    a: { ...a },
    b: { ...corners[(i + 1) % corners.length] },
    thickness: DEFAULT_WALL_THICKNESS,
    height: DEFAULT_WALL_HEIGHT,
    isExterior: true,
  }));

  const room: PlanRoom = {
    id: newId("room"),
    name: "Ruangan",
    polygon: corners.map((p) => ({ ...p })),
    anchor: { x: cx, y: cy },
  };

  return {
    version: 1,
    source: "manual",
    imageSize: { w, h },
    scale: {
      pxPerMeter,
      confirmed: false,
      method: "bbox_prior",
      confidence: 0,
    },
    northOffsetDeg: 0,
    walls,
    openings: [],
    rooms: [room],
    materials: { ...DEFAULT_MATERIALS },
    sun: createDefaultSun(),
    rab: { ...DEFAULT_RAB_INPUTS, overrides: {} },
    extraction: null,
    editedAt: new Date().toISOString(),
  };
};

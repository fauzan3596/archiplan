// Structural normalisation and validation of the persisted FloorPlan. Metric
// and topology checks (planIssues) live in lib/plan/geometry.ts.

import { polygonCentroid } from "./convert";
import {
  createDefaultSun,
  DEFAULT_MATERIALS,
  DEFAULT_RAB_INPUTS,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  MAX_WALL_THICKNESS,
  MIN_WALL_THICKNESS,
} from "./defaults";

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

const SCALE_METHODS: PlanScaleMethod[] = [
  "dimension_labels",
  "overall_dimension",
  "door_prior",
  "thickness_prior",
  "bbox_prior",
  "manual",
];

const ROOM_TYPES: PlanRoomType[] = [
  "kamar_tidur",
  "kamar_mandi",
  "dapur",
  "ruang_tamu",
  "ruang_keluarga",
  "ruang_makan",
  "teras",
  "garasi",
  "gudang",
  "koridor",
  "servis",
  "lainnya",
];

const OPENING_KINDS: PlanOpeningKind[] = ["door", "window", "opening"];
const DOOR_SUBTYPES: PlanDoorSubtype[] = ["kamar", "kamar_mandi", "utama"];
const PAKETS: RabPaket[] = ["ringan", "sedang", "bangun_baru"];
const GRADES: RabGrade[] = ["low", "mid", "high"];
const REGIONS: RabRegion[] = [
  "jabodetabek",
  "bandung",
  "jateng",
  "diy",
  "jatim",
  "jawa_lain",
  "bali",
  "sumatera",
  "kalimantan",
  "sulawesi",
  "nusa_tenggara",
  "papua",
  "papua_pegunungan",
];

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const finiteOr = (v: unknown, fallback: number): number => finite(v) ?? fallback;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const oneOf = <T extends string>(v: unknown, list: T[], fallback: T): T =>
  typeof v === "string" && (list as string[]).includes(v) ? (v as T) : fallback;

const point = (v: unknown): PlanPoint | null => {
  if (!isRecord(v)) return null;
  const x = finite(v.x);
  const y = finite(v.y);
  return x === null || y === null ? null : { x, y };
};

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

const normalizeDeg = (d: number) => {
  const r = ((d % 360) + 360) % 360;
  return r === 360 ? 0 : r;
};

const normalizeWall = (raw: unknown): PlanWall | null => {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const a = point(raw.a);
  const b = point(raw.b);
  if (!id || !a || !b) return null;

  const wall: PlanWall = {
    id,
    a,
    b,
    thickness: clamp(
      finiteOr(raw.thickness, DEFAULT_WALL_THICKNESS),
      MIN_WALL_THICKNESS,
      MAX_WALL_THICKNESS,
    ),
    height: (() => {
      const h = finite(raw.height);
      return h !== null && h > 0 ? h : DEFAULT_WALL_HEIGHT;
    })(),
  };
  if (typeof raw.isExterior === "boolean") wall.isExterior = raw.isExterior;
  const confidence = finite(raw.confidence);
  if (confidence !== null) wall.confidence = clamp(confidence, 0, 1);
  return wall;
};

const normalizeOpening = (raw: unknown): PlanOpening | null => {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const wallId = str(raw.wallId);
  const t0 = finite(raw.t0);
  const t1 = finite(raw.t1);
  const bottom = finite(raw.bottom);
  const top = finite(raw.top);
  if (!id || !wallId || t0 === null || t1 === null) return null;
  if (bottom === null || top === null) return null;

  const opening: PlanOpening = {
    id,
    wallId,
    kind: oneOf(raw.kind, OPENING_KINDS, "door"),
    t0,
    t1,
    bottom,
    top,
  };
  if (typeof raw.doorSubtype === "string") {
    opening.doorSubtype = oneOf(raw.doorSubtype, DOOR_SUBTYPES, "kamar");
  }
  const confidence = finite(raw.confidence);
  if (confidence !== null) opening.confidence = clamp(confidence, 0, 1);
  return opening;
};

const normalizeRoom = (raw: unknown): PlanRoom | null => {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const polygon = Array.isArray(raw.polygon)
    ? raw.polygon.map(point).filter((p): p is PlanPoint => p !== null)
    : [];
  if (polygon.length < 3) return null;

  const room: PlanRoom = {
    id,
    name: typeof raw.name === "string" ? raw.name : "",
    polygon,
    anchor: point(raw.anchor) ?? polygonCentroid(polygon),
  };
  if (typeof raw.type === "string") {
    room.type = oneOf(raw.type, ROOM_TYPES, "lainnya");
  }
  if (typeof raw.floorMaterialId === "string") {
    room.floorMaterialId = raw.floorMaterialId;
  } else if (raw.floorMaterialId === null) {
    room.floorMaterialId = null;
  }
  if (raw.stale === true) room.stale = true;
  const confidence = finite(raw.confidence);
  if (confidence !== null) room.confidence = clamp(confidence, 0, 1);
  return room;
};

const dedupeById = <T extends { id: string }>(items: T[]): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
};

const normalizeSun = (raw: unknown): SunSettings => {
  const base = createDefaultSun();
  if (!isRecord(raw)) return base;
  return {
    dateISO:
      typeof raw.dateISO === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.dateISO)
        ? raw.dateISO
        : base.dateISO,
    minutesOfDay: clamp(
      Math.round(finiteOr(raw.minutesOfDay, base.minutesOfDay)),
      0,
      1439,
    ),
    cityId: str(raw.cityId) ?? base.cityId,
    showPath: typeof raw.showPath === "boolean" ? raw.showPath : base.showPath,
    showCompass:
      typeof raw.showCompass === "boolean" ? raw.showCompass : base.showCompass,
  };
};

const normalizeRab = (raw: unknown): RabInputs => {
  const base = DEFAULT_RAB_INPUTS;
  if (!isRecord(raw)) return { ...base, overrides: {} };

  const overrides: Record<string, RabLineOverride> = {};
  if (isRecord(raw.overrides)) {
    for (const [key, value] of Object.entries(raw.overrides)) {
      if (!isRecord(value)) continue;
      const entry: RabLineOverride = {};
      if (value.volume === null || finite(value.volume) !== null) {
        entry.volume = value.volume as number | null;
      }
      if (value.harga === null || finite(value.harga) !== null) {
        entry.harga = value.harga as number | null;
      }
      if (value.enabled === null || typeof value.enabled === "boolean") {
        entry.enabled = value.enabled as boolean | null;
      }
      overrides[key] = entry;
    }
  }

  const luas = finite(raw.luasBangunanM2);

  return {
    paket: oneOf(raw.paket, PAKETS, base.paket),
    grade: oneOf(raw.grade, GRADES, base.grade),
    region: oneOf(raw.region, REGIONS, base.region),
    contractorFeePct: clamp(
      finiteOr(raw.contractorFeePct, base.contractorFeePct),
      0,
      15,
    ),
    includePpn:
      typeof raw.includePpn === "boolean" ? raw.includePpn : base.includePpn,
    demolition:
      typeof raw.demolition === "boolean" ? raw.demolition : base.demolition,
    luasBangunanM2: luas !== null && luas > 0 ? luas : null,
    overrides,
  };
};

const normalizeExtraction = (raw: unknown): PlanExtractionMeta | null => {
  if (!isRecord(raw)) return null;
  const sent = isRecord(raw.sentSize) ? raw.sentSize : {};
  const meta: PlanExtractionMeta = {
    model: str(raw.model) ?? "unknown",
    frame: raw.frame === "normalized1000" ? "normalized1000" : "pixels",
    sentSize: { w: finiteOr(sent.w, 0), h: finiteOr(sent.h, 0) },
    at: str(raw.at) ?? EPOCH_ISO,
    issues: Array.isArray(raw.issues)
      ? (raw.issues.filter(
          (i) => isRecord(i) && typeof i.code === "string",
        ) as PlanIssue[])
      : [],
    diagonalWallIds: Array.isArray(raw.diagonalWallIds)
      ? raw.diagonalWallIds.filter((v): v is string => typeof v === "string")
      : [],
    rawRooms: Array.isArray(raw.rawRooms)
      ? raw.rawRooms.flatMap((r) => {
          if (!isRecord(r)) return [];
          const polygon = Array.isArray(r.polygon)
            ? r.polygon.map(point).filter((p): p is PlanPoint => p !== null)
            : [];
          if (polygon.length < 3) return [];
          return [
            {
              id: str(r.id) ?? "",
              name: typeof r.name === "string" ? r.name : "",
              polygon,
            },
          ];
        })
      : [],
  };
  if (raw.raw !== undefined) meta.raw = raw.raw;
  return meta;
};

/** Clamps every opening to 0..1 / 0..wall.height, drops openings on missing walls
 *  or with an empty extent, and merges overlapping openings per wall. */
export const normalizeWallOpenings = (
  openings: PlanOpening[],
  walls: PlanWall[],
): PlanOpening[] => {
  const wallById = new Map(walls.map((w) => [w.id, w]));
  const byWall = new Map<string, PlanOpening[]>();

  for (const o of openings) {
    const wall = wallById.get(o.wallId);
    if (!wall) continue;
    const t0 = clamp(Math.min(o.t0, o.t1), 0, 1);
    const t1 = clamp(Math.max(o.t0, o.t1), 0, 1);
    const bottom = clamp(Math.min(o.bottom, o.top), 0, wall.height);
    const top = clamp(Math.max(o.bottom, o.top), 0, wall.height);
    if (t1 - t0 <= 1e-6 || top - bottom <= 1e-6) continue;
    const list = byWall.get(o.wallId) ?? [];
    list.push({ ...o, t0, t1, bottom, top });
    byWall.set(o.wallId, list);
  }

  const out: PlanOpening[] = [];
  for (const wall of walls) {
    const list = (byWall.get(wall.id) ?? []).sort((a, b) => a.t0 - b.t0);
    const merged: PlanOpening[] = [];
    for (const o of list) {
      const prev = merged[merged.length - 1];
      if (prev && o.t0 < prev.t1 - 1e-9) {
        merged[merged.length - 1] = {
          ...prev,
          t1: Math.max(prev.t1, o.t1),
          bottom: Math.min(prev.bottom, o.bottom),
          top: Math.max(prev.top, o.top),
        };
        continue;
      }
      merged.push(o);
    }
    out.push(...merged);
  }

  return out;
};

/** Coerces a stored plan into a valid FloorPlan (fills defaults, drops broken
 *  members, unique ids, non-overlapping openings). Null for garbage. */
export const normalizePlan = (raw: unknown): FloorPlan | null => {
  if (!isRecord(raw)) return null;
  if (raw.version !== 1) {
    console.error("normalizePlan: unsupported plan version", raw.version);
    return null;
  }
  if (!Array.isArray(raw.walls) || !isRecord(raw.imageSize)) {
    console.error("normalizePlan: missing walls or imageSize");
    return null;
  }

  const w = finite(raw.imageSize.w);
  const h = finite(raw.imageSize.h);
  if (w === null || h === null || w <= 0 || h <= 0) {
    console.error("normalizePlan: invalid imageSize");
    return null;
  }

  const scaleRaw = isRecord(raw.scale) ? raw.scale : {};
  const pxPerMeter = finite(scaleRaw.pxPerMeter);
  if (pxPerMeter === null || pxPerMeter <= 0) {
    console.error("normalizePlan: invalid scale");
    return null;
  }

  const walls = dedupeById(
    raw.walls.map(normalizeWall).filter((x): x is PlanWall => x !== null),
  );
  const openings = normalizeWallOpenings(
    dedupeById(
      (Array.isArray(raw.openings) ? raw.openings : [])
        .map(normalizeOpening)
        .filter((x): x is PlanOpening => x !== null),
    ),
    walls,
  );
  const rooms = dedupeById(
    (Array.isArray(raw.rooms) ? raw.rooms : [])
      .map(normalizeRoom)
      .filter((x): x is PlanRoom => x !== null),
  );

  const materialsRaw = isRecord(raw.materials) ? raw.materials : {};

  const plan: FloorPlan = {
    version: 1,
    source:
      raw.source === "ai" || raw.source === "sample" || raw.source === "manual"
        ? raw.source
        : "manual",
    imageSize: { w, h },
    scale: {
      pxPerMeter,
      confirmed: scaleRaw.confirmed === true,
      method: oneOf(scaleRaw.method, SCALE_METHODS, "bbox_prior"),
      confidence: clamp(finiteOr(scaleRaw.confidence, 0), 0, 1),
    },
    northOffsetDeg: normalizeDeg(finiteOr(raw.northOffsetDeg, 0)),
    walls,
    openings,
    rooms,
    materials: {
      floor: str(materialsRaw.floor) ?? DEFAULT_MATERIALS.floor,
      wall: str(materialsRaw.wall) ?? DEFAULT_MATERIALS.wall,
    },
    sun: normalizeSun(raw.sun),
    rab: normalizeRab(raw.rab),
    extraction: normalizeExtraction(raw.extraction),
    editedAt: str(raw.editedAt) ?? EPOCH_ISO,
  };

  return plan;
};

const issue = (
  code: PlanIssueCode,
  severity: PlanIssueSeverity,
  message: string,
  ids?: string[],
): PlanIssue => (ids ? { code, severity, message, ids } : { code, severity, message });

/** Structural checks only; returns an empty list for a healthy plan. */
export const validatePlan = (plan: FloorPlan): PlanIssue[] => {
  const issues: PlanIssue[] = [];

  if (!Number.isFinite(plan.scale.pxPerMeter) || plan.scale.pxPerMeter <= 0) {
    issues.push(issue("NO_SCALE", "error", "Skala denah belum ada"));
  }

  if (
    !Number.isFinite(plan.northOffsetDeg) ||
    plan.northOffsetDeg < 0 ||
    plan.northOffsetDeg >= 360
  ) {
    issues.push(
      issue("NORTH_RANGE", "warn", "Arah utara harus di antara 0 dan 359 derajat"),
    );
  }

  const seen = new Set<string>();
  const checkId = (id: string, label: string) => {
    if (seen.has(id)) {
      issues.push(issue("DUP_ID", "error", `ID ${label} ganda: ${id}`, [id]));
    }
    seen.add(id);
  };

  const wallById = new Map<string, PlanWall>();
  for (const w of plan.walls) {
    checkId(w.id, "dinding");
    wallById.set(w.id, w);
    const nums = [w.a.x, w.a.y, w.b.x, w.b.y, w.thickness, w.height];
    if (nums.some((n) => !Number.isFinite(n))) {
      issues.push(
        issue("INVALID_NUMBER", "error", "Dinding memiliki angka tidak valid", [w.id]),
      );
      continue;
    }
    if (Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) < 0.01) {
      issues.push(issue("WALL_ZERO", "error", "Dinding tanpa panjang", [w.id]));
    }
    if (w.thickness < MIN_WALL_THICKNESS || w.thickness > MAX_WALL_THICKNESS) {
      issues.push(
        issue(
          "WALL_THICKNESS",
          "warn",
          `Tebal dinding di luar ${MIN_WALL_THICKNESS}-${MAX_WALL_THICKNESS} m`,
          [w.id],
        ),
      );
    }
    if (w.height <= 0 || w.height > 10) {
      issues.push(issue("WALL_HEIGHT", "error", "Tinggi dinding tidak wajar", [w.id]));
    }
  }

  const byWall = new Map<string, PlanOpening[]>();
  for (const o of plan.openings) {
    checkId(o.id, "bukaan");
    const nums = [o.t0, o.t1, o.bottom, o.top];
    if (nums.some((n) => !Number.isFinite(n))) {
      issues.push(
        issue("INVALID_NUMBER", "error", "Bukaan memiliki angka tidak valid", [o.id]),
      );
      continue;
    }
    const wall = wallById.get(o.wallId);
    if (!wall) {
      issues.push(
        issue("OPENING_WALL", "error", "Bukaan mengacu ke dinding yang tidak ada", [o.id]),
      );
      continue;
    }
    if (o.t0 < 0 || o.t1 > 1 || o.t1 <= o.t0) {
      issues.push(issue("OPENING_T", "error", "Posisi bukaan di luar dinding", [o.id]));
    }
    if (o.bottom < 0 || o.top > wall.height || o.bottom >= o.top) {
      issues.push(
        issue("OPENING_VERTICAL", "error", "Tinggi bukaan tidak valid", [o.id]),
      );
    }
    const list = byWall.get(o.wallId) ?? [];
    list.push(o);
    byWall.set(o.wallId, list);
  }

  for (const list of byWall.values()) {
    const sorted = [...list].sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].t0 < sorted[i - 1].t1 - 1e-9) {
        issues.push(
          issue("OPENING_OVERLAP", "warn", "Bukaan saling tumpang tindih", [
            sorted[i - 1].id,
            sorted[i].id,
          ]),
        );
      }
    }
  }

  for (const r of plan.rooms) {
    checkId(r.id, "ruangan");
    if (
      r.polygon.length < 3 ||
      r.polygon.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
    ) {
      issues.push(issue("ROOM_POLY", "error", "Poligon ruangan tidak valid", [r.id]));
    }
  }

  return issues;
};

/** RAB CSV export gate: scale confirmed, at least one live room, no stale rooms. */
export const gateForRabExport = (
  plan: FloorPlan,
): { ok: boolean; reasons: PlanIssue[] } => {
  const reasons: PlanIssue[] = [];

  if (!plan.scale.confirmed) {
    reasons.push(
      issue("SCALE_UNCONFIRMED", "warn", "Skala denah belum dikonfirmasi"),
    );
  }

  const live = plan.rooms.filter((r) => !r.stale);
  const stale = plan.rooms.filter((r) => r.stale);

  if (live.length === 0) {
    reasons.push(issue("TOTAL_AREA", "error", "Belum ada ruangan pada denah"));
  }

  if (stale.length > 0) {
    reasons.push(
      issue(
        "ROOMS_STALE",
        "warn",
        "Ada ruangan terputus; bangun ulang ruangan dulu",
        stale.map((r) => r.id),
      ),
    );
  }

  return { ok: reasons.length === 0, reasons };
};

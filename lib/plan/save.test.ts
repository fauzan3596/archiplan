import { describe, expect, it } from "vitest";
import {
  PLAN_HARD_BYTES,
  PLAN_SOFT_BYTES,
  pickNewerPlan,
  planJsonBytes,
  shrinkPlanForSave,
} from "./save";

const makePlan = (editedAt: string): FloorPlan => ({
  version: 1,
  source: "manual",
  imageSize: { w: 1000, h: 800 },
  scale: { pxPerMeter: 80, confirmed: false, method: "bbox_prior", confidence: 0 },
  northOffsetDeg: 0,
  walls: [],
  openings: [],
  rooms: [],
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
  editedAt,
});

const withExtraction = (plan: FloorPlan, raw?: unknown): FloorPlan => ({
  ...plan,
  extraction: {
    model: "claude-sonnet-5",
    frame: "pixels",
    sentSize: { w: 1000, h: 800 },
    at: plan.editedAt,
    issues: [],
    diagonalWallIds: [],
    rawRooms: [],
    ...(raw !== undefined ? { raw } : {}),
  },
});

describe("pickNewerPlan", () => {
  const older = makePlan("2026-01-01T00:00:00.000Z");
  const newer = makePlan("2026-01-02T00:00:00.000Z");

  it("prefers the newer editedAt regardless of side", () => {
    expect(pickNewerPlan(older, newer)).toBe(newer);
    expect(pickNewerPlan(newer, older)).toBe(newer);
  });

  it("keeps local on a tie", () => {
    const localCopy = makePlan(older.editedAt);
    expect(pickNewerPlan(localCopy, older)).toBe(localCopy);
  });

  it("handles nulls", () => {
    expect(pickNewerPlan(null, null)).toBeNull();
    expect(pickNewerPlan(older, null)).toBe(older);
    expect(pickNewerPlan(null, newer)).toBe(newer);
  });
});

describe("shrinkPlanForSave", () => {
  it("returns the plan untouched under the soft budget", () => {
    const plan = withExtraction(makePlan("2026-01-01T00:00:00.000Z"), { small: true });
    const result = shrinkPlanForSave(plan);
    expect(result?.droppedRaw).toBe(false);
    expect(result?.plan).toBe(plan);
  });

  it("drops extraction.raw above the soft budget", () => {
    const plan = withExtraction(
      makePlan("2026-01-01T00:00:00.000Z"),
      "x".repeat(PLAN_SOFT_BYTES + 1000),
    );
    expect(planJsonBytes(plan)).toBeGreaterThan(PLAN_SOFT_BYTES);

    const result = shrinkPlanForSave(plan);
    expect(result).not.toBeNull();
    expect(result?.droppedRaw).toBe(true);
    expect(result?.plan.extraction).not.toHaveProperty("raw");
    expect(planJsonBytes(result?.plan ?? null)).toBeLessThan(PLAN_SOFT_BYTES);
    // rawRooms and the rest of the meta survive.
    expect(result?.plan.extraction?.model).toBe("claude-sonnet-5");
  });

  it("returns null above the hard budget even without raw", () => {
    const plan = makePlan("2026-01-01T00:00:00.000Z");
    plan.rooms = [
      {
        id: "huge",
        name: "y".repeat(PLAN_HARD_BYTES + 1000),
        polygon: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
        anchor: { x: 0.5, y: 0.5 },
      },
    ];
    expect(shrinkPlanForSave(plan)).toBeNull();
  });

  it("measures the JSON size in bytes", () => {
    expect(planJsonBytes(null)).toBe(0);
    const plan = makePlan("2026-01-01T00:00:00.000Z");
    expect(planJsonBytes(plan)).toBe(JSON.stringify(plan).length);
  });
});

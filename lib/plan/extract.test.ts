import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// puter.js must never be reached in mock mode; the retry tests drive this fake.
const chatMock = vi.hoisted(() => vi.fn());
vi.mock("@heyputer/puter.js", () => ({ default: { ai: { chat: chatMock } } }));

import {
  buildExtractionPrompt,
  buildExtractionTools,
  buildPlanFromExtraction,
  buildToolSchema,
  CLAUDE_MAX_VISUAL_TOKENS,
  computeSentSize,
  DEFAULT_EXTRACTION_MODEL_ID,
  EXTRACT_STEPS,
  EXTRACTION_MODELS,
  EXTRACTION_TOOL_NAME,
  ExtractError,
  extractFloorPlan,
  getExtractionModel,
  isMockMode,
  loadSamplePlan,
  readToolArgs,
  SAMPLE_EXTRACTION,
  SAMPLE_IMAGE_SIZE,
  toExtractError,
  validateExtraction,
  type Extraction,
} from "./extract";
import { openingWidth, polygonArea, pointInPolygon, wallLength } from "./convert";
import { planIssues, rebuildRooms } from "./geometry";
import { normalizePlan, validatePlan } from "./validate";

const clone = <T>(v: T): T => structuredClone(v);

const buildSample = (extraction: Extraction = SAMPLE_EXTRACTION, keepRaw = false) =>
  buildPlanFromExtraction({
    extraction,
    sentSize: SAMPLE_IMAGE_SIZE,
    imageSize: SAMPLE_IMAGE_SIZE,
    modelId: "gemini-2.5-pro",
    frame: "normalized1000",
    keepRaw,
  });

/** The normalized fixture re-expressed in the pixel frame of a W x H sent image. */
const toPixelFrame = (d: Extraction, W: number, H: number): Extraction => {
  const X = (v: number) => (v / 1000) * W;
  const Y = (v: number) => (v / 1000) * H;
  const P = (p: [number, number]): [number, number] => [X(p[0]), Y(p[1])];
  const unit = Math.max(W, H) / 1000;
  return {
    ...clone(d),
    image: { ...d.image, width_px: W, height_px: H },
    scale: {
      ...d.scale,
      dimension_labels: d.scale.dimension_labels.map((l) => ({ ...l, from: P(l.from), to: P(l.to) })),
    },
    rooms: d.rooms.map((r) => ({ ...r, polygon: r.polygon.map(P) })),
    walls: d.walls.map((w) => ({ ...w, x0: X(w.x0), y0: Y(w.y0), x1: X(w.x1), y1: Y(w.y1), thickness: w.thickness * unit })),
    openings: d.openings.map((o) => ({ ...o, center: P(o.center) })),
  };
};

const roomByName = (plan: FloorPlan, name: string) => {
  const room = plan.rooms.find((r) => r.name === name);
  if (!room) throw new Error(`room ${name} missing`);
  return room;
};

const bboxOf = (poly: PlanPoint[]) => ({
  minX: Math.min(...poly.map((p) => p.x)),
  minY: Math.min(...poly.map((p) => p.y)),
  maxX: Math.max(...poly.map((p) => p.x)),
  maxY: Math.max(...poly.map((p) => p.y)),
});

// SAMPLE_PLAN house: origin (1.25, 1.0) m in a 1000 x 800 image at 80 px/m.
const X0 = 1.25;
const Y0 = 1;

describe("buildPlanFromExtraction(sample fixture)", () => {
  const plan = buildSample();

  it("yields 5 named, typed rooms with anchors inside", () => {
    expect(plan.rooms).toHaveLength(5);
    const expected: Record<string, PlanRoomType> = {
      "Kamar Tidur 1": "kamar_tidur",
      "Kamar Tidur 2": "kamar_tidur",
      "Kamar Mandi": "kamar_mandi",
      "Ruang Tamu": "ruang_tamu",
      Dapur: "dapur",
    };
    for (const [name, type] of Object.entries(expected)) {
      const room = roomByName(plan, name);
      expect(room.type).toBe(type);
      expect(room.stale).toBeUndefined();
      expect(pointInPolygon(room.anchor, room.polygon)).toBe(true);
    }
  });

  it("reproduces the SAMPLE_PLAN room geometry in metres", () => {
    const cases: [string, number, number, number, number][] = [
      ["Kamar Tidur 1", 0, 0, 4, 4.5],
      ["Kamar Tidur 2", 4, 0, 8, 4.5],
      ["Kamar Mandi", 8, 0, 10, 4.5],
      ["Ruang Tamu", 0, 4.5, 6, 8],
      ["Dapur", 6, 4.5, 10, 8],
    ];
    for (const [name, x0, y0, x1, y1] of cases) {
      const room = roomByName(plan, name);
      const b = bboxOf(room.polygon);
      expect(b.minX).toBeCloseTo(X0 + x0, 6);
      expect(b.minY).toBeCloseTo(Y0 + y0, 6);
      expect(b.maxX).toBeCloseTo(X0 + x1, 6);
      expect(b.maxY).toBeCloseTo(Y0 + y1, 6);
      expect(room.polygon).toHaveLength(4);
      expect(polygonArea(room.polygon)).toBeCloseTo((x1 - x0) * (y1 - y0), 6);
    }
  });

  it("produces the noded wall graph with clamped thickness", () => {
    // The house's planar graph has V = 12 nodes and F = 6 faces, so Euler gives
    // E = 16 noded walls (SAMPLE_PLAN's 12 hand-drawn walls also node to 16).
    expect(plan.walls).toHaveLength(16);
    for (const w of plan.walls) {
      expect(w.thickness).toBeGreaterThanOrEqual(0.08);
      expect(w.thickness).toBeLessThanOrEqual(0.4);
      expect(w.height).toBe(3);
      expect(w.id.startsWith("wall-")).toBe(true);
    }
    const ext = plan.walls.filter((w) => w.isExterior);
    expect(ext.length).toBe(9);
    for (const w of ext) expect(w.thickness).toBeCloseTo(0.15, 6);
    for (const w of plan.walls.filter((x) => !x.isExterior)) expect(w.thickness).toBeCloseTo(0.12, 6);
    const total = plan.walls.reduce((s, w) => s + wallLength(w), 0);
    expect(total).toBeCloseTo(36 + 10 + 4.5 * 2 + 3.5, 6);
  });

  it("attaches all 7 openings with kind-based bottom/top and the original widths", () => {
    expect(plan.openings).toHaveLength(7);
    const wallIds = new Set(plan.walls.map((w) => w.id));
    const widths: Record<string, number[]> = { door: [], window: [], opening: [] };
    for (const o of plan.openings) {
      expect(wallIds.has(o.wallId)).toBe(true);
      expect(o.t0).toBeGreaterThanOrEqual(0);
      expect(o.t1).toBeLessThanOrEqual(1);
      expect(o.t1).toBeGreaterThan(o.t0);
      const wall = plan.walls.find((w) => w.id === o.wallId)!;
      widths[o.kind].push(Math.round(openingWidth(o, wall) * 1000) / 1000);
      if (o.kind === "door") expect([o.bottom, o.top]).toEqual([0, 2.1]);
      if (o.kind === "window") expect([o.bottom, o.top]).toEqual([0.9, 2.1]);
      if (o.kind === "opening") expect([o.bottom, o.top]).toEqual([0, 3]);
    }
    expect(widths.door.sort()).toEqual([0.7, 0.8, 0.8, 0.9]);
    expect(widths.window.sort()).toEqual([1.2, 1.2]);
    expect(widths.opening).toEqual([1.4]);
  });

  it("reads the scale from the dimension labels in natural px, unconfirmed", () => {
    expect(plan.scale.method).toBe("dimension_labels");
    expect(plan.scale.confirmed).toBe(false);
    expect(plan.scale.pxPerMeter).toBeCloseTo(80, 6);
    expect(plan.scale.confidence).toBeCloseTo(0.9, 6);
    expect(plan.imageSize).toEqual({ w: 1000, h: 800 });
    expect(plan.northOffsetDeg).toBe(0);
    expect(plan.source).toBe("ai");
  });

  it("stores extraction meta with rawRooms in metres and no raw by default", () => {
    const meta = plan.extraction!;
    expect(meta.model).toBe("gemini-2.5-pro");
    expect(meta.frame).toBe("normalized1000");
    expect(meta.sentSize).toEqual({ w: 1000, h: 800 });
    expect(meta.rawRooms).toHaveLength(5);
    const kt1 = meta.rawRooms.find((r) => r.id === "r1")!;
    expect(kt1.name).toBe("Kamar Tidur 1");
    expect(bboxOf(kt1.polygon).minX).toBeCloseTo(0.106 * 12.5, 6);
    expect(meta.raw).toBeUndefined();
    expect(meta.diagonalWallIds).toEqual([]);
    expect(meta.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(buildSample(SAMPLE_EXTRACTION, true).extraction!.raw).toEqual(SAMPLE_EXTRACTION);
  });

  it("is a valid, normalized, rebuild-stable plan", () => {
    expect(validatePlan(plan)).toEqual([]);
    expect(normalizePlan(plan)).toEqual(plan);
    const rebuilt = rebuildRooms(plan);
    expect(rebuilt.walls).toHaveLength(16);
    expect(rebuilt.rooms.map((r) => r.id).sort()).toEqual(plan.rooms.map((r) => r.id).sort());
    expect(rebuilt.rooms.some((r) => r.stale)).toBe(false);
    expect(rebuilt.openings).toHaveLength(7);
    const codes = planIssues(plan).map((i) => i.code);
    expect(codes).toContain("SCALE_UNCONFIRMED");
    for (const bad of ["NOT_WATERTIGHT", "ROOM_UNNAMED", "OPENING_OFF_WALL", "WALL_DANGLING", "WALL_DIAGONAL"]) {
      expect(codes).not.toContain(bad);
    }
  });

  it("converts north_deg with northOffsetFromExtraction", () => {
    const d = clone(SAMPLE_EXTRACTION);
    d.image.north_deg = 90;
    expect(buildSample(d).northOffsetDeg).toBe(270);
  });

  it("honours wallHeight for walls and full-height passages", () => {
    const p = buildPlanFromExtraction({
      extraction: SAMPLE_EXTRACTION,
      sentSize: SAMPLE_IMAGE_SIZE,
      imageSize: SAMPLE_IMAGE_SIZE,
      modelId: "m",
      frame: "normalized1000",
      wallHeight: 2.8,
    });
    expect(p.walls.every((w) => w.height === 2.8)).toBe(true);
    expect(p.openings.find((o) => o.kind === "opening")!.top).toBe(2.8);
  });
});

describe("frame equivalence", () => {
  const geometryOf = (plan: FloorPlan) => ({
    walls: plan.walls.map((w) => [w.a.x, w.a.y, w.b.x, w.b.y, w.thickness]),
    rooms: plan.rooms.map((r) => [r.name, ...r.polygon.flatMap((p) => [p.x, p.y]), r.anchor.x, r.anchor.y]),
    openings: plan.openings.map((o) => [o.kind, o.t0, o.t1, o.bottom, o.top]),
    rawRooms: plan.extraction!.rawRooms.map((r) => r.polygon.flatMap((p) => [p.x, p.y])),
    pxPerMeter: plan.scale.pxPerMeter,
  });

  const expectClose = (a: unknown, b: unknown) => {
    if (typeof a === "number" && typeof b === "number") {
      expect(Math.abs(a - b)).toBeLessThan(1e-6);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      expect(a.length).toBe(b.length);
      a.forEach((v, i) => expectClose(v, b[i]));
      return;
    }
    if (a && typeof a === "object" && b && typeof b === "object") {
      for (const key of Object.keys(a)) expectClose((a as Rec)[key], (b as Rec)[key]);
      return;
    }
    expect(a).toEqual(b);
  };
  type Rec = Record<string, unknown>;

  const normalized = geometryOf(buildSample());

  it("the pixel frame at the same sent size yields identical metres", () => {
    const plan = buildPlanFromExtraction({
      extraction: toPixelFrame(SAMPLE_EXTRACTION, 1000, 800),
      sentSize: { w: 1000, h: 800 },
      imageSize: SAMPLE_IMAGE_SIZE,
      modelId: "claude-sonnet-5",
      frame: "pixels",
    });
    expectClose(geometryOf(plan), normalized);
    expect(plan.scale.method).toBe("dimension_labels");
  });

  it("a larger sent image keeps metres and pxPerMeter in natural px", () => {
    const plan = buildPlanFromExtraction({
      extraction: toPixelFrame(SAMPLE_EXTRACTION, 1250, 1000),
      sentSize: { w: 1250, h: 1000 },
      imageSize: SAMPLE_IMAGE_SIZE,
      modelId: "claude-sonnet-5",
      frame: "pixels",
    });
    expectClose(geometryOf(plan), normalized);
    expect(plan.scale.pxPerMeter).toBeCloseTo(80, 6);
    expect(plan.extraction!.sentSize).toEqual({ w: 1250, h: 1000 });
  });

  it("a downscaled sent image maps back to a larger natural image", () => {
    const plan = buildPlanFromExtraction({
      extraction: SAMPLE_EXTRACTION,
      sentSize: { w: 1000, h: 800 },
      imageSize: { w: 2000, h: 1600 },
      modelId: "gemini-2.5-pro",
      frame: "normalized1000",
    });
    expect(plan.scale.pxPerMeter).toBeCloseTo(160, 6);
    expectClose(geometryOf(plan).walls, normalized.walls);
  });
});

describe("scale ladder", () => {
  const without = (mutate: (d: Extraction) => void) => {
    const d = clone(SAMPLE_EXTRACTION);
    mutate(d);
    return buildSample(d);
  };

  it("falls back to overall_dimension", () => {
    const p = without((d) => {
      d.scale.dimension_labels = [];
    });
    expect(p.scale.method).toBe("overall_dimension");
    expect(p.scale.pxPerMeter).toBeCloseTo(80, 6);
  });

  it("falls back to the 0.85 m door prior", () => {
    const p = without((d) => {
      d.scale.dimension_labels = [];
      delete d.scale.overall_width_m;
      delete d.scale.overall_height_m;
    });
    expect(p.scale.method).toBe("door_prior");
    // median door is 0.8 m in truth -> 0.85 / 0.8 scale error
    expect(p.scale.pxPerMeter).toBeCloseTo((80 * 0.8) / 0.85, 6);
  });

  it("falls back to the 0.15 m thickness prior", () => {
    const p = without((d) => {
      d.scale.dimension_labels = [];
      delete d.scale.overall_width_m;
      delete d.scale.overall_height_m;
      d.openings = d.openings.filter((o) => o.kind !== "door");
    });
    expect(p.scale.method).toBe("thickness_prior");
    expect(p.scale.pxPerMeter).toBeCloseTo(80, 6);
  });

  it("ends at bbox_prior (exterior width = 10 m, confidence 0)", () => {
    const p = without((d) => {
      d.scale.dimension_labels = [];
      delete d.scale.overall_width_m;
      delete d.scale.overall_height_m;
      d.openings = [];
      d.walls = d.walls.map((w) => ({ ...w, thickness: 0 }));
    });
    expect(p.scale.method).toBe("bbox_prior");
    expect(p.scale.confidence).toBe(0);
    expect(p.scale.pxPerMeter).toBeCloseTo(80, 6);
    expect(p.scale.confirmed).toBe(false);
    expect(p.walls.every((w) => w.thickness === 0.15)).toBe(true);
    expect(p.extraction!.issues.map((i) => i.code)).toContain("NO_SCALE");
  });

  it("skips an implausible dimension label reading", () => {
    const p = without((d) => {
      d.scale.dimension_labels = [{ text: "400", value_m: 400, from: [100, 40], to: [900, 40] }];
    });
    expect(p.scale.method).toBe("overall_dimension");
  });
});

describe("robustness", () => {
  it("keeps a diagonal wall and flags it", () => {
    const d = clone(SAMPLE_EXTRACTION);
    d.walls.push({ id: "w13", x0: 100, y0: 700, x1: 250, y1: 900, thickness: 9.6, exterior: false, confidence: 0.5 });
    const plan = buildSample(d);
    expect(plan.extraction!.diagonalWallIds).toHaveLength(1);
    const diag = plan.walls.find((w) => w.id === plan.extraction!.diagonalWallIds[0])!;
    expect(diag).toBeDefined();
    expect(plan.extraction!.issues.some((i) => i.code === "WALL_DIAGONAL" && i.ids?.includes(diag.id))).toBe(true);
    expect(plan.rooms).toHaveLength(5);
  });

  it("snaps jittered, slightly tilted model output back into 5 rooms", () => {
    const d = clone(SAMPLE_EXTRACTION);
    const jitter = [3, -2, 4, -3, 1, -4, 2, 3, -1, 4, -2, 1];
    d.walls = d.walls.map((w, i) => ({
      ...w,
      x0: w.x0 + jitter[i % 12],
      y0: w.y0 - jitter[(i + 3) % 12],
      x1: w.x1 + jitter[(i + 5) % 12],
      y1: w.y1 + jitter[(i + 7) % 12],
    }));
    const plan = buildSample(d);
    expect(plan.rooms).toHaveLength(5);
    expect(plan.rooms.every((r) => r.type && r.name !== "Ruangan")).toBe(true);
    expect(plan.openings).toHaveLength(7);
  });

  it("names an unlabelled face 'Ruangan' and reports orphan labels", () => {
    const d = clone(SAMPLE_EXTRACTION);
    d.rooms = d.rooms.filter((r) => r.id !== "r5");
    d.rooms.push({ id: "r9", name: "Gudang", kind: "storage", polygon: [[950, 950], [990, 950], [990, 990]], confidence: 0.4 });
    const plan = buildSample(d);
    const unnamed = plan.rooms.filter((r) => r.name === "Ruangan");
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0].type).toBeUndefined();
    expect(plan.extraction!.issues.some((i) => i.code === "LABEL_ORPHAN")).toBe(true);
  });
});

describe("loadSamplePlan", () => {
  it("builds the fixture with source 'sample'", () => {
    const plan = loadSamplePlan({ w: 1000, h: 800 });
    expect(plan.source).toBe("sample");
    expect(plan.rooms).toHaveLength(5);
    expect(plan.openings).toHaveLength(7);
    expect(plan.scale.pxPerMeter).toBeCloseTo(80, 6);
  });

  it("fits the house undistorted and centred into another image size", () => {
    const W = 2400;
    const H = 900;
    const plan = loadSamplePlan({ w: W, h: H });
    expect(plan.imageSize).toEqual({ w: W, h: H });
    const areas = plan.rooms.map((r) => polygonArea(r.polygon)).sort((a, b) => a - b);
    expect(areas).toEqual([9, 14, 18, 18, 21].map((v) => expect.closeTo(v, 6)));
    const ppm = plan.scale.pxPerMeter;
    const xs = plan.walls.flatMap((w) => [w.a.x, w.b.x]).map((x) => x * ppm);
    const ys = plan.walls.flatMap((w) => [w.a.y, w.b.y]).map((y) => y * ppm);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(W);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(H);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(W / 2, 6);
  });
});

describe("readToolArgs", () => {
  const args = { walls: [], rooms: [], openings: [] };

  it("reads normalized tool_calls arguments (JSON string)", () => {
    const res = {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: EXTRACTION_TOOL_NAME, arguments: JSON.stringify(args) } }],
      },
      finish_reason: "tool_calls",
      normalized: true,
    };
    expect(readToolArgs(res)).toEqual(args);
  });

  it("reads native Anthropic tool_use.input", () => {
    const res = {
      message: {
        content: [
          { type: "text", text: "Here is the plan." },
          { type: "tool_use", id: "t1", name: EXTRACTION_TOOL_NAME, input: args },
        ],
        stop_reason: "tool_use",
      },
      finish_reason: "stop",
    };
    expect(readToolArgs(res)).toEqual(args);
  });

  it("reads fenced JSON from text and bare JSON from content blocks", () => {
    expect(readToolArgs({ message: { content: "Sure:\n```json\n" + JSON.stringify(args) + "\n```" } })).toEqual(args);
    expect(readToolArgs({ message: { content: [{ type: "text", text: `result ${JSON.stringify(args)} done` }] } })).toEqual(args);
  });

  it("throws no_tool_call without a tool call or JSON", () => {
    expect(() => readToolArgs({ message: { content: "I cannot read this image." }, finish_reason: "stop" })).toThrow(
      expect.objectContaining({ code: "no_tool_call" }),
    );
    expect(() => readToolArgs(null)).toThrow(expect.objectContaining({ code: "no_tool_call" }));
  });

  it("throws output_truncated on finish_reason length", () => {
    const truncated = {
      message: { tool_calls: [{ function: { name: EXTRACTION_TOOL_NAME, arguments: '{"walls": [{"id": "w1", "x0": 1' } }] },
      finish_reason: "length",
    };
    expect(() => readToolArgs(truncated)).toThrow(expect.objectContaining({ code: "output_truncated" }));
    expect(() => readToolArgs({ message: { content: "" }, finish_reason: "length" })).toThrow(
      expect.objectContaining({ code: "output_truncated" }),
    );
    expect(() => readToolArgs({ message: { content: [{ type: "text", text: "..." }], stop_reason: "max_tokens" } })).toThrow(
      expect.objectContaining({ code: "output_truncated" }),
    );
  });

  it("throws invalid_output on broken JSON without truncation", () => {
    const res = { message: { tool_calls: [{ function: { name: EXTRACTION_TOOL_NAME, arguments: "{nope" } }] }, finish_reason: "tool_calls" };
    expect(() => readToolArgs(res)).toThrow(expect.objectContaining({ code: "invalid_output" }));
  });
});

describe("toExtractError", () => {
  const code = (e: unknown) => toExtractError(e).code;

  it("maps the Puter error envelopes", () => {
    expect(code({ success: false, error: { code: "insufficient_funds", message: "No usage left for request.", status: 402 } })).toBe(
      "insufficient_funds",
    );
    expect(code({ success: false, error: { code: "whatever" }, status: 402 })).toBe("insufficient_funds");
    expect(toExtractError({ success: false, error: { code: "insufficient_funds" } }).status).toBe(402);
    expect(code({ success: false, error: { code: "too_many_requests", message: "slow down" } })).toBe("rate_limited");
    expect(code({ success: false, error: { code: "upstream_rate_limited", status: 429 } })).toBe("rate_limited");
    expect(code({ status: 429, message: "Too Many Requests" })).toBe("rate_limited");
    expect(code({ error: { code: "auth_canceled", message: "Authentication canceled" } })).toBe("auth_canceled");
    expect(code({ status: 401, message: "Unauthorized" })).toBe("unauthorized");
    expect(code({ success: false, error: { code: "token_auth_failed" } })).toBe("unauthorized");
    expect(
      code({ success: false, error: { code: "bad_request", message: "Model gpt-x does not support image input", status: 400 } }),
    ).toBe("model_unsupported");
    expect(code({ success: false, error: { code: "bad_request", message: "Model not found: foo" } })).toBe("model_unsupported");
    expect(code({ success: false, error: { code: "upstream_timeout", status: 504 } })).toBe("upstream");
    expect(code({ success: false, error: { code: "internal_error", status: 500 } })).toBe("upstream");
    expect(code({ success: false, error: { code: "moderation_flagged", message: "flagged" } })).toBe("unknown");
  });

  it("maps network failures", () => {
    class XMLHttpRequest {
      readyState = 4;
      status = 0;
      responseText = "";
    }
    expect(code(new XMLHttpRequest())).toBe("network");
    expect(code(new TypeError("Failed to fetch"))).toBe("network");
  });

  it("keeps auth_canceled and unauthorized distinct and passes ExtractError through", () => {
    const e = new ExtractError("image_error", "x");
    expect(toExtractError(e)).toBe(e);
    expect(e).toBeInstanceOf(Error);
    expect(code({ error: { code: "auth_canceled" } })).not.toBe(code({ status: 401 }));
    expect(code("boom")).toBe("unknown");
    expect(code(undefined)).toBe("unknown");
  });
});

describe("validateExtraction", () => {
  const W = 1000;
  const H = 800;

  it("accepts the fixture", () => {
    const v = validateExtraction(SAMPLE_EXTRACTION, "normalized1000", W, H);
    expect(v.errors).toEqual([]);
    expect(v.data).not.toBeNull();
    expect(v.data!.walls).toHaveLength(12);
    expect(v.data!.openings).toHaveLength(7);
    expect(v.data!.rooms).toHaveLength(5);
  });

  it("rejects an opening on an unknown wall", () => {
    const d = clone(SAMPLE_EXTRACTION);
    d.openings[0].wall_id = "w99";
    const v = validateExtraction(d, "normalized1000", W, H);
    expect(v.errors.map((e) => e.code)).toEqual(["OPENING_WALL"]);
    expect(v.errors[0].ids).toEqual(["o1"]);
    expect(v.data).toBeNull();
  });

  it("rejects t1 <= t0", () => {
    const d = clone(SAMPLE_EXTRACTION);
    d.openings[1].t0 = 0.6;
    d.openings[1].t1 = 0.6;
    expect(validateExtraction(d, "normalized1000", W, H).errors.map((e) => e.code)).toEqual(["OPENING_T"]);
  });

  it("rejects fewer than 4 walls", () => {
    const d = clone(SAMPLE_EXTRACTION);
    d.walls = d.walls.slice(0, 3);
    d.openings = d.openings.filter((o) => ["w1", "w2", "w3"].includes(o.wall_id));
    expect(validateExtraction(d, "normalized1000", W, H).errors.map((e) => e.code)).toEqual(["TOO_FEW_WALLS"]);
  });

  it("rejects garbage, non-plans, duplicate ids and out-of-frame coordinates", () => {
    expect(validateExtraction("nope", "pixels", W, H).errors[0].code).toBe("SCHEMA");
    expect(validateExtraction({ rooms: [] }, "pixels", W, H).errors[0].code).toBe("SCHEMA");
    const notPlan = clone(SAMPLE_EXTRACTION);
    notPlan.image.is_floor_plan = false;
    expect(validateExtraction(notPlan, "normalized1000", W, H).errors.map((e) => e.code)).toContain("NOT_A_PLAN");
    const dup = clone(SAMPLE_EXTRACTION);
    dup.walls[1].id = "w1";
    expect(validateExtraction(dup, "normalized1000", W, H).errors.map((e) => e.code)).toContain("WALL_DUP_ID");
    const px = toPixelFrame(SAMPLE_EXTRACTION, W, H);
    px.walls[0].x1 = 1500; // beyond the 1000 px wide frame
    expect(validateExtraction(px, "pixels", W, H).errors.map((e) => e.code)).toContain("WALL_RANGE");
    // the same number is fine in a 2000 px frame
    expect(validateExtraction(px, "pixels", 2000, 1600).errors).toEqual([]);
  });

  it("warns (not errors) on diagonal walls, bad room polygons and zero-length walls, and clamps", () => {
    const d = clone(SAMPLE_EXTRACTION) as unknown as Record<string, unknown> & Extraction;
    d.walls.push({ id: "w13", x0: 100, y0: 700, x1: 250, y1: 900, thickness: 9.6, exterior: false, confidence: 0.5 });
    d.walls.push({ id: "w14", x0: 300, y0: 300, x1: 300, y1: 300, thickness: 9.6, exterior: false, confidence: 0.5 });
    d.walls[0].x1 = 1010; // slightly outside -> clamped
    d.rooms[0].polygon = [[1, 1]];
    (d.walls[1] as unknown as Record<string, unknown>).x0 = "900";
    const v = validateExtraction(d, "normalized1000", W, H);
    expect(v.errors).toEqual([]);
    expect(v.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["WALL_DIAGONAL", "WALL_ZERO", "ROOM_POLY"]));
    expect(v.data!.walls.find((w) => w.id === "w1")!.x1).toBe(1000);
    expect(v.data!.walls.find((w) => w.id === "w2")!.x0).toBe(900);
    expect(v.data!.walls.some((w) => w.id === "w14")).toBe(false);
    expect(v.data!.rooms).toHaveLength(4);
  });
});

describe("model configs, image sizing, schema and prompt", () => {
  it("has the three models of design §4 with Claude as default", () => {
    expect(EXTRACTION_MODELS.map((m) => m.id)).toEqual(["claude-sonnet-5", "gemini-2.5-pro", "gpt-5.4"]);
    expect(DEFAULT_EXTRACTION_MODEL_ID).toBe("claude-sonnet-5");
    expect(getExtractionModel().id).toBe("claude-sonnet-5");
    expect(getExtractionModel("nope").id).toBe("claude-sonnet-5");
    const claude = getExtractionModel("claude-sonnet-5");
    expect(claude).toMatchObject({ frame: "pixels", maxEdge: 1568, transport: "shorthand", supportsTools: "verified", estCostCents: 3 });
    expect(claude.maxPixels).toBeLessThanOrEqual(1_150_000);
    expect(getExtractionModel("gemini-2.5-pro")).toMatchObject({ frame: "normalized1000", maxEdge: 1024, supportsTools: "assumed" });
    expect(getExtractionModel("gpt-5.4")).toMatchObject({ frame: "pixels", maxEdge: 2048, maxShortEdge: 768 });
    for (const m of EXTRACTION_MODELS) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.estCostCents).toBeGreaterThan(0);
      expect(m.transport).toBe("shorthand");
    }
  });

  it("computeSentSize respects maxEdge, maxPixels, Claude tokens and maxShortEdge without upscaling", () => {
    const sizes = [
      { w: 1000, h: 800 },
      { w: 4000, h: 3000 },
      { w: 1920, h: 1080 },
      { w: 3000, h: 700 },
      { w: 600, h: 5000 },
      { w: 300, h: 200 },
    ];
    for (const m of EXTRACTION_MODELS) {
      for (const s of sizes) {
        const out = computeSentSize(s, m);
        expect(Math.max(out.w, out.h)).toBeLessThanOrEqual(m.maxEdge);
        expect(out.w).toBeLessThanOrEqual(s.w);
        expect(out.h).toBeLessThanOrEqual(s.h);
        if (m.maxPixels) {
          expect(out.w * out.h).toBeLessThanOrEqual(m.maxPixels);
          expect(Math.ceil(out.w / 28) * Math.ceil(out.h / 28)).toBeLessThanOrEqual(CLAUDE_MAX_VISUAL_TOKENS);
        }
        if (m.maxShortEdge) expect(Math.min(out.w, out.h)).toBeLessThanOrEqual(m.maxShortEdge);
        // aspect ratio preserved within rounding
        expect(Math.abs(out.w / out.h - s.w / s.h)).toBeLessThan(0.02 * (s.w / s.h));
      }
    }
    expect(computeSentSize({ w: 1000, h: 800 }, getExtractionModel("claude-sonnet-5"))).toEqual({ w: 1000, h: 800 });
    expect(computeSentSize({ w: 1000, h: 800 }, getExtractionModel("gpt-5.4"))).toEqual({ w: 960, h: 768 });
    expect(computeSentSize({ w: 4000, h: 3000 }, getExtractionModel("gemini-2.5-pro"))).toEqual({ w: 1024, h: 768 });
  });

  it("builds a frame-aware tool schema and prompt", () => {
    const norm = buildToolSchema("normalized1000", 1024, 819) as Record<string, any>;
    expect(norm.properties.walls.items.properties.x0.maximum).toBe(1000);
    expect(norm.properties.walls.items.properties.y1.maximum).toBe(1000);
    const px = buildToolSchema("pixels", 1568, 733) as Record<string, any>;
    expect(px.properties.walls.items.properties.x0.maximum).toBe(1568);
    expect(px.properties.walls.items.properties.y0.maximum).toBe(733);
    expect(px.properties.rooms.items.properties.polygon.items.items.maximum).toBe(1568);
    expect(px.properties.openings.items.properties.kind.enum).toEqual(["door", "window", "passage"]);
    const tools = buildExtractionTools("pixels", 1000, 800);
    expect(tools[0].function.name).toBe(EXTRACTION_TOOL_NAME);
    expect(JSON.stringify(tools)).not.toMatch(/\$ref|additionalProperties|nullable/);
    const p1 = buildExtractionPrompt("pixels", 1568, 733);
    expect(p1).toContain("1568 x 733");
    expect(p1).toContain("PIXELS");
    expect(p1).not.toContain("second and final attempt");
    const p2 = buildExtractionPrompt("normalized1000", 1024, 819, "RETRY NOTE");
    expect(p2).toContain("1000 at the right edge");
    expect(p2).toContain("NORMALIZED");
    expect(p2.endsWith("RETRY NOTE")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractFloorPlan orchestration with a fake puter.ai.chat and a fake canvas
// ---------------------------------------------------------------------------

const PNG = "data:image/png;base64,iVBORw0KGgo=";

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 1000;
  naturalHeight = 800;
  decoding = "auto";
  set src(_v: string) {
    setTimeout(() => this.onload?.(), 0);
  }
}

const fakeDocument = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: "",
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "high",
      fillRect: () => undefined,
      drawImage: () => undefined,
    }),
    toDataURL: () => PNG,
  }),
};

const toolResponse = (args: unknown) => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: EXTRACTION_TOOL_NAME, arguments: JSON.stringify(args) } }],
  },
  finish_reason: "tool_calls",
  normalized: true,
});

describe("extractFloorPlan", () => {
  beforeEach(() => {
    chatMock.mockReset();
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("document", fakeDocument);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("is not in mock mode by default", () => {
    expect(isMockMode()).toBe(false);
    vi.stubGlobal("location", { search: "?foo=1&mock=1" });
    expect(isMockMode()).toBe(true);
  });

  it("mock mode returns the fixture plan with progress steps and never calls Puter", async () => {
    vi.stubEnv("VITE_EXTRACT_MOCK", "1");
    expect(isMockMode()).toBe(true);
    vi.useFakeTimers();
    const steps: string[] = [];
    const promise = extractFloorPlan({
      sourceImage: PNG,
      imageSize: { w: 1000, h: 800 },
      onProgress: (s) => steps.push(s),
    });
    await vi.runAllTimersAsync();
    const plan = await promise;
    expect(chatMock).not.toHaveBeenCalled();
    expect(steps).toEqual([EXTRACT_STEPS.prepare, EXTRACT_STEPS.reading, EXTRACT_STEPS.build]);
    expect(plan.rooms).toHaveLength(5);
    expect(plan.source).toBe("ai");
    expect(plan.extraction!.model).toBe("claude-sonnet-5 (mock)");
  });

  it("calls the shorthand transport once and builds the plan", async () => {
    chatMock.mockResolvedValueOnce(toolResponse(toPixelFrame(SAMPLE_EXTRACTION, 1000, 800)));
    const plan = await extractFloorPlan({ sourceImage: PNG, imageSize: { w: 1000, h: 800 } });
    expect(chatMock).toHaveBeenCalledTimes(1);
    const [prompt, image, options] = chatMock.mock.calls[0];
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("1000 x 800");
    expect(image).toBe(PNG);
    expect(options).toMatchObject({ model: "claude-sonnet-5", normalize: true, max_tokens: 8000, temperature: 0 });
    expect(options.tools[0].function.name).toBe(EXTRACTION_TOOL_NAME);
    expect(plan.rooms).toHaveLength(5);
    expect(plan.openings).toHaveLength(7);
    expect(plan.extraction!.frame).toBe("pixels");
    expect(plan.scale.pxPerMeter).toBeCloseTo(80, 6);
  });

  it("retries exactly once with a firmer prompt after no_tool_call", async () => {
    chatMock
      .mockResolvedValueOnce({ message: { content: "Maaf, saya tidak bisa." }, finish_reason: "stop" })
      .mockResolvedValueOnce(toolResponse(toPixelFrame(SAMPLE_EXTRACTION, 1000, 800)));
    const steps: string[] = [];
    const plan = await extractFloorPlan({
      sourceImage: PNG,
      imageSize: { w: 1000, h: 800 },
      onProgress: (s) => steps.push(s),
    });
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(chatMock.mock.calls[1][0]).toContain("second and final attempt");
    expect(steps).toContain(EXTRACT_STEPS.retry);
    expect(plan.rooms).toHaveLength(5);
  });

  it("gives up after the second invalid answer", async () => {
    const bad = clone(SAMPLE_EXTRACTION);
    bad.openings[0].wall_id = "w99";
    chatMock.mockResolvedValue(toolResponse(bad));
    await expect(
      extractFloorPlan({ sourceImage: PNG, imageSize: { w: 1000, h: 800 }, modelId: "gemini-2.5-pro" }),
    ).rejects.toMatchObject({ code: "invalid_output" });
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(chatMock.mock.calls[1][0]).toContain("OPENING_WALL");
  });

  it("does not retry on 402 and does not retry a non-plan image", async () => {
    chatMock.mockRejectedValueOnce({ success: false, error: { code: "insufficient_funds", message: "No usage left", status: 402 } });
    await expect(extractFloorPlan({ sourceImage: PNG, imageSize: { w: 1000, h: 800 } })).rejects.toMatchObject({
      code: "insufficient_funds",
    });
    expect(chatMock).toHaveBeenCalledTimes(1);

    chatMock.mockReset();
    const notPlan = clone(SAMPLE_EXTRACTION);
    notPlan.image.is_floor_plan = false;
    chatMock.mockResolvedValue(toolResponse(notPlan));
    await expect(
      extractFloorPlan({ sourceImage: PNG, imageSize: { w: 1000, h: 800 }, modelId: "gemini-2.5-pro" }),
    ).rejects.toMatchObject({ code: "invalid_output" });
    expect(chatMock).toHaveBeenCalledTimes(1);
  });
});

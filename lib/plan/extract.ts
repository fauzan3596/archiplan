// Floor-plan extraction: source image -> puter.ai.chat (tool call) -> raw
// Extraction -> FloorPlan (metres). This is the ONLY module that reads raw LLM
// output. Everything except prepareImageForModel / loadImageSize /
// extractFloorPlan is pure and runs in Node (vitest).
//
// Frames. The model answers in the frame of the image it SAW:
//   - "normalized1000": x, y in 0..1000 per axis of the sent image (Gemini's
//     native convention); converted with x * W / 1000, y * H / 1000.
//   - "pixels": absolute pixels of the sent image (Claude and GPT work best
//     with these; Claude explicitly does badly with 0..1000).
// RULE: the returned frame is the frame AFTER the provider's own resize. We
// therefore never let a provider resize: every config caps the sent image to
// what that provider accepts untouched (see EXTRACTION_MODELS), so "sent px"
// == "px the model saw". Sent px -> natural px is `imageSize.w / sentSize.w`.
//
// puter.js is imported dynamically inside the browser-only functions so this
// module (and its tests) never load the SDK in Node; the SDK is already part
// of the app bundle, so the dynamic import adds no network round trip.

import {
  assignRoomNames,
  centroid as geoCentroid,
  length as geoLength,
  pointInPolygon as geoPointInPolygon,
  polygonizeRooms,
  simplifyCollinear,
  snapAndMerge,
  type GeoRoom,
  type GeoWall,
  type Pt,
  type RoomLabel,
} from "./geometry";
import {
  northOffsetFromExtraction,
  pointInPolygon,
  polygonCentroid,
} from "./convert";
import {
  AXIS_TOLERANCE_DEG,
  createDefaultSun,
  DEFAULT_MATERIALS,
  DEFAULT_RAB_INPUTS,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  defaultOpeningVertical,
  DOOR_WIDTH_PRIOR,
  MAX_WALL_THICKNESS,
  MIN_WALL_THICKNESS,
  newId,
  ROOM_TYPE_LABELS,
  roomTypeFromExtraction,
} from "./defaults";
import { normalizePlan } from "./validate";
import sampleExtractionJson from "./fixtures/sample-extraction.json";

// =============================================================================
// 1. Model table
// =============================================================================

export type ExtractionTransport = "shorthand" | "messages";

export interface ExtractionModelConfig {
  /** exact Puter model id */
  id: string;
  label: string;
  frame: ExtractionFrame;
  /** long-edge cap of the sent image (px) */
  maxEdge: number;
  /** w * h cap of the sent image (px²) */
  maxPixels?: number;
  /** short-edge cap of the sent image (px) */
  maxShortEdge?: number;
  /** "shorthand" = puter.ai.chat(prompt, dataUrl, opts); "messages" = messages array (probe only) */
  transport: ExtractionTransport;
  /** whether image + tools was verified end-to-end on Puter for this model */
  supportsTools: "verified" | "assumed";
  /** estimated USD cents per call (one image + ~2k output tokens) */
  estCostCents: number;
}

/**
 * Each entry caps the sent image where its provider would otherwise resize it,
 * so the returned coordinates are in the frame of the image we sent:
 * - Claude (standard tier): long edge <= 1568 px AND w·h <= 1.15 MP, which
 *   keeps ceil(w/28)·ceil(h/28) <= 1568 visual tokens on both tiers.
 * - Gemini: answers in normalized 0..1000, so the sent size only affects
 *   legibility/cost (768 px tiles); 1024 px long edge.
 * - OpenAI (high detail): fit within 2048 x 2048, then shortest side <= 768.
 */
export const EXTRACTION_MODELS: readonly ExtractionModelConfig[] = [
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5 (disarankan)",
    frame: "pixels",
    maxEdge: 1568,
    maxPixels: 1_150_000,
    transport: "shorthand",
    supportsTools: "verified",
    estCostCents: 3,
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    frame: "normalized1000",
    maxEdge: 1024,
    transport: "shorthand",
    supportsTools: "assumed",
    estCostCents: 2.5,
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    frame: "pixels",
    maxEdge: 2048,
    maxShortEdge: 768,
    transport: "shorthand",
    supportsTools: "assumed",
    estCostCents: 4,
  },
];

export const DEFAULT_EXTRACTION_MODEL_ID = "claude-sonnet-5";

/** Claude's visual-token budget per image (standard tier), tokens = ceil(w/28)·ceil(h/28). */
export const CLAUDE_MAX_VISUAL_TOKENS = 1568;

export const getExtractionModel = (id?: string | null): ExtractionModelConfig =>
  EXTRACTION_MODELS.find((m) => m.id === id) ??
  EXTRACTION_MODELS.find((m) => m.id === DEFAULT_EXTRACTION_MODEL_ID) ??
  EXTRACTION_MODELS[0];

/**
 * Size of the image we send for a natural size (never upscales). Pure; used by
 * prepareImageForModel and the tests.
 */
export const computeSentSize = (
  natural: PlanImageSize,
  cfg: Pick<ExtractionModelConfig, "maxEdge" | "maxPixels" | "maxShortEdge">,
): PlanImageSize => {
  const w = Math.max(1, natural.w);
  const h = Math.max(1, natural.h);
  let s = Math.min(1, cfg.maxEdge / Math.max(w, h));
  if (cfg.maxPixels) s = Math.min(s, Math.sqrt(cfg.maxPixels / (w * h)));
  if (cfg.maxShortEdge) s = Math.min(s, cfg.maxShortEdge / Math.min(w, h));

  const size = (k: number): PlanImageSize => ({
    w: Math.max(1, Math.floor(w * k + 1e-6)),
    h: Math.max(1, Math.floor(h * k + 1e-6)),
  });
  let out = size(s);
  if (cfg.maxPixels) {
    // Claude pads to 28 px patches; keep the token count inside its budget too.
    let guard = 0;
    while (
      Math.ceil(out.w / 28) * Math.ceil(out.h / 28) > CLAUDE_MAX_VISUAL_TOKENS &&
      guard++ < 200
    ) {
      s *= 0.99;
      out = size(s);
    }
  }
  return out;
};

// =============================================================================
// 2. Tool schema + prompt
// =============================================================================

export const EXTRACTION_TOOL_NAME = "submit_floorplan";

export const ROOM_KINDS = [
  "living",
  "bedroom",
  "kitchen",
  "bathroom",
  "dining",
  "garage",
  "terrace",
  "corridor",
  "service",
  "storage",
  "other",
] as const;

export type RoomKind = (typeof ROOM_KINDS)[number];

/** Typed view of a schema-conformant tool result (validated by validateExtraction). */
export interface Extraction {
  image: { width_px: number; height_px: number; is_floor_plan: boolean; north_deg?: number };
  scale: {
    method: "dimension_labels" | "overall_dimension" | "scale_bar" | "none";
    dimension_labels: { text: string; value_m: number; from: [number, number]; to: [number, number] }[];
    overall_width_m?: number;
    overall_height_m?: number;
    confidence: number;
  };
  rooms: { id: string; name: string; kind: RoomKind; polygon: [number, number][]; confidence: number }[];
  walls: { id: string; x0: number; y0: number; x1: number; y1: number; thickness: number; exterior: boolean; confidence: number }[];
  openings: { id: string; kind: "door" | "window" | "passage"; wall_id: string; t0: number; t1: number; center: [number, number]; confidence: number }[];
  notes?: string;
}

const frameMax = (frame: ExtractionFrame, w: number, h: number) =>
  frame === "normalized1000"
    ? { x: 1000, y: 1000, long: 1000 }
    : { x: Math.max(1, Math.round(w)), y: Math.max(1, Math.round(h)), long: Math.max(1, Math.round(Math.max(w, h))) };

/**
 * Tool-parameter JSON Schema in the subset OpenAI tools, Anthropic tools and
 * Gemini function declarations all accept (type/properties/required/items/
 * enum/description/minimum/maximum/minItems/maxItems/maxLength; optional ==
 * not listed in `required`). Coordinates are typed `number`.
 */
export const buildToolSchema = (frame: ExtractionFrame, w: number, h: number): object => {
  const max = frameMax(frame, w, h);
  const unitWord = frame === "normalized1000" ? "normalized 0..1000 units" : "pixels";
  const pt = {
    type: "array",
    minItems: 2,
    maxItems: 2,
    items: { type: "number", minimum: 0, maximum: max.long },
    description:
      frame === "normalized1000"
        ? "[x, y] normalized 0..1000 per axis of the image, origin top-left, x right, y down"
        : `[x, y] pixel position in the ${Math.round(w)} x ${Math.round(h)} image, origin top-left, x right, y down`,
  };
  const conf = { type: "number", minimum: 0, maximum: 1, description: "Your confidence 0..1" };
  const cx = { type: "number", minimum: 0, maximum: max.x };
  const cy = { type: "number", minimum: 0, maximum: max.y };

  return {
    type: "object",
    required: ["image", "scale", "rooms", "walls", "openings"],
    properties: {
      image: {
        type: "object",
        required: ["width_px", "height_px", "is_floor_plan"],
        properties: {
          width_px: { type: "number", description: "Echo the image width in pixels stated in the prompt" },
          height_px: { type: "number", description: "Echo the image height in pixels stated in the prompt" },
          is_floor_plan: { type: "boolean", description: "false if the image is not a 2D top-down architectural floor plan" },
          north_deg: {
            type: "number",
            minimum: 0,
            maximum: 360,
            description: "Compass north as clockwise degrees from image-up; only if a north arrow is drawn",
          },
        },
      },
      scale: {
        type: "object",
        required: ["method", "dimension_labels", "confidence"],
        properties: {
          method: { type: "string", enum: ["dimension_labels", "overall_dimension", "scale_bar", "none"] },
          dimension_labels: {
            type: "array",
            maxItems: 16,
            description: `Every printed dimension you can read, with the two points (in ${unitWord}) it measures between`,
            items: {
              type: "object",
              required: ["text", "value_m", "from", "to"],
              properties: {
                text: { type: "string", description: "Exactly as printed, e.g. '3.50', '350', '3,5 m'" },
                value_m: { type: "number", minimum: 0.2, maximum: 100, description: "The label converted to metres" },
                from: pt,
                to: pt,
              },
            },
          },
          overall_width_m: {
            type: "number",
            minimum: 2,
            maximum: 100,
            description: "Total building width (left-right) in metres if printed or summable from a dimension chain",
          },
          overall_height_m: {
            type: "number",
            minimum: 2,
            maximum: 100,
            description: "Total building depth (top-bottom) in metres if printed or summable",
          },
          confidence: conf,
        },
      },
      rooms: {
        type: "array",
        maxItems: 40,
        items: {
          type: "object",
          required: ["id", "name", "kind", "polygon", "confidence"],
          properties: {
            id: { type: "string", description: "r1, r2, ..." },
            name: { type: "string", description: "Room label exactly as printed (e.g. 'K. Tidur Utama'); empty string if unlabelled" },
            kind: { type: "string", enum: [...ROOM_KINDS] },
            polygon: { type: "array", minItems: 3, maxItems: 16, items: pt, description: "Interior outline; 4 points if rectangular" },
            confidence: conf,
          },
        },
      },
      walls: {
        type: "array",
        maxItems: 120,
        description:
          "Centerline segments, exactly horizontal or vertical unless clearly diagonal; one segment per straight wall from junction to junction",
        items: {
          type: "object",
          required: ["id", "x0", "y0", "x1", "y1", "thickness", "exterior", "confidence"],
          properties: {
            id: { type: "string", description: "w1, w2, ..." },
            x0: cx,
            y0: cy,
            x1: cx,
            y1: cy,
            thickness: {
              type: "number",
              minimum: 0,
              maximum: Math.max(8, Math.round(max.long * 0.08)),
              description: `Wall thickness in ${unitWord}`,
            },
            exterior: { type: "boolean" },
            confidence: conf,
          },
        },
      },
      openings: {
        type: "array",
        maxItems: 80,
        items: {
          type: "object",
          required: ["id", "kind", "wall_id", "t0", "t1", "center", "confidence"],
          properties: {
            id: { type: "string", description: "o1, o2, ..." },
            kind: { type: "string", enum: ["door", "window", "passage"] },
            wall_id: { type: "string", description: "id of the wall this opening is cut into" },
            t0: { type: "number", minimum: 0, maximum: 1, description: "Start along the wall: 0 = (x0,y0), 1 = (x1,y1)" },
            t1: { type: "number", minimum: 0, maximum: 1, description: "End along the wall; t1 > t0" },
            center: pt,
            confidence: conf,
          },
        },
      },
      notes: {
        type: "string",
        maxLength: 400,
        description: "Anything ambiguous: illegible labels, diagonal walls, stairs, columns",
      },
    },
  };
};

export const buildExtractionTools = (frame: ExtractionFrame, w: number, h: number) => [
  {
    type: "function",
    function: {
      name: EXTRACTION_TOOL_NAME,
      description: "Submit the vectorized floor plan (walls, rooms, openings, dimension labels). Call exactly once with the complete result.",
      parameters: buildToolSchema(frame, w, h),
    },
  },
];

/**
 * Prompt stating the exact frame and W x H. `retryNote` (second attempt only)
 * is appended as a firmer instruction.
 */
export const buildExtractionPrompt = (
  frame: ExtractionFrame,
  w: number,
  h: number,
  retryNote?: string,
): string => {
  const W = Math.round(w);
  const H = Math.round(h);
  const coords =
    frame === "normalized1000"
      ? `Coordinates are NORMALIZED numbers: x = 0 at the left edge .. 1000 at the right edge, y = 0 at the top edge .. 1000 at the bottom edge (each axis normalized independently). Wall thickness is in the same 0..1000 units measured along the long side of the image.`
      : `Coordinates are absolute PIXELS of this ${W} x ${H} image exactly as you see it: x = 0 at the left edge .. ${W} at the right edge, y = 0 at the top edge .. ${H} at the bottom edge. Wall thickness is in pixels too.`;
  const lines = [
    "You convert a 2D architectural floor plan image into vector geometry.",
    `The image is ${W} x ${H} pixels. ${coords}`,
    "Assume Manhattan geometry: every wall is exactly horizontal (y0 == y1) or vertical (x0 == x1) unless it is clearly diagonal.",
    "Labels are often Indonesian (K. Tidur / KT = bedroom, KM / WC = bathroom, R. Tamu = living, R. Keluarga = family, R. Makan = dining, Dapur = kitchen, Teras, Carport / Garasi, Gudang, Cuci / Jemur = service). Copy labels exactly as printed.",
    "Work in this order:",
    "1. Read every room label and every printed dimension label (text exactly as printed, value converted to metres, plus the two points it measures between).",
    "2. Trace the exterior outline as walls, then every interior partition. One wall = one straight centerline segment from junction to junction. Do not split a wall at a door or window. Give its thickness.",
    "3. For every door, window and open passage: the wall id it sits in, its extent t0..t1 along that wall (0 = x0,y0; 1 = x1,y1) and its center point.",
    "4. For every room: its interior outline polygon (4 points if rectangular), its label exactly as printed, and its kind.",
    "5. If a north arrow is drawn, north_deg = compass north as clockwise degrees from image-up.",
    "6. A confidence 0..1 per element. Be exhaustive: a missing wall is worse than an extra low-confidence one.",
    `Respond only by calling ${EXTRACTION_TOOL_NAME}.`,
  ];
  if (retryNote) lines.push("", retryNote);
  return lines.join("\n");
};

// =============================================================================
// 3. Errors
// =============================================================================

export type ExtractErrorCode =
  | "insufficient_funds"
  | "rate_limited"
  | "unauthorized"
  | "auth_canceled"
  | "model_unsupported"
  | "no_tool_call"
  | "invalid_output"
  | "output_truncated"
  | "image_error"
  | "network"
  | "upstream"
  | "unknown";

export class ExtractError extends Error {
  readonly code: ExtractErrorCode;
  readonly status?: number;

  constructor(
    code: ExtractErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ExtractError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

/** Codes that trigger the single automatic retry with a firmer prompt. */
export const RETRYABLE_EXTRACT_CODES: readonly ExtractErrorCode[] = [
  "no_tool_call",
  "invalid_output",
  "output_truncated",
];

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const isXhrLike = (e: unknown): boolean => {
  if (typeof XMLHttpRequest !== "undefined" && e instanceof XMLHttpRequest) return true;
  if (!isRec(e)) return false;
  const name = (e as { constructor?: { name?: unknown } }).constructor?.name;
  if (name === "XMLHttpRequest") return true;
  return typeof e.readyState === "number" && "responseText" in e && !("success" in e);
};

const firstString = (...vals: unknown[]): string | undefined =>
  vals.find((v): v is string => typeof v === "string" && v.length > 0);

const firstNumber = (...vals: unknown[]): number | undefined =>
  vals.find((v): v is number => typeof v === "number" && Number.isFinite(v));

/**
 * Maps whatever puter.ai.chat rejected with to an ExtractError. The SDK
 * rejects with plain objects, not Errors:
 *   { success: false, error: { code, message, status? } }   driver envelope
 *   { status: 401, message: "Unauthorized" }                 token failure
 *   { error: { code: "auth_canceled", message } }            sign-in cancelled
 *   XMLHttpRequest                                           network failure
 */
export const toExtractError = (e: unknown): ExtractError => {
  if (e instanceof ExtractError) return e;
  if (isXhrLike(e)) return new ExtractError("network", "Koneksi ke Puter gagal", { cause: e });

  const rec: Rec = isRec(e) ? e : {};
  const inner: Rec = isRec(rec.error) ? rec.error : {};
  const meta: Rec = isRec(rec.metadata) ? rec.metadata : isRec(inner.metadata) ? inner.metadata : {};
  const code = firstString(inner.code, rec.code)?.toLowerCase();
  const status = firstNumber(rec.status, inner.status);
  const message =
    firstString(inner.message, rec.message, typeof rec.error === "string" ? rec.error : undefined) ??
    (typeof e === "string" ? e : e instanceof Error ? e.message : "Permintaan AI Puter gagal");

  if (code === "insufficient_funds" || status === 402 || meta.usage_limited === true) {
    return new ExtractError("insufficient_funds", message, { status: 402, cause: e });
  }
  if (code === "too_many_requests" || code === "upstream_rate_limited" || code === "rate_limited" || status === 429) {
    return new ExtractError("rate_limited", message, { status: 429, cause: e });
  }
  if (code === "auth_canceled") {
    return new ExtractError("auth_canceled", message, { status, cause: e });
  }
  if (status === 401 || code === "token_auth_failed" || code === "unauthorized" || /^unauthori[sz]ed$/i.test(message)) {
    return new ExtractError("unauthorized", message, { status: 401, cause: e });
  }
  if (
    /does not support (image|vision)|not support(ed)? .*image|model not found|unknown model/i.test(message) ||
    code === "model_not_found" ||
    (code === "forbidden" && /subscri/i.test(message))
  ) {
    return new ExtractError("model_unsupported", message, { status, cause: e });
  }
  if ((code && code.startsWith("upstream_")) || code === "internal_error" || (status !== undefined && status >= 500)) {
    return new ExtractError("upstream", message, { status, cause: e });
  }
  if (
    (e instanceof Error || typeof e === "string") &&
    /network|failed to fetch|load failed|xmlhttprequest|econn|etimedout|timeout/i.test(message)
  ) {
    return new ExtractError("network", message, { cause: e });
  }
  return new ExtractError("unknown", message, { status, cause: e });
};

// =============================================================================
// 4. Reading the tool call back
// =============================================================================

/** First fenced ```json block, else the outermost {...} of the text. */
const jsonTextOf = (text: string): string | null => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  return start >= 0 && end > start ? fenced.slice(start, end + 1) : null;
};

/**
 * Tool arguments from a chat response, in order: normalized
 * `message.tool_calls[0].function.arguments` (JSON string) -> native Anthropic
 * `message.content[].tool_use.input` -> fenced / bare JSON in the text.
 * Throws ExtractError `output_truncated` (finish_reason "length" or native
 * stop_reason "max_tokens" without parseable output), `invalid_output`
 * (unparseable JSON) or `no_tool_call`.
 */
export const readToolArgs = (res: unknown): unknown => {
  const r: Rec = isRec(res) ? res : {};
  const msg: Rec = isRec(r.message) ? r.message : {};
  const truncated =
    r.finish_reason === "length" ||
    msg.finish_reason === "length" ||
    msg.stop_reason === "max_tokens" ||
    r.stop_reason === "max_tokens";

  const parse = (value: unknown, where: string): unknown => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch (e) {
      throw new ExtractError(
        truncated ? "output_truncated" : "invalid_output",
        truncated
          ? "Keluaran AI terpotong (batas token tercapai)"
          : `Keluaran AI bukan JSON yang valid (${where})`,
        { cause: e },
      );
    }
  };

  // 1. normalized OpenAI shape
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const calls = msg.tool_calls.filter(isRec);
    const call =
      calls.find((c) => isRec(c.function) && c.function.name === EXTRACTION_TOOL_NAME) ?? calls[0];
    const fn = call && isRec(call.function) ? call.function : null;
    if (fn && fn.arguments != null && fn.arguments !== "") return parse(fn.arguments, "tool_calls");
  }

  // 2. native Anthropic content blocks
  const blocks = Array.isArray(msg.content) ? msg.content.filter(isRec) : [];
  const toolUse =
    blocks.find((b) => b.type === "tool_use" && b.name === EXTRACTION_TOOL_NAME) ??
    blocks.find((b) => b.type === "tool_use");
  if (toolUse && toolUse.input != null) return parse(toolUse.input, "tool_use.input");

  // 3. JSON written as text (fenced or bare)
  const text =
    typeof msg.content === "string"
      ? msg.content
      : blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n");
  const json = text ? jsonTextOf(text) : null;
  if (json) return parse(json, "teks");

  if (truncated) {
    throw new ExtractError("output_truncated", "Keluaran AI terpotong sebelum memanggil alat ekstraksi");
  }
  throw new ExtractError("no_tool_call", "AI tidak memanggil alat ekstraksi");
};

// =============================================================================
// 5. Stage-1 validation (errors -> one retry; warnings -> editor issues)
// =============================================================================

export interface ExtractionIssue {
  code: string;
  severity: "error" | "warn";
  message: string;
  /** raw extraction ids (w1, o1, r1, ...) */
  ids?: string[];
}

export interface ExtractionValidation {
  errors: ExtractionIssue[];
  warnings: ExtractionIssue[];
  /** sanitized copy (coordinates clamped to the frame); null when errors exist */
  data: Extraction | null;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Structural checks in the model's frame. Errors (retry): SCHEMA, NOT_A_PLAN,
 * TOO_FEW_WALLS (< 4), WALL_RANGE, WALL_DUP_ID, OPENING_WALL (unknown
 * wall_id), OPENING_T (needs 0 <= t0 < t1 <= 1). Warnings: WALL_ZERO (dropped),
 * WALL_SHORT, WALL_DIAGONAL, OPENING_WIDTH, ROOM_POLY (label dropped),
 * ROOM_OVERLAP.
 */
export const validateExtraction = (
  raw: unknown,
  frame: ExtractionFrame,
  w: number,
  h: number,
): ExtractionValidation => {
  const errors: ExtractionIssue[] = [];
  const warnings: ExtractionIssue[] = [];
  const max = frameMax(frame, w, h);
  const tolX = max.x * 0.03;
  const tolY = max.y * 0.03;
  const unit = max.long / 1000; // 1 "normalized unit" of the long axis in frame units

  if (!isRec(raw) || !Array.isArray(raw.walls)) {
    return {
      errors: [{ code: "SCHEMA", severity: "error", message: "Output must be an object with walls[], rooms[], openings[]" }],
      warnings,
      data: null,
    };
  }

  const image: Rec = isRec(raw.image) ? raw.image : {};
  if (image.is_floor_plan === false) {
    errors.push({ code: "NOT_A_PLAN", severity: "error", message: "The image was judged not to be a 2D floor plan" });
  }

  const inX = (v: number) => v >= -tolX && v <= max.x + tolX;
  const inY = (v: number) => v >= -tolY && v <= max.y + tolY;
  const cxv = (v: number) => clampNum(v, 0, max.x);
  const cyv = (v: number) => clampNum(v, 0, max.y);
  const point = (p: unknown): [number, number] | null => {
    if (!Array.isArray(p) || p.length < 2) return null;
    const x = num(p[0]);
    const y = num(p[1]);
    if (x === null || y === null || !inX(x) || !inY(y)) return null;
    return [cxv(x), cyv(y)];
  };

  // --- walls ---------------------------------------------------------------
  const walls: Extraction["walls"] = [];
  const wallIds = new Set<string>();
  raw.walls.forEach((item, i) => {
    const wr: Rec = isRec(item) ? item : {};
    const id = firstString(wr.id) ?? `w${i + 1}`;
    if (wallIds.has(id)) {
      errors.push({ code: "WALL_DUP_ID", severity: "error", message: `Duplicate wall id '${id}'`, ids: [id] });
      return;
    }
    wallIds.add(id);
    const x0 = num(wr.x0);
    const y0 = num(wr.y0);
    const x1 = num(wr.x1);
    const y1 = num(wr.y1);
    if (x0 === null || y0 === null || x1 === null || y1 === null || !inX(x0) || !inX(x1) || !inY(y0) || !inY(y1)) {
      errors.push({
        code: "WALL_RANGE",
        severity: "error",
        message: `Wall '${id}' coordinates must be numbers within 0..${max.x} (x) and 0..${max.y} (y)`,
        ids: [id],
      });
      return;
    }
    const wall = {
      id,
      x0: cxv(x0),
      y0: cyv(y0),
      x1: cxv(x1),
      y1: cyv(y1),
      thickness: Math.max(0, num(wr.thickness) ?? 0),
      exterior: wr.exterior === true,
      confidence: clampNum(num(wr.confidence) ?? 0.5, 0, 1),
    };
    const len = Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0);
    if (len < unit) {
      warnings.push({ code: "WALL_ZERO", severity: "warn", message: "Dinding dengan panjang nol diabaikan.", ids: [id] });
      return;
    }
    if (len < 20 * unit) {
      warnings.push({ code: "WALL_SHORT", severity: "warn", message: "Dinding sangat pendek (< 2% gambar); mungkin noise.", ids: [id] });
    }
    const ang = (Math.atan2(Math.abs(wall.y1 - wall.y0), Math.abs(wall.x1 - wall.x0)) * 180) / Math.PI;
    if (ang > AXIS_TOLERANCE_DEG && ang < 90 - AXIS_TOLERANCE_DEG) {
      warnings.push({
        code: "WALL_DIAGONAL",
        severity: "warn",
        message: `Dinding miring ${ang.toFixed(0)}°; pastikan memang diagonal.`,
        ids: [id],
      });
    }
    walls.push(wall);
  });
  const liveWallIds = new Set(walls.map((wl) => wl.id));
  if (walls.length < 4) {
    errors.push({
      code: "TOO_FEW_WALLS",
      severity: "error",
      message: `Only ${walls.length} usable walls; a closed plan needs at least 4`,
    });
  }

  // --- openings --------------------------------------------------------------
  const openings: Extraction["openings"] = [];
  const rawOpenings = Array.isArray(raw.openings) ? raw.openings : [];
  if (!Array.isArray(raw.openings)) {
    warnings.push({ code: "SCHEMA", severity: "warn", message: "Daftar bukaan (pintu/jendela) tidak ada pada keluaran AI." });
  }
  rawOpenings.forEach((item, i) => {
    const orec: Rec = isRec(item) ? item : {};
    const id = firstString(orec.id) ?? `o${i + 1}`;
    const wallId = firstString(orec.wall_id) ?? "";
    const t0 = num(orec.t0);
    const t1 = num(orec.t1);
    if (!wallIds.has(wallId)) {
      errors.push({ code: "OPENING_WALL", severity: "error", message: `Opening '${id}' references unknown wall '${wallId}'`, ids: [id] });
      return;
    }
    if (t0 === null || t1 === null || !(t0 >= 0 && t1 <= 1 && t1 > t0)) {
      errors.push({ code: "OPENING_T", severity: "error", message: `Opening '${id}' needs 0 <= t0 < t1 <= 1`, ids: [id] });
      return;
    }
    const wall = walls.find((wl) => wl.id === wallId);
    if (!wall || !liveWallIds.has(wallId)) return; // host wall dropped (zero length)
    const kindRaw = firstString(orec.kind)?.toLowerCase();
    const kind: "door" | "window" | "passage" =
      kindRaw === "door" || kindRaw === "window" ? kindRaw : "passage";
    const tc = (t0 + t1) / 2;
    const center =
      point(orec.center) ??
      ([wall.x0 + (wall.x1 - wall.x0) * tc, wall.y0 + (wall.y1 - wall.y0) * tc] as [number, number]);
    const units = ((t1 - t0) * Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0)) / unit;
    if (units < 15 || units > 350) {
      warnings.push({
        code: "OPENING_WIDTH",
        severity: "warn",
        message: `Lebar bukaan ${(units / 10).toFixed(1)}% dari gambar; tidak wajar.`,
        ids: [id],
      });
    }
    openings.push({ id, kind, wall_id: wallId, t0, t1, center, confidence: clampNum(num(orec.confidence) ?? 0.5, 0, 1) });
  });

  // --- rooms -----------------------------------------------------------------
  const rooms: Extraction["rooms"] = [];
  const rawRooms = Array.isArray(raw.rooms) ? raw.rooms : [];
  rawRooms.forEach((item, i) => {
    const rr: Rec = isRec(item) ? item : {};
    const id = firstString(rr.id) ?? `r${i + 1}`;
    const polygon = Array.isArray(rr.polygon)
      ? rr.polygon.map(point).filter((p): p is [number, number] => p !== null)
      : [];
    if (polygon.length < 3) {
      warnings.push({ code: "ROOM_POLY", severity: "warn", message: "Poligon label ruangan tidak valid; label diabaikan.", ids: [id] });
      return;
    }
    const kindRaw = firstString(rr.kind)?.toLowerCase() ?? "other";
    const kind = ((ROOM_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : "other") as RoomKind;
    rooms.push({
      id,
      name: typeof rr.name === "string" ? rr.name.trim() : "",
      kind,
      polygon,
      confidence: clampNum(num(rr.confidence) ?? 0.5, 0, 1),
    });
  });
  const bbox = (poly: [number, number][]) => ({
    x0: Math.min(...poly.map((p) => p[0])),
    y0: Math.min(...poly.map((p) => p[1])),
    x1: Math.max(...poly.map((p) => p[0])),
    y1: Math.max(...poly.map((p) => p[1])),
  });
  for (let i = 0; i < rooms.length; i += 1) {
    for (let j = i + 1; j < rooms.length; j += 1) {
      const a = bbox(rooms[i].polygon);
      const b = bbox(rooms[j].polygon);
      const iw = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
      const ih = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
      const inter = iw * ih;
      const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
      if (union > 0 && inter / union > 0.2) {
        warnings.push({
          code: "ROOM_OVERLAP",
          severity: "warn",
          message: `Label ruangan '${rooms[i].name || rooms[i].id}' dan '${rooms[j].name || rooms[j].id}' tumpang tindih.`,
          ids: [rooms[i].id, rooms[j].id],
        });
      }
    }
  }

  // --- scale -------------------------------------------------------------------
  const scaleRec: Rec = isRec(raw.scale) ? raw.scale : {};
  const dims: Extraction["scale"]["dimension_labels"] = [];
  for (const item of Array.isArray(scaleRec.dimension_labels) ? scaleRec.dimension_labels : []) {
    if (!isRec(item)) continue;
    const value = num(item.value_m);
    const from = point(item.from);
    const to = point(item.to);
    if (value === null || value <= 0 || !from || !to) continue;
    dims.push({ text: typeof item.text === "string" ? item.text : String(value), value_m: value, from, to });
  }
  const method = scaleRec.method;
  const overallW = num(scaleRec.overall_width_m);
  const overallH = num(scaleRec.overall_height_m);
  const north = num(image.north_deg);

  const data: Extraction = {
    image: {
      width_px: num(image.width_px) ?? Math.round(w),
      height_px: num(image.height_px) ?? Math.round(h),
      is_floor_plan: image.is_floor_plan !== false,
      ...(north !== null ? { north_deg: north } : {}),
    },
    scale: {
      method:
        method === "dimension_labels" || method === "overall_dimension" || method === "scale_bar"
          ? method
          : "none",
      dimension_labels: dims,
      ...(overallW !== null && overallW > 0 ? { overall_width_m: overallW } : {}),
      ...(overallH !== null && overallH > 0 ? { overall_height_m: overallH } : {}),
      confidence: clampNum(num(scaleRec.confidence) ?? 0, 0, 1),
    },
    rooms,
    walls,
    openings,
    ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
  };

  return { errors, warnings, data: errors.length ? null : data };
};

// =============================================================================
// 6. Pure plan builder
// =============================================================================

interface RawOpeningPx {
  id: string;
  kind: "door" | "window" | "passage";
  rawWallId: string;
  center: Pt;
  /** (t1 - t0) * raw wall length, 0 when unknown */
  widthPx: number;
  confidence: number;
}

interface PlacedOpening {
  id: string;
  kind: "door" | "window" | "passage";
  wall: GeoWall;
  t0: number;
  t1: number;
  widthPx: number;
  confidence: number;
}

interface ScaleEstimate {
  mPerPx: number;
  method: PlanScaleMethod;
  confidence: number;
}

/** Frame -> sent-image pixels. Thickness uses the long-axis unit. */
const toPixelSpace = (d: Extraction, frame: ExtractionFrame, W: number, H: number) => {
  const norm = frame === "normalized1000";
  const px = (p: [number, number]): Pt =>
    norm ? { x: (p[0] / 1000) * W, y: (p[1] / 1000) * H } : { x: p[0], y: p[1] };
  const unit = norm ? Math.max(W, H) / 1000 : 1;

  const walls: GeoWall[] = d.walls.map((w) => ({
    id: w.id,
    a: px([w.x0, w.y0]),
    b: px([w.x1, w.y1]),
    thickness: w.thickness * unit,
    exterior: w.exterior,
    confidence: w.confidence,
    sources: [w.id],
  }));
  const byId = new Map(walls.map((w) => [w.id, w]));
  const labels: RoomLabel[] = d.rooms.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    polygon: r.polygon.map(px),
    confidence: r.confidence,
  }));
  const dims = d.scale.dimension_labels.map((l) => ({ valueM: l.value_m, from: px(l.from), to: px(l.to) }));
  const openings: RawOpeningPx[] = d.openings.map((o) => {
    const host = byId.get(o.wall_id);
    return {
      id: o.id,
      kind: o.kind,
      rawWallId: o.wall_id,
      center: px(o.center),
      widthPx: host ? Math.max(0, o.t1 - o.t0) * geoLength(host) : 0,
      confidence: o.confidence,
    };
  });
  return { walls, labels, dims, openings };
};

const projectClamped = (p: Pt, w: GeoWall): { t: number; dist: number } => {
  const dx = w.b.x - w.a.x;
  const dy = w.b.y - w.a.y;
  const l2 = dx * dx + dy * dy;
  const raw = l2 < 1e-12 ? 0 : ((p.x - w.a.x) * dx + (p.y - w.a.y) * dy) / l2;
  const t = Math.min(1, Math.max(0, raw));
  return { t, dist: Math.hypot(p.x - (w.a.x + t * dx), p.y - (w.a.y + t * dy)) };
};

/** t0/t1 for a `widthPx` opening centred at t, shifted to stay inside 0..1. */
const fitSpan = (t: number, widthPx: number, lenPx: number): { t0: number; t1: number } => {
  if (lenPx < 1e-9) return { t0: 0, t1: 1 };
  const span = Math.min(Math.max(widthPx, 0), lenPx) / lenPx;
  let t0 = t - span / 2;
  let t1 = t + span / 2;
  if (t0 < 0) {
    t1 -= t0;
    t0 = 0;
  }
  if (t1 > 1) {
    t0 -= t1 - 1;
    t1 = 1;
  }
  return { t0: Math.max(0, t0), t1: Math.min(1, t1) };
};

/** Map raw openings onto merged/noded walls via `sources`, re-projecting the centre. */
const reattachOpenings = (
  openings: RawOpeningPx[],
  walls: GeoWall[],
  eps: number,
): { placed: PlacedOpening[]; offWall: string[] } => {
  const placed: PlacedOpening[] = [];
  const offWall: string[] = [];
  for (const o of openings) {
    const pick = (pool: GeoWall[]) => {
      let best: { w: GeoWall; t: number; dist: number } | null = null;
      for (const w of pool) {
        if (geoLength(w) < 1e-9) continue;
        const { t, dist } = projectClamped(o.center, w);
        if (!best || dist < best.dist) best = { w, t, dist };
      }
      return best;
    };
    const lineage = walls.filter((w) => w.sources.includes(o.rawWallId));
    let best = pick(lineage);
    if (!best || best.dist > 2 * eps) best = pick(walls);
    if (!best || best.dist > 2 * eps) {
      offWall.push(o.id);
      continue;
    }
    const len = geoLength(best.w);
    const widthPx = o.widthPx > 0 ? o.widthPx : 4 * eps;
    placed.push({ id: o.id, kind: o.kind, wall: best.w, ...fitSpan(best.t, widthPx, len), widthPx: o.widthPx, confidence: o.confidence });
  }
  return { placed, offWall };
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const PLAUSIBLE_WIDTH_M: [number, number] = [3, 150];
const BBOX_PRIOR_WIDTH_M = 10;
const THICKNESS_PRIOR_M = 0.15;

/**
 * Metres per SENT pixel: dimension_labels -> overall_dimension -> door_prior
 * (0.85 m) -> thickness_prior (0.15 m) -> bbox_prior (exterior bbox width =
 * 10 m, confidence 0). A candidate that makes the building narrower than 3 m
 * or wider than 150 m falls through to the next rung.
 */
const estimateMetersPerPixel = (x: {
  dims: { valueM: number; from: Pt; to: Pt }[];
  overallWidthM?: number;
  overallHeightM?: number;
  walls: GeoWall[];
  openings: PlacedOpening[];
  sentSize: PlanImageSize;
}): ScaleEstimate => {
  const ext = x.walls.filter((w) => w.exterior);
  const pool = ext.length ? ext : x.walls;
  const xs = pool.flatMap((w) => [w.a.x, w.b.x]);
  const ys = pool.flatMap((w) => [w.a.y, w.b.y]);
  const widthPx = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  const heightPx = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  const plausible = (mPerPx: number) => {
    if (!Number.isFinite(mPerPx) || mPerPx <= 0) return false;
    const span = Math.max(widthPx, heightPx);
    if (span < 1) return true;
    const m = span * mPerPx;
    return m >= PLAUSIBLE_WIDTH_M[0] && m <= PLAUSIBLE_WIDTH_M[1];
  };

  const ratios = x.dims
    .map((l) => {
      const px = Math.hypot(l.to.x - l.from.x, l.to.y - l.from.y);
      return { r: l.valueM / px, px };
    })
    .filter((v) => v.px > 10 && Number.isFinite(v.r) && v.r > 0);
  if (ratios.length) {
    const med = median(ratios.map((v) => v.r));
    const spread = median(ratios.map((v) => Math.abs(v.r - med))) / med;
    if (plausible(med)) {
      return { mPerPx: med, method: "dimension_labels", confidence: spread < 0.1 ? 0.9 : spread < 0.25 ? 0.6 : 0.4 };
    }
  }

  if (x.overallWidthM && widthPx > 10) {
    const m = x.overallWidthM / widthPx;
    if (plausible(m)) return { mPerPx: m, method: "overall_dimension", confidence: 0.7 };
  }
  if (x.overallHeightM && heightPx > 10) {
    const m = x.overallHeightM / heightPx;
    if (plausible(m)) return { mPerPx: m, method: "overall_dimension", confidence: 0.6 };
  }

  const doors = x.openings.filter((o) => o.kind === "door" && o.widthPx > 0).map((o) => o.widthPx);
  if (doors.length) {
    const m = DOOR_WIDTH_PRIOR / median(doors);
    if (plausible(m)) return { mPerPx: m, method: "door_prior", confidence: 0.35 };
  }

  const th = pool.map((w) => w.thickness).filter((v) => v > 0);
  if (th.length) {
    const m = THICKNESS_PRIOR_M / median(th);
    if (plausible(m)) return { mPerPx: m, method: "thickness_prior", confidence: 0.2 };
  }

  const basis = widthPx >= 1 ? widthPx : Math.max(1, x.sentSize.w * 0.8);
  return { mPerPx: BBOX_PRIOR_WIDTH_M / basis, method: "bbox_prior", confidence: 0 };
};

/** Label point: the centroid when inside, else the preferred point, else the
 *  middle of the widest horizontal chord between vertex rows. */
const labelPoint = (poly: PlanPoint[], preferred?: PlanPoint | null): PlanPoint => {
  const c = polygonCentroid(poly);
  if (poly.length < 3 || pointInPolygon(c, poly)) return c;
  if (preferred && pointInPolygon(preferred, poly)) return { ...preferred };
  const ys = [...new Set(poly.map((p) => p.y))].sort((a, b) => a - b);
  let best: { x: number; y: number; w: number } | null = null;
  for (let i = 0; i + 1 < ys.length; i += 1) {
    const y = (ys[i] + ys[i + 1]) / 2;
    const cuts: number[] = [];
    for (let k = 0, j = poly.length - 1; k < poly.length; j = k, k += 1) {
      const a = poly[k];
      const b = poly[j];
      if (a.y > y !== b.y > y) cuts.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    cuts.sort((p, q) => p - q);
    for (let k = 0; k + 1 < cuts.length; k += 2) {
      const width = cuts[k + 1] - cuts[k];
      if (!best || width > best.w) best = { x: (cuts[k] + cuts[k + 1]) / 2, y, w: width };
    }
  }
  return best ? { x: best.x, y: best.y } : c;
};

const PLAN_CODE_OF: Record<string, PlanIssueCode> = {
  SCHEMA: "SCHEMA",
  WALL_ZERO: "WALL_ZERO",
  WALL_SHORT: "WALL_SHORT",
  WALL_DIAGONAL: "WALL_DIAGONAL",
  ROOM_POLY: "ROOM_POLY",
  ROOM_OVERLAP: "MISSING_WALL",
};

export interface BuildPlanParams {
  extraction: Extraction;
  /** size of the image the model saw (after our downscale) */
  sentSize: PlanImageSize;
  /** natural size of DesignItem.sourceImage */
  imageSize: PlanImageSize;
  modelId: string;
  frame: ExtractionFrame;
  /** validateExtraction warnings, surfaced as plan.extraction.issues */
  warnings?: ExtractionIssue[];
  /** metres (default DEFAULT_WALL_HEIGHT) */
  wallHeight?: number;
  /** keep the full raw extraction in plan.extraction.raw */
  keepRaw?: boolean;
}

/**
 * Pure: raw extraction -> FloorPlan in metres. toPixelSpace (sent px) ->
 * snapAndMerge (eps = max(6, 1.2% of the long edge)) -> polygonizeRooms
 * (minArea 4·eps²) -> assignRoomNames -> reattach openings -> scale ladder ->
 * metres. `pxPerMeter` is expressed in NATURAL image px. Diagonal walls are
 * kept (not polygonised) and listed in extraction.diagonalWallIds. The scale
 * is never confirmed here.
 */
export const buildPlanFromExtraction = ({
  extraction,
  sentSize,
  imageSize,
  modelId,
  frame,
  warnings = [],
  wallHeight,
  keepRaw = false,
}: BuildPlanParams): FloorPlan => {
  const sent: PlanImageSize = {
    w: sentSize.w > 0 ? sentSize.w : imageSize.w || 1000,
    h: sentSize.h > 0 ? sentSize.h : imageSize.h || 800,
  };
  const natural: PlanImageSize = {
    w: imageSize.w > 0 ? imageSize.w : sent.w,
    h: imageSize.h > 0 ? imageSize.h : sent.h,
  };
  const height = wallHeight !== undefined && Number.isFinite(wallHeight) && wallHeight > 0 ? wallHeight : DEFAULT_WALL_HEIGHT;
  const eps = Math.max(6, 0.012 * Math.max(sent.w, sent.h));

  // --- geometry in sent px -----------------------------------------------------
  const px = toPixelSpace(extraction, frame, sent.w, sent.h);
  const snapped = snapAndMerge(px.walls, { eps, angleTolDeg: AXIS_TOLERANCE_DEG });
  const axisWalls = snapped.walls;
  const nodes = axisWalls.flatMap((w) => [w.a, w.b]);
  const snapEnd = (p: Pt): Pt => {
    let best: Pt | null = null;
    let bestDist = eps;
    for (const n of nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d <= bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best ? { x: best.x, y: best.y } : { x: p.x, y: p.y };
  };
  const diagonals: GeoWall[] = snapped.diagonals.map((d) => ({ ...d, a: snapEnd(d.a), b: snapEnd(d.b) }));
  const allWalls = [...axisWalls, ...diagonals];

  const { rooms: faces, dangling } = polygonizeRooms(axisWalls, { minArea: 4 * eps * eps });
  const named = assignRoomNames(faces, px.labels);
  const { placed, offWall } = reattachOpenings(px.openings, allWalls, eps);
  const scale = estimateMetersPerPixel({
    dims: px.dims,
    overallWidthM: extraction.scale.overall_width_m,
    overallHeightM: extraction.scale.overall_height_m,
    walls: axisWalls.length ? axisWalls : allWalls,
    openings: placed,
    sentSize: sent,
  });

  // --- metres -------------------------------------------------------------------
  const k = scale.mPerPx;
  const toM = (p: Pt): PlanPoint => ({ x: p.x * k, y: p.y * k });
  const pxPerMeter = (1 / k) * (natural.w / sent.w);

  const wallIdOf = new Map<GeoWall, string>();
  const walls: PlanWall[] = allWalls.map((g) => {
    const id = newId("wall");
    wallIdOf.set(g, id);
    const thicknessM = g.thickness > 0 ? g.thickness * k : DEFAULT_WALL_THICKNESS;
    const wall: PlanWall = {
      id,
      a: toM(g.a),
      b: toM(g.b),
      thickness: Math.min(MAX_WALL_THICKNESS, Math.max(MIN_WALL_THICKNESS, thicknessM)),
      height,
      isExterior: g.exterior,
    };
    if (Number.isFinite(g.confidence)) wall.confidence = Math.min(1, Math.max(0, g.confidence));
    return wall;
  });
  const wallById = new Map(walls.map((w) => [w.id, w]));
  const rawWallToPlan = (rawId: string): string | undefined => {
    const g = allWalls.find((w) => w.sources.includes(rawId));
    return g ? wallIdOf.get(g) : undefined;
  };

  const openingIdOf = new Map<string, string>();
  const openings: PlanOpening[] = placed.flatMap((o) => {
    const wallId = wallIdOf.get(o.wall);
    const wall = wallId ? wallById.get(wallId) : undefined;
    if (!wallId || !wall) return [];
    const kind: PlanOpeningKind = o.kind === "passage" ? "opening" : o.kind;
    const id = newId("opening");
    openingIdOf.set(o.id, id);
    return [{
      id,
      wallId,
      kind,
      t0: o.t0,
      t1: o.t1,
      ...defaultOpeningVertical(kind, wall.height),
      confidence: o.confidence,
    }];
  });

  const roomIdOfLabel = new Map<string, string>();
  const rooms: PlanRoom[] = named.rooms.map((face: GeoRoom) => {
    const polygon = simplifyCollinear(face.polygon).map(toM);
    const label = px.labels
      .filter((l) => geoPointInPolygon(geoCentroid(l.polygon), face.polygon))
      .sort((a, b) => b.confidence - a.confidence)[0];
    const printed = (face.name ?? "").trim();
    const type = face.name !== null || face.kind !== null
      ? roomTypeFromExtraction(face.kind ?? "", printed)
      : undefined;
    const name = printed || (type ? ROOM_TYPE_LABELS[type] : "Ruangan");
    const id = newId("room");
    for (const l of px.labels) {
      if (geoPointInPolygon(geoCentroid(l.polygon), face.polygon)) roomIdOfLabel.set(l.id, id);
    }
    const room: PlanRoom = {
      id,
      name,
      polygon,
      anchor: labelPoint(polygon, label ? toM(geoCentroid(label.polygon)) : null),
    };
    if (type) room.type = type;
    if (label) room.confidence = label.confidence;
    return room;
  });

  // --- issues (extraction-specific; the editor adds planIssues itself) -----------------
  const issues: PlanIssue[] = [];
  const mapIds = (ids?: string[]): string[] =>
    (ids ?? [])
      .map((id) => rawWallToPlan(id) ?? openingIdOf.get(id) ?? roomIdOfLabel.get(id))
      .filter((id): id is string => Boolean(id));
  for (const w of warnings) {
    const code = PLAN_CODE_OF[w.code];
    if (!code || w.code === "WALL_DIAGONAL") continue; // diagonals are re-flagged below with plan ids
    const ids = mapIds(w.ids);
    issues.push(ids.length ? { code, severity: "warn", message: w.message, ids } : { code, severity: "warn", message: w.message });
  }
  const diagonalWallIds = diagonals.map((d) => wallIdOf.get(d)).filter((id): id is string => Boolean(id));
  if (diagonalWallIds.length) {
    issues.push({
      code: "WALL_DIAGONAL",
      severity: "warn",
      message: `${diagonalWallIds.length} dinding miring dipertahankan apa adanya; periksa atau luruskan.`,
      ids: diagonalWallIds,
    });
  }
  const danglingIds = dangling.map((d) => wallIdOf.get(d)).filter((id): id is string => Boolean(id));
  if (danglingIds.length) {
    issues.push({
      code: "WALL_DANGLING",
      severity: "warn",
      message: "Ada ujung dinding yang tidak bertemu dinding lain.",
      ids: [...new Set(danglingIds)],
    });
  }
  if (snapped.dropped.length) {
    issues.push({
      code: "WALL_SHORT",
      severity: "warn",
      message: `${snapped.dropped.length} dinding sangat pendek dibuang saat penyatuan.`,
    });
  }
  if (offWall.length) {
    issues.push({
      code: "OPENING_OFF_WALL",
      severity: "warn",
      message: `${offWall.length} pintu/jendela tidak menempel pada dinding mana pun dan dibuang; tambahkan manual.`,
    });
  }
  for (const m of named.multi) {
    const roomIdx = named.rooms.findIndex((r) => r.id === m.roomId);
    const roomId = roomIdx >= 0 ? rooms[roomIdx]?.id : undefined;
    issues.push({
      code: "MISSING_WALL",
      severity: "warn",
      message: `Label ${m.labels.join(" / ")} berada di satu ruangan; kemungkinan ada dinding yang hilang.`,
      ...(roomId ? { ids: [roomId] } : {}),
    });
  }
  for (const l of named.unmatched) {
    issues.push({
      code: "LABEL_ORPHAN",
      severity: "warn",
      message: `Label "${l.name || l.id}" tidak berada di dalam ruangan tertutup.`,
    });
  }
  if (rooms.length === 0) {
    issues.push({
      code: "NOT_WATERTIGHT",
      severity: "error",
      message: "Dinding hasil AI belum membentuk ruangan tertutup. Sambungkan ujung dinding lalu bangun ulang ruangan.",
    });
  }
  if (scale.method === "bbox_prior") {
    issues.push({
      code: "NO_SCALE",
      severity: "warn",
      message: "Skala tidak terbaca dari gambar; lebar bangunan diasumsikan 10 m. Kalibrasi 2 titik atau isi lebar bangunan.",
    });
  }

  const north = extraction.image.north_deg;
  const rawRooms = px.labels.map((l) => ({
    id: l.id,
    name: l.name,
    polygon: l.polygon.map(toM),
  }));
  const now = new Date().toISOString();

  const meta: PlanExtractionMeta = {
    model: modelId,
    frame,
    sentSize: { w: sent.w, h: sent.h },
    at: now,
    issues,
    diagonalWallIds,
    rawRooms,
  };
  if (keepRaw) meta.raw = extraction;

  const plan: FloorPlan = {
    version: 1,
    source: "ai",
    imageSize: { w: natural.w, h: natural.h },
    scale: {
      pxPerMeter,
      confirmed: false,
      method: scale.method,
      confidence: scale.confidence,
    },
    northOffsetDeg: typeof north === "number" && Number.isFinite(north) ? northOffsetFromExtraction(north) : 0,
    walls,
    openings,
    rooms,
    materials: { ...DEFAULT_MATERIALS },
    sun: createDefaultSun(),
    rab: { ...DEFAULT_RAB_INPUTS, overrides: {} },
    extraction: meta,
    editedAt: now,
  };

  return normalizePlan(plan) ?? plan;
};

// =============================================================================
// 7. Sample plan (fixture) and mock mode
// =============================================================================

/** Natural size of the image the fixture was authored for. */
export const SAMPLE_IMAGE_SIZE: PlanImageSize = { w: 1000, h: 800 };

/** Hand-authored normalized1000 extraction of the SAMPLE_PLAN house. */
export const SAMPLE_EXTRACTION = sampleExtractionJson as unknown as Extraction;

const translatePlan = (plan: FloorPlan, dx: number, dy: number): FloorPlan => {
  if (dx === 0 && dy === 0) return plan;
  const t = (p: PlanPoint): PlanPoint => ({ x: p.x + dx, y: p.y + dy });
  return {
    ...plan,
    walls: plan.walls.map((w) => ({ ...w, a: t(w.a), b: t(w.b) })),
    rooms: plan.rooms.map((r) => ({ ...r, polygon: r.polygon.map(t), anchor: t(r.anchor) })),
    extraction: plan.extraction
      ? {
          ...plan.extraction,
          rawRooms: plan.extraction.rawRooms.map((r) => ({ ...r, polygon: r.polygon.map(t) })),
        }
      : plan.extraction,
  };
};

/** The fixture house built at its native 1000 x 800 frame, then placed
 *  undistorted and centred in `imageSize` (uniform scale, no stretching). */
const buildFittedSample = (imageSize: PlanImageSize, modelId: string): FloorPlan => {
  const base = buildPlanFromExtraction({
    extraction: SAMPLE_EXTRACTION,
    sentSize: SAMPLE_IMAGE_SIZE,
    imageSize: SAMPLE_IMAGE_SIZE,
    modelId,
    frame: "normalized1000",
  });
  const W = Number.isFinite(imageSize.w) && imageSize.w > 0 ? imageSize.w : SAMPLE_IMAGE_SIZE.w;
  const H = Number.isFinite(imageSize.h) && imageSize.h > 0 ? imageSize.h : SAMPLE_IMAGE_SIZE.h;
  if (W === SAMPLE_IMAGE_SIZE.w && H === SAMPLE_IMAGE_SIZE.h) return base;

  const s = Math.min(W / SAMPLE_IMAGE_SIZE.w, H / SAMPLE_IMAGE_SIZE.h);
  const ppm0 = base.scale.pxPerMeter;
  const ppm = ppm0 * s;
  const dx = (W / ppm - SAMPLE_IMAGE_SIZE.w / ppm0) / 2;
  const dy = (H / ppm - SAMPLE_IMAGE_SIZE.h / ppm0) / 2;
  const moved = translatePlan(base, dx, dy);
  return {
    ...moved,
    imageSize: { w: W, h: H },
    scale: { ...moved.scale, pxPerMeter: ppm },
  };
};

/** "Coba denah contoh": the fixture through buildPlanFromExtraction, source "sample". */
export const loadSamplePlan = (imageSize: PlanImageSize): FloorPlan => ({
  ...buildFittedSample(imageSize, "sample"),
  source: "sample",
});

/** `VITE_EXTRACT_MOCK=1` or `?mock=1`: extraction returns the fixture, no Puter call. */
export const isMockMode = (): boolean => {
  try {
    if (import.meta.env?.VITE_EXTRACT_MOCK === "1") return true;
  } catch {
    // import.meta.env unavailable (non-Vite runtime)
  }
  try {
    if (typeof location === "undefined" || typeof location.search !== "string") return false;
    return new URLSearchParams(location.search).get("mock") === "1";
  } catch {
    return false;
  }
};

// =============================================================================
// 8. Browser-only: image loading, image prep, Puter call, orchestration
// =============================================================================

export const EXTRACT_STEPS = {
  prepare: "Menyiapkan gambar",
  reading: "AI sedang membaca denah",
  retry: "Mengulang sekali dengan instruksi lebih tegas",
  build: "Menyusun denah 2D",
} as const;

export type ExtractProgress = (typeof EXTRACT_STEPS)[keyof typeof EXTRACT_STEPS];

export interface PreparedImage {
  dataUrl: string;
  width: number;
  height: number;
}

const loadImageElement = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ExtractError("image_error", "Gambar denah tidak dapat dibaca"));
    img.src = src;
  });

/** Natural pixel size of an image URL (data: or https). */
export const loadImageSize = async (src: string): Promise<PlanImageSize> => {
  const img = await loadImageElement(src);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new ExtractError("image_error", "Ukuran gambar denah tidak diketahui");
  return { w, h };
};

const MAX_IMAGE_BYTES = 4_500_000;

const dataUrlBytes = (u: string): number => {
  const b64 = u.slice(u.indexOf(",") + 1);
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
};

/**
 * Re-fetches the source (hosted URLs through fetchAsDataUrl, so the canvas is
 * never tainted), paints it on a white canvas (transparency -> white),
 * downscales per the model config and encodes PNG (JPEG q 0.92..0.6 when the
 * PNG exceeds 4.5 MB).
 */
export const prepareImageForModel = async (
  src: string,
  cfg: ExtractionModelConfig,
): Promise<PreparedImage> => {
  let dataUrl: string;
  try {
    if (src.startsWith("data:")) {
      dataUrl = src;
    } else {
      const { fetchAsDataUrl } = await import("../ai.action");
      dataUrl = await fetchAsDataUrl(src);
    }
  } catch (e) {
    // fetch() rejects with a TypeError only when the network fails; an HTTP
    // error status (e.g. a deleted hosted image) is an image problem.
    throw e instanceof TypeError
      ? new ExtractError("network", "Gambar denah tidak dapat diunduh (koneksi gagal)", { cause: e })
      : new ExtractError("image_error", "Gambar denah tidak dapat diunduh", { cause: e });
  }

  const img = await loadImageElement(dataUrl);
  const natural = { w: img.naturalWidth, h: img.naturalHeight };
  if (!natural.w || !natural.h) throw new ExtractError("image_error", "Ukuran gambar denah tidak diketahui");
  const size = computeSentSize(natural, cfg);

  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ExtractError("image_error", "Canvas tidak tersedia di peramban ini");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size.w, size.h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, size.w, size.h);

  let out = canvas.toDataURL("image/png");
  if (dataUrlBytes(out) > MAX_IMAGE_BYTES) {
    for (const q of [0.92, 0.85, 0.75, 0.6]) {
      out = canvas.toDataURL("image/jpeg", q);
      if (dataUrlBytes(out) <= MAX_IMAGE_BYTES) break;
    }
  }
  return { dataUrl: out, width: size.w, height: size.h };
};

type ChatFn = (...args: unknown[]) => Promise<unknown>;

const loadChat = async (): Promise<ChatFn> => {
  const mod = await import("@heyputer/puter.js");
  const puter = mod.default as unknown as { ai: { chat: ChatFn } };
  return puter.ai.chat.bind(puter.ai) as ChatFn;
};

/**
 * One Puter call. Shorthand (default): the SDK wraps the image as
 * {image_url:{url}} and sets vision:true; it forwards only model,
 * temperature, max_tokens, tools and normalize from these options.
 */
export const callExtractionModel = async (
  cfg: ExtractionModelConfig,
  prompt: string,
  img: PreparedImage,
): Promise<unknown> => {
  const chat = await loadChat();
  const options = {
    model: cfg.id,
    tools: buildExtractionTools(cfg.frame, img.width, img.height),
    normalize: true,
    max_tokens: 8000,
    temperature: 0,
  };
  try {
    if (cfg.transport === "messages") {
      return await chat(
        [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: img.dataUrl } },
              { type: "text", text: prompt },
            ],
          },
        ],
        options,
      );
    }
    return await chat(prompt, img.dataUrl, options);
  } catch (e) {
    throw toExtractError(e);
  }
};

const buildRetryNote = (err: ExtractError, validationErrors: ExtractionIssue[]): string => {
  const lines = [
    `IMPORTANT - second and final attempt. Your previous reply was rejected (${err.code}: ${err.message}).`,
    `You MUST respond with exactly one ${EXTRACTION_TOOL_NAME} tool call containing the COMPLETE extraction (all walls, rooms, openings). No prose.`,
    "Keep every room polygon to at most 12 points and every wall id unique; every opening wall_id must be one of your wall ids and 0 <= t0 < t1 <= 1.",
  ];
  if (err.code === "output_truncated") {
    lines.push("Your previous output was cut off: be concise (short ids, no notes, integers where possible).");
  }
  validationErrors.slice(0, 12).forEach((e, i) => {
    lines.push(`${i + 1}. [${e.code}] ${e.message}${e.ids?.length ? ` (ids: ${e.ids.join(", ")})` : ""}`);
  });
  return lines.join("\n");
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ExtractFloorPlanParams {
  sourceImage: string;
  /** natural size of sourceImage */
  imageSize: PlanImageSize;
  modelId?: string;
  onProgress?: (step: ExtractProgress) => void;
  keepRaw?: boolean;
  /** force the fixture path (e.g. the /visualizer/demo project); defaults to isMockMode() */
  mock?: boolean;
}

/**
 * Browser only. At most two Puter calls (one automatic retry with a firmer
 * prompt on no_tool_call | invalid_output | output_truncated). Throws
 * ExtractError. Mock mode returns the fixture-built plan without calling Puter.
 */
export const extractFloorPlan = async ({
  sourceImage,
  imageSize,
  modelId,
  onProgress,
  keepRaw = false,
  mock = isMockMode(),
}: ExtractFloorPlanParams): Promise<FloorPlan> => {
  const cfg = getExtractionModel(modelId);
  const report = (step: ExtractProgress) => {
    try {
      onProgress?.(step);
    } catch (e) {
      console.error("extractFloorPlan onProgress failed:", e);
    }
  };

  if (mock) {
    report(EXTRACT_STEPS.prepare);
    await delay(400);
    report(EXTRACT_STEPS.reading);
    await delay(1500);
    report(EXTRACT_STEPS.build);
    await delay(300);
    return buildFittedSample(imageSize, `${cfg.id} (mock)`);
  }

  if (!sourceImage) throw new ExtractError("image_error", "Proyek ini tidak memiliki gambar denah");

  report(EXTRACT_STEPS.prepare);
  const img = await prepareImageForModel(sourceImage, cfg);
  const sentSize = { w: img.width, h: img.height };
  const natural = imageSize.w > 0 && imageSize.h > 0 ? imageSize : sentSize;

  let retryNote: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    report(attempt === 0 ? EXTRACT_STEPS.reading : EXTRACT_STEPS.retry);
    const res = await callExtractionModel(cfg, buildExtractionPrompt(cfg.frame, img.width, img.height, retryNote), img);
    let validationErrors: ExtractionIssue[] = [];
    try {
      const raw = readToolArgs(res);
      const v = validateExtraction(raw, cfg.frame, img.width, img.height);
      if (!v.data) {
        validationErrors = v.errors;
        const notPlan = v.errors.some((e) => e.code === "NOT_A_PLAN");
        const err = new ExtractError(
          "invalid_output",
          notPlan
            ? "AI menilai gambar ini bukan denah 2D"
            : `Hasil AI tidak lolos validasi: ${v.errors.slice(0, 3).map((e) => e.message).join("; ")}`,
          { cause: v.errors },
        );
        if (notPlan) throw Object.assign(err, { final: true });
        throw err;
      }
      report(EXTRACT_STEPS.build);
      return buildPlanFromExtraction({
        extraction: v.data,
        sentSize,
        imageSize: natural,
        modelId: cfg.id,
        frame: cfg.frame,
        warnings: v.warnings,
        keepRaw,
      });
    } catch (e) {
      const err = toExtractError(e);
      const final = (e as { final?: boolean }).final === true;
      if (final || attempt >= 1 || !RETRYABLE_EXTRACT_CODES.includes(err.code)) throw err;
      retryNote = buildRetryNote(err, validationErrors);
    }
  }
  throw new ExtractError("unknown", "Ekstraksi gagal");
};

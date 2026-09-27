// Owner-run probe for the floor-plan extraction models on Puter.
//
// Sends ONE real image to each model with the exact tool schema and prompt of
// lib/plan/extract.ts and reports what came back, so the model table
// (frame, tool support, cost) can be verified before users pay for it.
// It is NOT wired into any npm script, test or CI job: run it by hand only.
// Every call spends Puter credit (~2.5-4 US cents per model and transport).
//
// Usage:  node scripts/probe-vision.mjs <image.png> [modelId...] [--transport=shorthand|messages|both]
//         (default models: every entry of EXTRACTION_MODELS; default transport: both)
// Auth:   PUTER_AUTH_TOKEN, or the token saved by `npm run deploy:login`
//         (same discovery as scripts/deploy.mjs).
// Output: per model/transport: normalized?, finish_reason, tool_calls present,
//         frame guess (max coordinate <= 1000), wall/room/opening counts,
//         usage keys and latency; raw responses go to scratch/probe-<model>.json.
// Exit:   0 ok, 1 usage/setup error, 2 when Puter answers 402 (credit exhausted).
//
// Node has no canvas, so the PNG is sent as-is: use an image no larger than
// the model's cap (the script warns) or the provider may resize it and pixel
// coordinates come back in the provider's resized frame.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { runnerImport } from "vite";

const require = createRequire(import.meta.url);
const PUTER_BILLING_URL = "https://puter.com/dashboard#billing";
const OUT_DIR = "scratch";

const fail = (message, code = 1) => {
  console.error(`\n✖ ${message}`);
  process.exit(code);
};

// --- args ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = Object.fromEntries(
  argv
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v];
    }),
);
const positional = argv.filter((a) => !a.startsWith("--"));
const imagePath = positional[0];

if (!imagePath || flags.help) {
  console.log(
    "Usage: node scripts/probe-vision.mjs <image.png> [modelId...] [--transport=shorthand|messages|both]",
  );
  process.exit(imagePath ? 0 : 1);
}

const transportFlag = flags.transport ?? "both";
if (!["shorthand", "messages", "both"].includes(transportFlag)) {
  fail(`Unknown --transport '${transportFlag}'. Use shorthand, messages or both.`);
}
const transports = transportFlag === "both" ? ["shorthand", "messages"] : [transportFlag];

// --- image (PNG IHDR for dimensions) -------------------------------------------
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const readPng = (file) => {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    fail(`Cannot read ${file}: ${e.message}`);
  }
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString("ascii", 12, 16) !== "IHDR") {
    fail(`${file} is not a PNG (IHDR chunk not found). Convert it to PNG first.`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) fail(`${file}: invalid PNG dimensions ${width} x ${height}`);
  return { buf, width, height };
};

const png = readPng(imagePath);
const W = png.width;
const H = png.height;
const dataUrl = `data:image/png;base64,${png.buf.toString("base64")}`;

// --- extraction module (the real TS source, via Vite's module runner) -----------
let X;
try {
  ({ module: X } = await runnerImport(path.resolve("lib/plan/extract.ts"), {
    configFile: false,
    root: process.cwd(),
    logLevel: "error",
  }));
} catch (e) {
  fail(`Could not load lib/plan/extract.ts through Vite: ${e?.message ?? e}`);
}

const modelIds = positional.length > 1 ? positional.slice(1) : X.EXTRACTION_MODELS.map((m) => m.id);

// --- auth + SDK (same as scripts/deploy.mjs) -------------------------------------
const cliConfigPath = () => {
  const home = os.homedir();
  const name = "puter-cli-nodejs";
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, name, "Config", "config.json");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Preferences", name, "config.json");
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configHome, name, "config.json");
};

const getToken = () => {
  if (process.env.PUTER_AUTH_TOKEN) return process.env.PUTER_AUTH_TOKEN;
  try {
    const config = JSON.parse(fs.readFileSync(cliConfigPath(), "utf8"));
    return config.accounts?.[config.active || "default"]?.token ?? null;
  } catch {
    return null;
  }
};

// The SDK's Node XHR shim assumes every response has a Content-Type.
const patchHeadersContentType = () => {
  const original = Headers.prototype.get;
  Headers.prototype.get = function (name) {
    const value = original.call(this, name);
    return value === null && String(name).toLowerCase() === "content-type" ? "" : value;
  };
};

const token = getToken();
if (!token) fail("Not logged in to Puter. Set PUTER_AUTH_TOKEN or run `npm run deploy:login` first.");

patchHeadersContentType();
const { init } = require("@heyputer/puter.js/src/init.cjs");
const puter = init(token);

// --- helpers -------------------------------------------------------------------------
const safeName = (id) => id.replace(/[^a-z0-9._-]+/gi, "_");

const jsonSafe = (value) => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
};

const maxCoordinate = (args) => {
  const values = [];
  for (const w of Array.isArray(args?.walls) ? args.walls : []) values.push(w?.x0, w?.y0, w?.x1, w?.y1);
  for (const r of Array.isArray(args?.rooms) ? args.rooms : []) {
    for (const p of Array.isArray(r?.polygon) ? r.polygon : []) values.push(p?.[0], p?.[1]);
  }
  for (const o of Array.isArray(args?.openings) ? args.openings : []) values.push(o?.center?.[0], o?.center?.[1]);
  const nums = values.map(Number).filter((v) => Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
};

const frameGuess = (maxCoord) => {
  if (maxCoord === null) return "unknown (no coordinates)";
  if (maxCoord <= 1000) {
    return Math.max(W, H) > 1100 ? "normalized1000" : "ambiguous (image <= 1000 px; max coord <= 1000)";
  }
  return "pixels";
};

const summarize = (res, cfg) => {
  const msg = res?.message ?? {};
  const summary = {
    normalized: res?.normalized === true,
    finish_reason: res?.finish_reason ?? null,
    stop_reason: msg?.stop_reason ?? null,
    tool_calls: Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0,
    native_tool_use: Array.isArray(msg?.content) && msg.content.some((b) => b?.type === "tool_use"),
    usage_keys: Object.keys(res?.usage ?? {}),
    usage: res?.usage ?? null,
    read_error: null,
    expected_frame: cfg.frame,
    max_coordinate: null,
    frame_guess: null,
    counts: null,
    validation: null,
    plan: null,
  };

  let args = null;
  try {
    args = X.readToolArgs(res);
  } catch (e) {
    summary.read_error = `${e?.code ?? "error"}: ${e?.message ?? e}`;
    return summary;
  }

  summary.max_coordinate = maxCoordinate(args);
  summary.frame_guess = frameGuess(summary.max_coordinate);
  summary.counts = {
    walls: Array.isArray(args?.walls) ? args.walls.length : 0,
    rooms: Array.isArray(args?.rooms) ? args.rooms.length : 0,
    openings: Array.isArray(args?.openings) ? args.openings.length : 0,
    dimension_labels: Array.isArray(args?.scale?.dimension_labels) ? args.scale.dimension_labels.length : 0,
  };

  const v = X.validateExtraction(args, cfg.frame, W, H);
  summary.validation = {
    errors: v.errors.map((e) => `${e.code}${e.ids?.length ? `(${e.ids.join(",")})` : ""}`),
    warnings: v.warnings.map((e) => e.code),
  };
  if (v.data) {
    const plan = X.buildPlanFromExtraction({
      extraction: v.data,
      sentSize: { w: W, h: H },
      imageSize: { w: W, h: H },
      modelId: cfg.id,
      frame: cfg.frame,
      warnings: v.warnings,
    });
    summary.plan = {
      walls: plan.walls.length,
      rooms: plan.rooms.length,
      named_rooms: plan.rooms.filter((r) => r.name && r.name !== "Ruangan").length,
      openings: plan.openings.length,
      scale: plan.scale,
      issues: plan.extraction?.issues?.map((i) => i.code) ?? [],
    };
  }
  return { ...summary, args };
};

const printSummary = (id, transport, ms, s) => {
  console.log(`\n■ ${id} · ${transport} · ${Math.round(ms)} ms`);
  console.log(`  normalized: ${s.normalized}   finish_reason: ${s.finish_reason}   stop_reason: ${s.stop_reason}`);
  console.log(`  tool_calls present: ${s.tool_calls}   native tool_use: ${s.native_tool_use}`);
  console.log(`  usage keys: ${s.usage_keys.join(", ") || "(none)"}`);
  if (s.read_error) {
    console.log(`  ✖ readToolArgs: ${s.read_error}`);
    return;
  }
  console.log(`  frame guess: ${s.frame_guess} (max coord ${s.max_coordinate}, expected ${s.expected_frame})`);
  console.log(
    `  counts: walls ${s.counts.walls}, rooms ${s.counts.rooms}, openings ${s.counts.openings}, dimension labels ${s.counts.dimension_labels}`,
  );
  console.log(
    `  validation: ${s.validation.errors.length ? `errors ${s.validation.errors.join(" ")}` : "ok"}${
      s.validation.warnings.length ? `; warnings ${s.validation.warnings.join(" ")}` : ""
    }`,
  );
  if (s.plan) {
    console.log(
      `  plan: ${s.plan.walls} walls, ${s.plan.rooms} rooms (${s.plan.named_rooms} named), ${s.plan.openings} openings, scale ${s.plan.scale.method} ${s.plan.scale.pxPerMeter.toFixed(2)} px/m`,
    );
  }
};

// --- run -----------------------------------------------------------------------------
const perCallCents = modelIds.reduce(
  (sum, id) => sum + (X.EXTRACTION_MODELS.find((m) => m.id === id)?.estCostCents ?? 4),
  0,
);
console.log(`Image: ${imagePath} (${W} x ${H} px, ${(png.buf.length / 1024).toFixed(0)} KB)`);
console.log(`Models: ${modelIds.join(", ")}   transports: ${transports.join(", ")}`);
console.log(`Estimated spend: ~${(perCallCents * transports.length).toFixed(1)} US cents`);

fs.mkdirSync(OUT_DIR, { recursive: true });
let failures = 0;

for (const id of modelIds) {
  const known = X.EXTRACTION_MODELS.find((m) => m.id === id);
  const cfg = known ?? { id, label: id, frame: "pixels", maxEdge: 1568, transport: "shorthand", supportsTools: "assumed", estCostCents: 4 };
  if (!known) console.warn(`\n! ${id} is not in EXTRACTION_MODELS; probing with the pixel frame.`);

  const cap = X.computeSentSize({ w: W, h: H }, cfg);
  if (cap.w !== W || cap.h !== H) {
    console.warn(
      `\n! ${W} x ${H} exceeds the ${id} cap (${cap.w} x ${cap.h}); the provider may resize the image, so pixel coordinates may come back in its resized frame. Use an image of at most ${cap.w} x ${cap.h} for frame checks.`,
    );
  }

  const prompt = X.buildExtractionPrompt(cfg.frame, W, H);
  const options = {
    model: id,
    tools: X.buildExtractionTools(cfg.frame, W, H),
    normalize: true,
    max_tokens: 8000,
    temperature: 0,
  };
  const record = { model: id, image: { path: imagePath, width: W, height: H }, frame: cfg.frame, at: new Date().toISOString(), results: {} };
  const outFile = path.join(OUT_DIR, `probe-${safeName(id)}.json`);
  const save = () => fs.writeFileSync(outFile, JSON.stringify(record, null, 2));

  for (const transport of transports) {
    const started = performance.now();
    let res;
    try {
      res =
        transport === "messages"
          ? await puter.ai.chat(
              [
                {
                  role: "user",
                  content: [
                    { type: "image_url", image_url: { url: dataUrl } },
                    { type: "text", text: prompt },
                  ],
                },
              ],
              options,
            )
          : await puter.ai.chat(prompt, dataUrl, options);
    } catch (e) {
      const ms = performance.now() - started;
      const err = X.toExtractError(e);
      record.results[transport] = { ms, error: { code: err.code, status: err.status ?? null, message: err.message, raw: jsonSafe(e) } };
      save();
      if (err.code === "insufficient_funds") {
        fail(
          `Puter credit exhausted (402 insufficient_funds) while calling ${id}: ${err.message}\n  Top up at ${PUTER_BILLING_URL} and run the probe again. Partial results: ${outFile}`,
          2,
        );
      }
      failures += 1;
      console.log(`\n■ ${id} · ${transport} · ${Math.round(ms)} ms\n  ✖ ${err.code}${err.status ? ` (${err.status})` : ""}: ${err.message}`);
      continue;
    }
    const ms = performance.now() - started;
    const summary = summarize(res, cfg);
    printSummary(id, transport, ms, summary);
    const { args, ...rest } = summary;
    record.results[transport] = { ms, summary: rest, args: args ?? null, response: jsonSafe(res) };
    save();
  }
  console.log(`  → ${outFile}`);
}

console.log(failures ? `\nDone with ${failures} failed call(s).` : "\nDone.");
process.exit(0);

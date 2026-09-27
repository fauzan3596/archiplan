// Procedural, same-origin CanvasTextures for the material catalog in
// lib/plan/materials.ts. Every pattern is painted from a PRNG seeded with the
// material id into a plain RGB raster by small pure helpers; only
// createMaterialTexture touches the DOM (one canvas + putImageData). No
// network requests, no files in public/, and GLTFExporter can re-encode the
// canvases without tainting.
//
// Texture space: one texture repeat = def.tileSize metres (repeat is set to
// 1 / tileSize because ShapeGeometry / ExtrudeGeometry UVs are raw metres).
// Every pattern is periodic with period = size px on both axes: noise
// lattices wrap, grout / gaps / mortar straddle the edges, and a plank or
// brick that crosses an edge is the same object on both sides, so the repeat
// boundary is invisible.
//
//   tile     one tile per repeat (tileSize = tile edge): mottled face with a
//            subtle tone offset and clouding, flecks (denser on polished,
//            low-roughness tiles such as granite), soft bevel, 5 mm grout
//            band in accentColor.
//   planks   4 strips per repeat (strip length = tileSize, width tileSize / 4),
//            per-strip tone jitter, wavy grain streaks and fibre, end joints
//            staggered 0 / 1/2 / 1/4 / 3/4 (jittered), dark 1 mm gaps.
//   plaster  low-contrast fbm mottling between baseColor and accentColor.
//   brick    running bond, ~6 cm courses (5 cm brick + 1 cm mortar), brick
//            length = tileSize / round(tileSize / 0.25), mortar in accentColor,
//            per-brick tone / warmth jitter, surface noise and pits.
//
// MANUAL VISUAL CHECK (canvas APIs are unavailable under vitest / node):
//   1. `npm run dev`, open the app in the browser and run in the devtools
//      console:
//        const { createMaterialTexture } = await import("/components/three/textures.ts");
//        const { MATERIALS } = await import("/lib/plan/materials.ts");
//        document.body.innerHTML = "";
//        for (const def of MATERIALS) {
//          const url = createMaterialTexture(def).image.toDataURL();
//          const el = document.createElement("div");
//          el.title = def.id;
//          el.style.cssText = `display:inline-block;width:384px;height:384px;margin:8px;background:url(${url}) 0 0/128px 128px repeat`;
//          document.body.append(el);
//        }
//      Expect 8 visibly distinct swatches, each a 3x3 repeat with no seam
//      other than the pattern's own grout / joints / mortar, and identical
//      pixels after a reload (deterministic per material id).
//   2. Open a project -> "Walkthrough 3D": a keramik_putih tile is about half
//      a door width (40 cm), bata_ekspos courses are ~6 cm, plaster shows no
//      obvious repeat at 1 m, switching materials in the side panel updates
//      floors / walls.
//   3. Export the .glb and open it in a glTF viewer: textures are embedded.
//   The pure part (renderMaterialPixels) can also be run under node to dump
//   PNGs or compare edge columns/rows for seams.

import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";

export type Rgb = readonly [number, number, number];
export type Random = () => number;
/** Scalar field sampler, periodic with period 1 in both u and v. */
export type Sampler = (u: number, v: number) => number;
export type Painter = (def: MaterialDef, size: number, rand: Random) => Raster;

export interface Raster {
  size: number;
  /** RGB triples, row-major from the top-left, sRGB 0..255 (unclamped) */
  data: Float32Array;
}

export const DEFAULT_TEXTURE_SIZE = 512;
const MIN_TEXTURE_SIZE = 16;
const MAX_TEXTURE_SIZE = 2048;

// ----------------------------------------------------------------- numbers

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

const frac = (x: number): number => x - Math.floor(x);

/** Positive modulo: result in [0, period). */
export const wrap = (x: number, period: number): number => {
  const m = x % period;
  return m < 0 ? m + period : m;
};

/** Distance from p to the nearest multiple of period (0 on a boundary). */
export const edgeDistance = (p: number, period: number): number => {
  const m = wrap(p, period);
  return Math.min(m, period - m);
};

/** Anti-aliased coverage of a band of half-width `halfWidth` at pixel-centre distance `d`. */
export const bandCoverage = (d: number, halfWidth: number): number =>
  clamp01(halfWidth - d + 0.5);

/** Darkening factor for a soft bevel of width `bevel` just outside a band. */
const bevelShade = (
  d: number,
  halfWidth: number,
  bevel: number,
  depth: number,
): number => {
  const e = clamp01(1 - (d - halfWidth) / bevel);
  return 1 - depth * e * e;
};

const safeTileSize = (def: MaterialDef): number =>
  Number.isFinite(def.tileSize) && def.tileSize > 0 ? def.tileSize : 1;

const normaliseSize = (size: number): number =>
  Number.isFinite(size)
    ? Math.min(MAX_TEXTURE_SIZE, Math.max(MIN_TEXTURE_SIZE, Math.round(size)))
    : DEFAULT_TEXTURE_SIZE;

// ------------------------------------------------------------------ random

/** 32-bit FNV-1a hash, used to seed the PRNG from a material id. */
export const hashString = (text: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** mulberry32 PRNG: deterministic floats in [0, 1). */
export const mulberry32 = (seed: number): Random => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ------------------------------------------------------------------ colour

/** "#rgb" / "#rrggbb" -> [r, g, b]; anything else -> mid grey. */
export const parseHexColor = (hex: string): Rgb => {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return [128, 128, 128];
  const digits =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : match[1];
  const n = parseInt(digits, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

const scaleRgb = (c: Rgb, f: number): Rgb => [c[0] * f, c[1] * f, c[2] * f];

// ------------------------------------------------------------------ raster

export const createRaster = (size: number): Raster => ({
  size,
  data: new Float32Array(size * size * 3),
});

const setPixel = (
  raster: Raster,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
): void => {
  const i = (y * raster.size + x) * 3;
  raster.data[i] = r;
  raster.data[i + 1] = g;
  raster.data[i + 2] = b;
};

/** Clamped, opaque RGBA bytes ready for ImageData. */
export const rasterToRgba = (raster: Raster): Uint8ClampedArray => {
  const count = raster.size * raster.size;
  const out = new Uint8ClampedArray(count * 4);
  for (let p = 0; p < count; p += 1) {
    out[p * 4] = raster.data[p * 3];
    out[p * 4 + 1] = raster.data[p * 3 + 1];
    out[p * 4 + 2] = raster.data[p * 3 + 2];
    out[p * 4 + 3] = 255;
  }
  return out;
};

// ------------------------------------------------------------------- noise

/** Smooth value noise on a wrapping cellsX x cellsY lattice (period 1 in u and v). */
export const periodicNoise = (
  cellsX: number,
  cellsY: number,
  rand: Random,
): Sampler => {
  const cx = Math.max(1, Math.round(cellsX));
  const cy = Math.max(1, Math.round(cellsY));
  const lattice = new Float32Array(cx * cy);
  for (let k = 0; k < lattice.length; k += 1) lattice[k] = rand();
  return (u, v) => {
    const x = frac(u) * cx;
    const y = frac(v) * cy;
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const tx = x - xf;
    const ty = y - yf;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const x0 = xf % cx;
    const x1 = (xf + 1) % cx;
    const y0 = (yf % cy) * cx;
    const y1 = ((yf + 1) % cy) * cx;
    return lerp(
      lerp(lattice[y0 + x0], lattice[y0 + x1], sx),
      lerp(lattice[y1 + x0], lattice[y1 + x1], sx),
      sy,
    );
  };
};

/** Fractal sum of periodicNoise octaves (lattice doubles per octave), normalised to 0..1. */
export const periodicFbm = (
  cellsX: number,
  cellsY: number,
  octaves: number,
  rand: Random,
  gain = 0.5,
): Sampler => {
  const layers: { sample: Sampler; amp: number }[] = [];
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o += 1) {
    layers.push({
      sample: periodicNoise(cellsX * 2 ** o, cellsY * 2 ** o, rand),
      amp,
    });
    total += amp;
    amp *= gain;
  }
  return (u, v) => {
    let sum = 0;
    for (const layer of layers) sum += layer.sample(u, v) * layer.amp;
    return sum / total;
  };
};

/**
 * Approximate q-quantile of a sampler (97 x 97 grid; 97 is prime so the
 * probes avoid lattice points). Used to turn "cover ~x %" into a threshold.
 */
export const samplerQuantile = (sample: Sampler, q: number): number => {
  const grid = 97;
  const values = new Float32Array(grid * grid);
  for (let j = 0; j < grid; j += 1) {
    for (let i = 0; i < grid; i += 1) {
      values[j * grid + i] = sample((i + 0.5) / grid, (j + 0.5) / grid);
    }
  }
  values.sort();
  const index = Math.floor(clamp01(q) * values.length);
  return values[Math.min(values.length - 1, index)];
};

// ---------------------------------------------------------------- painters

/** One tile per repeat: grout band centred on the texture edges. */
export const paintTile: Painter = (def, size, rand) => {
  const base = parseHexColor(def.baseColor);
  const accent = parseHexColor(def.accentColor);
  const pxPerMetre = size / safeTileSize(def);
  const groutHalf = Math.max(1, pxPerMetre * 0.0025); // 5 mm joint
  const bevel = Math.max(2, pxPerMetre * 0.006);
  // polished (low-roughness) tiles read as stone: more clouding and flecks
  const polish = clamp01((0.4 - def.roughness) / 0.15);
  const tone = 1 + (rand() - 0.5) * 0.05;
  const mottle = periodicFbm(3, 3, 4, rand);
  const cloud = periodicFbm(3, 3, 5, rand);
  const warp = periodicFbm(4, 4, 2, rand);
  const fleckCells = Math.max(8, Math.round(size / 5));
  const darkFleck = periodicFbm(fleckCells, fleckCells, 2, rand, 0.7);
  const lightFleck = periodicFbm(fleckCells, fleckCells, 2, rand, 0.7);
  const sandCells = Math.max(8, Math.round(size / 3));
  const sand = periodicNoise(sandCells, sandCells, rand);
  // fleck share of the face: ~2 % on glazed ceramic, ~14 % on granite
  const speckle = polish * polish;
  const darkCut = samplerQuantile(darkFleck, 1 - (0.01 + 0.13 * speckle));
  const lightCut = samplerQuantile(lightFleck, 1 - (0.004 + 0.05 * speckle));
  const darkAmount = 0.25 + 0.45 * speckle;
  const lightAmount = 0.1 + 0.25 * speckle;
  const cloudAmount = 0.1 + 0.3 * polish;
  const fleck = scaleRgb(accent, 0.8);
  const raster = createRaster(size);

  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) / size;
    const dy = edgeDistance(y + 0.5, size);
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const d = Math.min(edgeDistance(x + 0.5, size), dy);

      // domain-warped clouding hides the lattice of the low-frequency noise
      const w = warp(u, v) - 0.5;
      const c =
        smoothstep(0.42, 0.72, cloud(u + w * 0.3, v - w * 0.3)) * cloudAmount;
      const f =
        tone *
        (1 + (mottle(u, v) - 0.5) * 0.08) *
        bevelShade(d, groutHalf, bevel, 0.1);
      const dark =
        smoothstep(darkCut, darkCut + 0.03, darkFleck(u, v)) * darkAmount;
      const light =
        smoothstep(lightCut, lightCut + 0.03, lightFleck(u, v)) * lightAmount;
      const grout = 0.92 + sand(u, v) * 0.14;
      const cov = bandCoverage(d, groutHalf);

      const r = lerp(lerp(base[0], accent[0], c) * f, fleck[0], dark);
      const g = lerp(lerp(base[1], accent[1], c) * f, fleck[1], dark);
      const b = lerp(lerp(base[2], accent[2], c) * f, fleck[2], dark);
      setPixel(
        raster,
        x,
        y,
        lerp(lerp(r, 255, light), accent[0] * grout, cov),
        lerp(lerp(g, 255, light), accent[1] * grout, cov),
        lerp(lerp(b, 255, light), accent[2] * grout, cov),
      );
    }
  }
  return raster;
};

const PLANK_ROWS = 4;
const PLANK_STAGGER = [0, 0.5, 0.25, 0.75] as const;

/** Four strips per repeat, one end joint per strip, joints staggered. */
export const paintPlanks: Painter = (def, size, rand) => {
  const base = parseHexColor(def.baseColor);
  const accent = parseHexColor(def.accentColor);
  const pxPerMetre = size / safeTileSize(def);
  const gapHalf = Math.max(0.75, pxPerMetre * 0.0006); // ~1.2 mm gap
  const bevel = Math.max(1.5, gapHalf * 2.5);
  const rowH = size / PLANK_ROWS;
  const rows = PLANK_STAGGER.map((stagger) => ({
    joint: wrap((stagger + (rand() - 0.5) * 0.1) * size, size),
    colour: scaleRgb(
      mixRgb(base, accent, rand() * 0.35),
      1 + (rand() - 0.5) * 0.18,
    ),
    streaks: 4 + rand() * 4,
    slope: (rand() - 0.5) * 0.6,
    seedU: rand(),
    seedV: rand(),
  }));
  const warp = periodicFbm(2, 3, 3, rand);
  const fibre = periodicNoise(6, Math.max(16, Math.round(size / 4)), rand);
  const gapColour = scaleRgb(accent, 0.45);
  const raster = createRaster(size);

  for (let y = 0; y < size; y += 1) {
    const r = Math.min(PLANK_ROWS - 1, Math.floor((y + 0.5) / rowH));
    const row = rows[r];
    const inRow = y + 0.5 - r * rowH;
    const rv = inRow / rowH;
    const dRow = Math.min(inRow, rowH - inRow);
    const fv = (y + 0.5) / size + row.seedV;
    for (let x = 0; x < size; x += 1) {
      // position along the strip, 0 right after its joint, size right before it
      const lx = wrap(x + 0.5 - row.joint, size);
      const lu = lx / size;
      const d = Math.min(dRow, lx, size - lx);
      // lu is scaled by a non-integer so the grain breaks at the joint
      const t =
        rv * row.streaks +
        (warp(lu * 0.61 + row.seedU, rv * 0.5 + row.seedV) - 0.5) * 3 +
        lu * row.slope;
      const ring = Math.exp(-((frac(t) - 0.5) ** 2) / 0.006);
      const fine = fibre(lu * 0.83 + row.seedU, fv) - 0.5;
      // slight end-to-end shading so both sides of a joint differ in tone
      const along = 1 + (lu - 0.5) * 0.07;
      const f =
        along *
        (1 + fine * 0.14 - ring * 0.16) *
        bevelShade(d, gapHalf, bevel, 0.18);
      const cov = bandCoverage(d, gapHalf);
      setPixel(
        raster,
        x,
        y,
        lerp(row.colour[0] * f, gapColour[0], cov),
        lerp(row.colour[1] * f, gapColour[1], cov),
        lerp(row.colour[2] * f, gapColour[2], cov),
      );
    }
  }
  return raster;
};

/** Soft, low-contrast mottling between baseColor and accentColor. */
export const paintPlaster: Painter = (def, size, rand) => {
  const base = parseHexColor(def.baseColor);
  const accent = parseHexColor(def.accentColor);
  const broad = periodicFbm(3, 3, 4, rand);
  const mid = periodicFbm(10, 10, 3, rand);
  const grainCells = Math.max(8, Math.round(size / 2));
  const grain = periodicNoise(grainCells, grainCells, rand);
  const raster = createRaster(size);

  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const m = mid(u, v) - 0.5;
      // warping the broad blotches by the mid layer hides the noise lattice
      const t = smoothstep(0.36, 0.68, broad(u + m * 0.2, v - m * 0.2)) * 0.6;
      const f = 1 + m * 0.05 + (grain(u, v) - 0.5) * 0.03;
      setPixel(
        raster,
        x,
        y,
        lerp(base[0], accent[0], t) * f,
        lerp(base[1], accent[1], t) * f,
        lerp(base[2], accent[2], t) * f,
      );
    }
  }
  return raster;
};

/** Running bond with an even number of courses so the half-brick offset wraps. */
export const paintBrick: Painter = (def, size, rand) => {
  const base = parseHexColor(def.baseColor);
  const accent = parseHexColor(def.accentColor);
  const tile = safeTileSize(def);
  const courses = Math.max(2, 2 * Math.round(tile / 0.125)); // ~6.25 cm each
  const perCourse = Math.max(1, Math.round(tile / 0.25));
  const courseH = size / courses;
  const brickL = size / perCourse;
  const pxPerMetre = size / tile;
  const mortarHalf = Math.max(1, pxPerMetre * 0.005); // 1 cm joint
  const bricks = Array.from({ length: courses * perCourse }, () => {
    const tone = 1 + (rand() - 0.5) * 0.24;
    const warmth = (rand() - 0.5) * 0.12;
    const burnt = rand() < 0.2 ? 0.78 + rand() * 0.12 : 1;
    const k = tone * burnt;
    return {
      factor: [k * (1 + warmth), k, k * (1 - warmth)] as Rgb,
      seedU: rand(),
      seedV: rand(),
    };
  });
  const surface = periodicFbm(8, 8, 4, rand);
  const fineCells = Math.max(8, Math.round(size / 3));
  const pits = periodicNoise(fineCells, fineCells, rand);
  const sand = periodicNoise(fineCells, fineCells, rand);
  const raster = createRaster(size);

  for (let y = 0; y < size; y += 1) {
    const c = Math.min(courses - 1, Math.floor((y + 0.5) / courseH));
    const by = y + 0.5 - c * courseH;
    const dy = Math.min(by, courseH - by);
    const offset = (c % 2) * brickL * 0.5;
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const lx = wrap(x + 0.5 - offset, size);
      const k = Math.min(perCourse - 1, Math.floor(lx / brickL));
      const bx = lx - k * brickL;
      const d = Math.min(dy, bx, brickL - bx);
      const brick = bricks[c * perCourse + k];
      const pit = smoothstep(0.86, 0.93, pits(u, v)) * 0.25;
      const f =
        (1 + (surface(u + brick.seedU, v + brick.seedV) - 0.5) * 0.22) *
        (1 - pit) *
        bevelShade(d, mortarHalf, mortarHalf * 1.2, 0.14);
      const m = 0.88 + sand(u, v) * 0.18;
      const cov = bandCoverage(d, mortarHalf);
      setPixel(
        raster,
        x,
        y,
        lerp(base[0] * brick.factor[0] * f, accent[0] * m, cov),
        lerp(base[1] * brick.factor[1] * f, accent[1] * m, cov),
        lerp(base[2] * brick.factor[2] * f, accent[2] * m, cov),
      );
    }
  }
  return raster;
};

const PAINTERS: Record<MaterialPattern, Painter> = {
  tile: paintTile,
  planks: paintPlanks,
  plaster: paintPlaster,
  brick: paintBrick,
};

/** Pure: paints `def` into a size x size raster, deterministic per def.id. */
export const paintMaterial = (
  def: MaterialDef,
  size = DEFAULT_TEXTURE_SIZE,
): Raster => {
  const painter = PAINTERS[def.pattern] ?? paintPlaster;
  return painter(def, normaliseSize(size), mulberry32(hashString(def.id)));
};

/** Pure: RGBA bytes of the material texture (row-major from the top-left). */
export const renderMaterialPixels = (
  def: MaterialDef,
  size = DEFAULT_TEXTURE_SIZE,
): Uint8ClampedArray => rasterToRgba(paintMaterial(def, size));

// -------------------------------------------------------------- THREE glue

/**
 * Seamless procedural texture for a catalog material. One repeat covers
 * def.tileSize metres (UVs are raw metres). Browser only (needs a canvas).
 */
export const createMaterialTexture = (
  def: MaterialDef,
  size = DEFAULT_TEXTURE_SIZE,
): CanvasTexture => {
  const px = normaliseSize(size);
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const image = ctx.createImageData(px, px);
    image.data.set(renderMaterialPixels(def, px));
    ctx.putImageData(image, 0, 0);
  } else {
    console.error(`createMaterialTexture: no 2D context for ${def.id}`);
  }

  const tile = safeTileSize(def);
  const texture = new CanvasTexture(canvas);
  texture.name = def.id;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(1 / tile, 1 / tile);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
};

// Built-in demo project for /visualizer/demo: a sample house that works
// without a Puter login, credit or network, so reviewers can try the 2D
// editor, 3D walkthrough, RAB and sun simulation immediately. Its "source
// image" is an SVG drawing generated from the same plan, so the overlay in
// the 2D editor lines up exactly.

import { SAMPLE_PLAN } from "./fixtures/sample-plan";
import { createDefaultSun } from "./defaults";
import { openingWidth, polygonArea } from "./convert";

export const DEMO_PROJECT_ID = "demo";

const extraWindow = (
  id: string,
  wallId: string,
  t0: number,
  t1: number,
): PlanOpening => ({ id, wallId, kind: "window", t0, t1, bottom: 0.9, top: 2.1 });

// SAMPLE_PLAN only has two windows; the demo adds more so every room gets
// daylight in the sun simulation and the RAB has a realistic window count.
export const createDemoPlan = (): FloorPlan => {
  const plan = structuredClone(SAMPLE_PLAN);

  plan.openings = [
    ...plan.openings,
    // w-n (10 m): Kamar Tidur 2 window centred at x = 6
    extraWindow("o-jendela-kt2", "w-n", 0.54, 0.66),
    // w-n: small Kamar Mandi window centred at x = 9
    { ...extraWindow("o-jendela-km", "w-n", 0.87, 0.93), bottom: 1.5 },
    // w-e (8 m, runs y 0 -> 8): Dapur window centred at y = 6.25
    extraWindow("o-jendela-dapur", "w-e", 0.71, 0.851),
    // w-s1 (4 m, runs x 10 -> 6): Dapur south window centred at x = 8
    extraWindow("o-jendela-dapur-s", "w-s1", 0.35, 0.65),
  ];

  return {
    ...plan,
    source: "sample",
    sun: createDefaultSun(),
    editedAt: new Date().toISOString(),
  };
};

const fmt = (n: number) => Number(n.toFixed(1));

const escapeXml = (s: string) =>
  s.replace(/[<>&"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : "&quot;",
  );

// A clean architectural-style drawing of the plan in natural image pixels.
export const planToSvg = (plan: FloorPlan): string => {
  const ppm = plan.scale.pxPerMeter;
  const { w: width, h: height } = plan.imageSize;
  const P = (p: PlanPoint) => `${fmt(p.x * ppm)},${fmt(p.y * ppm)}`;
  const parts: string[] = [];

  for (const room of plan.rooms) {
    const points = room.polygon.map(P).join(" ");
    parts.push(`<polygon points="${points}" fill="#f4f1ea" stroke="none"/>`);
  }

  for (const wall of plan.walls) {
    parts.push(
      `<line x1="${fmt(wall.a.x * ppm)}" y1="${fmt(wall.a.y * ppm)}" x2="${fmt(wall.b.x * ppm)}" y2="${fmt(wall.b.y * ppm)}" stroke="#1a1a1a" stroke-width="${fmt(wall.thickness * ppm)}" stroke-linecap="square"/>`,
    );
  }

  const wallsById = new Map(plan.walls.map((w) => [w.id, w]));

  for (const o of plan.openings) {
    const wall = wallsById.get(o.wallId);
    if (!wall) continue;

    const dx = wall.b.x - wall.a.x;
    const dy = wall.b.y - wall.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const d = { x: dx / len, y: dy / len };
    const n = { x: -d.y, y: d.x };
    const at = (t: number) => ({ x: wall.a.x + dx * t, y: wall.a.y + dy * t });
    const p0 = at(o.t0);
    const p1 = at(o.t1);
    const gap = fmt(wall.thickness * ppm + 2);

    parts.push(
      `<line x1="${fmt(p0.x * ppm)}" y1="${fmt(p0.y * ppm)}" x2="${fmt(p1.x * ppm)}" y2="${fmt(p1.y * ppm)}" stroke="#ffffff" stroke-width="${gap}"/>`,
    );

    if (o.kind === "window") {
      const off = (wall.thickness / 2) * 0.6;
      for (const s of [-1, 1]) {
        const a = { x: p0.x + n.x * off * s, y: p0.y + n.y * off * s };
        const b = { x: p1.x + n.x * off * s, y: p1.y + n.y * off * s };
        parts.push(
          `<line x1="${fmt(a.x * ppm)}" y1="${fmt(a.y * ppm)}" x2="${fmt(b.x * ppm)}" y2="${fmt(b.y * ppm)}" stroke="#1a1a1a" stroke-width="1.5"/>`,
        );
      }
    } else if (o.kind === "door") {
      // Leaf hinged at p0, drawn open 90 degrees, with its swing arc.
      const w = openingWidth(o, wall);
      const leaf = { x: p0.x + n.x * w, y: p0.y + n.y * w };
      const r = fmt(w * ppm);
      parts.push(
        `<line x1="${fmt(p0.x * ppm)}" y1="${fmt(p0.y * ppm)}" x2="${fmt(leaf.x * ppm)}" y2="${fmt(leaf.y * ppm)}" stroke="#1a1a1a" stroke-width="2"/>`,
        `<path d="M ${P(leaf)} A ${r} ${r} 0 0 0 ${P(p1)}" fill="none" stroke="#1a1a1a" stroke-width="1" stroke-dasharray="4 3"/>`,
      );
    }
  }

  for (const room of plan.rooms) {
    const x = fmt(room.anchor.x * ppm);
    const y = fmt(room.anchor.y * ppm);
    const area = polygonArea(room.polygon).toFixed(1).replace(".", ",");
    parts.push(
      `<text x="${x}" y="${y - 6}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="17" font-weight="700" fill="#1a1a1a">${escapeXml(room.name.toUpperCase())}</text>`,
      `<text x="${x}" y="${y + 16}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#555">${area} m²</text>`,
    );
  }

  // Overall dimension lines (top and left) like a printed denah.
  const xs = plan.walls.flatMap((w) => [w.a.x, w.b.x]);
  const ys = plan.walls.flatMap((w) => [w.a.y, w.b.y]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const dimY = fmt(minY * ppm - 40);
  const dimX = fmt(minX * ppm - 40);
  const label = (m: number) => `${m.toFixed(2).replace(".", ",")} m`;

  parts.push(
    `<g stroke="#1a1a1a" stroke-width="1">`,
    `<line x1="${fmt(minX * ppm)}" y1="${dimY}" x2="${fmt(maxX * ppm)}" y2="${dimY}"/>`,
    `<line x1="${fmt(minX * ppm)}" y1="${dimY - 8}" x2="${fmt(minX * ppm)}" y2="${dimY + 8}"/>`,
    `<line x1="${fmt(maxX * ppm)}" y1="${dimY - 8}" x2="${fmt(maxX * ppm)}" y2="${dimY + 8}"/>`,
    `<line x1="${dimX}" y1="${fmt(minY * ppm)}" x2="${dimX}" y2="${fmt(maxY * ppm)}"/>`,
    `<line x1="${dimX - 8}" y1="${fmt(minY * ppm)}" x2="${dimX + 8}" y2="${fmt(minY * ppm)}"/>`,
    `<line x1="${dimX - 8}" y1="${fmt(maxY * ppm)}" x2="${dimX + 8}" y2="${fmt(maxY * ppm)}"/>`,
    `</g>`,
    `<text x="${fmt(((minX + maxX) / 2) * ppm)}" y="${dimY - 10}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#1a1a1a">${label(maxX - minX)}</text>`,
    `<text x="${dimX - 12}" y="${fmt(((minY + maxY) / 2) * ppm)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#1a1a1a" transform="rotate(-90 ${dimX - 12} ${fmt(((minY + maxY) / 2) * ppm)})">${label(maxY - minY)}</text>`,
    `<text x="${width - 24}" y="${height - 24}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#888">DENAH CONTOH · ARCHIPLAN</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ffffff"/>${parts.join("")}</svg>`;
};

export const planToSvgDataUrl = (plan: FloorPlan): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(planToSvg(plan))}`;

export const createDemoProject = (): DesignItem => {
  const plan = createDemoPlan();

  return {
    id: DEMO_PROJECT_ID,
    name: "Rumah Contoh (Demo)",
    sourceImage: planToSvgDataUrl(plan),
    renderedImage: null,
    timestamp: Date.now(),
    ownerId: null,
    ownerName: "Archiplan",
    isPublic: true,
    plan,
  };
};

// Shared fixture: a 10 x 8 m single-storey house centred in a 1000 x 800 px
// image at 80 px/m (image = 12.5 x 10 m, house offset 1.25 / 1.0 m). Metres,
// x right / y down, plan-up = north. Treat as read-only (structuredClone
// before mutating). Walls are drawn the way a person or the extractor would:
// the north, east and west walls run full length, so rebuildRooms() nodes them
// at the T-junctions (12 walls -> 16 noded walls, the 12 original ids kept).
//
//   y=0   +---------------+---------------+-------+
//         |  Kamar Tidur 1 |  Kamar Tidur 2 |  K.   |
//         |  (4 x 4.5)     |  (4 x 4.5)     | Mandi |
//   y=4.5 +---------------+-------+-------+-------+
//         |  Ruang Tamu (6 x 3.5)  |  Dapur (4 x 3.5)|
//   y=8   +-----------------------+-----------------+
//         x=0            x=4     x=6     x=8     x=10
//
// Openings (7): pintu utama (exterior, south), pintu kamar mandi (from the
// dapur), 2 bedroom doors and a passage from the ruang tamu, 2 windows.
// Openings are listed in normalizeWallOpenings order (wall order, then t0) so
// normalizePlan(SAMPLE_PLAN) deep-equals SAMPLE_PLAN.

import { DEFAULT_MATERIALS, DEFAULT_RAB_INPUTS } from "../defaults";

const X0 = 1.25;
const Y0 = 1;
const EXTERIOR_THICKNESS = 0.15;
const INTERIOR_THICKNESS = 0.12;
const WALL_HEIGHT = 3;

const p = (x: number, y: number): PlanPoint => ({ x: X0 + x, y: Y0 + y });

const wall = (
  id: string,
  a: PlanPoint,
  b: PlanPoint,
  isExterior: boolean,
): PlanWall => ({
  id,
  a,
  b,
  thickness: isExterior ? EXTERIOR_THICKNESS : INTERIOR_THICKNESS,
  height: WALL_HEIGHT,
  isExterior,
});

const rect = (x0: number, y0: number, x1: number, y1: number): PlanPoint[] => [
  p(x0, y0),
  p(x1, y0),
  p(x1, y1),
  p(x0, y1),
];

export const SAMPLE_PLAN: FloorPlan = {
  version: 1,
  source: "sample",
  imageSize: { w: 1000, h: 800 },
  scale: { pxPerMeter: 80, confirmed: true, method: "manual", confidence: 1 },
  northOffsetDeg: 0,
  walls: [
    // exterior, clockwise
    wall("w-n", p(0, 0), p(10, 0), true),
    wall("w-e", p(10, 0), p(10, 8), true),
    wall("w-s1", p(10, 8), p(6, 8), true),
    wall("w-s2", p(6, 8), p(0, 8), true),
    wall("w-w", p(0, 8), p(0, 0), true),
    // partition y = 4.5 between the bedroom row and the front rooms
    wall("w-p1", p(0, 4.5), p(4, 4.5), false),
    wall("w-p2", p(4, 4.5), p(6, 4.5), false),
    wall("w-p3", p(6, 4.5), p(8, 4.5), false),
    wall("w-p4", p(8, 4.5), p(10, 4.5), false),
    // cross partitions
    wall("w-kt", p(4, 0), p(4, 4.5), false),
    wall("w-km", p(8, 0), p(8, 4.5), false),
    wall("w-dp", p(6, 4.5), p(6, 8), false),
  ],
  openings: [
    // w-n (10 m): window of Kamar Tidur 1 centred at x = 2
    { id: "o-jendela-kt1", wallId: "w-n", kind: "window", t0: 0.14, t1: 0.26, bottom: 0.9, top: 2.1 },
    // w-s2 (6 m, runs x 6 -> 0): pintu utama centred at x = 3, 0.9 m
    { id: "o-pintu-utama", wallId: "w-s2", kind: "door", t0: 0.425, t1: 0.575, bottom: 0, top: 2.1 },
    // w-w (8 m, runs y 8 -> 0): Ruang Tamu window centred at y = 6
    { id: "o-jendela-tamu", wallId: "w-w", kind: "window", t0: 0.175, t1: 0.325, bottom: 0.9, top: 2.1 },
    // w-p1 (4 m): Kamar Tidur 1 door centred at x = 3, 0.8 m
    { id: "o-pintu-kt1", wallId: "w-p1", kind: "door", t0: 0.65, t1: 0.85, bottom: 0, top: 2.1 },
    // w-p2 (2 m): Kamar Tidur 2 door centred at x = 5, 0.8 m
    { id: "o-pintu-kt2", wallId: "w-p2", kind: "door", t0: 0.3, t1: 0.7, bottom: 0, top: 2.1 },
    // w-p4 (2 m): Kamar Mandi door from the Dapur centred at x = 9, 0.7 m
    { id: "o-pintu-km", wallId: "w-p4", kind: "door", t0: 0.325, t1: 0.675, bottom: 0, top: 2.1 },
    // w-dp (3.5 m): full-height passage Ruang Tamu -> Dapur, 1.4 m
    { id: "o-lorong", wallId: "w-dp", kind: "opening", t0: 0.3, t1: 0.7, bottom: 0, top: WALL_HEIGHT },
  ],
  rooms: [
    {
      id: "r-tamu",
      name: "Ruang Tamu",
      type: "ruang_tamu",
      polygon: rect(0, 4.5, 6, 8),
      anchor: p(3, 6.25),
      floorMaterialId: "granit_abu",
    },
    {
      id: "r-kt1",
      name: "Kamar Tidur 1",
      type: "kamar_tidur",
      polygon: rect(0, 0, 4, 4.5),
      anchor: p(2, 2.25),
    },
    {
      id: "r-kt2",
      name: "Kamar Tidur 2",
      type: "kamar_tidur",
      polygon: rect(4, 0, 8, 4.5),
      anchor: p(6, 2.25),
    },
    {
      id: "r-km",
      name: "Kamar Mandi",
      type: "kamar_mandi",
      polygon: rect(8, 0, 10, 4.5),
      anchor: p(9, 2.25),
    },
    {
      id: "r-dapur",
      name: "Dapur",
      type: "dapur",
      polygon: rect(6, 4.5, 10, 8),
      anchor: p(8, 6.25),
    },
  ],
  materials: { ...DEFAULT_MATERIALS },
  sun: {
    dateISO: "2026-06-21",
    minutesOfDay: 600,
    cityId: "jakarta",
    showPath: true,
    showCompass: true,
  },
  rab: { ...DEFAULT_RAB_INPUTS, overrides: {} },
  extraction: null,
  editedAt: "2026-01-01T00:00:00.000Z",
};

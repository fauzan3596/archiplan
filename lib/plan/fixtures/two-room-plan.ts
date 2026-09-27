// Shared fixture: the sun-spec house (research sun.spec.ts), 10 x 8 m with a
// partition at x = 5, plan-up = north (northOffsetDeg 0). Metres, x right /
// y down; coordinates, wall directions and opening order are exactly the
// spec's so planToSunGeometry(TWO_ROOM_PLAN) reproduces its results
// (spec t / width / sill / height -> t0 = t - width / (2 * len), etc.).
// Treat as read-only (structuredClone before mutating).
//
//   wN (0,0)->(10,0): winN_A t 0.19..0.31 (x = 1.9..3.1, room A)
//   wE (10,0)->(10,8): winE_B t 0.425..0.575 (room B)
//   wS (10,8)->(0,8): winS_A t 0.69..0.81 (x = 3.1..1.9, room A),
//                     doorS_B t 0.205..0.295 (x = 7.95..7.05, room B)
//   wW (0,8)->(0,0):  winW_A t 0.425..0.575 (room A)
//   wMid (5,0)->(5,8): winMid t 0.425..0.575 (interior)

import { DEFAULT_MATERIALS, DEFAULT_RAB_INPUTS } from "../defaults";

export const TWO_ROOM_PLAN: FloorPlan = {
  version: 1,
  source: "manual",
  imageSize: { w: 600, h: 480 },
  scale: { pxPerMeter: 50, confirmed: true, method: "manual", confidence: 1 },
  northOffsetDeg: 0,
  walls: [
    { id: "wN", a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, thickness: 0.15, height: 3, isExterior: true },
    { id: "wE", a: { x: 10, y: 0 }, b: { x: 10, y: 8 }, thickness: 0.15, height: 3, isExterior: true },
    { id: "wS", a: { x: 10, y: 8 }, b: { x: 0, y: 8 }, thickness: 0.15, height: 3, isExterior: true },
    { id: "wW", a: { x: 0, y: 8 }, b: { x: 0, y: 0 }, thickness: 0.15, height: 3, isExterior: true },
    { id: "wMid", a: { x: 5, y: 0 }, b: { x: 5, y: 8 }, thickness: 0.15, height: 3, isExterior: false },
  ],
  openings: [
    { id: "winN_A", wallId: "wN", kind: "window", t0: 0.19, t1: 0.31, bottom: 0.9, top: 2.1 },
    { id: "winS_A", wallId: "wS", kind: "window", t0: 0.69, t1: 0.81, bottom: 0.9, top: 2.1 },
    { id: "winW_A", wallId: "wW", kind: "window", t0: 0.425, t1: 0.575, bottom: 0.9, top: 2.1 },
    { id: "winE_B", wallId: "wE", kind: "window", t0: 0.425, t1: 0.575, bottom: 0.9, top: 2.1 },
    { id: "winMid", wallId: "wMid", kind: "window", t0: 0.425, t1: 0.575, bottom: 0.9, top: 2.1 },
    { id: "doorS_B", wallId: "wS", kind: "door", t0: 0.205, t1: 0.295, bottom: 0, top: 2.1 },
  ],
  rooms: [
    {
      id: "rA",
      name: "Kamar A",
      type: "kamar_tidur",
      polygon: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 8 },
        { x: 0, y: 8 },
      ],
      anchor: { x: 2.5, y: 4 },
    },
    {
      id: "rB",
      name: "Ruang B",
      type: "ruang_keluarga",
      polygon: [
        { x: 5, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 8 },
        { x: 5, y: 8 },
      ],
      anchor: { x: 7.5, y: 4 },
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

// Known-case tests for the sun modules: vitest port of the verified research spec
// (43 assertions, tolerances kept at or below the original +/- values) plus the
// Archiplan cases (north offset sign, WIT day rollover, planToSunGeometry, sunInstant).
import * as SunCalc from "suncalc";
import { describe, expect, it } from "vitest";
import { CITIES, cityById, formatLocalTime, localToInstant, sunInstant } from "./geo";
import { lightingForAltitude, sunAngles, sunDirection, sunPathForDay } from "./sunDirection";
import { planToSunGeometry, sunlightHoursPerRoom, type FloorPlanGeometry } from "./sunlightHours";
import { TWO_ROOM_PLAN } from "../plan/fixtures/two-room-plan";

const jakarta = CITIES[0];
const JUN_21 = { year: 2026, month: 6, day: 21 };
const DEC_21 = { year: 2026, month: 12, day: 21 };

describe("timezone", () => {
  it("localToInstant 09:00 WIB", () => {
    expect(localToInstant(JUN_21, 9 * 60, "WIB").toISOString()).toBe("2026-06-21T02:00:00.000Z");
  });

  it("localToInstant 09:00 WIT", () => {
    expect(localToInstant(JUN_21, 9 * 60, "WIT").toISOString()).toBe("2026-06-21T00:00:00.000Z");
  });

  it("localToInstant 00:00 WIB rolls to prev UTC day", () => {
    expect(localToInstant(JUN_21, 0, "WIB").toISOString()).toBe("2026-06-20T17:00:00.000Z");
  });

  it("localToInstant 00:30 WIT rolls to prev UTC day", () => {
    const t = localToInstant(JUN_21, 30, "WIT");
    expect(t.toISOString()).toBe("2026-06-20T15:30:00.000Z");
    expect(t.getUTCDate()).toBe(20);
  });
});

describe("equator, equinox, solar noon -> straight up", () => {
  const noon = SunCalc.getTimes(new Date(Date.UTC(2026, 2, 20, 12)), 0, 0).solarNoon;

  it("solar noon (0,0) 2026-03-20", () => {
    expect(noon.toISOString()).toBe("2026-03-20T12:07:27.932Z");
  });

  it("noon altitude, direction and the 6 h-before position", () => {
    expect(sunAngles(noon, 0, 0).altitudeDeg).toBeCloseTo(89.96, 1);
    const d = sunDirection(noon, 0, 0, 0);
    expect(d.y).toBeCloseTo(1, 4);
    expect(Math.abs(d.x)).toBeCloseTo(0, 3);
    const east = sunAngles(new Date(noon.getTime() - 6 * 3_600_000), 0, 0);
    expect(east.azimuthDeg).toBeCloseTo(90.14, 1);
    expect(east.altitudeDeg).toBeCloseTo(0.47, 1); // horizon + refraction
  });
});

describe("Jakarta 21 Jun 2026 09:00 WIB (canonical)", () => {
  const t = localToInstant(JUN_21, 9 * 60, "WIB");

  it("azimuth 53.55 / altitude 38.16 (suncalc 2.x degrees, clockwise from north)", () => {
    const a = sunAngles(t, jakarta.lat, jakarta.lng);
    expect(a.azimuthDeg).toBeCloseTo(53.55, 1);
    expect(a.altitudeDeg).toBeCloseTo(38.16, 1);
  });

  it("dir (0.632, 0.618, -0.467)", () => {
    const d = sunDirection(t, jakarta.lat, jakarta.lng, 0);
    expect(d.x).toBeCloseTo(0.632, 2); // east, +
    expect(d.y).toBeCloseTo(0.618, 2); // up
    expect(d.z).toBeCloseTo(-0.467, 2); // north => negative
  });

  it("northOffsetDeg 90 (plan-up faces true east)", () => {
    const d90 = sunDirection(t, jakarta.lat, jakarta.lng, 90);
    expect(d90.x).toBeCloseTo(-0.467, 2);
    expect(d90.z).toBeCloseTo(-0.632, 2);
    expect(d90.x < 0 && d90.z < 0).toBe(true);
  });
});

describe("Jakarta noon: north in June, south in December", () => {
  const junNoon = localToInstant(JUN_21, 12 * 60, "WIB");
  const decNoon = localToInstant(DEC_21, 12 * 60, "WIB");

  it("June noon sun in the north", () => {
    expect(Math.sign(sunDirection(junNoon, jakarta.lat, jakarta.lng).z)).toBe(-1);
    expect(sunAngles(junNoon, jakarta.lat, jakarta.lng).altitudeDeg).toBeCloseTo(60.33, 1);
  });

  it("December noon sun in the south", () => {
    expect(Math.sign(sunDirection(decNoon, jakarta.lat, jakarta.lng).z)).toBe(1);
    expect(sunAngles(decNoon, jakarta.lat, jakarta.lng).altitudeDeg).toBeCloseTo(72.63, 1);
  });

  it("midnight sun below the horizon", () => {
    const night = sunDirection(localToInstant(JUN_21, 0, "WIB"), jakarta.lat, jakarta.lng);
    expect(Math.sign(night.y)).toBe(-1);
  });
});

describe("sun path", () => {
  const p = sunPathForDay(JUN_21, jakarta.lat, jakarta.lng, "WIB", 0, 30);

  it("sunrise 06:01 / sunset 17:47 WIB", () => {
    expect(formatLocalTime(p.sunrise, "WIB")).toBe("06:01 WIB");
    expect(formatLocalTime(p.sunset, "WIB")).toBe("17:47 WIB");
  });

  it("samples, arc and day length", () => {
    expect(p.samples.length).toBe(48);
    expect(p.arc.length).toBe(25); // sunrise + 23 samples + sunset
    expect(p.dayLengthHours).toBeCloseTo(11.76, 2);
  });

  it("arc first point is the apparent altitude at sunrise", () => {
    // sunrise is geometric -0.833 deg; getPosition() is apparent (refraction ~ +0.48 deg)
    expect(p.arc[0].altitudeDeg).toBeCloseTo(-0.35, 1);
  });
});

describe("lighting ramp", () => {
  it("sun off at night and just below the horizon, ~3 at noon", () => {
    expect(lightingForAltitude(-30).sunIntensity).toBe(0);
    expect(lightingForAltitude(-0.5).sunIntensity).toBe(0);
    expect(lightingForAltitude(70).sunIntensity).toBeCloseTo(2.95, 1);
    expect(lightingForAltitude(-20).phase).toBe("night");
  });
});

// 10 x 8 m two-room house, plan-up = north (the research spec geometry, verbatim)
const plan: FloorPlanGeometry = {
  walls: [
    { id: "wN", a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, thickness: 0.15, height: 3 },
    { id: "wE", a: { x: 10, y: 0 }, b: { x: 10, y: 8 }, thickness: 0.15, height: 3 },
    { id: "wS", a: { x: 10, y: 8 }, b: { x: 0, y: 8 }, thickness: 0.15, height: 3 },
    { id: "wW", a: { x: 0, y: 8 }, b: { x: 0, y: 0 }, thickness: 0.15, height: 3 },
    { id: "wMid", a: { x: 5, y: 0 }, b: { x: 5, y: 8 }, thickness: 0.15, height: 3 },
  ],
  rooms: [
    { id: "rA", name: "Kamar A", polygon: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 8 }, { x: 0, y: 8 }] },
    { id: "rB", name: "Ruang B", polygon: [{ x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 5, y: 8 }] },
  ],
  openings: [
    { id: "winN_A", wallId: "wN", kind: "window", t: 0.25, width: 1.2, sillHeight: 0.9, height: 1.2 },
    { id: "winS_A", wallId: "wS", kind: "window", t: 0.75, width: 1.2, sillHeight: 0.9, height: 1.2 },
    { id: "winW_A", wallId: "wW", kind: "window", t: 0.5, width: 1.2, sillHeight: 0.9, height: 1.2 },
    { id: "winE_B", wallId: "wE", kind: "window", t: 0.5, width: 1.2, sillHeight: 0.9, height: 1.2 },
    { id: "winMid", wallId: "wMid", kind: "window", t: 0.5, width: 1.2, sillHeight: 0.9, height: 1.2 },
    { id: "doorS_B", wallId: "wS", kind: "door", t: 0.25, width: 0.9, sillHeight: 0, height: 2.1 },
  ],
};

describe("sunlight hours on the two-room house", () => {
  it("21 Jun, offset 0", () => {
    const jun = sunlightHoursPerRoom(plan, JUN_21, jakarta.lat, jakarta.lng, "WIB", 0);
    expect(jun.byWindow.winN_A).toBeCloseTo(11.25, 2);
    expect(jun.byWindow.winS_A).toBe(0);
    expect(jun.byWindow.winW_A).toBeCloseTo(5.75, 2);
    expect(jun.byWindow.winE_B).toBeCloseTo(5.5, 2);
    expect(jun.byRoom.rA).toBeCloseTo(11.25, 2); // union of N + S + W
    expect(jun.skipped.map((s) => `${s.id}:${s.reason}`).join(",")).toBe("winMid:interior-wall,doorS_B:door");
    expect(jun.rooms[0].windows.find((w) => w.id === "winW_A")!.facingLabel).toBe("Barat");
    // 06:15 sample is 2.51 deg < minAltitudeDeg (3) -> first counted step is 06:30 (5.79 deg)
    expect(formatLocalTime(jun.rooms[0].first, "WIB")).toBe("06:30 WIB");
  });

  it("21 Dec swaps north and south", () => {
    const dec = sunlightHoursPerRoom(plan, DEC_21, jakarta.lat, jakarta.lng, "WIB", 0);
    expect(dec.byWindow.winS_A).toBeCloseTo(12, 2);
    expect(dec.byWindow.winN_A).toBe(0);
  });

  it("offset 90: the plan-west window faces true north", () => {
    const jun90 = sunlightHoursPerRoom(plan, JUN_21, jakarta.lat, jakarta.lng, "WIB", 90);
    expect(jun90.byWindow.winW_A).toBeCloseTo(11.25, 2);
    expect(jun90.rooms[0].windows.find((w) => w.id === "winW_A")!.facingLabel).toBe("Utara");
  });
});

describe("planToSunGeometry(TWO_ROOM_PLAN)", () => {
  const geometry = planToSunGeometry(TWO_ROOM_PLAN);
  const byId = (id: string) => geometry.openings.find((o) => o.id === id)!;

  it("maps openings to centre t, width, sill and height in metres", () => {
    const n = byId("winN_A");
    expect(n.kind).toBe("window");
    expect(n.wallId).toBe("wN");
    expect(n.t).toBeCloseTo(0.25, 6);
    expect(n.width).toBeCloseTo(1.2, 6);
    expect(n.sillHeight).toBeCloseTo(0.9, 6);
    expect(n.height).toBeCloseTo(1.2, 6);

    const w = byId("winW_A");
    expect(w.t).toBeCloseTo(0.5, 6);
    expect(w.width).toBeCloseTo(1.2, 6); // 0.15 * 8 m

    const door = byId("doorS_B");
    expect(door.kind).toBe("door");
    expect(door.t).toBeCloseTo(0.25, 6);
    expect(door.width).toBeCloseTo(0.9, 6);
    expect(door.sillHeight).toBe(0);
    expect(door.height).toBeCloseTo(2.1, 6);

    expect(geometry.walls.map((x) => x.id).sort()).toEqual(["wE", "wMid", "wN", "wS", "wW"]);
    expect(geometry.rooms.map((r) => r.id).sort()).toEqual(["rA", "rB"]);
  });

  it("treats passages as doors and excludes stale rooms", () => {
    const edited: FloorPlan = {
      ...TWO_ROOM_PLAN,
      openings: [
        ...TWO_ROOM_PLAN.openings,
        { id: "passMid", wallId: "wMid", kind: "opening", t0: 0.1, t1: 0.2, bottom: 0, top: 3 },
      ],
      rooms: [
        ...TWO_ROOM_PLAN.rooms,
        {
          id: "rOld",
          name: "Lama",
          polygon: [{ x: 20, y: 0 }, { x: 22, y: 0 }, { x: 22, y: 2 }, { x: 20, y: 2 }],
          anchor: { x: 21, y: 1 },
          stale: true,
        },
      ],
    };
    const g = planToSunGeometry(edited);
    const pass = g.openings.find((o) => o.id === "passMid")!;
    expect(pass.kind).toBe("door");
    expect(pass.height).toBeCloseTo(3, 6);
    expect(g.rooms.some((r) => r.id === "rOld")).toBe(false);
  });

  it("reproduces N 11.25 h / S 0 h on 21 Jun, swapped on 21 Dec, winMid skipped", () => {
    const north = TWO_ROOM_PLAN.northOffsetDeg;
    const jun = sunlightHoursPerRoom(geometry, JUN_21, jakarta.lat, jakarta.lng, "WIB", north, {
      stepMinutes: 15,
      minAltitudeDeg: 3,
      selfShadow: true,
    });
    expect(jun.byWindow.winN_A).toBeCloseTo(11.25, 2);
    expect(jun.byWindow.winS_A).toBe(0);
    expect(jun.skipped).toContainEqual({ id: "winMid", reason: "interior-wall" });
    expect(jun.skipped).toContainEqual({ id: "doorS_B", reason: "door" });

    const dec = sunlightHoursPerRoom(geometry, DEC_21, jakarta.lat, jakarta.lng, "WIB", north);
    expect(dec.byWindow.winS_A).toBeCloseTo(12, 2);
    expect(dec.byWindow.winN_A).toBe(0);
  });
});

describe("sunInstant", () => {
  const base: SunSettings = {
    dateISO: "2026-06-21",
    minutesOfDay: 540,
    cityId: "jakarta",
    showPath: true,
    showCompass: true,
  };

  it("builds the canonical instant from plan sun settings", () => {
    const { date, city } = sunInstant(base);
    expect(city.id).toBe("jakarta");
    expect(date.toISOString()).toBe("2026-06-21T02:00:00.000Z");
  });

  it("uses the city's zone and falls back to Jakarta for unknown ids", () => {
    expect(sunInstant({ ...base, cityId: "jayapura" }).date.toISOString()).toBe("2026-06-21T00:00:00.000Z");
    expect(sunInstant({ ...base, cityId: "atlantis" }).city).toBe(cityById("jakarta"));
  });

  it("never yields an invalid date for a cleared date input", () => {
    expect(Number.isNaN(sunInstant({ ...base, dateISO: "" }).date.getTime())).toBe(false);
  });
});

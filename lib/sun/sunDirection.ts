// lib/sun/sunDirection.ts
// Scene convention: +X = east, +Y = up, +Z = south (right-handed; plan "up" = -Z).
// suncalc 2.0.2: azimuth in DEGREES clockwise from north (0=N, 90=E, 180=S, 270=W),
// altitude in DEGREES above the horizon (refraction-corrected). Dates are UTC instants.
import * as SunCalc from "suncalc";
import { Color, MathUtils, Vector3 } from "three";
import { instantToLocalMinutes, localToInstant, type IndoZone, type LocalDay } from "./geo";

export interface SunAngles {
  azimuthDeg: number;
  altitudeDeg: number;
}

export function sunAngles(date: Date, lat: number, lng: number): SunAngles {
  const p = SunCalc.getPosition(date, lat, lng);
  return { azimuthDeg: p.azimuth, altitudeDeg: p.altitude };
}

/**
 * Unit vector FROM the scene origin TOWARD the sun, in building/scene coordinates.
 * `northOffsetDeg` = compass bearing of the plan's "up" (-Z) direction, clockwise from
 * true north. Example: plan-up points true east -> northOffsetDeg = 90.
 *   az' = azimuth - northOffset      (sun bearing measured from plan-up instead of true N)
 *   x = cos(alt) * sin(az')          (east / plan-right)
 *   y = sin(alt)                     (up)
 *   z = -cos(alt) * cos(az')         (south / plan-down; negative = toward plan-up)
 */
export function directionFromAngles(
  azimuthDeg: number,
  altitudeDeg: number,
  northOffsetDeg = 0,
  target: Vector3 = new Vector3(),
): Vector3 {
  const az = MathUtils.degToRad(azimuthDeg - northOffsetDeg);
  const alt = MathUtils.degToRad(altitudeDeg);
  const c = Math.cos(alt);
  return target.set(c * Math.sin(az), Math.sin(alt), -c * Math.cos(az));
}

export function sunDirection(
  date: Date,
  lat: number,
  lng: number,
  northOffsetDeg = 0,
  target: Vector3 = new Vector3(),
): Vector3 {
  const { azimuth, altitude } = SunCalc.getPosition(date, lat, lng);
  return directionFromAngles(azimuth, altitude, northOffsetDeg, target);
}

/**
 * Compass bearing (deg, clockwise from true N) of a horizontal direction given in
 * PLAN coordinates (x right, y DOWN like SVG). Inverse of the mapping above.
 */
export function planDirToBearing(nx: number, ny: number, northOffsetDeg = 0): number {
  const bearingInPlan = MathUtils.radToDeg(Math.atan2(nx, -ny)); // 0 = plan-up
  return ((bearingInPlan + northOffsetDeg) % 360 + 360) % 360;
}

export function bearingToLabelId(bearing: number): string {
  const names = ["Utara", "Timur Laut", "Timur", "Tenggara", "Selatan", "Barat Daya", "Barat", "Barat Laut"];
  return names[Math.round(bearing / 45) % 8];
}

// ---------------------------------------------------------------------------
// Sun path for one local day
// ---------------------------------------------------------------------------

export interface SunSample {
  date: Date;
  minutesOfDay: number;
  azimuthDeg: number;
  altitudeDeg: number;
  /** unit vector toward the sun, scene coords */
  dir: Vector3;
  aboveHorizon: boolean;
}

export interface SunPath {
  /** every `stepMinutes` from 00:00 to 23:xx local, including night samples */
  samples: SunSample[];
  /** sunrise, the above-horizon samples, sunset - ready to draw as a polyline */
  arc: SunSample[];
  sunrise: Date | null;
  sunset: Date | null;
  solarNoon: Date;
  dayLengthHours: number;
}

export function sunPathForDay(
  day: LocalDay,
  lat: number,
  lng: number,
  zone: IndoZone,
  northOffsetDeg = 0,
  stepMinutes = 30,
): SunPath {
  const sample = (date: Date): SunSample => {
    const { azimuth, altitude } = SunCalc.getPosition(date, lat, lng);
    return {
      date,
      minutesOfDay: instantToLocalMinutes(date, zone),
      azimuthDeg: azimuth,
      altitudeDeg: altitude,
      dir: directionFromAngles(azimuth, altitude, northOffsetDeg),
      aboveHorizon: altitude > 0,
    };
  };

  const samples: SunSample[] = [];
  for (let m = 0; m < 1440; m += stepMinutes) samples.push(sample(localToInstant(day, m, zone)));

  // getTimes() resolves the solar day of the instant passed; local noon is safely inside it.
  const times = SunCalc.getTimes(localToInstant(day, 720, zone), lat, lng);
  const sunrise = times.sunrise ?? null;
  const sunset = times.sunset ?? null;

  const arc: SunSample[] = [];
  if (sunrise) arc.push(sample(sunrise));
  for (const s of samples) {
    if (s.aboveHorizon && (!sunrise || s.date > sunrise) && (!sunset || s.date < sunset)) arc.push(s);
  }
  if (sunset) arc.push(sample(sunset));

  return {
    samples,
    arc,
    sunrise,
    sunset,
    solarNoon: times.solarNoon,
    dayLengthHours: sunrise && sunset ? (sunset.getTime() - sunrise.getTime()) / 3_600_000 : 0,
  };
}

/** Points for a THREE.Line / drei <Line>: arc scaled to `radius` around `center`. */
export function sunPathPoints(path: SunPath, radius: number, center = new Vector3()): Vector3[] {
  return path.arc.map((s) => s.dir.clone().multiplyScalar(radius).add(center));
}

// ---------------------------------------------------------------------------
// Lighting model (three >= r155 physically-based light units, ACES tone mapping, exposure 1)
// ---------------------------------------------------------------------------

export type DayPhase = "night" | "twilight" | "golden" | "day";

export interface SkyLighting {
  /** DirectionalLight intensity (0 when the sun is below the horizon) */
  sunIntensity: number;
  sunColor: string;
  hemiSkyColor: string;
  hemiGroundColor: string;
  hemiIntensity: number;
  ambientIntensity: number;
  phase: DayPhase;
}

interface Key {
  alt: number;
  sun: number;
  sunColor: string;
  sky: string;
  ground: string;
  hemi: number;
  ambient: number;
  phase: DayPhase;
}

// Keyframes by solar altitude. -18 = astronomical night, -6 = civil twilight boundary,
// 0 = horizon, 6 = end of golden hour (matches suncalc's `goldenHourEnd` angle).
const KEYS: readonly Key[] = [
  { alt: -18, sun: 0.0, sunColor: "#ff8a3d", sky: "#070b1a", ground: "#03040a", hemi: 0.12, ambient: 0.03, phase: "night" },
  { alt: -6, sun: 0.0, sunColor: "#ff8a3d", sky: "#223a66", ground: "#0e1015", hemi: 0.3, ambient: 0.05, phase: "twilight" },
  { alt: 0, sun: 0.5, sunColor: "#ff8a3d", sky: "#c48a6a", ground: "#35302b", hemi: 0.55, ambient: 0.08, phase: "golden" },
  { alt: 6, sun: 1.6, sunColor: "#ffb86b", sky: "#a9c6e6", ground: "#5e574d", hemi: 0.85, ambient: 0.1, phase: "golden" },
  { alt: 15, sun: 2.4, sunColor: "#ffd9a8", sky: "#93c2ec", ground: "#756d61", hemi: 1.05, ambient: 0.12, phase: "day" },
  { alt: 35, sun: 2.9, sunColor: "#fff1dc", sky: "#86c0f0", ground: "#847b6e", hemi: 1.2, ambient: 0.15, phase: "day" },
  { alt: 90, sun: 3.0, sunColor: "#fffaf2", sky: "#7fbdf3", ground: "#8a8174", hemi: 1.25, ambient: 0.15, phase: "day" },
];

const _ca = new Color();
const _cb = new Color();
function lerpHex(a: string, b: string, t: number): string {
  return "#" + _ca.set(a).lerp(_cb.set(b), t).getHexString();
}

export function lightingForAltitude(altitudeDeg: number): SkyLighting {
  const alt = MathUtils.clamp(altitudeDeg, KEYS[0].alt, KEYS[KEYS.length - 1].alt);
  let i = 0;
  while (i < KEYS.length - 2 && alt > KEYS[i + 1].alt) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const t = MathUtils.smoothstep(alt, a.alt, b.alt);
  return {
    sunIntensity: altitudeDeg <= 0 ? 0 : MathUtils.lerp(a.sun, b.sun, t),
    sunColor: lerpHex(a.sunColor, b.sunColor, t),
    hemiSkyColor: lerpHex(a.sky, b.sky, t),
    hemiGroundColor: lerpHex(a.ground, b.ground, t),
    hemiIntensity: MathUtils.lerp(a.hemi, b.hemi, t),
    ambientIntensity: MathUtils.lerp(a.ambient, b.ambient, t),
    phase: t < 0.5 ? a.phase : b.phase,
  };
}

export interface MoonLight {
  dir: Vector3;
  intensity: number;
  color: string;
  illuminatedFraction: number;
  altitudeDeg: number;
}

/** Reuse the same DirectionalLight as moonlight at night. Returns null if the moon is set. */
export function moonLight(date: Date, lat: number, lng: number, northOffsetDeg = 0): MoonLight | null {
  const m = SunCalc.getMoonPosition(date, lat, lng);
  if (m.altitude <= 0) return null;
  const { fraction } = SunCalc.getMoonIllumination(date);
  return {
    dir: directionFromAngles(m.azimuth, m.altitude, northOffsetDeg),
    intensity: 0.02 + 0.1 * fraction, // full moon ~0.12 vs sun 3.0
    color: "#9fb4ff",
    illuminatedFraction: fraction,
    altitudeDeg: m.altitude,
  };
}

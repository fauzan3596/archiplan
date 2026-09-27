// lib/sun/geo.ts
// Indonesian time zones are fixed offsets with no DST (WIB=UTC+7, WITA=UTC+8, WIT=UTC+9).
// suncalc 2.x treats every Date as a UTC instant, so we never rely on the browser's local zone.

export type IndoZone = "WIB" | "WITA" | "WIT";

export const ZONE_OFFSET_HOURS: Readonly<Record<IndoZone, number>> = {
  WIB: 7,
  WITA: 8,
  WIT: 9,
};

/** IANA names, only needed for display formatting via Intl. */
export const ZONE_IANA: Readonly<Record<IndoZone, string>> = {
  WIB: "Asia/Jakarta",
  WITA: "Asia/Makassar",
  WIT: "Asia/Jayapura",
};

export interface City {
  id: string;
  name: string;
  lat: number;
  lng: number;
  zone: IndoZone;
}

export const CITIES: readonly City[] = [
  { id: "jakarta", name: "Jakarta", lat: -6.2088, lng: 106.8456, zone: "WIB" },
  { id: "bandung", name: "Bandung", lat: -6.9175, lng: 107.6191, zone: "WIB" },
  { id: "surabaya", name: "Surabaya", lat: -7.2575, lng: 112.7521, zone: "WIB" },
  { id: "yogyakarta", name: "Yogyakarta", lat: -7.7956, lng: 110.3695, zone: "WIB" },
  { id: "medan", name: "Medan", lat: 3.5952, lng: 98.6722, zone: "WIB" },
  { id: "makassar", name: "Makassar", lat: -5.1477, lng: 119.4327, zone: "WITA" },
  { id: "denpasar", name: "Denpasar", lat: -8.6705, lng: 115.2126, zone: "WITA" },
  { id: "jayapura", name: "Jayapura", lat: -2.5337, lng: 140.7181, zone: "WIT" },
];

export function cityById(id: string): City {
  return CITIES.find((c) => c.id === id) ?? CITIES[0];
}

/** Calendar day in local wall-clock terms. `month` is 1-12. */
export interface LocalDay {
  year: number;
  month: number;
  day: number;
}

/** Parse the value of an `<input type="date">` ("YYYY-MM-DD"). */
export function parseDateInput(value: string): LocalDay {
  const [y, m, d] = value.split("-").map(Number);
  return { year: y, month: m, day: d };
}

export function formatDateInput(day: LocalDay): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${day.year}-${p(day.month)}-${p(day.day)}`;
}

/**
 * Local wall clock (e.g. 09:00 WIB on 21 Jun 2026) -> absolute instant.
 * Date.UTC normalises negative / overflowing minutes, so `minutesOfDay - offset*60`
 * correctly rolls into the previous UTC day for early-morning local times.
 * Independent of the browser's time zone.
 */
export function localToInstant(day: LocalDay, minutesOfDay: number, zone: IndoZone): Date {
  return new Date(
    Date.UTC(day.year, day.month - 1, day.day, 0, minutesOfDay - ZONE_OFFSET_HOURS[zone] * 60, 0, 0),
  );
}

/** Absolute instant -> minutes since local midnight in the given zone (0..1439). */
export function instantToLocalMinutes(date: Date, zone: IndoZone): number {
  const shifted = new Date(date.getTime() + ZONE_OFFSET_HOURS[zone] * 3_600_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** "HH:MM WIB" for UI labels. Uses Intl only for formatting, never for arithmetic. */
export function formatLocalTime(date: Date | null | undefined, zone: IndoZone, withZone = true): string {
  if (!date) return "—";
  const s = date.toLocaleTimeString("en-GB", {
    timeZone: ZONE_IANA[zone],
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return withZone ? `${s} ${zone}` : s;
}

export function minutesToLabel(minutesOfDay: number): string {
  const h = Math.floor(minutesOfDay / 60);
  const m = minutesOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Archiplan glue (not part of the verified sketch)
// ---------------------------------------------------------------------------

/**
 * `parseDateInput` that never yields NaN fields: an empty or malformed value (e.g. a
 * cleared `<input type="date">`) falls back to today's calendar day in the browser zone.
 */
export function dayFromDateISO(value: string): LocalDay {
  const day = parseDateInput(value ?? "");
  const valid =
    Number.isInteger(day.year) &&
    Number.isInteger(day.month) &&
    Number.isInteger(day.day) &&
    day.month >= 1 &&
    day.month <= 12 &&
    day.day >= 1 &&
    day.day <= 31;
  if (valid) return day;
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** Plan sun settings -> absolute instant, city and local day (the one place SunSettings is read). */
export function sunInstant(sun: SunSettings): { date: Date; city: City; day: LocalDay } {
  const city = cityById(sun.cityId);
  const day = dayFromDateISO(sun.dateISO);
  const minutes = Number.isFinite(sun.minutesOfDay) ? sun.minutesOfDay : 600;
  return { date: localToInstant(day, minutes, city.zone), city, day };
}

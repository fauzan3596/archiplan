// Per-room direct-sunlight hours ("estimasi kasar") from the 2D plan. Plain React:
// recomputed only when the day, city, north offset or the plan geometry change,
// never when the time-of-day slider moves.

import { useMemo } from "react";
import { cityById, dayFromDateISO, formatLocalTime } from "../../lib/sun/geo";
import { sunAngles } from "../../lib/sun/sunDirection";
import {
  planToSunGeometry,
  sunlightHoursPerRoom,
  type FloorPlanGeometry,
} from "../../lib/sun/sunlightHours";

interface SunlightTableProps {
  plan: FloorPlan;
  dateISO: string;
  cityId: string;
  northOffsetDeg: number;
  /** solar noon of the day (for the north/south insight line) */
  solarNoon?: Date | null;
}

const STEP_MINUTES = 15;
const MAX_BAR_HOURS = 12;

const HOURS_FORMAT = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Barat Daya .. Barat Laut: the low afternoon sun ("panas sore") hits these. */
const isWestFacing = (bearing: number) => bearing >= 225 && bearing < 315;

const joinNames = (names: string[]) =>
  names.length <= 1
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} dan ${names[names.length - 1]}`;

const SunlightTable = ({
  plan,
  dateISO,
  cityId,
  northOffsetDeg,
  solarNoon,
}: SunlightTableProps) => {
  // Structural key: the shell re-normalises the plan on every sun tweak, so array
  // identity changes with the time slider even when the geometry does not.
  const geometryKey = useMemo(() => JSON.stringify(planToSunGeometry(plan)), [plan]);

  const result = useMemo(() => {
    const city = cityById(cityId);
    const geometry = JSON.parse(geometryKey) as FloorPlanGeometry;
    const hours = sunlightHoursPerRoom(
      geometry,
      dayFromDateISO(dateISO),
      city.lat,
      city.lng,
      city.zone,
      northOffsetDeg,
      { stepMinutes: STEP_MINUTES, minAltitudeDeg: 3, selfShadow: true },
    );
    return { city, hours };
  }, [geometryKey, dateISO, cityId, northOffsetDeg]);

  const { city, hours } = result;
  const zone = city.zone;
  const interiorCount = hours.skipped.filter((s) => s.reason === "interior-wall").length;

  const westRooms = hours.rooms
    .filter((r) => r.windows.some((w) => isWestFacing(w.facingBearing)))
    .map((r) => r.name);

  const noon = useMemo(
    () => (solarNoon ? sunAngles(solarNoon, city.lat, city.lng) : null),
    [solarNoon, city],
  );
  const noonInNorth = noon ? Math.cos((noon.azimuthDeg * Math.PI) / 180) > 0 : null;

  const formatRange = (first: Date | null, last: Date | null) => {
    if (!first || !last) return "—";
    const end = new Date(last.getTime() + STEP_MINUTES * 60_000);
    return `${formatLocalTime(first, zone, false)}–${formatLocalTime(end, zone, false)}`;
  };

  return (
    <div className="sun-hours">
      <div className="sun-hours-head">
        <p className="sun-label">Jam matahari langsung</p>
        <span className="sun-badge">estimasi kasar</span>
      </div>

      {hours.rooms.length === 0 ? (
        <p className="sun-empty">Belum ada ruangan pada denah.</p>
      ) : (
        <table className="sun-table">
          <thead>
            <tr>
              <th>Ruangan</th>
              <th>Jam</th>
              <th>Waktu ({zone})</th>
            </tr>
          </thead>
          <tbody>
            {hours.rooms.map((r) => {
              const facings = [...new Set(r.windows.map((w) => w.facingLabel))];
              const pct = Math.min(100, (r.hours / MAX_BAR_HOURS) * 100);
              return (
                <tr key={r.roomId}>
                  <td>
                    <span className="room">{r.name}</span>
                    <span className="facing">
                      {facings.length > 0
                        ? `Jendela: ${facings.join(", ")}`
                        : "Tanpa jendela luar"}
                    </span>
                  </td>
                  <td>
                    <span className="hours">{HOURS_FORMAT.format(r.hours)}</span>
                    <span className="bar" aria-hidden="true">
                      <span style={{ width: `${pct}%` }} />
                    </span>
                  </td>
                  <td className="range">{formatRange(r.first, r.last)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="sun-note">
        Dihitung tiap {STEP_MINUTES} menit dari jendela di dinding luar (matahari di atas 3°,
        termasuk bayangan dinding bangunan sendiri). Tritisan, pohon, dan bangunan tetangga
        belum diperhitungkan.
        {interiorCount > 0 && ` ${interiorCount} jendela di dinding dalam diabaikan.`}
      </p>

      <ul className="sun-insights">
        <li>
          {westRooms.length > 0
            ? `Jendela menghadap barat di ${joinNames(westRooms)} terkena panas sore (± 15.00–17.30, matahari rendah): pertimbangkan tritisan lebar, kanopi, atau kaca film.`
            : "Tidak ada jendela menghadap barat, jadi ruangan terhindar dari panas sore yang paling menyengat."}
        </li>
        {noon && noonInNorth !== null && (
          <li>
            {`Pada tanggal ini matahari siang ada di sisi ${noonInNorth ? "utara" : "selatan"} (ketinggian ${Math.round(noon.altitudeDeg)}°): jendela menghadap ${noonInNorth ? "utara" : "selatan"} mendapat sinar langsung, sisi ${noonInNorth ? "selatan" : "utara"} teduh. Di Indonesia sisi ini bergantian utara–selatan sepanjang tahun.`}
          </li>
        )}
      </ul>
    </div>
  );
};

export default SunlightTable;

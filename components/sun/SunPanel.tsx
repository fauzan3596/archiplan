// Sun simulation controls for the 3D route (plain React, no three.js imports here).
// Date / time / city / toggles call onSunChange (viewers change local state only);
// the plan's north offset is owner-editable, like in the Denah 2D toolbar.

import { useEffect, useMemo, useState } from "react";
import { Compass, RotateCcw, RotateCw, Sun, Sunrise, Sunset } from "lucide-react";
import { normalizeDeg } from "../../lib/plan/convert";
import {
  CITIES,
  cityById,
  dayFromDateISO,
  formatLocalTime,
  localToInstant,
  minutesToLabel,
} from "../../lib/sun/geo";
import { bearingToLabelId, sunAngles, sunPathForDay } from "../../lib/sun/sunDirection";
import SunlightTable from "./SunlightTable";

interface SunPanelProps {
  plan: FloorPlan;
  readOnly: boolean;
  onSunChange: (patch: Partial<SunSettings>) => void;
  onNorthChange: (deg: number) => void;
}

const NORTH_STEP = 15;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const HOURS_FORMAT = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const SunPanel = ({ plan, readOnly, onSunChange, onNorthChange }: SunPanelProps) => {
  const sun = plan.sun;
  const north = normalizeDeg(plan.northOffsetDeg);
  const city = cityById(sun.cityId);
  const minutes = Number.isFinite(sun.minutesOfDay) ? sun.minutesOfDay : 600;

  // Sunrise / solar noon / sunset depend on the day and city only.
  const path = useMemo(() => {
    const c = cityById(sun.cityId);
    return sunPathForDay(dayFromDateISO(sun.dateISO), c.lat, c.lng, c.zone, 0, 60);
  }, [sun.dateISO, sun.cityId]);

  const angles = useMemo(() => {
    const c = cityById(sun.cityId);
    const date = localToInstant(dayFromDateISO(sun.dateISO), minutes, c.zone);
    return sunAngles(date, c.lat, c.lng);
  }, [sun.dateISO, sun.cityId, minutes]);

  const [northDraft, setNorthDraft] = useState(String(Math.round(north)));
  useEffect(() => {
    setNorthDraft(String(Math.round(north)));
  }, [north]);

  const commitNorth = (deg: number) => onNorthChange(normalizeDeg(Math.round(deg)));

  const handleNorthInput = (value: string) => {
    setNorthDraft(value);
    const n = Number(value);
    if (value.trim() !== "" && Number.isFinite(n)) commitNorth(n);
  };

  return (
    <section className="panel sun-panel">
      <div className="panel-header">
        <div className="panel-meta">
          <p>Simulasi matahari</p>
          <h3>Cahaya &amp; bayangan</h3>
        </div>
      </div>

      <div className="sun-body">
        {readOnly && (
          <p className="sun-readonly">
            Perubahan waktu dan lokasi hanya tampil di perangkat Anda dan tidak disimpan.
          </p>
        )}

        <div className="sun-grid">
          <label className="sun-field">
            <span className="sun-label">Tanggal</span>
            <input
              type="date"
              value={sun.dateISO}
              onChange={(e) => {
                if (DATE_RE.test(e.target.value)) onSunChange({ dateISO: e.target.value });
              }}
            />
          </label>
          <label className="sun-field">
            <span className="sun-label">Kota</span>
            <select value={city.id} onChange={(e) => onSunChange({ cityId: e.target.value })}>
              {CITIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.zone})
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="sun-field">
          <span className="sun-time-row">
            <span className="sun-label">Jam</span>
            <span className="sun-time">
              {minutesToLabel(minutes)} {city.zone}
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={1439}
            step={5}
            value={minutes}
            onChange={(e) => onSunChange({ minutesOfDay: Number(e.target.value) })}
            aria-valuetext={`${minutesToLabel(minutes)} ${city.zone}`}
          />
        </label>

        <p className="sun-position">
          <Sun className="icon" />
          {angles.altitudeDeg > 0
            ? `Azimut ${Math.round(angles.azimuthDeg)}° (${bearingToLabelId(angles.azimuthDeg)}) · ketinggian ${Math.round(angles.altitudeDeg)}°`
            : "Matahari di bawah cakrawala (malam)"}
        </p>

        <div className="sun-times">
          <span>
            <Sunrise className="icon" />
            Terbit {formatLocalTime(path.sunrise, city.zone, false)}
          </span>
          <span>
            <Sun className="icon" />
            Tengah hari {formatLocalTime(path.solarNoon, city.zone, false)}
          </span>
          <span>
            <Sunset className="icon" />
            Terbenam {formatLocalTime(path.sunset, city.zone, false)}
          </span>
          <span className="sun-daylen">
            {city.zone} · lama siang {HOURS_FORMAT.format(path.dayLengthHours)} jam
          </span>
        </div>

        <div className="sun-field">
          <span className="sun-label">Arah utara denah</span>
          <div className="sun-north">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={readOnly}
              onClick={() => commitNorth(north - NORTH_STEP)}
              aria-label={`Putar utara ${NORTH_STEP}° berlawanan jarum jam`}
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              {NORTH_STEP}°
            </button>
            <input
              type="number"
              min={0}
              max={359}
              step={1}
              value={northDraft}
              disabled={readOnly}
              onChange={(e) => handleNorthInput(e.target.value)}
              onBlur={() => setNorthDraft(String(Math.round(north)))}
              aria-label="Arah utara (derajat)"
            />
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={readOnly}
              onClick={() => commitNorth(north + NORTH_STEP)}
              aria-label={`Putar utara ${NORTH_STEP}° searah jarum jam`}
            >
              <RotateCw className="w-4 h-4 mr-2" />
              {NORTH_STEP}°
            </button>
          </div>
          <span className="sun-hint">
            <Compass className="icon" />
            0° = bagian atas gambar menghadap utara. Bangunan tidak ikut berputar.
          </span>
        </div>

        <div className="sun-toggles">
          <label>
            <input
              type="checkbox"
              checked={sun.showPath}
              onChange={(e) => onSunChange({ showPath: e.target.checked })}
            />
            Lintasan matahari
          </label>
          <label>
            <input
              type="checkbox"
              checked={sun.showCompass}
              onChange={(e) => onSunChange({ showCompass: e.target.checked })}
            />
            Kompas
          </label>
        </div>

        <SunlightTable
          plan={plan}
          dateISO={sun.dateISO}
          cityId={city.id}
          northOffsetDeg={north}
          solarNoon={path.solarNoon}
        />
      </div>
    </section>
  );
};

export default SunPanel;

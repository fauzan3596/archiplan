// RAB controls: paket, kualitas, wilayah, jasa kontraktor, PPN, bongkar,
// luas bangunan and the plan-wide wall height. Owners persist through
// ctx.updatePlan (RabRoute); viewers change local state only.

import { useRef, useState, type KeyboardEvent } from "react";
import {
  CONTRACTOR_FEE_MAX_PCT,
  GRADE_LABELS,
  GRADE_ORDER,
  PAKET,
  PAKET_ORDER,
  PPN_PCT,
  REGION_MULTIPLIERS,
  REGION_ORDER,
} from "../../lib/rab/data";

export const MIN_WALL_HEIGHT_M = 2.2;
export const MAX_WALL_HEIGHT_M = 6;

const factorFormat = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const areaFormat = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });

/** Parses "3,5" / "3.5" (decimal) or "1.200.000" (integer, id-ID thousands). */
export const parseIdNumber = (raw: string, kind: "decimal" | "integer"): number | null => {
  const s = raw.trim().replace(/\s|Rp/gi, "");
  if (!s) return null;
  if (kind === "integer") {
    const digits = s.replace(/[^\d]/g, "");
    return digits ? Number(digits) : null;
  }
  const normalized = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
};

interface NumberDraftInputProps {
  value: number | null;
  onCommit: (value: number | null) => void;
  kind?: "decimal" | "integer";
  min?: number;
  max?: number;
  format?: (value: number) => string;
  placeholder?: string;
  className?: string;
  ariaLabel: string;
  disabled?: boolean;
}

/** Text input that edits a local draft and commits on blur / Enter (Esc reverts),
 *  so partial values such as "3," never reach the plan. */
export const NumberDraftInput = ({
  value,
  onCommit,
  kind = "decimal",
  min,
  max,
  format,
  placeholder,
  className,
  ariaLabel,
  disabled,
}: NumberDraftInputProps) => {
  const shown = value === null ? "" : format ? format(value) : String(value);
  const [draft, setDraft] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const commit = () => {
    const current = draft;
    setDraft(null);
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    if (current === null || current === shown) return;
    const parsed = parseIdNumber(current, kind);
    if (parsed === null) {
      onCommit(null);
      return;
    }
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
    if (value !== null && Math.abs(clamped - value) < 1e-9) return;
    onCommit(clamped);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      cancelRef.current = true;
      e.currentTarget.blur();
    }
  };

  return (
    <input
      type="text"
      inputMode={kind === "integer" ? "numeric" : "decimal"}
      className={className}
      aria-label={ariaLabel}
      placeholder={placeholder}
      disabled={disabled}
      value={draft ?? shown}
      onFocus={() => setDraft(shown)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
};

interface RabInputsPanelProps {
  inputs: RabInputs;
  wallHeight: number;
  floorArea: number;
  isOwner: boolean;
  onChange: (patch: Partial<RabInputs>) => void;
  onWallHeightChange: (height: number) => void;
}

const RabInputsPanel = ({
  inputs,
  wallHeight,
  floorArea,
  isOwner,
  onChange,
  onWallHeightChange,
}: RabInputsPanelProps) => {
  const region = REGION_MULTIPLIERS[inputs.region];
  const isNewBuild = inputs.paket === "bangun_baru";

  return (
    <section className="panel rab-inputs" aria-label="Pengaturan RAB">
      <div className="panel-header">
        <div className="panel-meta">
          <p>Pengaturan</p>
          <h3>Asumsi estimasi</h3>
          {!isOwner && (
            <p className="note">Mode lihat: perubahan hanya berlaku di perangkat ini dan tidak disimpan.</p>
          )}
        </div>
      </div>

      <div className="rab-fields">
        <fieldset className="rab-field">
          <legend className="rab-label">Paket pekerjaan</legend>
          <div className="rab-segment" role="radiogroup" aria-label="Paket pekerjaan">
            {PAKET_ORDER.map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={inputs.paket === key}
                className={`segment ${inputs.paket === key ? "is-active" : ""}`}
                onClick={() => onChange({ paket: key })}
              >
                {PAKET[key].label}
              </button>
            ))}
          </div>
          <p className="rab-help">{PAKET[inputs.paket].description}</p>
        </fieldset>

        <fieldset className="rab-field">
          <legend className="rab-label">Kualitas</legend>
          <div className="rab-segment" role="radiogroup" aria-label="Kualitas">
            {GRADE_ORDER.map((grade) => (
              <button
                key={grade}
                type="button"
                role="radio"
                aria-checked={inputs.grade === grade}
                className={`segment ${inputs.grade === grade ? "is-active" : ""}`}
                onClick={() => onChange({ grade })}
              >
                {GRADE_LABELS[grade]}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="rab-field">
          <span className="rab-label">Wilayah</span>
          <select
            value={inputs.region}
            onChange={(e) => onChange({ region: e.target.value as RabRegion })}
          >
            {REGION_ORDER.map((key) => (
              <option key={key} value={key}>
                {REGION_MULTIPLIERS[key].label} (×{factorFormat.format(REGION_MULTIPLIERS[key].factor)})
              </option>
            ))}
          </select>
          <span className="rab-help">
            Faktor ×{factorFormat.format(region.factor)} · {region.note}
          </span>
        </label>

        <label className="rab-field">
          <span className="rab-label-row">
            <span className="rab-label">Jasa kontraktor</span>
            <span className="rab-value">{inputs.contractorFeePct}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={CONTRACTOR_FEE_MAX_PCT}
            step={1}
            value={inputs.contractorFeePct}
            onChange={(e) => onChange({ contractorFeePct: Number(e.target.value) })}
          />
          <span className="rab-help">Praktik umum 10–15% (keuntungan + overhead).</span>
        </label>

        <label className="rab-check">
          <input
            type="checkbox"
            checked={inputs.includePpn}
            onChange={(e) => onChange({ includePpn: e.target.checked })}
          />
          <span>
            {`PPN ${PPN_PCT}% (PMK 131/2024)`}
            <small>Hanya bila kontraktor berstatus PKP.</small>
          </span>
        </label>

        <label className="rab-check">
          <input
            type="checkbox"
            checked={inputs.demolition}
            disabled={isNewBuild}
            onChange={(e) => onChange({ demolition: e.target.checked })}
          />
          <span>
            Bongkar lantai & plafon lama
            <small>Termasuk angkut & buang puing.</small>
          </span>
        </label>

        <label className="rab-field">
          <span className="rab-label">Luas bangunan (m²)</span>
          <NumberDraftInput
            ariaLabel="Luas bangunan (m²)"
            value={inputs.luasBangunanM2 ?? null}
            min={1}
            max={5000}
            format={(v) => areaFormat.format(v)}
            placeholder={`Denah: ${areaFormat.format(floorArea)}`}
            onCommit={(v) => onChange({ luasBangunanM2: v !== null && v > 0 ? v : null })}
          />
          <span className="rab-help">Opsional; dibandingkan dengan luas denah untuk cek skala.</span>
        </label>

        <label className="rab-field">
          <span className="rab-label">Tinggi dinding (m)</span>
          <NumberDraftInput
            ariaLabel="Tinggi dinding (m)"
            value={wallHeight}
            min={MIN_WALL_HEIGHT_M}
            max={MAX_WALL_HEIGHT_M}
            format={(v) => factorFormat.format(v)}
            onCommit={(v) => {
              if (v !== null) onWallHeightChange(v);
            }}
          />
          <span className="rab-help">
            Mengubah tinggi semua dinding denah (juga di Walkthrough 3D).
          </span>
        </label>
      </div>
    </section>
  );
};

export default RabInputsPanel;

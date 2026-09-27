import { useEffect, useState } from "react";
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AppWindow,
  Compass,
  DoorOpen,
  Eye,
  Layers,
  MousePointer2,
  PenLine,
  RectangleHorizontal,
  Redo2,
  RefreshCcw,
  Ruler,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { normalizeDeg, planBounds } from "../../lib/plan/convert";
import {
  EDITOR_TOOLS,
  MAX_WALL_HEIGHT_M,
  MIN_WALL_HEIGHT_M,
  canRedo,
  canUndo,
  planWallHeight,
} from "../../lib/plan/editor";
import type { EditorAction, EditorState, EditorTool } from "../../lib/plan/editor";

// -----------------------------------------------------------------------------
// Commit-on-blur inputs (shared with PlanSidebar): typing never dispatches, so
// one edit = one undo step and one save.
// -----------------------------------------------------------------------------

const formatNumber = (value: number, digits: number) =>
  Number.isFinite(value) ? String(Number(value.toFixed(digits))) : "";

const parseNumber = (text: string): number | null => {
  const n = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(n) ? n : null;
};

interface CommitNumberInputProps {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
  disabled?: boolean;
  label: string;
  className?: string;
}

export const CommitNumberInput = ({
  value,
  onCommit,
  min,
  max,
  step,
  digits = 2,
  disabled,
  label,
  className,
}: CommitNumberInputProps) => {
  const [text, setText] = useState(() => formatNumber(value, digits));

  useEffect(() => {
    setText(formatNumber(value, digits));
  }, [value, digits]);

  const commit = () => {
    const n = parseNumber(text);
    if (n === null) {
      setText(formatNumber(value, digits));
      return;
    }
    let next = n;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setText(formatNumber(next, digits));
    if (Math.abs(next - value) > 1e-9) onCommit(next);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      setText(formatNumber(value, digits));
    }
  };

  return (
    <input
      type="number"
      inputMode="decimal"
      className={className ?? "num"}
      value={text}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
};

interface CommitTextInputProps {
  value: string;
  onCommit: (value: string) => void;
  disabled?: boolean;
  label: string;
  placeholder?: string;
}

export const CommitTextInput = ({
  value,
  onCommit,
  disabled,
  label,
  placeholder,
}: CommitTextInputProps) => {
  const [text, setText] = useState(value);

  useEffect(() => {
    setText(value);
  }, [value]);

  const commit = () => {
    if (text.trim() !== value) onCommit(text.trim());
  };

  return (
    <input
      type="text"
      className="text"
      value={text}
      disabled={disabled}
      aria-label={label}
      placeholder={placeholder}
      maxLength={60}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          setText(value);
        }
      }}
    />
  );
};

// -----------------------------------------------------------------------------
// Toolbar
// -----------------------------------------------------------------------------

const TOOL_META: Record<EditorTool, { label: string; icon: LucideIcon }> = {
  select: { label: "Pilih", icon: MousePointer2 },
  wall: { label: "Dinding", icon: PenLine },
  door: { label: "Pintu", icon: DoorOpen },
  window: { label: "Jendela", icon: AppWindow },
  opening: { label: "Bukaan", icon: RectangleHorizontal },
  calibrate: { label: "Kalibrasi 2 titik", icon: Ruler },
  north: { label: "Utara", icon: Compass },
};

interface PlanToolbarProps {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  readOnly: boolean;
  showRawLayer: boolean;
  onToggleRawLayer: (show: boolean) => void;
}

const RawLayerToggle = ({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) => (
  <label className="toggle">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <Layers className="w-4 h-4" />
    <span>Layer denah AI</span>
  </label>
);

const CalibrateBar = ({
  state,
  dispatch,
}: {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
}) => {
  const [metres, setMetres] = useState("");
  const cal = state.calibration;
  const ready = Boolean(cal?.a && cal?.b);

  const apply = () => {
    const n = parseNumber(metres);
    if (n === null || n <= 0) return;
    dispatch({ type: "CALIBRATE_APPLY", metres: n });
    setMetres("");
  };

  return (
    <div className="calibrate-bar" role="status">
      <Ruler className="w-4 h-4 shrink-0" />
      {!cal?.a && <span>Klik titik pertama pada garis ukuran yang panjangnya diketahui.</span>}
      {cal?.a && !cal.b && <span>Klik titik kedua.</span>}
      {ready && (
        <form
          className="calibrate-form"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <label className="field">
            <span>Jarak sebenarnya (m)</span>
            <input
              type="number"
              inputMode="decimal"
              className="num"
              min={0.1}
              step={0.01}
              value={metres}
              autoFocus
              onChange={(e) => setMetres(e.target.value)}
            />
          </label>
          <button type="submit" className="tool is-primary" disabled={parseNumber(metres) === null}>
            Terapkan
          </button>
        </form>
      )}
      <button type="button" className="tool" onClick={() => dispatch({ type: "CALIBRATE_CANCEL" })}>
        Batal
      </button>
    </div>
  );
};

const PlanToolbar = ({
  state,
  dispatch,
  readOnly,
  showRawLayer,
  onToggleRawLayer,
}: PlanToolbarProps) => {
  const { plan } = state;
  const [widthText, setWidthText] = useState("");
  const hasRawLayer = Boolean(plan.extraction?.rawRooms?.length);

  if (readOnly) {
    return (
      <div className="plan-toolbar is-readonly">
        <span className="readonly-badge">
          <Eye className="w-4 h-4 mr-2" />
          Hanya lihat
        </span>
        {hasRawLayer && <RawLayerToggle checked={showRawLayer} onChange={onToggleRawLayer} />}
      </div>
    );
  }

  const currentWidth = planBounds(plan).width;
  const applyWidth = () => {
    const n = parseNumber(widthText);
    if (n === null || n <= 0) return;
    dispatch({ type: "CALIBRATE_TOTAL_WIDTH", metres: n });
    setWidthText("");
  };

  const setNorth = (deg: number) => dispatch({ type: "SET_NORTH", deg: normalizeDeg(deg) });

  return (
    <div className="plan-toolbar">
      <div className="tool-row">
        <div className="tool-group" role="toolbar" aria-label="Alat gambar">
          {EDITOR_TOOLS.map((tool, i) => {
            const { label, icon: Icon } = TOOL_META[tool];
            const active = state.tool === tool;
            return (
              <button
                key={tool}
                type="button"
                className={`tool${active ? " is-active" : ""}`}
                aria-pressed={active}
                title={`${label} (${i + 1})`}
                onClick={() => dispatch({ type: "SET_TOOL", tool })}
              >
                <Icon className="w-4 h-4" />
                <span className="label">{label}</span>
              </button>
            );
          })}
        </div>

        <div className="tool-group" aria-label="Riwayat">
          <button
            type="button"
            className="tool"
            disabled={!canUndo(state)}
            title="Urungkan (Ctrl+Z)"
            aria-label="Urungkan"
            onClick={() => dispatch({ type: "UNDO" })}
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="tool"
            disabled={!canRedo(state)}
            title="Ulangi (Ctrl+Y)"
            aria-label="Ulangi"
            onClick={() => dispatch({ type: "REDO" })}
          >
            <Redo2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="tool"
            title="Bentuk ulang ruangan dari dinding dan hapus ruangan terputus"
            onClick={() => dispatch({ type: "REBUILD_ROOMS" })}
          >
            <RefreshCcw className="w-4 h-4" />
            <span className="label">Bangun ulang ruangan</span>
          </button>
        </div>
      </div>

      <div className="tool-row settings">
        <form
          className="field-group"
          onSubmit={(e) => {
            e.preventDefault();
            applyWidth();
          }}
        >
          <label className="field">
            <span>Lebar bangunan (m)</span>
            <input
              type="number"
              inputMode="decimal"
              className="num"
              min={1}
              step={0.01}
              value={widthText}
              placeholder={currentWidth > 0 ? currentWidth.toFixed(2) : ""}
              title="Lebar bangunan dari as ke as dinding terluar"
              onChange={(e) => setWidthText(e.target.value)}
            />
          </label>
          <button type="submit" className="tool" disabled={parseNumber(widthText) === null}>
            Terapkan
          </button>
        </form>

        <button
          type="button"
          className={`tool${plan.scale.confirmed ? " is-done" : ""}`}
          disabled={plan.scale.confirmed}
          onClick={() => dispatch({ type: "CONFIRM_SCALE" })}
        >
          <ShieldCheck className="w-4 h-4" />
          <span className="label">Skala sudah benar</span>
        </button>

        <div className="field-group north" aria-label="Arah utara">
          <span className="field-label">Utara</span>
          <button
            type="button"
            className="tool"
            onClick={() => setNorth(plan.northOffsetDeg - 15)}
            aria-label="Putar utara -15 derajat"
          >
            −15°
          </button>
          <CommitNumberInput
            value={plan.northOffsetDeg}
            min={0}
            max={359}
            step={1}
            digits={0}
            label="Arah utara (derajat)"
            onCommit={(v) => setNorth(Math.round(v))}
          />
          <button
            type="button"
            className="tool"
            onClick={() => setNorth(plan.northOffsetDeg + 15)}
            aria-label="Putar utara +15 derajat"
          >
            +15°
          </button>
        </div>

        <label className="field">
          <span>Tinggi dinding (m)</span>
          <CommitNumberInput
            value={planWallHeight(plan)}
            min={MIN_WALL_HEIGHT_M}
            max={MAX_WALL_HEIGHT_M}
            step={0.1}
            label="Tinggi dinding (m)"
            onCommit={(height) => dispatch({ type: "SET_WALL_HEIGHT", height })}
          />
        </label>

        {hasRawLayer && <RawLayerToggle checked={showRawLayer} onChange={onToggleRawLayer} />}
      </div>

      {state.tool === "calibrate" && <CalibrateBar state={state} dispatch={dispatch} />}
    </div>
  );
};

export default PlanToolbar;

import { useEffect, useReducer, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, Info, Ruler } from "lucide-react";
import { useVisualizer } from "../../lib/visualizer.context";
import {
  EDITOR_TOOLS,
  createEditorState,
  editorReducer,
} from "../../lib/plan/editor";
import type { EditorTool } from "../../lib/plan/editor";
import PlanSidebar from "./PlanSidebar";
import PlanSvg from "./PlanSvg";
import PlanToolbar from "./PlanToolbar";

interface PlanEditorProps {
  readOnly: boolean;
}

const TOOL_HINTS: Record<EditorTool, string> = {
  select:
    "Klik dinding, bukaan, atau ruangan untuk memilih. Seret titik ujung untuk memindahkan (Shift: tanpa snap, Alt: lepas dari sudut). Klik ganda dinding untuk membaginya.",
  wall: "Klik titik awal lalu titik akhir; klik lagi untuk dinding bersambung. Esc atau klik ganda untuk selesai.",
  door: "Klik pada dinding untuk menambah pintu (lebar 0,85 m).",
  window: "Klik pada dinding untuk menambah jendela (lebar 1,2 m).",
  opening: "Klik pada dinding untuk menambah bukaan tanpa daun (lebar 0,9 m).",
  calibrate: "Klik dua titik pada garis ukuran di gambar, lalu isi jarak sebenarnya.",
  north: "Klik ke arah utara, dihitung dari pusat bangunan.",
};

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
};

const PlanEditor = ({ readOnly }: PlanEditorProps) => {
  const ctx = useVisualizer();
  const { updatePlan, projectRef, setPlan } = ctx;
  const initialPlan = ctx.plan as FloorPlan; // PlanRoute only mounts us with a plan

  const [state, dispatch] = useReducer(editorReducer, initialPlan, createEditorState);
  const [showRawLayer, setShowRawLayer] = useState(false);

  // The plan object we last exchanged with the shell (pushed or adopted), and
  // the editedAt the shell stamped on it: pushes happen only when the reducer
  // produced a different plan object; the shell's echo (same editedAt) is
  // never adopted back, so there is no push/adopt loop.
  const syncedPlanRef = useRef<FloorPlan>(initialPlan);
  const knownEditedAtRef = useRef<string>(initialPlan.editedAt);

  // Outside changes (conflict adoption, extraction, another tab's save).
  useEffect(() => {
    const plan = ctx.plan;
    if (!plan || plan.editedAt === knownEditedAtRef.current) return;
    knownEditedAtRef.current = plan.editedAt;
    syncedPlanRef.current = plan;
    dispatch({ type: "REPLACE_PLAN", plan });
  }, [ctx.plan]);

  // Push user edits (not while an endpoint drag is still live).
  useEffect(() => {
    if (readOnly || state.drag) return;
    const plan = state.plan;
    if (plan === syncedPlanRef.current) return;
    syncedPlanRef.current = plan;
    // Keep the shell's editedAt as the base so touchPlan stamps a strictly newer one.
    updatePlan((base) => ({ ...plan, editedAt: base.editedAt }));
    const stamped = projectRef.current?.plan?.editedAt;
    if (stamped) {
      knownEditedAtRef.current = stamped;
      dispatch({ type: "MARK_PUSHED", editedAt: stamped });
    }
  }, [state.plan, state.drag, readOnly, updatePlan, projectRef]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isTypingTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (e.key === "Escape") {
      if (state.drag) dispatch({ type: "CANCEL_DRAG" });
      else if (state.draft) dispatch({ type: "DRAFT_WALL", draft: null });
      else if (state.calibration) dispatch({ type: "CALIBRATE_CANCEL" });
      else if (state.selection) dispatch({ type: "SELECT", selection: null });
      else if (state.tool !== "select") dispatch({ type: "SET_TOOL", tool: "select" });
      return;
    }

    if (readOnly) return;

    if (mod && key === "z") {
      e.preventDefault();
      dispatch({ type: e.shiftKey ? "REDO" : "UNDO" });
      return;
    }
    if (mod && key === "y") {
      e.preventDefault();
      dispatch({ type: "REDO" });
      return;
    }
    if (mod || e.altKey) return;

    if (e.key === "Delete" || e.key === "Backspace") {
      if (state.selection) {
        e.preventDefault();
        dispatch({ type: "DELETE_SELECTED" });
      }
      return;
    }

    const index = Number(e.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < EDITOR_TOOLS.length) {
      e.preventDefault();
      dispatch({ type: "SET_TOOL", tool: EDITOR_TOOLS[index] });
    }
  };

  const onResetPlan = () => {
    if (
      window.confirm(
        "Hapus denah ini dan mulai lagi dari gambar sumber? Semua perubahan denah akan hilang.",
      )
    ) {
      void setPlan(null);
    }
  };

  const plan = state.plan;

  return (
    <div
      className="plan-editor"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="Editor denah 2D"
    >
      <div className="plan-main">
        <PlanToolbar
          state={state}
          dispatch={dispatch}
          readOnly={readOnly}
          showRawLayer={showRawLayer}
          onToggleRawLayer={setShowRawLayer}
        />

        {!plan.scale.confirmed && (
          <div className="scale-banner" role="status">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Skala belum dikonfirmasi — kalibrasi agar RAB akurat</span>
            {!readOnly && state.tool !== "calibrate" && (
              <button
                type="button"
                onClick={() => dispatch({ type: "SET_TOOL", tool: "calibrate" })}
              >
                <Ruler className="w-3.5 h-3.5 mr-1" />
                Kalibrasi
              </button>
            )}
          </div>
        )}

        {state.notice && (
          <div className="plan-notice" role="status">
            <Info className="w-4 h-4 shrink-0" />
            <span>{state.notice}</span>
          </div>
        )}

        <div className="plan-stage">
          <PlanSvg
            plan={plan}
            sourceImage={ctx.project?.sourceImage ?? null}
            state={state}
            dispatch={dispatch}
            readOnly={readOnly}
            showRawLayer={showRawLayer}
          />
        </div>

        <p className="plan-hint">
          {readOnly
            ? "Mode lihat saja — hanya pemilik proyek yang dapat mengubah denah."
            : TOOL_HINTS[state.tool]}
        </p>
      </div>

      <PlanSidebar
        state={state}
        dispatch={dispatch}
        readOnly={readOnly}
        onResetPlan={readOnly ? undefined : onResetPlan}
      />
    </div>
  );
};

export default PlanEditor;

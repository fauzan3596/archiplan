// "Walkthrough 3D" tab: stage with orbit / walk modes and .glb export, the
// materials panel and the sun panel. three/r3f are only reachable from this
// route module, so they stay in the 3d route chunks.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Download, Footprints, Orbit } from "lucide-react";
import Button from "../ui/Button";
import SunPanel from "../sun/SunPanel";
import SunRig from "../sun/SunRig";
import { normalizeDeg, planToScene, polygonArea } from "../../lib/plan/convert";
import { useVisualizer } from "../../lib/visualizer.context";
import HouseCanvas, { type ExportGlbFn } from "./HouseCanvas";
import ThreePanel from "./ThreePanel";
import type { ViewMode } from "./Walker";

/** Chrome refuses a re-lock requested within ~1 s of leaving pointer lock. */
const RELOCK_COOLDOWN_MS = 1200;

const areaFormat = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });

const NoPlanCard = () => (
  <div className="panel">
    <div className="placeholder-card">
      <p className="eyebrow">Walkthrough 3D</p>
      <h3>Belum ada denah</h3>
      <p>Buat atau ekstrak denah terlebih dahulu di tab Denah 2D.</p>
      <Link to="../plan" className="btn btn--primary btn--sm three-empty-link">
        Buka Denah 2D
      </Link>
    </div>
  </div>
);

const ThreeView = ({ plan }: { plan: FloorPlan }) => {
  const { projectId, isOwner, updatePlan } = useVisualizer();
  const scene = useMemo(() => planToScene(plan), [plan]);
  const exportRef = useRef<ExportGlbFn | null>(null);

  const [mode, setMode] = useState<ViewMode>("orbit");
  const modeRef = useRef<ViewMode>("orbit");
  const [cooldown, setCooldown] = useState(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleModeChange = useCallback((next: ViewMode) => {
    if (modeRef.current === next) return;
    if (modeRef.current === "walk" && next === "orbit") {
      setCooldown(true);
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
      cooldownTimer.current = setTimeout(() => {
        cooldownTimer.current = null;
        setCooldown(false);
      }, RELOCK_COOLDOWN_MS);
    }
    modeRef.current = next;
    setMode(next);
  }, []);

  useEffect(
    () => () => {
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    },
    [],
  );

  const handleExport = async () => {
    const run = exportRef.current;
    if (!run) return;
    setIsExporting(true);
    setExportError(null);
    try {
      await run(`archiplan-${projectId || "denah"}.glb`);
    } catch (error) {
      console.error("GLB export failed:", error);
      setExportError("Gagal mengekspor model .glb. Coba lagi.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleSunChange = useCallback(
    (patch: Partial<SunSettings>) =>
      updatePlan((p) => ({ ...p, sun: { ...p.sun, ...patch } })),
    [updatePlan],
  );

  const handleNorthChange = useCallback(
    (deg: number) =>
      updatePlan((p) => ({ ...p, northOffsetDeg: normalizeDeg(deg) })),
    [updatePlan],
  );

  const totalArea = plan.rooms.reduce(
    (sum, r) => (r.stale ? sum : sum + polygonArea(r.polygon)),
    0,
  );

  return (
    <div className="three-route">
      <div className="panel three-main">
        <div className="panel-header">
          <div className="panel-meta">
            <p>Walkthrough 3D</p>
            <h3>Jelajahi rumah</h3>
            <p className="note">
              {scene.rooms.length} ruangan · {areaFormat.format(totalArea)} m²
              {plan.scale.confirmed ? "" : " · skala belum dikonfirmasi"}
            </p>
          </div>

          <div className="panel-actions">
            <div className="mode-toggle" role="group" aria-label="Mode tampilan">
              <button
                type="button"
                className={`mode ${mode === "orbit" ? "is-active" : ""}`}
                aria-pressed={mode === "orbit"}
                onClick={() => handleModeChange("orbit")}
              >
                <Orbit className="w-4 h-4 mr-2" />
                Orbit
              </button>
              <button
                id="walk-btn"
                type="button"
                className={`mode ${mode === "walk" ? "is-active" : ""}`}
                aria-pressed={mode === "walk"}
                disabled={cooldown}
                onClick={() =>
                  handleModeChange(modeRef.current === "walk" ? "orbit" : "walk")
                }
              >
                <Footprints className="w-4 h-4 mr-2" />
                {mode === "walk" ? "Keluar (Esc)" : "Jalan-jalan"}
              </button>
            </div>
            <Button
              size="sm"
              className="export"
              onClick={() => void handleExport()}
              disabled={isExporting}
            >
              <Download className="w-4 h-4 mr-2" />
              {isExporting ? "Mengekspor…" : "Ekspor .glb"}
            </Button>
          </div>
        </div>

        <div className="three-stage">
          <HouseCanvas
            plan={plan}
            scene={scene}
            mode={mode}
            onModeChange={handleModeChange}
            exportRef={exportRef}
            selectedRoomId={selectedRoomId}
            lights={<SunRig plan={plan} scene={scene} sun={plan.sun} />}
          />
        </div>

        {exportError && (
          <p className="three-error" role="alert">
            {exportError}
          </p>
        )}
      </div>

      <aside className="three-side">
        <ThreePanel
          plan={plan}
          readOnly={!isOwner}
          selectedRoomId={selectedRoomId}
          onSelectRoom={setSelectedRoomId}
          onUpdatePlan={updatePlan}
        />
        <SunPanel
          plan={plan}
          readOnly={!isOwner}
          onSunChange={handleSunChange}
          onNorthChange={handleNorthChange}
        />
      </aside>
    </div>
  );
};

const ThreeRoute = () => {
  const { plan } = useVisualizer();
  if (!plan) return <NoPlanCard />;
  return <ThreeView plan={plan} />;
};

export default ThreeRoute;

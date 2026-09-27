// "RAB" tab: Indonesian renovation estimate computed from the corrected plan.
// Owners persist inputs, overrides and wall height through ctx.updatePlan;
// viewers change local state only (nothing is saved). View gate: red banner
// while the scale is unconfirmed (numbers still shown). Export gate:
// rekap.exportGate (gateForRabExport).

import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { AlertTriangle } from "lucide-react";
import { useVisualizer } from "../../lib/visualizer.context";
import { computeRab } from "../../lib/rab/compute";
import { downloadCsv, rabCsvFilename, rabToCsv } from "../../lib/rab/csv";
import { planWallHeight, setPlanWallHeight } from "../../lib/rab/geometry";
import RabInputsPanel from "./RabInputs";
import RabRekap from "./RabRekap";
import RabTable from "./RabTable";

const NoPlanCard = () => (
  <div className="panel">
    <div className="placeholder-card">
      <p className="eyebrow">RAB</p>
      <h3>Belum ada denah</h3>
      <p>RAB dihitung dari denah. Buat atau ekstrak denah terlebih dahulu di tab Denah 2D.</p>
      <Link to="../plan" className="btn btn--primary btn--sm rab-empty-link">
        Buka Denah 2D
      </Link>
    </div>
  </div>
);

/** Merges one line override; null (or an all-null patch) removes the entry. */
const mergeOverride = (
  overrides: Record<string, RabLineOverride>,
  itemId: string,
  patch: RabLineOverride | null,
): Record<string, RabLineOverride> => {
  const next = { ...overrides };
  if (patch === null) {
    delete next[itemId];
    return next;
  }
  const merged: RabLineOverride = { ...next[itemId], ...patch };
  const clean: RabLineOverride = {};
  if (merged.volume !== null && merged.volume !== undefined) clean.volume = merged.volume;
  if (merged.harga !== null && merged.harga !== undefined) clean.harga = merged.harga;
  if (merged.enabled === false) clean.enabled = false;
  if (Object.keys(clean).length === 0) delete next[itemId];
  else next[itemId] = clean;
  return next;
};

const RabView = ({ plan }: { plan: FloorPlan }) => {
  const { isOwner, updatePlan, project, projectId } = useVisualizer();

  // Viewer-only local state (owners always read/write the plan).
  const [localInputs, setLocalInputs] = useState<RabInputs | null>(null);
  const [localHeight, setLocalHeight] = useState<number | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const effectivePlan = useMemo(
    () => (!isOwner && localHeight !== null ? setPlanWallHeight(plan, localHeight) : plan),
    [isOwner, localHeight, plan],
  );
  const inputs = isOwner ? plan.rab : (localInputs ?? plan.rab);

  const rekap = useMemo(() => computeRab(effectivePlan, inputs), [effectivePlan, inputs]);
  const wallHeight = useMemo(() => planWallHeight(effectivePlan), [effectivePlan]);

  const changeInputs = useCallback(
    (patch: Partial<RabInputs>) => {
      if (isOwner) {
        updatePlan((p) => ({ ...p, rab: { ...p.rab, ...patch } }));
      } else {
        setLocalInputs((prev) => ({ ...(prev ?? plan.rab), ...patch }));
      }
    },
    [isOwner, plan.rab, updatePlan],
  );

  const changeOverride = useCallback(
    (itemId: string, patch: RabLineOverride | null) => {
      if (isOwner) {
        updatePlan((p) => ({
          ...p,
          rab: { ...p.rab, overrides: mergeOverride(p.rab.overrides ?? {}, itemId, patch) },
        }));
      } else {
        setLocalInputs((prev) => {
          const base = prev ?? plan.rab;
          return { ...base, overrides: mergeOverride(base.overrides ?? {}, itemId, patch) };
        });
      }
    },
    [isOwner, plan.rab, updatePlan],
  );

  const changeWallHeight = useCallback(
    (height: number) => {
      if (isOwner) updatePlan((p) => setPlanWallHeight(p, height));
      else setLocalHeight(height);
    },
    [isOwner, updatePlan],
  );

  const handleExport = () => {
    if (!rekap.exportGate.ok) return;
    const name = project?.name || `Residence ${projectId}`;
    const csv = rabToCsv(rekap, effectivePlan, inputs, name);
    const ok = downloadCsv(csv, rabCsvFilename(name, rekap.priceVersion));
    setExportError(ok ? null : "Gagal membuat file CSV. Coba lagi.");
  };

  return (
    <div className="rab-route">
      <aside className="rab-side">
        <RabInputsPanel
          inputs={inputs}
          wallHeight={wallHeight}
          floorArea={rekap.quantities.floor_area}
          isOwner={isOwner}
          onChange={changeInputs}
          onWallHeightChange={changeWallHeight}
        />
      </aside>

      <div className="rab-main">
        {!plan.scale.confirmed && (
          <div className="rab-banner" role="alert">
            <AlertTriangle className="w-4 h-4 mr-2" />
            <div className="copy">
              <strong>Skala denah belum dikonfirmasi — angka bisa meleset jauh.</strong>
              <span>Kalibrasi atau konfirmasi skala di tab Denah 2D sebelum memakai angka ini.</span>
            </div>
            <Link to="../plan" className="btn btn--secondary btn--sm">
              Buka Denah 2D
            </Link>
          </div>
        )}

        <RabTable
          rekap={rekap}
          inputs={inputs}
          editable={isOwner}
          onOverride={changeOverride}
        />
        <RabRekap rekap={rekap} inputs={inputs} onExport={handleExport} />

        {exportError && (
          <p className="rab-error" role="alert">
            {exportError}
          </p>
        )}
      </div>
    </div>
  );
};

const RabRoute = () => {
  const { plan } = useVisualizer();
  if (!plan) return <NoPlanCard />;
  return <RabView plan={plan} />;
};

export default RabRoute;

import { useVisualizer } from "../../lib/visualizer.context";
import ExtractPanel from "./ExtractPanel";
import PlanEditor from "./PlanEditor";

// "Denah 2D" tab: the owner extracts a plan when none exists, then everyone
// sees the editor (read-only for viewers).

const PlanRoute = () => {
  const ctx = useVisualizer();

  if (!ctx.plan) {
    // The shell already shows the "Denah rusak" card (with the owner reset).
    if (ctx.planCorrupt) return null;

    if (ctx.isOwner) return <ExtractPanel onPlanReady={ctx.setPlan} />;

    return (
      <div className="panel">
        <div className="placeholder-card">
          <p className="eyebrow">Denah 2D</p>
          <h3>Denah belum tersedia</h3>
          <p>Pemilik proyek belum membuat denah 2D untuk gambar ini.</p>
        </div>
      </div>
    );
  }

  return <PlanEditor key={ctx.projectId} readOnly={!ctx.isOwner} />;
};

export default PlanRoute;

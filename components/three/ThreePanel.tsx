// Side panel of the 3D route: plan-wide floor / wall materials and a
// per-room floor override. Plain React (no three imports); writes go through
// the shell's updatePlan. Viewers can pick a room (label highlight) but not
// change materials.

import { FLOOR_MATERIALS, WALL_MATERIALS, materialById } from "../../lib/plan/materials";

interface ThreePanelProps {
  plan: FloorPlan;
  readOnly: boolean;
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string | null) => void;
  onUpdatePlan: (updater: (plan: FloorPlan) => FloorPlan) => void;
}

const ThreePanel = ({
  plan,
  readOnly,
  selectedRoomId,
  onSelectRoom,
  onUpdatePlan,
}: ThreePanelProps) => {
  const rooms = plan.rooms.filter((r) => !r.stale);
  const room = rooms.find((r) => r.id === selectedRoomId) ?? null;
  const defaultFloor = materialById(plan.materials.floor, "floor");

  const setDefaultFloor = (id: string) =>
    onUpdatePlan((p) => ({ ...p, materials: { ...p.materials, floor: id } }));

  const setWall = (id: string) =>
    onUpdatePlan((p) => ({ ...p, materials: { ...p.materials, wall: id } }));

  const setRoomFloor = (roomId: string, id: string) =>
    onUpdatePlan((p) => ({
      ...p,
      rooms: p.rooms.map((r) =>
        r.id === roomId ? { ...r, floorMaterialId: id || null } : r,
      ),
    }));

  return (
    <section className="panel three-panel" aria-label="Material">
      <div className="panel-title">
        <p className="eyebrow">Material</p>
        <h3>Lantai &amp; dinding</h3>
      </div>

      <label className="field">
        <span>Lantai bawaan</span>
        <select
          value={defaultFloor.id}
          disabled={readOnly}
          onChange={(e) => setDefaultFloor(e.target.value)}
        >
          {FLOOR_MATERIALS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Dinding (seluruh rumah)</span>
        <select
          value={materialById(plan.materials.wall, "wall").id}
          disabled={readOnly}
          onChange={(e) => setWall(e.target.value)}
        >
          {WALL_MATERIALS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      <div className="divider" />

      <label className="field">
        <span>Ruangan</span>
        <select
          value={room?.id ?? ""}
          disabled={rooms.length === 0}
          onChange={(e) => onSelectRoom(e.target.value || null)}
        >
          <option value="">
            {rooms.length === 0 ? "Belum ada ruangan" : "Pilih ruangan…"}
          </option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name || "Ruangan"}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Lantai ruangan</span>
        <select
          value={room?.floorMaterialId ?? ""}
          disabled={readOnly || !room}
          onChange={(e) => room && setRoomFloor(room.id, e.target.value)}
        >
          <option value="">Ikuti bawaan ({defaultFloor.name})</option>
          {FLOOR_MATERIALS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      {readOnly && (
        <p className="note">Hanya pemilik proyek yang dapat mengubah material.</p>
      )}
    </section>
  );
};

export default ThreePanel;

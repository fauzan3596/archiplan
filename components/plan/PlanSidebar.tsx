import type { Dispatch } from "react";
import {
  AlertTriangle,
  CircleAlert,
  RotateCcw,
  Scissors,
  Trash2,
  Wrench,
} from "lucide-react";
import { openingWidth, polygonArea, wallLength } from "../../lib/plan/convert";
import {
  MAX_WALL_THICKNESS,
  MIN_WALL_THICKNESS,
  ROOM_TYPE_LABELS,
} from "../../lib/plan/defaults";
import {
  MAX_WALL_HEIGHT_M,
  MIN_OPENING_WIDTH_M,
  MIN_WALL_HEIGHT_M,
} from "../../lib/plan/editor";
import type { EditorAction, EditorSelection, EditorState } from "../../lib/plan/editor";
import {
  FLOOR_MATERIALS,
  WALL_MATERIALS,
  materialById,
} from "../../lib/plan/materials";
import { CommitNumberInput, CommitTextInput } from "./PlanToolbar";

interface PlanSidebarProps {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  readOnly: boolean;
  onResetPlan?: () => void;
}

const fmt = (n: number, digits = 2) =>
  n.toLocaleString("id-ID", { maximumFractionDigits: digits });

const METHOD_LABELS: Record<PlanScaleMethod, string> = {
  dimension_labels: "Label ukuran pada gambar",
  overall_dimension: "Ukuran total bangunan",
  door_prior: "Perkiraan dari lebar pintu",
  thickness_prior: "Perkiraan dari tebal dinding",
  bbox_prior: "Perkiraan kasar (lebar 10 m)",
  manual: "Kalibrasi manual",
};

const OPENING_LABELS: Record<PlanOpeningKind, string> = {
  door: "Pintu",
  window: "Jendela",
  opening: "Bukaan (tanpa daun)",
};

const DOOR_SUBTYPE_LABELS: Record<PlanDoorSubtype, string> = {
  kamar: "Pintu kamar",
  kamar_mandi: "Pintu kamar mandi",
  utama: "Pintu utama",
};

const ROOM_TYPES = Object.keys(ROOM_TYPE_LABELS) as PlanRoomType[];
const OPENING_KINDS = Object.keys(OPENING_LABELS) as PlanOpeningKind[];
const DOOR_SUBTYPES = Object.keys(DOOR_SUBTYPE_LABELS) as PlanDoorSubtype[];

/** First issue id that names an element of the plan, as an editor selection. */
const selectionForIssue = (plan: FloorPlan, issue: PlanIssue): EditorSelection => {
  for (const id of [...(issue.ids ?? []), ...(issue.fix?.ids ?? [])]) {
    if (plan.walls.some((w) => w.id === id)) return { kind: "wall", id };
    if (plan.openings.some((o) => o.id === id)) return { kind: "opening", id };
    if (plan.rooms.some((r) => r.id === id)) return { kind: "room", id };
  }
  return null;
};

const WallProps = ({
  wall,
  dispatch,
  readOnly,
}: {
  wall: PlanWall;
  dispatch: Dispatch<EditorAction>;
  readOnly: boolean;
}) => {
  const mid = { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 };
  return (
    <>
      <p className="eyebrow">Dinding</p>
      <dl className="facts">
        <dt>Panjang</dt>
        <dd>{fmt(wallLength(wall))} m</dd>
      </dl>
      <label className="field">
        <span>Tebal (m)</span>
        <CommitNumberInput
          value={wall.thickness}
          min={MIN_WALL_THICKNESS}
          max={MAX_WALL_THICKNESS}
          step={0.01}
          disabled={readOnly}
          label="Tebal dinding (m)"
          onCommit={(thickness) =>
            dispatch({ type: "SET_WALL", id: wall.id, patch: { thickness } })
          }
        />
      </label>
      <label className="field">
        <span>Tinggi (m)</span>
        <CommitNumberInput
          value={wall.height}
          min={MIN_WALL_HEIGHT_M}
          max={MAX_WALL_HEIGHT_M}
          step={0.1}
          disabled={readOnly}
          label="Tinggi dinding ini (m)"
          onCommit={(height) => dispatch({ type: "SET_WALL", id: wall.id, patch: { height } })}
        />
      </label>
      {!readOnly && (
        <div className="side-actions">
          <button
            type="button"
            className="tool"
            onClick={() => dispatch({ type: "SPLIT_WALL", wallId: wall.id, point: mid })}
          >
            <Scissors className="w-4 h-4" />
            <span className="label">Bagi dua</span>
          </button>
          <button
            type="button"
            className="tool is-danger"
            onClick={() => dispatch({ type: "DELETE_SELECTED" })}
          >
            <Trash2 className="w-4 h-4" />
            <span className="label">Hapus</span>
          </button>
        </div>
      )}
    </>
  );
};

const OpeningProps = ({
  opening,
  wall,
  dispatch,
  readOnly,
}: {
  opening: PlanOpening;
  wall: PlanWall;
  dispatch: Dispatch<EditorAction>;
  readOnly: boolean;
}) => (
  <>
    <p className="eyebrow">{OPENING_LABELS[opening.kind]}</p>
    <label className="field">
      <span>Jenis</span>
      <select
        value={opening.kind}
        disabled={readOnly}
        onChange={(e) =>
          dispatch({
            type: "SET_OPENING",
            id: opening.id,
            patch: { kind: e.target.value as PlanOpeningKind },
          })
        }
      >
        {OPENING_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {OPENING_LABELS[kind]}
          </option>
        ))}
      </select>
    </label>
    {opening.kind === "door" && (
      <label className="field">
        <span>Tipe pintu</span>
        <select
          value={opening.doorSubtype ?? ""}
          disabled={readOnly}
          onChange={(e) =>
            dispatch({
              type: "SET_OPENING",
              id: opening.id,
              patch: {
                doorSubtype: e.target.value ? (e.target.value as PlanDoorSubtype) : null,
              },
            })
          }
        >
          <option value="">Otomatis</option>
          {DOOR_SUBTYPES.map((s) => (
            <option key={s} value={s}>
              {DOOR_SUBTYPE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
    )}
    <label className="field">
      <span>Lebar (m)</span>
      <CommitNumberInput
        value={openingWidth(opening, wall)}
        min={MIN_OPENING_WIDTH_M}
        max={wallLength(wall)}
        step={0.05}
        disabled={readOnly}
        label="Lebar bukaan (m)"
        onCommit={(width) => dispatch({ type: "SET_OPENING", id: opening.id, patch: { width } })}
      />
    </label>
    <div className="field-pair">
      <label className="field">
        <span>Bawah (m)</span>
        <CommitNumberInput
          value={opening.bottom}
          min={0}
          max={wall.height}
          step={0.05}
          disabled={readOnly}
          label="Tinggi bawah bukaan (m)"
          onCommit={(bottom) =>
            dispatch({ type: "SET_OPENING", id: opening.id, patch: { bottom } })
          }
        />
      </label>
      <label className="field">
        <span>Atas (m)</span>
        <CommitNumberInput
          value={opening.top}
          min={0}
          max={wall.height}
          step={0.05}
          disabled={readOnly}
          label="Tinggi atas bukaan (m)"
          onCommit={(top) => dispatch({ type: "SET_OPENING", id: opening.id, patch: { top } })}
        />
      </label>
    </div>
    {!readOnly && (
      <div className="side-actions">
        <button
          type="button"
          className="tool is-danger"
          onClick={() => dispatch({ type: "DELETE_SELECTED" })}
        >
          <Trash2 className="w-4 h-4" />
          <span className="label">Hapus</span>
        </button>
      </div>
    )}
  </>
);

const RoomProps = ({
  room,
  plan,
  dispatch,
  readOnly,
}: {
  room: PlanRoom;
  plan: FloorPlan;
  dispatch: Dispatch<EditorAction>;
  readOnly: boolean;
}) => {
  const defaultFloor = materialById(plan.materials.floor, "floor");
  return (
    <>
      <p className="eyebrow">Ruangan</p>
      {room.stale && (
        <p className="stale-note">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Ruangan terputus dari dinding. Sambungkan kembali dindingnya atau pilih
          &quot;Bangun ulang ruangan&quot;.
        </p>
      )}
      <label className="field">
        <span>Nama</span>
        <CommitTextInput
          value={room.name}
          disabled={readOnly}
          label="Nama ruangan"
          placeholder="Nama ruangan"
          onCommit={(name) => dispatch({ type: "RENAME_ROOM", id: room.id, name })}
        />
      </label>
      <label className="field">
        <span>Jenis</span>
        <select
          value={room.type ?? ""}
          disabled={readOnly}
          onChange={(e) =>
            dispatch({
              type: "SET_ROOM_TYPE",
              id: room.id,
              roomType: e.target.value ? (e.target.value as PlanRoomType) : null,
            })
          }
        >
          <option value="">Belum ditentukan</option>
          {ROOM_TYPES.map((t) => (
            <option key={t} value={t}>
              {ROOM_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Lantai</span>
        <select
          value={room.floorMaterialId ?? ""}
          disabled={readOnly}
          onChange={(e) =>
            dispatch({
              type: "SET_ROOM_FLOOR_MATERIAL",
              id: room.id,
              materialId: e.target.value || null,
            })
          }
        >
          <option value="">Default ({defaultFloor.name})</option>
          {FLOOR_MATERIALS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <dl className="facts">
        <dt>Luas</dt>
        <dd>{room.stale ? "—" : `${fmt(polygonArea(room.polygon))} m²`}</dd>
      </dl>
      {!readOnly && (
        <p className="hint">Seret label ruangan pada denah untuk memindahkannya.</p>
      )}
      {!readOnly && room.stale && (
        <div className="side-actions">
          <button
            type="button"
            className="tool is-danger"
            onClick={() => dispatch({ type: "DELETE_SELECTED" })}
          >
            <Trash2 className="w-4 h-4" />
            <span className="label">Hapus ruangan</span>
          </button>
        </div>
      )}
    </>
  );
};

const PlanSidebar = ({ state, dispatch, readOnly, onResetPlan }: PlanSidebarProps) => {
  const { plan, selection, issues } = state;

  const selectedWall =
    selection?.kind === "wall" ? plan.walls.find((w) => w.id === selection.id) : undefined;
  const selectedOpening =
    selection?.kind === "opening"
      ? plan.openings.find((o) => o.id === selection.id)
      : undefined;
  const openingWall = selectedOpening
    ? plan.walls.find((w) => w.id === selectedOpening.wallId)
    : undefined;
  const selectedRoom =
    selection?.kind === "room" ? plan.rooms.find((r) => r.id === selection.id) : undefined;

  const safeCount = issues.filter((i) => i.fix?.safe).length;
  const liveRooms = plan.rooms.filter((r) => !r.stale);
  const totalArea = liveRooms.reduce((sum, r) => sum + polygonArea(r.polygon), 0);

  return (
    <aside className="plan-side">
      <section className="side-card selection">
        {selectedWall ? (
          <WallProps wall={selectedWall} dispatch={dispatch} readOnly={readOnly} />
        ) : selectedOpening && openingWall ? (
          <OpeningProps
            opening={selectedOpening}
            wall={openingWall}
            dispatch={dispatch}
            readOnly={readOnly}
          />
        ) : selectedRoom ? (
          <RoomProps room={selectedRoom} plan={plan} dispatch={dispatch} readOnly={readOnly} />
        ) : (
          <>
            <p className="eyebrow">Properti</p>
            <p className="hint">
              Pilih dinding, bukaan, atau ruangan pada denah untuk melihat
              {readOnly ? "" : " dan mengubah"} propertinya.
            </p>
          </>
        )}
      </section>

      <section className="side-card issues">
        <div className="card-head">
          <p className="eyebrow">Masalah ({issues.length})</p>
          {!readOnly && safeCount > 0 && (
            <button
              type="button"
              className="issue-fix is-all"
              onClick={() => dispatch({ type: "APPLY_SAFE_FIXES" })}
            >
              <Wrench className="w-3.5 h-3.5 mr-1" />
              Perbaiki semua yang aman
            </button>
          )}
        </div>
        {issues.length === 0 ? (
          <p className="hint">Tidak ada masalah terdeteksi.</p>
        ) : (
          <ul className="issue-list">
            {issues.map((issue, index) => {
              const target = selectionForIssue(plan, issue);
              return (
                <li
                  key={`${issue.code}-${index}`}
                  className={`issue severity-${issue.severity}`}
                >
                  <button
                    type="button"
                    className="issue-main"
                    disabled={!target}
                    onClick={() => target && dispatch({ type: "SELECT", selection: target })}
                  >
                    {issue.severity === "error" ? (
                      <CircleAlert className="w-4 h-4 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                    )}
                    <span>{issue.message}</span>
                  </button>
                  {!readOnly && issue.fix && (
                    <button
                      type="button"
                      className={`issue-fix${issue.fix.safe ? "" : " is-unsafe"}`}
                      title={issue.fix.safe ? "Perbaikan aman" : "Perbaikan ini menghapus elemen"}
                      onClick={() => dispatch({ type: "APPLY_FIX", issueIndex: index })}
                    >
                      {issue.fix.label}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="side-card scale">
        <div className="card-head">
          <p className="eyebrow">Skala</p>
          <span className={`scale-badge ${plan.scale.confirmed ? "is-ok" : "is-warn"}`}>
            {plan.scale.confirmed ? "Terkonfirmasi" : "Belum dikonfirmasi"}
          </span>
        </div>
        <dl className="facts">
          <dt>Metode</dt>
          <dd>{METHOD_LABELS[plan.scale.method]}</dd>
          <dt>Keyakinan</dt>
          <dd>{fmt(plan.scale.confidence * 100, 0)}%</dd>
          <dt>Resolusi</dt>
          <dd>{fmt(plan.scale.pxPerMeter, 1)} px/m</dd>
        </dl>
      </section>

      <section className="side-card rooms">
        <p className="eyebrow">Ruangan ({liveRooms.length})</p>
        {plan.rooms.length === 0 ? (
          <p className="hint">Belum ada ruangan. Tutup dinding lalu pilih &quot;Bangun ulang ruangan&quot;.</p>
        ) : (
          <ul className="room-list">
            {plan.rooms.map((room) => {
              const active = selection?.kind === "room" && selection.id === room.id;
              return (
                <li key={room.id}>
                  <button
                    type="button"
                    className={`room${room.stale ? " is-stale" : ""}${active ? " is-active" : ""}`}
                    onClick={() =>
                      dispatch({ type: "SELECT", selection: { kind: "room", id: room.id } })
                    }
                  >
                    <span className="name">
                      {room.name || "Tanpa nama"}
                      <small>
                        {room.stale
                          ? "ruangan terputus"
                          : room.type
                            ? ROOM_TYPE_LABELS[room.type]
                            : "Jenis belum ditentukan"}
                      </small>
                    </span>
                    <span className="area">
                      {room.stale ? "—" : `${fmt(polygonArea(room.polygon))} m²`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="total">
          <span>Total luas</span>
          <strong>{fmt(totalArea)} m²</strong>
        </div>
      </section>

      <section className="side-card materials">
        <p className="eyebrow">Material default</p>
        <label className="field">
          <span>Lantai</span>
          <select
            value={plan.materials.floor}
            disabled={readOnly}
            onChange={(e) =>
              dispatch({ type: "SET_DEFAULT_MATERIALS", patch: { floor: e.target.value } })
            }
          >
            {FLOOR_MATERIALS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Dinding</span>
          <select
            value={plan.materials.wall}
            disabled={readOnly}
            onChange={(e) =>
              dispatch({ type: "SET_DEFAULT_MATERIALS", patch: { wall: e.target.value } })
            }
          >
            {WALL_MATERIALS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      {!readOnly && onResetPlan && (
        <button type="button" className="reset-plan" onClick={onResetPlan}>
          <RotateCcw className="w-4 h-4 mr-2" />
          Mulai ulang denah dari awal
        </button>
      )}
    </aside>
  );
};

export default PlanSidebar;

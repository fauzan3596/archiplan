import { Html } from "@react-three/drei";

interface RoomLabelProps {
  name: string;
  /** world position (plan anchor at floor level) */
  position: [number, number, number];
  areaM2?: number | null;
  selected?: boolean;
}

const areaFormat = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });

// DOM label (no font download, no troika). Orbit mode only: it is not
// occluded, so it would float through walls during the walkthrough.
const RoomLabel = ({ name, position, areaM2, selected = false }: RoomLabelProps) => (
  <Html
    position={position}
    center
    distanceFactor={12}
    zIndexRange={[20, 0]}
    pointerEvents="none"
  >
    <div className={`room-label ${selected ? "is-selected" : ""}`}>
      <span className="name">{name || "Ruangan"}</span>
      {areaM2 ? (
        <span className="area">{areaFormat.format(areaM2)} m²</span>
      ) : null}
    </div>
  </Html>
);

export default RoomLabel;

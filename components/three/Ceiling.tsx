import type * as THREE from "three";
import { useEffect, useMemo } from "react";
import type { RoomSpec } from "../../lib/plan/convert";
import { buildCeilingGeometry } from "./floor-geometry";

interface CeilingProps {
  room: RoomSpec;
  /** metres; the slab sits on top of the walls */
  height: number;
  material: THREE.Material;
  /** walk mode only; hidden (but still exported) in orbit mode */
  visible: boolean;
}

const Ceiling = ({ room, height, material, visible }: CeilingProps) => {
  const polygonKey = JSON.stringify(room.polygon);
  const geometry = useMemo(() => buildCeilingGeometry(room.polygon), [polygonKey]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Faces down; its back side is drawn into the shadow map, so it shades the
  // interior from the sun while walking.
  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[0, height, 0]}
      visible={visible}
      castShadow
      userData={{ ceilingOf: room.id }}
    />
  );
};

export default Ceiling;

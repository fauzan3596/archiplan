import type * as THREE from "three";
import { useEffect, useMemo } from "react";
import type { RoomSpec } from "../../lib/plan/convert";
import { buildFloorGeometry } from "./floor-geometry";

interface FloorProps {
  room: RoomSpec;
  /** from useMaterials().get(room.floorMaterialId, "floor"); UVs are metres */
  material: THREE.Material;
}

const Floor = ({ room, material }: FloorProps) => {
  const polygonKey = JSON.stringify(room.polygon);
  const geometry = useMemo(() => buildFloorGeometry(room.polygon), [polygonKey]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh
      geometry={geometry}
      material={material}
      receiveShadow
      userData={{ roomId: room.id }}
    />
  );
};

export default Floor;

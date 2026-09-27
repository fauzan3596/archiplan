import type * as THREE from "three";
import { useEffect, useMemo } from "react";
import type { WallSpec } from "../../lib/plan/convert";
import { buildWallGeometry, wallTransform } from "./wall-geometry";

interface WallProps {
  spec: WallSpec;
  /** single material, or [faceMaterial, edgeMaterial] (ExtrudeGeometry groups 0 = faces, 1 = edges) */
  material: THREE.Material | THREE.Material[];
}

const Wall = ({ spec, material }: WallProps) => {
  // Every plan edit or save response yields new WallSpec objects; rebuild the
  // geometry only when this wall's numbers actually changed.
  const specKey = JSON.stringify(spec);
  const geometry = useMemo(() => buildWallGeometry(spec), [specKey]);
  // Geometry created outside JSX is not auto-disposed by r3f.
  useEffect(() => () => geometry.dispose(), [geometry]);
  const { position, rotationY } = wallTransform(spec);

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={position}
      rotation={[0, rotationY, 0]}
      castShadow
      receiveShadow
      userData={{ wallId: spec.id }}
    />
  );
};

export default Wall;

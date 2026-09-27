// Frames for the cut-outs made by wall-geometry.ts. Window: 4 frame boxes +
// a 35 %-opacity pane (no transmission pass). Door: two jambs + a head over a
// walkable void. Passage ("opening"): nothing.

import type * as THREE from "three";
import type { SceneOpening, WallSpec } from "../../lib/plan/convert";
import { wallTransform } from "./wall-geometry";

export interface OpeningMaterials {
  windowFrame: THREE.Material;
  doorFrame: THREE.Material;
  glass: THREE.Material;
}

interface OpeningMeshProps {
  wall: WallSpec;
  opening: SceneOpening;
  materials: OpeningMaterials;
}

const FRAME = 0.05;
const PANE = 0.01;

interface BoxProps {
  position: [number, number, number];
  size: [number, number, number];
  material: THREE.Material;
  shadow?: boolean;
}

const Box = ({ position, size, material, shadow = true }: BoxProps) => (
  <mesh
    position={position}
    material={material}
    castShadow={shadow}
    receiveShadow={shadow}
  >
    <boxGeometry args={size} />
  </mesh>
);

const OpeningMesh = ({ wall, opening, materials }: OpeningMeshProps) => {
  if (opening.kind === "opening") return null;

  const length = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
  const u0 = opening.t0 * length;
  const u1 = opening.t1 * length;
  const w = u1 - u0;
  const h = opening.top - opening.bottom;
  if (w <= 0.02 || h <= 0.02) return null;

  const f = Math.min(FRAME, w / 4, h / 4);
  // Slightly proud of both wall faces so the frame reads as a separate part.
  const depth = wall.thickness + 0.02;
  const mid = u0 + w / 2;
  const midV = opening.bottom + h / 2;
  const { position, rotationY } = wallTransform(wall);

  // Local frame (same as the wall mesh): x = along the wall, y = up, z = across.
  return (
    <group
      position={position}
      rotation={[0, rotationY, 0]}
      userData={{ openingId: opening.id }}
    >
      {opening.kind === "window" ? (
        <>
          <Box position={[u0 + f / 2, midV, 0]} size={[f, h, depth]} material={materials.windowFrame} />
          <Box position={[u1 - f / 2, midV, 0]} size={[f, h, depth]} material={materials.windowFrame} />
          <Box position={[mid, opening.bottom + f / 2, 0]} size={[w - 2 * f, f, depth]} material={materials.windowFrame} />
          <Box position={[mid, opening.top - f / 2, 0]} size={[w - 2 * f, f, depth]} material={materials.windowFrame} />
          <Box
            position={[mid, midV, 0]}
            size={[w - 2 * f, h - 2 * f, PANE]}
            material={materials.glass}
            shadow={false}
          />
        </>
      ) : (
        <>
          <Box position={[u0 + f / 2, midV, 0]} size={[f, h, depth]} material={materials.doorFrame} />
          <Box position={[u1 - f / 2, midV, 0]} size={[f, h, depth]} material={materials.doorFrame} />
          <Box position={[mid, opening.top - f / 2, 0]} size={[w - 2 * f, f, depth]} material={materials.doorFrame} />
        </>
      )}
    </group>
  );
};

export default OpeningMesh;

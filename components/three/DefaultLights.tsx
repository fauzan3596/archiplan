// Fallback lighting when HouseCanvas gets no `lights` slot: ambient +
// hemisphere + one shadow-casting sun whose orthographic shadow frustum is
// fitted to the plan bounds.

import type * as THREE from "three";
import { useEffect, useRef } from "react";

interface DefaultLightsProps {
  /** scene.center, [x, 0, z] */
  center: [number, number, number];
  /** largest plan dimension, metres */
  extent: number;
  /** tallest wall, metres */
  height?: number;
}

// Morning sun from the south-east-ish, normalised below.
const SUN_DIR: [number, number, number] = [0.55, 0.75, 0.37];

const DefaultLights = ({ center, extent, height = 3 }: DefaultLightsProps) => {
  const sun = useRef<THREE.DirectionalLight>(null);
  const [cx, cy, cz] = center;

  // Bounding radius of the house (half diagonal plus wall height) + margin.
  const radius = Math.max(4, Math.hypot(extent, extent) / 2 + height + 1);
  const len = Math.hypot(...SUN_DIR);
  const distance = radius * 2;
  const position: [number, number, number] = [
    cx + (SUN_DIR[0] / len) * distance,
    cy + (SUN_DIR[1] / len) * distance,
    cz + (SUN_DIR[2] / len) * distance,
  ];

  useEffect(() => {
    const light = sun.current;
    if (!light) return;
    // The target is not in the scene graph, so update its matrix by hand.
    light.target.position.set(cx, cy, cz);
    light.target.updateMatrixWorld();
    light.shadow.camera.updateProjectionMatrix();
  }, [cx, cy, cz, radius]);

  return (
    <>
      <ambientLight intensity={0.35} />
      <hemisphereLight args={["#dfe9ff", "#8a7a60", 0.6]} />
      <directionalLight
        ref={sun}
        position={position}
        intensity={2.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-radius}
        shadow-camera-right={radius}
        shadow-camera-top={radius}
        shadow-camera-bottom={-radius}
        shadow-camera-near={0.5}
        shadow-camera-far={distance + radius * 2}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      />
    </>
  );
};

export default DefaultLights;

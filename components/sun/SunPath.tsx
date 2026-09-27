// Sun arc + sun sphere + compass rose. Port of the verified research sketch; changes:
// imports, GPU disposal of the arc line, a drei <Html> "U" label on the compass.
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type {} from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { sunPathPoints, type SunPath as SunPathData } from "../../lib/sun/sunDirection";

export interface SunPathProps {
  path: SunPathData;
  /** current sun direction (unit) - the sphere is drawn here when above the horizon */
  sunDir: THREE.Vector3;
  center: THREE.Vector3;
  /** e.g. building radius * 2.5 */
  radius: number;
}

export const SunPathArc = ({ path, sunDir, center, radius }: SunPathProps) => {
  const line = useMemo(() => {
    const pts = sunPathPoints(path, radius, center);
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineDashedMaterial({ color: "#ffb347", dashSize: 0.4, gapSize: 0.2, toneMapped: false });
    const l = new THREE.Line(geom, mat);
    l.computeLineDistances();
    return l;
  }, [path, radius, center]);

  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    },
    [line],
  );

  const sunPos = useMemo(() => sunDir.clone().multiplyScalar(radius).add(center), [sunDir, radius, center]);
  const above = sunDir.y > 0;

  return (
    <group>
      <primitive object={line} />
      {/* hourly tick dots */}
      {path.arc.map((s, i) =>
        s.minutesOfDay % 60 === 0 ? (
          <mesh key={i} position={s.dir.clone().multiplyScalar(radius).add(center)}>
            <sphereGeometry args={[radius * 0.008, 8, 8]} />
            <meshBasicMaterial color="#ffe0a3" toneMapped={false} />
          </mesh>
        ) : null,
      )}
      {above && (
        <mesh position={sunPos}>
          <sphereGeometry args={[radius * 0.035, 24, 24]} />
          <meshBasicMaterial color="#ffd27a" toneMapped={false} />
        </mesh>
      )}
    </group>
  );
};

export interface CompassRoseProps {
  center: THREE.Vector3;
  radius: number;
  /** bearing of plan-up; the rose rotates so its N arrow points to true north */
  northOffsetDeg: number;
}

/**
 * True north in scene coords is (-sin th, 0, -cos th) where th = northOffset (rad).
 * Rotating a group whose local -Z arrow means "N" by rotation.y = +th yields exactly that.
 */
export const CompassRose = ({ center, radius, northOffsetDeg }: CompassRoseProps) => {
  const th = THREE.MathUtils.degToRad(northOffsetDeg);
  return (
    <group position={[center.x, 0.02, center.z]} rotation-y={th}>
      <mesh rotation-x={-Math.PI / 2}>
        <ringGeometry args={[radius * 0.96, radius, 64]} />
        <meshBasicMaterial color="#94a3b8" transparent opacity={0.6} toneMapped={false} />
      </mesh>
      {/* N arrow along local -Z */}
      <mesh position={[0, 0, -radius * 0.9]} rotation-x={-Math.PI / 2}>
        <coneGeometry args={[radius * 0.05, radius * 0.16, 3]} />
        <meshBasicMaterial color="#ef4444" toneMapped={false} />
      </mesh>
      <Html position={[0, 0, -radius * 1.08]} center zIndexRange={[20, 0]} className="sun-compass-label">
        U
      </Html>
      {/* E / S / W ticks */}
      {([0, 90, 180] as const).map((deg) => (
        <mesh
          key={deg}
          position={[
            Math.sin(THREE.MathUtils.degToRad(90 + deg)) * radius * 0.92,
            0,
            -Math.cos(THREE.MathUtils.degToRad(90 + deg)) * radius * 0.92,
          ]}
        >
          <boxGeometry args={[radius * 0.04, 0.01, radius * 0.04]} />
          <meshBasicMaterial color="#cbd5e1" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
};

export default SunPathArc;

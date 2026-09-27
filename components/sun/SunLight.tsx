// Sun (or moon) DirectionalLight with a shadow camera fitted to the building, plus the
// hemisphere/ambient fill from lightingForAltitude (React Three Fiber v9, three r186).
// Port of the verified research sketch; changes: imports, default export, the
// demand-frameloop invalidate, and hemisphere colours passed as props.
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { lightingForAltitude, moonLight, sunAngles, sunDirection } from "../../lib/sun/sunDirection";

export interface SunLightProps {
  /** absolute instant (build with localToInstant / sunInstant) */
  date: Date;
  lat: number;
  lng: number;
  northOffsetDeg: number;
  /** building bounds in scene units (metres) - the shadow camera is fitted to this */
  bounds: THREE.Box3;
  /** default 2048 */
  shadowMapSize?: number;
}

const SunLight = ({ date, lat, lng, northOffsetDeg, bounds, shadowMapSize = 2048 }: SunLightProps) => {
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  const invalidate = useThree((s) => s.invalidate);

  const { center, radius } = useMemo(() => {
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    return { center: sphere.center.clone(), radius: Math.max(sphere.radius, 1) };
  }, [bounds]);

  const state = useMemo(() => {
    const { altitudeDeg } = sunAngles(date, lat, lng);
    const lighting = lightingForAltitude(altitudeDeg);
    const distance = radius * 3;
    if (altitudeDeg > 0) {
      const dir = sunDirection(date, lat, lng, northOffsetDeg);
      return { lighting, dir, color: lighting.sunColor, intensity: lighting.sunIntensity, distance };
    }
    const moon = moonLight(date, lat, lng, northOffsetDeg);
    return moon
      ? { lighting, dir: moon.dir, color: moon.color, intensity: moon.intensity, distance }
      : { lighting, dir: new THREE.Vector3(0, 1, 0), color: "#000000", intensity: 0, distance };
  }, [date, lat, lng, northOffsetDeg, radius]);

  const position = useMemo(
    () => state.dir.clone().multiplyScalar(state.distance).add(center),
    [state, center],
  );

  // Fit the orthographic shadow frustum around the building; near/far along the light ray.
  useEffect(() => {
    const light = lightRef.current;
    if (!light) return;
    light.target = target;
    const cam = light.shadow.camera;
    const half = radius * 1.15;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 0.1;
    cam.far = state.distance + radius * 2;
    cam.updateProjectionMatrix();
    light.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    light.shadow.map?.dispose(); // force re-allocation if the size changed
    light.shadow.map = null;
    invalidate();
  }, [radius, state.distance, shadowMapSize, target, invalidate]);

  const { lighting } = state;
  return (
    <>
      <directionalLight
        ref={lightRef}
        position={position}
        color={state.color}
        intensity={state.intensity}
        castShadow
        shadow-bias={-0.0003}
        shadow-normalBias={0.03}
        shadow-radius={2}
      />
      <primitive object={target} position={center} />
      {/* props instead of args so the light is updated in place, not rebuilt per slider step */}
      <hemisphereLight
        color={lighting.hemiSkyColor}
        groundColor={lighting.hemiGroundColor}
        intensity={lighting.hemiIntensity}
      />
      <ambientLight intensity={lighting.ambientIntensity} />
    </>
  );
};

export default SunLight;

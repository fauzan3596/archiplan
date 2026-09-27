// Fills HouseCanvas's `lights` slot: the sun/moon light fitted to the building, the
// day's sun arc and the compass rose (per the plan's toggles), and a sky-coloured
// background. Must render inside an R3F <Canvas>. The building never rotates:
// northOffsetDeg only rotates the sun direction and the compass.

import { useMemo } from "react";
import * as THREE from "three";
import type {} from "@react-three/fiber";
import type { SceneModel } from "../../lib/plan/convert";
import { cityById, dayFromDateISO, localToInstant } from "../../lib/sun/geo";
import { lightingForAltitude, sunAngles, sunDirection, sunPathForDay } from "../../lib/sun/sunDirection";
import SunLight from "./SunLight";
import { CompassRose, SunPathArc } from "./SunPath";

interface SunRigProps {
  plan: FloorPlan;
  scene: SceneModel;
  sun: SunSettings;
}

/** Minimum building radius (m) so an empty plan still gets a usable arc and compass. */
const MIN_RADIUS = 4;

const SunRig = ({ plan, scene, sun }: SunRigProps) => {
  const north = plan.northOffsetDeg;
  const city = cityById(sun.cityId);
  const day = useMemo(() => dayFromDateISO(sun.dateISO), [sun.dateISO]);
  const minutes = Number.isFinite(sun.minutesOfDay) ? sun.minutesOfDay : 600;
  const date = useMemo(() => localToInstant(day, minutes, city.zone), [day, minutes, city]);

  const { minX, minY, maxX, maxY } = scene.bounds;
  const height = scene.height;
  // Plan (x, y) -> world (x, 0, z = y); walls stand from y = 0 to the tallest wall.
  const bounds = useMemo(
    () => new THREE.Box3(new THREE.Vector3(minX, 0, minY), new THREE.Vector3(maxX, height, maxY)),
    [minX, minY, maxX, maxY, height],
  );

  const { center, radius } = useMemo(
    () => ({
      center: new THREE.Vector3((minX + maxX) / 2, 0, (minY + maxY) / 2),
      radius: Math.max(Math.hypot(maxX - minX, maxY - minY) / 2, MIN_RADIUS),
    }),
    [minX, minY, maxX, maxY],
  );

  // The arc depends on the day, city and north only - never on the time of day.
  const path = useMemo(
    () => sunPathForDay(day, city.lat, city.lng, city.zone, north, 15),
    [day, city, north],
  );

  const sunDir = useMemo(() => sunDirection(date, city.lat, city.lng, north), [date, city, north]);
  const lighting = useMemo(
    () => lightingForAltitude(sunAngles(date, city.lat, city.lng).altitudeDeg),
    [date, city],
  );

  return (
    <>
      <color attach="background" args={[lighting.hemiSkyColor]} />
      <SunLight date={date} lat={city.lat} lng={city.lng} northOffsetDeg={north} bounds={bounds} />
      {sun.showPath && <SunPathArc path={path} sunDir={sunDir} center={center} radius={radius * 2.5} />}
      {sun.showCompass && <CompassRose center={center} radius={radius * 1.25} northOffsetDeg={north} />}
    </>
  );
};

export default SunRig;

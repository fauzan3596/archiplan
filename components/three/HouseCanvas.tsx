// R3F host for the walkthrough: the exported house group (walls, openings,
// floors, ceilings), orbit-mode labels, the lights slot (SunRig or
// DefaultLights), orbit / walk controls and the touch fallback.

import * as THREE from "three";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, PointerLockControls } from "@react-three/drei";
import type { SceneModel } from "../../lib/plan/convert";
import { polygonArea } from "../../lib/plan/convert";
import CanvasErrorBoundary from "./CanvasErrorBoundary";
import Ceiling from "./Ceiling";
import DefaultLights from "./DefaultLights";
import Floor from "./Floor";
import Joystick from "./Joystick";
import OpeningMesh, { type OpeningMaterials } from "./OpeningMesh";
import RoomLabel from "./RoomLabel";
import Wall from "./Wall";
import Walker, {
  TouchLook,
  isTouchOnlyDevice,
  type MoveInput,
  type ViewMode,
} from "./Walker";
import { exportGlb } from "./export-glb";
import { polygonCentroid } from "./floor-geometry";
import { useMaterials } from "./useMaterials";
import { normalizeOpenings } from "./wall-geometry";

/** Downloads the house group as a .glb (filename defaults to "archiplan.glb"). */
export type ExportGlbFn = (filename?: string) => Promise<void>;

export interface HouseCanvasProps {
  plan: FloorPlan;
  scene: SceneModel;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  exportRef: RefObject<ExportGlbFn | null>;
  selectedRoomId?: string | null;
  /** rendered inside the Canvas; defaults to <DefaultLights /> */
  lights?: ReactNode;
  /** extra R3F children (not exported) */
  sceneExtras?: ReactNode;
}

const GL_OPTIONS = {
  antialias: true,
  powerPreference: "high-performance" as const,
};

const LABEL_HEIGHT = 0.1;

interface SceneMaterials extends OpeningMaterials {
  ceiling: THREE.MeshStandardMaterial;
}

const createSceneMaterials = (): SceneMaterials => ({
  ceiling: new THREE.MeshStandardMaterial({ color: "#f5f5f4", roughness: 0.95 }),
  windowFrame: new THREE.MeshStandardMaterial({ color: "#f4f4f5", roughness: 0.5 }),
  doorFrame: new THREE.MeshStandardMaterial({ color: "#8a5a36", roughness: 0.7 }),
  glass: new THREE.MeshStandardMaterial({
    color: "#cfe3f5",
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  }),
});

interface HouseSceneProps {
  plan: FloorPlan;
  scene: SceneModel;
  mode: ViewMode;
  selectedRoomId: string | null;
  houseRef: RefObject<THREE.Group | null>;
}

const HouseScene = ({
  plan,
  scene,
  mode,
  selectedRoomId,
  houseRef,
}: HouseSceneProps) => {
  const { get } = useMaterials();
  const fixed = useMemo(createSceneMaterials, []);
  useEffect(
    () => () => {
      for (const m of Object.values(fixed)) m.dispose();
    },
    [fixed],
  );

  const wallMaterial = get(plan.materials.wall, "wall");
  const planRooms = useMemo(
    () => new Map(plan.rooms.map((r) => [r.id, r])),
    [plan.rooms],
  );

  return (
    <>
      {/* Everything in this group (and nothing else) goes into the .glb. */}
      <group ref={houseRef} name="archiplan-house">
        {scene.walls.map((w) => (
          <Wall key={w.id} spec={w} material={wallMaterial} />
        ))}
        {scene.walls.flatMap((w) =>
          normalizeOpenings(w.openings, w.height).map((o) => (
            <OpeningMesh
              key={`${w.id}:${o.id}`}
              wall={w}
              opening={o}
              materials={fixed}
            />
          )),
        )}
        {scene.rooms.map((r) => (
          <Floor
            key={r.id}
            room={r}
            material={get(r.floorMaterialId, "floor")}
          />
        ))}
        {scene.rooms.map((r) => (
          <Ceiling
            key={r.id}
            room={r}
            height={scene.height}
            material={fixed.ceiling}
            visible={mode === "walk"}
          />
        ))}
      </group>

      {mode === "orbit" &&
        scene.rooms.map((r) => {
          const source = planRooms.get(r.id);
          const [x, z] = source
            ? [source.anchor.x, source.anchor.y]
            : polygonCentroid(r.polygon);
          return (
            <RoomLabel
              key={r.id}
              name={r.name}
              position={[x, LABEL_HEIGHT, z]}
              areaM2={source ? polygonArea(source.polygon) : null}
              selected={r.id === selectedRoomId}
            />
          );
        })}
    </>
  );
};

const Ground = ({
  center,
  extent,
}: {
  center: [number, number, number];
  extent: number;
}) => (
  <mesh
    rotation={[-Math.PI / 2, 0, 0]}
    position={[center[0], -0.02, center[2]]}
    receiveShadow
  >
    <circleGeometry args={[extent * 3, 64]} />
    <meshStandardMaterial color="#e4dfd3" roughness={1} />
  </mesh>
);

interface OrbitRigProps {
  center: [number, number, number];
  extent: number;
  /** last orbit camera position, restored when coming back from walk mode */
  poseRef: RefObject<THREE.Vector3 | null>;
}

const OrbitRig = ({ center, extent, poseRef }: OrbitRigProps) => {
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const [cx, cy, cz] = center;
  const target = useMemo<[number, number, number]>(
    () => [cx, cy, cz],
    [cx, cy, cz],
  );
  const initial = useRef({ cx, cy, cz, extent });

  useEffect(() => {
    const { cx: x, cy: y, cz: z, extent: e } = initial.current;
    const saved = poseRef.current;
    if (saved) camera.position.copy(saved);
    else camera.position.set(x + e * 0.9, e * 0.95, z + e * 0.9);
    camera.lookAt(x, y, z);
    invalidate();
    return () => {
      poseRef.current = camera.position.clone();
    };
  }, [camera, invalidate, poseRef]);

  return (
    <OrbitControls
      makeDefault
      target={target}
      minDistance={2}
      maxDistance={Math.max(30, extent * 5)}
      maxPolarAngle={Math.PI / 2 - 0.05}
      enableDamping
      dampingFactor={0.08}
    />
  );
};

const HouseCanvasInner = ({
  plan,
  scene,
  mode,
  onModeChange,
  exportRef,
  selectedRoomId = null,
  lights,
  sceneExtras,
}: HouseCanvasProps) => {
  const houseRef = useRef<THREE.Group>(null);
  const joystickRef = useRef<MoveInput>({ x: 0, y: 0 });
  const orbitPoseRef = useRef<THREE.Vector3 | null>(null);
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;

  const [touchOnly] = useState(isTouchOnlyDevice);
  // Pointer lock can be refused (sandboxed iframe, browser policy): fall back
  // to drag-look for the rest of the session.
  const [lockFailed, setLockFailed] = useState(false);
  const dragLook = touchOnly || lockFailed;

  const extent = Math.max(scene.size[0], scene.size[1], 4);
  const center = scene.center;

  const cameraOptions = useMemo(
    () => ({
      fov: 50,
      near: 0.05,
      far: 500,
      position: [
        center[0] + extent * 0.9,
        extent * 0.95,
        center[2] + extent * 0.9,
      ] as [number, number, number],
    }),
    // Initial camera only; OrbitRig owns the camera afterwards.
    [],
  );

  const handleLock = useCallback(() => onModeChangeRef.current("walk"), []);
  const handleUnlock = useCallback(() => onModeChangeRef.current("orbit"), []);

  useEffect(() => {
    if (touchOnly) return;
    const onError = () => {
      setLockFailed(true);
      onModeChangeRef.current("walk");
    };
    document.addEventListener("pointerlockerror", onError);
    return () => document.removeEventListener("pointerlockerror", onError);
  }, [touchOnly]);

  // Leaving walk mode by any route (button, Esc, route change) releases the lock.
  useEffect(() => {
    if (mode === "orbit" && document.pointerLockElement) {
      document.exitPointerLock();
    }
  }, [mode]);

  useEffect(
    () => () => {
      if (document.pointerLockElement) document.exitPointerLock();
    },
    [],
  );

  // Esc while drag-looking (pointer lock handles its own Esc via onUnlock).
  useEffect(() => {
    if (mode !== "walk") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onModeChangeRef.current("orbit");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  useEffect(() => {
    exportRef.current = async (filename?: string) => {
      const root = houseRef.current;
      if (!root) throw new Error("Model 3D belum siap");
      await exportGlb(root, filename);
    };
    return () => {
      exportRef.current = null;
    };
  }, [exportRef]);

  const hint =
    mode === "orbit"
      ? "Seret untuk memutar · gulir atau cubit untuk zoom"
      : touchOnly
        ? "Seret untuk melihat · joystick untuk berjalan"
        : dragLook
          ? "Seret untuk melihat · WASD / panah untuk berjalan · Esc untuk keluar"
          : "Gerakkan mouse untuk melihat · WASD / panah untuk berjalan · Esc untuk keluar";

  return (
    <div className={`house-canvas ${mode === "walk" ? "is-walking" : ""}`}>
      <Canvas
        shadows
        dpr={[1, 1.5]}
        frameloop={mode === "walk" ? "always" : "demand"}
        camera={cameraOptions}
        gl={GL_OPTIONS}
      >
        {lights ?? (
          <>
            <color attach="background" args={["#e8eef5"]} />
            <DefaultLights center={center} extent={extent} height={scene.height} />
          </>
        )}

        <Suspense fallback={null}>
          <HouseScene
            plan={plan}
            scene={scene}
            mode={mode}
            selectedRoomId={selectedRoomId}
            houseRef={houseRef}
          />
        </Suspense>
        <Ground center={center} extent={extent} />
        {sceneExtras}

        {mode === "orbit" && (
          <OrbitRig center={center} extent={extent} poseRef={orbitPoseRef} />
        )}
        {mode === "walk" && (
          <Walker
            walls={scene.walls}
            start={scene.spawn}
            startYaw={scene.spawnYaw}
            joystick={dragLook ? joystickRef : undefined}
          />
        )}
        {mode === "walk" && dragLook && <TouchLook />}
        {!dragLook && (
          // Always mounted so the #walk-btn click can call lock() inside the
          // user gesture; mode follows the lock / unlock events.
          <PointerLockControls
            selector="#walk-btn"
            onLock={handleLock}
            onUnlock={handleUnlock}
          />
        )}
      </Canvas>

      {mode === "walk" && dragLook && <Joystick inputRef={joystickRef} />}
      <p className="canvas-hint">{hint}</p>
    </div>
  );
};

const HouseCanvas = (props: HouseCanvasProps) => (
  <CanvasErrorBoundary>
    <HouseCanvasInner {...props} />
  </CanvasErrorBoundary>
);

export default HouseCanvas;

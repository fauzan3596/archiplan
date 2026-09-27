// First-person mover for walk mode (port of the verified three-stack sketch).
// It only moves the default camera; looking around is done by drei's
// PointerLockControls (desktop) or TouchLook (touch / no pointer lock), which
// both only rotate it. Needs frameloop="always" while walking.

import * as THREE from "three";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { WallSpec } from "../../lib/plan/convert";
import { buildColliders, resolveCollisions } from "./collision";

export type ViewMode = "orbit" | "walk";

/** Analogue input (virtual joystick). x: strafe -1..1 (right +), y: forward -1..1 */
export type MoveInput = { x: number; y: number };

type MoveKey = "forward" | "back" | "left" | "right";

const MOVE_KEYS: Record<string, MoveKey> = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "back",
  ArrowDown: "back",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
};
const RUN_KEYS = new Set(["ShiftLeft", "ShiftRight"]);
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/** True while the user is typing in a form control (ThreePanel / SunPanel). */
export const isFormField = (el: Element | null): boolean => {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (el as HTMLElement).isContentEditable === true
  );
};

interface WalkerProps {
  walls: WallSpec[];
  /** XZ spawn (scene.spawn: centroid of the largest room) */
  start: [number, number];
  /** rotation.y at spawn (scene.spawnYaw: facing the nearest door) */
  startYaw?: number;
  eyeHeight?: number;
  /** metres per second */
  speed?: number;
  /** player radius, metres */
  radius?: number;
  joystick?: RefObject<MoveInput>;
}

const UP = new THREE.Vector3(0, 1, 0);

const Walker = ({
  walls,
  start,
  startYaw = 0,
  eyeHeight = 1.6,
  speed = 2.5,
  radius = 0.3,
  joystick,
}: WalkerProps) => {
  const camera = useThree((s) => s.camera);
  const colliders = useMemo(() => buildColliders(walls), [walls]);
  const collidersRef = useRef(colliders);
  collidersRef.current = colliders;
  const pressed = useRef(new Set<string>());
  const fwd = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());
  const [sx, sz] = start;

  // Spawn only when the spawn values change: the plan object (and so `start`)
  // gets a new identity on every edit or save response.
  useEffect(() => {
    camera.position.set(sx, eyeHeight, sz);
    camera.rotation.set(0, startYaw, 0, "YXZ");
    resolveCollisions(camera.position, collidersRef.current, radius);
    camera.position.y = eyeHeight;
  }, [camera, sx, sz, startYaw, eyeHeight, radius]);

  useEffect(() => {
    const keys = pressed.current;
    const down = (e: KeyboardEvent) => {
      if (isFormField(document.activeElement)) return;
      if (!MOVE_KEYS[e.code] && !RUN_KEYS.has(e.code)) return;
      keys.add(e.code);
      // Arrow keys would scroll the page under the canvas while walking.
      if (SCROLL_KEYS.has(e.code)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      keys.delete(e.code);
    };
    const clear = () => keys.clear();

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
      clear();
    };
  }, []);

  useFrame((_, dt) => {
    const keys = pressed.current;
    let mx = 0;
    let my = 0;
    let run = false;

    if (!isFormField(document.activeElement)) {
      const held = new Set<MoveKey>();
      for (const code of keys) {
        const k = MOVE_KEYS[code];
        if (k) held.add(k);
        if (RUN_KEYS.has(code)) run = true;
      }
      mx = (held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0);
      my = (held.has("forward") ? 1 : 0) - (held.has("back") ? 1 : 0);
    }
    if (joystick?.current) {
      mx += joystick.current.x;
      my += joystick.current.y;
    }

    const len = Math.hypot(mx, my);
    if (len < 1e-3) return;
    if (len > 1) {
      mx /= len;
      my /= len;
    }

    // Clamp dt so a tab switch cannot teleport the player through a wall.
    const step = Math.min(dt, 0.05) * speed * (run ? 2 : 1);
    camera.getWorldDirection(fwd.current);
    fwd.current.y = 0;
    if (fwd.current.lengthSq() < 1e-8) return;
    fwd.current.normalize();
    right.current.crossVectors(fwd.current, UP); // forward x up = right

    camera.position.x += (fwd.current.x * my + right.current.x * mx) * step;
    camera.position.z += (fwd.current.z * my + right.current.z * mx) * step;
    resolveCollisions(camera.position, colliders, radius);
    camera.position.y = eyeHeight;
  });

  return null;
};

export default Walker;

/* ---------- Touch / no-pointer-lock fallback ---------- */

/** Coarse pointer or no Pointer Lock API (iOS Safari, Chrome Android, Samsung Internet). */
export const isTouchOnlyDevice = (): boolean => {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const noLock = !("requestPointerLock" in document.documentElement);
  return coarse || noLock;
};

/** Drag-to-look on the canvas (pointer events, so it also works with a
 *  mouse). Same YXZ maths as PointerLockControls. */
export const TouchLook = ({ sensitivity = 0.004 }: { sensitivity?: number }) => {
  const camera = useThree((s) => s.camera);
  const dom = useThree((s) => s.gl.domElement);

  useEffect(() => {
    const euler = new THREE.Euler(0, 0, 0, "YXZ");
    let last: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      if (e.isPrimary) last = { x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!last || !e.isPrimary) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      euler.setFromQuaternion(camera.quaternion);
      euler.y -= dx * sensitivity;
      euler.x = THREE.MathUtils.clamp(
        euler.x - dy * sensitivity,
        -Math.PI / 2 + 0.05,
        Math.PI / 2 - 0.05,
      );
      camera.quaternion.setFromEuler(euler);
    };
    const up = () => {
      last = null;
    };

    const previousTouchAction = dom.style.touchAction;
    dom.style.touchAction = "none"; // stop the page from scrolling while dragging
    dom.addEventListener("pointerdown", down);
    dom.addEventListener("pointermove", move);
    dom.addEventListener("pointerup", up);
    dom.addEventListener("pointercancel", up);
    dom.addEventListener("pointerleave", up);
    return () => {
      dom.style.touchAction = previousTouchAction;
      dom.removeEventListener("pointerdown", down);
      dom.removeEventListener("pointermove", move);
      dom.removeEventListener("pointerup", up);
      dom.removeEventListener("pointercancel", up);
      dom.removeEventListener("pointerleave", up);
    };
  }, [camera, dom, sensitivity]);

  return null;
};

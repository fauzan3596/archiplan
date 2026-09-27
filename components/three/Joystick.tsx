// Hand-rolled virtual joystick for touch walk mode. It writes {x, y} into a
// ref that Walker reads every frame (no React re-render per move); the knob
// is moved through its style directly.

import { useEffect, useRef, type PointerEvent, type RefObject } from "react";
import type { MoveInput } from "./Walker";

interface JoystickProps {
  inputRef: RefObject<MoveInput>;
  /** knob travel, px */
  radius?: number;
}

const DEADZONE = 0.12;

const Joystick = ({ inputRef, radius = 44 }: JoystickProps) => {
  const baseRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const activePointer = useRef<number | null>(null);

  const setKnob = (x: number, y: number) => {
    if (knobRef.current) {
      knobRef.current.style.transform = `translate(${x}px, ${y}px)`;
    }
  };

  const release = () => {
    activePointer.current = null;
    setKnob(0, 0);
    inputRef.current = { x: 0, y: 0 };
  };

  const track = (e: PointerEvent<HTMLDivElement>) => {
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    let dx = e.clientX - (rect.left + rect.width / 2);
    let dy = e.clientY - (rect.top + rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > radius) {
      dx = (dx / len) * radius;
      dy = (dy / len) * radius;
    }
    setKnob(dx, dy);
    const x = dx / radius;
    const y = -dy / radius; // screen up = forward
    inputRef.current =
      Math.hypot(x, y) < DEADZONE ? { x: 0, y: 0 } : { x, y };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== null) return;
    activePointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    track(e);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== activePointer.current) return;
    track(e);
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== activePointer.current) return;
    release();
  };

  // Never leave the player walking after the joystick unmounts.
  useEffect(
    () => () => {
      inputRef.current = { x: 0, y: 0 };
    },
    [inputRef],
  );

  return (
    <div
      ref={baseRef}
      className="joystick"
      role="presentation"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div ref={knobRef} className="knob" />
    </div>
  );
};

export default Joystick;

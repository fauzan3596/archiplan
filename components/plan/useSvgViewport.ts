import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

// Zoom / pan for the plan SVG by rewriting its viewBox: wheel zoom around the
// cursor, background-drag pan (beginPan) and two-finger pinch. Because only the
// viewBox changes, getScreenCTM().inverse() keeps mapping client -> natural
// image px for the editor's pointer math.

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ClientPoint {
  x: number;
  y: number;
}

type Gesture =
  | { kind: "pan"; pointerId: number; c0: ClientPoint; vb0: ViewBox; a0: number }
  | {
      kind: "pinch";
      ids: [number, number];
      d0: number;
      m0: ClientPoint;
      u0: ClientPoint;
      vb0: ViewBox;
      a0: number;
    };

export interface SvgViewport {
  viewBox: ViewBox;
  /** screen px per SVG user unit (natural image px) */
  pxPerUnit: number;
  /** client -> SVG user coordinates (natural image px) */
  toUser: (clientX: number, clientY: number) => ClientPoint | null;
  zoomBy: (factor: number) => void;
  reset: () => void;
  /** start a background-drag pan with this pointer (optionally anchored at an
   *  earlier client point, e.g. where the press started) */
  beginPan: (e: ReactPointerEvent<SVGSVGElement>, from?: ClientPoint) => void;
  /** feed every pointerdown; true when a pinch started (cancel tool gestures) */
  onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => boolean;
  /** feed every pointermove; true when a pan / pinch consumed it */
  onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => boolean;
  /** feed every pointerup / pointercancel; true when a pan / pinch consumed it */
  onPointerUp: (e: ReactPointerEvent<SVGSVGElement>) => boolean;
}

const MAX_ZOOM_IN = 40;
const MAX_ZOOM_OUT = 2.5;

const initialView = (size: { w: number; h: number }): ViewBox => ({
  x: 0,
  y: 0,
  w: size.w,
  h: size.h,
});

export const useSvgViewport = (
  svgRef: RefObject<SVGSVGElement | null>,
  content: { w: number; h: number },
): SvgViewport => {
  const [viewBox, setViewBoxState] = useState<ViewBox>(() => initialView(content));
  const [elementSize, setElementSize] = useState({ w: 0, h: 0 });
  const viewRef = useRef(viewBox);
  const gestureRef = useRef<Gesture | null>(null);
  const touchesRef = useRef(new Map<number, ClientPoint>());

  const setViewBox = useCallback((vb: ViewBox) => {
    viewRef.current = vb;
    setViewBoxState(vb);
  }, []);

  // New image -> fit it again.
  useEffect(() => {
    setViewBox(initialView(content));
  }, [content.w, content.h, setViewBox]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setElementSize({ w: width, h: height });
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, [svgRef]);

  const toUser = useCallback(
    (clientX: number, clientY: number): ClientPoint | null => {
      const svg = svgRef.current;
      const ctm = svg?.getScreenCTM();
      if (!svg || !ctm) return null;
      const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    },
    [svgRef],
  );

  const currentScale = useCallback((): number => {
    const ctm = svgRef.current?.getScreenCTM();
    return ctm && ctm.a > 0 ? ctm.a : 1;
  }, [svgRef]);

  /** New viewBox after scaling by s about user point u0, which moves from
   *  client c0 to client c1 (a0 = screen px per unit before). */
  const transform = useCallback(
    (
      vb0: ViewBox,
      a0: number,
      u0: ClientPoint,
      c0: ClientPoint,
      c1: ClientPoint,
      s: number,
    ): ViewBox => {
      const minW = content.w / MAX_ZOOM_IN;
      const maxW = content.w * MAX_ZOOM_OUT;
      const w1 = Math.min(maxW, Math.max(minW, vb0.w / s));
      const sEff = vb0.w / w1;
      const a1 = a0 * sEff;
      return {
        x: u0.x - (c1.x - c0.x + a0 * (u0.x - vb0.x)) / a1,
        y: u0.y - (c1.y - c0.y + a0 * (u0.y - vb0.y)) / a1,
        w: w1,
        h: vb0.h / sEff,
      };
    },
    [content.w],
  );

  const zoomAtClient = useCallback(
    (factor: number, client: ClientPoint | null) => {
      const vb0 = viewRef.current;
      const svg = svgRef.current;
      let c = client;
      if (!c && svg) {
        const rect = svg.getBoundingClientRect();
        c = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      const u0 = c ? toUser(c.x, c.y) : null;
      if (!c || !u0) return;
      setViewBox(transform(vb0, currentScale(), u0, c, c, factor));
    },
    [currentScale, setViewBox, svgRef, toUser, transform],
  );

  // Wheel must be non-passive to stop the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-e.deltaY * unit * 0.0015);
      zoomAtClient(factor, { x: e.clientX, y: e.clientY });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [svgRef, zoomAtClient]);

  const zoomBy = useCallback((factor: number) => zoomAtClient(factor, null), [zoomAtClient]);

  const reset = useCallback(() => setViewBox(initialView(content)), [content, setViewBox]);

  const beginPan = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>, from?: ClientPoint) => {
      if (gestureRef.current?.kind === "pinch") return;
      gestureRef.current = {
        kind: "pan",
        pointerId: e.pointerId,
        c0: from ?? { x: e.clientX, y: e.clientY },
        vb0: viewRef.current,
        a0: currentScale(),
      };
    },
    [currentScale],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>): boolean => {
      if (e.pointerType !== "touch") return false;
      const touches = touchesRef.current;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size !== 2) return false;
      const [[id1, p1], [id2, p2]] = [...touches.entries()];
      const m0 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const u0 = toUser(m0.x, m0.y);
      if (!u0) return false;
      gestureRef.current = {
        kind: "pinch",
        ids: [id1, id2],
        d0: Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y)),
        m0,
        u0,
        vb0: viewRef.current,
        a0: currentScale(),
      };
      return true;
    },
    [currentScale, toUser],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>): boolean => {
      const touches = touchesRef.current;
      if (touches.has(e.pointerId)) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      const g = gestureRef.current;
      if (!g) return false;

      if (g.kind === "pinch") {
        const p1 = touches.get(g.ids[0]);
        const p2 = touches.get(g.ids[1]);
        if (!p1 || !p2) return true;
        const d1 = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
        const m1 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        setViewBox(transform(g.vb0, g.a0, g.u0, g.m0, m1, d1 / g.d0));
        return true;
      }

      if (g.pointerId !== e.pointerId) return false;
      setViewBox({
        ...g.vb0,
        x: g.vb0.x - (e.clientX - g.c0.x) / g.a0,
        y: g.vb0.y - (e.clientY - g.c0.y) / g.a0,
      });
      return true;
    },
    [setViewBox, transform],
  );

  const onPointerUp = useCallback((e: ReactPointerEvent<SVGSVGElement>): boolean => {
    touchesRef.current.delete(e.pointerId);
    const g = gestureRef.current;
    if (!g) return false;
    if (g.kind === "pinch") {
      if (g.ids.includes(e.pointerId)) gestureRef.current = null;
      return true;
    }
    if (g.pointerId !== e.pointerId) return false;
    gestureRef.current = null;
    return true;
  }, []);

  const pxPerUnit =
    elementSize.w > 0 && elementSize.h > 0
      ? Math.min(elementSize.w / viewBox.w, elementSize.h / viewBox.h)
      : 1;

  return {
    viewBox,
    pxPerUnit,
    toUser,
    zoomBy,
    reset,
    beginPan,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
};

export default useSvgViewport;

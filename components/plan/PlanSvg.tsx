import { useMemo, useRef, useState } from "react";
import type { Dispatch, PointerEvent as ReactPointerEvent } from "react";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import {
  planBounds,
  pointMToPx,
  pointPxToM,
  polygonArea,
  wallLength,
} from "../../lib/plan/convert";
import {
  OPENING_DEFAULT_WIDTH,
  moveOpeningSpan,
  nearestWall,
  northOffsetFromDirection,
  projectOntoWall,
  snapPointInfo,
} from "../../lib/plan/editor";
import type {
  EditorAction,
  EditorState,
  WallEnd,
} from "../../lib/plan/editor";
import { useSvgViewport } from "./useSvgViewport";

interface PlanSvgProps {
  plan: FloorPlan;
  sourceImage: string | null;
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  readOnly: boolean;
  showRawLayer: boolean;
}

interface ClientPoint {
  x: number;
  y: number;
}

type Gesture =
  | { type: "endpoint"; pointerId: number }
  | {
      type: "opening";
      pointerId: number;
      id: string;
      grab: number;
      c0: ClientPoint;
      moved: boolean;
    }
  | {
      type: "anchor";
      pointerId: number;
      roomId: string;
      offset: PlanPoint;
      c0: ClientPoint;
      moved: boolean;
    }
  | {
      type: "tap";
      pointerId: number;
      c0: ClientPoint;
      hitKind: string | null;
      hitId: string | null;
      /** the press turned into a background pan */
      panning: boolean;
    }
  | { type: "pinch" };

interface OpeningPreview {
  id: string;
  wallId: string;
  t0: number;
  t1: number;
}

interface AnchorPreview {
  roomId: string;
  point: PlanPoint;
}

const TAP_SLOP_PX = 6;
const DOUBLE_TAP_MS = 350;
const HANDLE_HIT_PX = 22; // 44 px diameter touch target
const WALL_HIT_PX = 14;
const OPENING_PICK_PX = 18;

const ROOM_FILL: Record<PlanRoomType, string> = {
  kamar_tidur: "#60a5fa",
  kamar_mandi: "#22d3ee",
  dapur: "#fb923c",
  ruang_tamu: "#a3e635",
  ruang_keluarga: "#4ade80",
  ruang_makan: "#facc15",
  teras: "#a8a29e",
  garasi: "#94a3b8",
  gudang: "#c4b5fd",
  koridor: "#d4d4d8",
  servis: "#f9a8d4",
  lainnya: "#d4d4d8",
};

const OPENING_STROKE: Record<PlanOpeningKind, string> = {
  door: "#ea580c",
  window: "#2563eb",
  opening: "#a1a1aa",
};

const WALL_STROKE = "#27272a";
const WALL_WARN = "#f59e0b";
const SELECT_STROKE = "#f97316";
const STALE_STROKE = "#dc2626";
const RAW_STROKE = "#8b5cf6";

const ISSUE_WALL_CODES: PlanIssueCode[] = [
  "WALL_DIAGONAL",
  "WALL_DANGLING",
  "WALL_SHORT",
];

const fmt = (n: number, digits = 2) =>
  n.toLocaleString("id-ID", { maximumFractionDigits: digits });

const polyPoints = (poly: PlanPoint[], ppm: number) =>
  poly.map((p) => `${p.x * ppm},${p.y * ppm}`).join(" ");

const PlanSvg = ({
  plan,
  sourceImage,
  state,
  dispatch,
  readOnly,
  showRawLayer,
}: PlanSvgProps) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const pointersRef = useRef(new Set<number>());
  const lastTapRef = useRef<{ at: number; c: ClientPoint; hitId: string | null } | null>(
    null,
  );

  const [hover, setHover] = useState<PlanPoint | null>(null);
  const [openingPreview, setOpeningPreviewState] = useState<OpeningPreview | null>(null);
  const [anchorPreview, setAnchorPreviewState] = useState<AnchorPreview | null>(null);
  // Mirrors of the previews: pointerup may run before React re-renders.
  const openingPreviewRef = useRef<OpeningPreview | null>(null);
  const anchorPreviewRef = useRef<AnchorPreview | null>(null);
  const setOpeningPreview = (v: OpeningPreview | null) => {
    openingPreviewRef.current = v;
    setOpeningPreviewState(v);
  };
  const setAnchorPreview = (v: AnchorPreview | null) => {
    anchorPreviewRef.current = v;
    setAnchorPreviewState(v);
  };

  const viewport = useSvgViewport(svgRef, plan.imageSize);
  const ppm = plan.scale.pxPerMeter;
  const u = 1 / viewport.pxPerUnit; // SVG units per screen px
  const tool = readOnly ? "select" : state.tool;

  const wallById = useMemo(
    () => new Map(plan.walls.map((w) => [w.id, w])),
    [plan.walls],
  );

  const issueWallIds = useMemo(() => {
    const ids = new Set<string>();
    for (const issue of state.issues) {
      if (!ISSUE_WALL_CODES.includes(issue.code)) continue;
      for (const id of issue.ids ?? []) ids.add(id);
    }
    return ids;
  }, [state.issues]);

  const handles = useMemo(() => {
    const seen = new Map<string, { p: PlanPoint; wallId: string; end: WallEnd }>();
    for (const w of plan.walls) {
      for (const end of ["a", "b"] as const) {
        const p = w[end];
        const key = `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
        if (!seen.has(key)) seen.set(key, { p, wallId: w.id, end });
      }
    }
    return [...seen.values()];
  }, [plan.walls]);

  // --- pointer math ---------------------------------------------------------
  const toPlan = (clientX: number, clientY: number): PlanPoint | null => {
    const user = viewport.toUser(clientX, clientY);
    return user ? pointPxToM(user, plan.scale) : null;
  };

  const pickTolM = (px: number) => (px * u) / ppm;

  const cancelGesture = () => {
    const g = gestureRef.current;
    if (g?.type === "endpoint") dispatch({ type: "CANCEL_DRAG" });
    setOpeningPreview(null);
    setAnchorPreview(null);
    gestureRef.current = null;
  };

  const isDoubleTap = (c: ClientPoint, hitId: string | null): boolean => {
    const now = Date.now();
    const last = lastTapRef.current;
    const double =
      Boolean(last) &&
      now - last!.at < DOUBLE_TAP_MS &&
      Math.hypot(c.x - last!.c.x, c.y - last!.c.y) < TAP_SLOP_PX * 2 &&
      last!.hitId === hitId;
    lastTapRef.current = double ? null : { at: now, c, hitId };
    return double;
  };

  const handleTap = (
    p: PlanPoint,
    hitKind: string | null,
    hitId: string | null,
    c: ClientPoint,
    shift: boolean,
  ) => {
    const double = isDoubleTap(c, hitKind === "wall" ? hitId : null);

    switch (tool) {
      case "select":
        if (!readOnly && double && hitKind === "wall" && hitId) {
          dispatch({ type: "SPLIT_WALL", wallId: hitId, point: p });
        }
        return;

      case "wall":
        if (double) {
          dispatch({ type: "DRAFT_WALL", draft: null });
          return;
        }
        if (!state.draft) {
          dispatch({ type: "DRAFT_WALL", draft: { a: p, b: p }, snap: !shift });
        } else {
          dispatch({
            type: "ADD_WALL",
            a: state.draft.a,
            b: p,
            snap: !shift,
            chain: true,
          });
        }
        return;

      case "door":
      case "window":
      case "opening": {
        if (hitKind === "opening" && hitId) {
          dispatch({ type: "SELECT", selection: { kind: "opening", id: hitId } });
          return;
        }
        const direct = hitKind === "wall" && hitId ? wallById.get(hitId) : undefined;
        if (direct) {
          dispatch({
            type: "ADD_OPENING",
            wallId: direct.id,
            kind: tool,
            t: projectOntoWall(direct, p).t,
          });
          return;
        }
        const near = nearestWall(plan, p, Math.max(0.3, pickTolM(OPENING_PICK_PX)));
        if (near) {
          dispatch({ type: "ADD_OPENING", wallId: near.wall.id, kind: tool, t: near.t });
        }
        return;
      }

      case "calibrate":
        dispatch({ type: "CALIBRATE_POINT", point: p });
        return;

      case "north": {
        const deg = northOffsetFromDirection(planBounds(plan).center, p);
        if (deg !== null) dispatch({ type: "SET_NORTH", deg: Math.round(deg) });
        return;
      }

      default:
        return;
    }
  };

  // --- pointer handlers -----------------------------------------------------
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointersRef.current.add(e.pointerId);
    if (viewport.onPointerDown(e)) {
      cancelGesture();
      gestureRef.current = { type: "pinch" };
      return;
    }
    if (gestureRef.current) return;
    if (e.pointerType === "mouse" && e.button === 1) {
      e.preventDefault();
      viewport.beginPan(e);
      gestureRef.current = {
        type: "tap",
        pointerId: e.pointerId,
        c0: { x: e.clientX, y: e.clientY },
        hitKind: null,
        hitId: null,
        panning: true,
      };
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) return;

    const p = toPlan(e.clientX, e.clientY);
    if (!p) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // capture is best effort (synthetic events cannot be captured)
    }

    const c0 = { x: e.clientX, y: e.clientY };
    const hit = (e.target as Element).closest<SVGElement>("[data-kind]");
    const hitKind = hit?.dataset.kind ?? null;
    const hitId = hit?.dataset.id ?? null;

    if (tool === "select") {
      if (!readOnly && hitKind === "handle" && hit?.dataset.wall) {
        dispatch({
          type: "BEGIN_DRAG",
          wallId: hit.dataset.wall,
          end: hit.dataset.end === "b" ? "b" : "a",
          detach: e.altKey,
        });
        gestureRef.current = { type: "endpoint", pointerId: e.pointerId };
        return;
      }
      if (hitKind === "opening" && hitId) {
        dispatch({ type: "SELECT", selection: { kind: "opening", id: hitId } });
        const o = plan.openings.find((x) => x.id === hitId);
        const host = o ? wallById.get(o.wallId) : undefined;
        if (!readOnly && o && host) {
          gestureRef.current = {
            type: "opening",
            pointerId: e.pointerId,
            id: o.id,
            grab: (o.t0 + o.t1) / 2 - projectOntoWall(host, p).t,
            c0,
            moved: false,
          };
          return;
        }
      } else if (hitKind === "label" && hitId) {
        dispatch({ type: "SELECT", selection: { kind: "room", id: hitId } });
        const room = plan.rooms.find((r) => r.id === hitId);
        if (!readOnly && room) {
          gestureRef.current = {
            type: "anchor",
            pointerId: e.pointerId,
            roomId: room.id,
            offset: { x: room.anchor.x - p.x, y: room.anchor.y - p.y },
            c0,
            moved: false,
          };
          return;
        }
      } else if (hitKind === "wall" && hitId) {
        dispatch({ type: "SELECT", selection: { kind: "wall", id: hitId } });
      } else if (hitKind === "room" && hitId) {
        dispatch({ type: "SELECT", selection: { kind: "room", id: hitId } });
      } else {
        dispatch({ type: "SELECT", selection: null });
      }
    }

    // Becomes a pan only once the pointer leaves the tap slop (see onPointerMove).
    gestureRef.current = { type: "tap", pointerId: e.pointerId, c0, hitKind, hitId, panning: false };
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (viewport.onPointerMove(e)) return;
    const p = toPlan(e.clientX, e.clientY);
    if (!p) return;
    const g = gestureRef.current;

    if (g?.type === "endpoint" && g.pointerId === e.pointerId) {
      dispatch({ type: "DRAG_ENDPOINT", point: p, snap: !e.shiftKey });
      return;
    }

    if (g?.type === "opening" && g.pointerId === e.pointerId) {
      if (!g.moved && Math.hypot(e.clientX - g.c0.x, e.clientY - g.c0.y) < TAP_SLOP_PX) return;
      g.moved = true;
      const o = plan.openings.find((x) => x.id === g.id);
      const host = o ? wallById.get(o.wallId) : undefined;
      if (!o || !host) return;
      const onHost = projectOntoWall(host, p);
      let next = moveOpeningSpan(plan, o.id, onHost.t + g.grab);
      // Far from its wall and close to another one: hop over.
      if (onHost.dist > Math.max(0.4, pickTolM(OPENING_PICK_PX))) {
        const near = nearestWall(plan, p, Math.max(0.3, pickTolM(OPENING_PICK_PX)));
        if (near && near.wall.id !== host.id) {
          next = moveOpeningSpan(plan, o.id, near.t, near.wall.id) ?? next;
        }
      }
      if (next) setOpeningPreview({ id: o.id, wallId: next.wallId, t0: next.t0, t1: next.t1 });
      return;
    }

    if (g?.type === "anchor" && g.pointerId === e.pointerId) {
      if (!g.moved && Math.hypot(e.clientX - g.c0.x, e.clientY - g.c0.y) < TAP_SLOP_PX) return;
      g.moved = true;
      setAnchorPreview({ roomId: g.roomId, point: { x: p.x + g.offset.x, y: p.y + g.offset.y } });
      return;
    }

    if (g?.type === "tap" && g.pointerId === e.pointerId) {
      if (!g.panning && Math.hypot(e.clientX - g.c0.x, e.clientY - g.c0.y) >= TAP_SLOP_PX) {
        g.panning = true;
        viewport.beginPan(e, g.c0);
        viewport.onPointerMove(e);
      }
      return;
    }

    if (g) return;
    if (tool === "wall" && state.draft) {
      dispatch({ type: "DRAFT_WALL", draft: { a: state.draft.a, b: p }, snap: !e.shiftKey });
    }
    if (tool !== "select" && !readOnly) setHover(p);
  };

  const finishPointer = (e: ReactPointerEvent<SVGSVGElement>, cancelled: boolean) => {
    pointersRef.current.delete(e.pointerId);
    viewport.onPointerUp(e);
    const g = gestureRef.current;
    if (!g) return;

    if (g.type === "pinch") {
      if (pointersRef.current.size === 0) gestureRef.current = null;
      return;
    }
    if (g.pointerId !== e.pointerId) return;
    gestureRef.current = null;

    if (cancelled) {
      if (g.type === "endpoint") dispatch({ type: "CANCEL_DRAG" });
      setOpeningPreview(null);
      setAnchorPreview(null);
      return;
    }

    if (g.type === "endpoint") {
      dispatch({ type: "COMMIT_DRAG" });
      return;
    }

    if (g.type === "opening") {
      const preview = openingPreviewRef.current;
      setOpeningPreview(null);
      if (g.moved && preview && preview.id === g.id) {
        dispatch({
          type: "MOVE_OPENING",
          id: g.id,
          t: (preview.t0 + preview.t1) / 2,
          wallId: preview.wallId,
        });
      }
      return;
    }

    if (g.type === "anchor") {
      const preview = anchorPreviewRef.current;
      setAnchorPreview(null);
      if (g.moved && preview) {
        dispatch({ type: "SET_ROOM_ANCHOR", id: g.roomId, point: preview.point });
      }
      return;
    }

    // tap-or-pan
    if (g.panning) return;
    const p = toPlan(e.clientX, e.clientY);
    if (p) handleTap(p, g.hitKind, g.hitId, { x: e.clientX, y: e.clientY }, e.shiftKey);
  };

  // --- derived render data --------------------------------------------------
  const P = (p: PlanPoint) => pointMToPx(p, plan.scale);
  const selection = state.selection;
  const vb = viewport.viewBox;

  const renderedOpenings = plan.openings.map((o) =>
    openingPreview && openingPreview.id === o.id ? { ...o, ...openingPreview } : o,
  );

  let hoverMarker: { p: PlanPoint; kind: string } | null = null;
  let ghostOpening: { a: PlanPoint; b: PlanPoint; kind: PlanOpeningKind; thickness: number } | null =
    null;
  if (!readOnly && hover && !state.drag && !openingPreview && !anchorPreview) {
    if (tool === "wall") {
      if (state.draft) hoverMarker = { p: state.draft.b, kind: "draft" };
      else {
        const info = snapPointInfo(plan, hover);
        hoverMarker = { p: info.point, kind: info.kind };
      }
    } else if (tool === "door" || tool === "window" || tool === "opening") {
      const near = nearestWall(plan, hover, Math.max(0.3, pickTolM(OPENING_PICK_PX)));
      if (near) {
        const len = wallLength(near.wall);
        const half = Math.min(OPENING_DEFAULT_WIDTH[tool], len) / len / 2;
        const t0 = Math.max(0, Math.min(1 - 2 * half, near.t - half));
        const lerp = (t: number) => ({
          x: near.wall.a.x + (near.wall.b.x - near.wall.a.x) * t,
          y: near.wall.a.y + (near.wall.b.y - near.wall.a.y) * t,
        });
        ghostOpening = {
          a: lerp(t0),
          b: lerp(t0 + 2 * half),
          kind: tool,
          thickness: near.wall.thickness,
        };
      }
    }
  }

  const calibration = state.calibration;
  const calA = calibration?.a ?? null;
  const calB = calibration?.b ?? (calA && tool === "calibrate" ? hover : null);

  const compass = {
    x: vb.x + vb.w - 34 * u,
    y: vb.y + 34 * u,
  };

  const svgClass = [
    "plan-svg",
    `tool-${tool}`,
    readOnly ? "is-readonly" : "",
    state.drag ? "is-dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <svg
        ref={svgRef}
        className={svgClass}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Denah 2D"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finishPointer(e, false)}
        onPointerCancel={(e) => finishPointer(e, true)}
        onPointerLeave={() => setHover(null)}
        onContextMenu={(e) => e.preventDefault()}
      >
        {sourceImage && (
          <image
            href={sourceImage}
            x={0}
            y={0}
            width={plan.imageSize.w}
            height={plan.imageSize.h}
            preserveAspectRatio="none"
            className="plan-image"
          />
        )}

        {showRawLayer && plan.extraction?.rawRooms?.length ? (
          <g className="raw-layer" pointerEvents="none">
            {plan.extraction.rawRooms.map((r, i) => (
              <polygon
                key={`${r.id}-${i}`}
                points={polyPoints(r.polygon, ppm)}
                fill={RAW_STROKE}
                fillOpacity={0.08}
                stroke={RAW_STROKE}
                strokeWidth={1.5 * u}
                strokeDasharray={`${6 * u} ${4 * u}`}
              />
            ))}
          </g>
        ) : null}

        <g className="rooms">
          {plan.rooms.map((room) => {
            const selected = selection?.kind === "room" && selection.id === room.id;
            const classes = ["room", room.stale ? "is-stale" : "", selected ? "is-selected" : ""]
              .filter(Boolean)
              .join(" ");
            return (
              <polygon
                key={room.id}
                className={classes}
                data-kind="room"
                data-id={room.id}
                points={polyPoints(room.polygon, ppm)}
                fill={room.stale ? STALE_STROKE : ROOM_FILL[room.type ?? "lainnya"]}
                fillOpacity={room.stale ? 0.06 : selected ? 0.45 : 0.28}
                stroke={room.stale ? STALE_STROKE : selected ? SELECT_STROKE : "none"}
                strokeWidth={(room.stale ? 1.5 : 2) * u}
                strokeDasharray={room.stale ? `${6 * u} ${4 * u}` : undefined}
              />
            );
          })}
        </g>

        <g className="walls">
          {plan.walls.map((w) => {
            const a = P(w.a);
            const b = P(w.b);
            const selected = selection?.kind === "wall" && selection.id === w.id;
            const warn = issueWallIds.has(w.id);
            const width = Math.max(w.thickness * ppm, 1.5 * u);
            const lowConfidence = w.confidence !== undefined && w.confidence < 0.6;
            return (
              <g key={w.id} className={`wall${selected ? " is-selected" : ""}`}>
                {selected && (
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={SELECT_STROKE}
                    strokeOpacity={0.35}
                    strokeWidth={width + 8 * u}
                    strokeLinecap="round"
                    pointerEvents="none"
                  />
                )}
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={selected ? SELECT_STROKE : warn ? WALL_WARN : WALL_STROKE}
                  strokeOpacity={selected || warn ? 0.95 : 0.8}
                  strokeWidth={width}
                  strokeLinecap="square"
                  strokeDasharray={lowConfidence ? `${width * 1.5} ${width}` : undefined}
                  pointerEvents="none"
                />
                <line
                  data-kind="wall"
                  data-id={w.id}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="transparent"
                  strokeWidth={Math.max(width, WALL_HIT_PX * u)}
                  pointerEvents="stroke"
                />
              </g>
            );
          })}
        </g>

        <g className="openings">
          {renderedOpenings.map((o) => {
            const w = wallById.get(o.wallId);
            if (!w) return null;
            const lerp = (t: number) =>
              P({ x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t });
            const a = lerp(o.t0);
            const b = lerp(o.t1);
            const width = Math.max(w.thickness * ppm, 1.5 * u);
            const selected = selection?.kind === "opening" && selection.id === o.id;
            return (
              <g key={o.id} className={`opening kind-${o.kind}${selected ? " is-selected" : ""}`}>
                {selected && (
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={SELECT_STROKE}
                    strokeOpacity={0.4}
                    strokeWidth={width + 10 * u}
                    pointerEvents="none"
                  />
                )}
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="#ffffff"
                  strokeWidth={width + 1 * u}
                  pointerEvents="none"
                />
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={OPENING_STROKE[o.kind]}
                  strokeWidth={Math.max(width * 0.6, 3 * u)}
                  strokeDasharray={o.kind === "opening" ? `${4 * u} ${3 * u}` : undefined}
                  pointerEvents="none"
                />
                <line
                  data-kind="opening"
                  data-id={o.id}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="transparent"
                  strokeWidth={Math.max(width + 6 * u, 18 * u)}
                  pointerEvents="stroke"
                />
              </g>
            );
          })}
        </g>

        {ghostOpening && (
          <line
            x1={P(ghostOpening.a).x}
            y1={P(ghostOpening.a).y}
            x2={P(ghostOpening.b).x}
            y2={P(ghostOpening.b).y}
            stroke={OPENING_STROKE[ghostOpening.kind]}
            strokeOpacity={0.55}
            strokeWidth={Math.max(ghostOpening.thickness * ppm * 0.6, 3 * u)}
            pointerEvents="none"
          />
        )}

        <g className="labels">
          {plan.rooms.map((room) => {
            const anchor =
              anchorPreview && anchorPreview.roomId === room.id
                ? anchorPreview.point
                : room.anchor;
            const at = P(anchor);
            const area = polygonArea(room.polygon);
            return (
              <g
                key={room.id}
                className={`room-tag${room.stale ? " is-stale" : ""}`}
                data-kind="label"
                data-id={room.id}
                transform={`translate(${at.x} ${at.y})`}
              >
                <text
                  textAnchor="middle"
                  fontSize={12 * u}
                  fontWeight={600}
                  fill={room.stale ? STALE_STROKE : "#18181b"}
                  stroke="#ffffff"
                  strokeWidth={3 * u}
                  paintOrder="stroke"
                >
                  {room.name || "Tanpa nama"}
                </text>
                <text
                  textAnchor="middle"
                  y={13 * u}
                  fontSize={10 * u}
                  fill={room.stale ? STALE_STROKE : "#52525b"}
                  stroke="#ffffff"
                  strokeWidth={3 * u}
                  paintOrder="stroke"
                >
                  {room.stale ? "ruangan terputus" : `${fmt(area)} m²`}
                </text>
              </g>
            );
          })}
        </g>

        {!readOnly && tool === "select" && (
          <g className="handles">
            {handles.map((h) => {
              const at = P(h.p);
              return (
                <g
                  key={`${h.wallId}-${h.end}`}
                  data-kind="handle"
                  data-wall={h.wallId}
                  data-end={h.end}
                >
                  <circle cx={at.x} cy={at.y} r={HANDLE_HIT_PX * u} fill="transparent" />
                  <circle
                    cx={at.x}
                    cy={at.y}
                    r={5 * u}
                    fill="#ffffff"
                    stroke={SELECT_STROKE}
                    strokeWidth={1.75 * u}
                    pointerEvents="none"
                  />
                </g>
              );
            })}
          </g>
        )}

        {state.draft && (
          <g className="draft" pointerEvents="none">
            <line
              x1={P(state.draft.a).x}
              y1={P(state.draft.a).y}
              x2={P(state.draft.b).x}
              y2={P(state.draft.b).y}
              stroke={SELECT_STROKE}
              strokeWidth={Math.max(0.15 * ppm, 2 * u)}
              strokeOpacity={0.6}
              strokeDasharray={`${8 * u} ${5 * u}`}
            />
            <circle cx={P(state.draft.a).x} cy={P(state.draft.a).y} r={4 * u} fill={SELECT_STROKE} />
            <text
              x={(P(state.draft.a).x + P(state.draft.b).x) / 2}
              y={(P(state.draft.a).y + P(state.draft.b).y) / 2 - 8 * u}
              textAnchor="middle"
              fontSize={11 * u}
              fill="#18181b"
              stroke="#ffffff"
              strokeWidth={3 * u}
              paintOrder="stroke"
            >
              {`${fmt(Math.hypot(state.draft.b.x - state.draft.a.x, state.draft.b.y - state.draft.a.y))} m`}
            </text>
          </g>
        )}

        {hoverMarker && (
          <g className="snap-marker" pointerEvents="none">
            <circle
              cx={P(hoverMarker.p).x}
              cy={P(hoverMarker.p).y}
              r={(hoverMarker.kind === "endpoint" ? 6 : 4) * u}
              fill={hoverMarker.kind === "endpoint" || hoverMarker.kind === "wall" ? SELECT_STROKE : "#ffffff"}
              stroke={SELECT_STROKE}
              strokeWidth={1.5 * u}
            />
          </g>
        )}

        {calA && (
          <g className="calibration" pointerEvents="none">
            {calB && (
              <>
                <line
                  x1={P(calA).x}
                  y1={P(calA).y}
                  x2={P(calB).x}
                  y2={P(calB).y}
                  stroke="#16a34a"
                  strokeWidth={2 * u}
                  strokeDasharray={`${6 * u} ${4 * u}`}
                />
                <text
                  x={(P(calA).x + P(calB).x) / 2}
                  y={(P(calA).y + P(calB).y) / 2 - 8 * u}
                  textAnchor="middle"
                  fontSize={11 * u}
                  fill="#166534"
                  stroke="#ffffff"
                  strokeWidth={3 * u}
                  paintOrder="stroke"
                >
                  {`${fmt(Math.hypot(calB.x - calA.x, calB.y - calA.y))} m (skala sekarang)`}
                </text>
                <circle cx={P(calB).x} cy={P(calB).y} r={5 * u} fill="#16a34a" />
              </>
            )}
            <circle cx={P(calA).x} cy={P(calA).y} r={5 * u} fill="#16a34a" />
          </g>
        )}

        <g
          className="compass"
          pointerEvents="none"
          transform={`translate(${compass.x} ${compass.y})`}
        >
          <circle r={22 * u} fill="#ffffff" fillOpacity={0.9} stroke="#d4d4d8" strokeWidth={1 * u} />
          <g transform={`rotate(${-plan.northOffsetDeg})`}>
            <polygon
              points={`0,${-16 * u} ${6 * u},${4 * u} 0,${0} ${-6 * u},${4 * u}`}
              fill="#dc2626"
            />
            <polygon
              points={`0,${16 * u} ${6 * u},${4 * u} 0,${0} ${-6 * u},${4 * u}`}
              fill="#a1a1aa"
            />
            <text y={-17 * u} textAnchor="middle" fontSize={9 * u} fontWeight={700} fill="#dc2626">
              U
            </text>
          </g>
        </g>
      </svg>

      <div className="plan-zoom">
        <button type="button" onClick={() => viewport.zoomBy(1.25)} aria-label="Perbesar" title="Perbesar">
          <ZoomIn className="w-4 h-4" />
        </button>
        <button type="button" onClick={() => viewport.zoomBy(0.8)} aria-label="Perkecil" title="Perkecil">
          <ZoomOut className="w-4 h-4" />
        </button>
        <button type="button" onClick={viewport.reset} aria-label="Pas layar" title="Pas layar">
          <Maximize2 className="w-4 h-4" />
        </button>
      </div>
    </>
  );
};

export default PlanSvg;

interface AuthState {
  isSignedIn: boolean;
  userName: string | null;
  userId: string | null;
}

interface Material {
  id: string;
  name: string;
  thumbnail: string;
  type: "color" | "texture";
  category: "floor" | "wall" | "furniture";
}

interface DesignItem {
  id: string;
  name?: string | null;
  sourceImage: string;
  sourcePath?: string | null;
  renderedImage?: string | null;
  renderedPath?: string | null;
  publicPath?: string | null;
  timestamp: number;
  ownerId?: string | null;
  ownerName?: string | null;
  sharedBy?: string | null;
  sharedAt?: string | null;
  isPublic?: boolean;
}

interface DesignConfig {
  floor: string;
  walls: string;
  style: string;
}

enum AppStatus {
  IDLE = "IDLE",
  UPLOADING = "UPLOADING",
  PROCESSING = "PROCESSING",
  READY = "READY",
}

type RenderCompletePayload = {
  renderedImage: string;
  renderedPath?: string;
};

type VisualizerLocationState = {
  initialImage?: string;
  initialRender?: string | null;
  ownerId?: string | null;
  name?: string | null;
  sharedBy?: string | null;
};

interface VisualizerProps {
  onBack: () => void;
  initialImage: string | null;
  onRenderComplete?: (payload: RenderCompletePayload) => void;
  onShare?: (image: string) => Promise<void> | void;
  onUnshare?: (image: string) => Promise<void> | void;
  projectName?: string;
  projectId?: string;
  initialRender?: string | null;
  isPublic?: boolean;
  sharedBy?: string | null;
  canUnshare?: boolean;
}

interface UploadProps {
  onComplete: (base64File: string) => Promise<boolean | void> | boolean | void;
  className?: string;
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "outline";
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
}

interface CardProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
  action?: React.ReactNode;
}

type AuthContext = {
  isSignedIn: boolean;
  isAuthReady: boolean;
  userName: string | null;
  userId: string | null;
  refreshAuth: () => Promise<boolean>;
  signIn: () => Promise<boolean>;
  signOut: () => Promise<boolean>;
};

type AuthRequiredModalProps = {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title?: string;
  description?: string;
  confirmLabel?: string;
};

type ShareAction = "share" | "unshare";
type ShareStatus = "idle" | "saving" | "done";

type HostingConfig = { subdomain: string };
type HostedAsset = { url: string };

interface StoreHostedImageParams {
  hosting: HostingConfig | null;
  url: string;
  projectId: string;
  label: "source" | "rendered";
}

interface CreateProjectParams {
  item: DesignItem;
  visibility?: "private" | "public";
}

interface Generate3DViewParams {
  sourceImage: string;
  projectId?: string | null;
}

// =============================================================================
// APPEND TO type.d.ts (global ambient script file: NO import/export, no
// `declare global`). Existing identifiers in type.d.ts (AuthState, Material,
// DesignItem, DesignConfig, AppStatus, RenderCompletePayload,
// VisualizerLocationState, VisualizerProps, UploadProps, ButtonProps, CardProps,
// AuthContext, AuthRequiredModalProps, ShareAction, ShareStatus, HostingConfig,
// HostedAsset, StoreHostedImageParams, CreateProjectParams,
// Generate3DViewParams) are NOT redeclared here except DesignItem, which is
// extended by interface merging. `React` is available as in the existing file.
//
// UNITS / FRAMES: plan geometry is METRES, x right / y DOWN (image and SVG
// handedness), origin = top-left of the natural image. Scene: plan (x, y) ->
// world (x, 0, z = y); +X east, +Y up, +Z south when northOffsetDeg = 0.
// northOffsetDeg = compass bearing (deg, clockwise) of plan-up (-y).
// suncalc 2.0.2 azimuth = degrees clockwise from north; az' = az - northOffsetDeg.
// =============================================================================

/** Metres, plan space. */
interface PlanPoint {
  x: number;
  y: number;
}

/** Natural pixel size of DesignItem.sourceImage (also the SVG viewBox). */
interface PlanImageSize {
  w: number;
  h: number;
}

type PlanOpeningKind = "door" | "window" | "opening";
type PlanDoorSubtype = "kamar" | "kamar_mandi" | "utama";

type PlanRoomType =
  | "kamar_tidur"
  | "kamar_mandi"
  | "dapur"
  | "ruang_tamu"
  | "ruang_keluarga"
  | "ruang_makan"
  | "teras"
  | "garasi"
  | "gudang"
  | "koridor"
  | "servis"
  | "lainnya";

type PlanScaleMethod =
  | "dimension_labels"
  | "overall_dimension"
  | "door_prior"
  | "thickness_prior"
  | "bbox_prior"
  | "manual";

interface PlanWall {
  id: string;
  a: PlanPoint;
  b: PlanPoint;
  /** metres, clamped 0.08..0.40 when converted from pixels */
  thickness: number;
  /** metres; the ONLY wall-height source (RAB and 3D both read it) */
  height: number;
  /** hint only; lib/plan/geometry.ts wallAdjacency() is authoritative */
  isExterior?: boolean;
  /** 0..1 from the extractor; undefined for user-drawn walls */
  confidence?: number;
}

interface PlanOpening {
  id: string;
  wallId: string;
  kind: PlanOpeningKind;
  /** parametric extent along wall a -> b, 0 <= t0 < t1 <= 1 */
  t0: number;
  t1: number;
  /** metres above floor, 0 <= bottom < top <= wall.height */
  bottom: number;
  top: number;
  /** doors only; RAB derives it when absent */
  doorSubtype?: PlanDoorSubtype;
  confidence?: number;
}

interface PlanRoom {
  id: string;
  name: string;
  /** simple polygon, metres, no repeated closing vertex, >= 3 points */
  polygon: PlanPoint[];
  /** label anchor; rebuildRooms re-matches rooms by anchor containment first */
  anchor: PlanPoint;
  type?: PlanRoomType;
  /** MaterialDef id (floor category); undefined -> plan.materials.floor */
  floorMaterialId?: string | null;
  /** true when the enclosing face vanished after a wall edit; polygon is frozen,
   *  excluded from 3D / RAB / sun until re-attached or removed by REBUILD_ROOMS */
  stale?: boolean;
  confidence?: number;
}

interface PlanScale {
  /** natural image pixels per metre: m = px / pxPerMeter */
  pxPerMeter: number;
  /** true only after manual calibration or explicit "Skala sudah benar" */
  confirmed: boolean;
  method: PlanScaleMethod;
  /** 0..1 estimator confidence (0 for bbox_prior, 1 for manual) */
  confidence: number;
}

/** Plan-wide material defaults (MaterialDef ids from lib/plan/materials.ts). */
interface PlanMaterials {
  floor: string;
  /** plan-wide wall material (no per-room wall material in v1) */
  wall: string;
}

type MaterialCategory = "floor" | "wall";
type MaterialPattern = "tile" | "planks" | "plaster" | "brick";

interface MaterialDef {
  id: string;
  name: string;
  category: MaterialCategory;
  pattern: MaterialPattern;
  /** metres per texture repeat */
  tileSize: number;
  baseColor: string;
  accentColor: string;
  roughness: number;
  /** RabItem id in lib/rab/data.ts, or null when the material carries no RAB line */
  rabItemId: string | null;
}

interface SunSettings {
  /** "YYYY-MM-DD" local calendar day */
  dateISO: string;
  /** 0..1439 local wall-clock minutes */
  minutesOfDay: number;
  /** id in lib/sun/geo.ts CITIES (default "jakarta") */
  cityId: string;
  showPath: boolean;
  showCompass: boolean;
}

type RabPaket = "ringan" | "sedang" | "bangun_baru";
type RabGrade = "low" | "mid" | "high";
type RabRegion =
  | "jabodetabek"
  | "bandung"
  | "jateng"
  | "diy"
  | "jatim"
  | "jawa_lain"
  | "bali"
  | "sumatera"
  | "kalimantan"
  | "sulawesi"
  | "nusa_tenggara"
  | "papua"
  | "papua_pegunungan";

interface RabLineOverride {
  volume?: number | null;
  harga?: number | null;
  enabled?: boolean | null;
}

/** Persisted RAB inputs. NO wall height here: it lives on PlanWall.height. */
interface RabInputs {
  paket: RabPaket;
  grade: RabGrade;
  region: RabRegion;
  /** 0..15 */
  contractorFeePct: number;
  includePpn: boolean;
  /** include bongkar/buang puing lines */
  demolition: boolean;
  /** user-entered luas bangunan for the > 15 % scale sanity check */
  luasBangunanM2?: number | null;
  /** keyed by RabItem id */
  overrides: Record<string, RabLineOverride>;
}

type PlanIssueSeverity = "error" | "warn";

type PlanIssueCode =
  // structural (lib/plan/validate.ts)
  | "INVALID_NUMBER"
  | "DUP_ID"
  | "WALL_ZERO"
  | "WALL_THICKNESS"
  | "WALL_HEIGHT"
  | "OPENING_WALL"
  | "OPENING_T"
  | "OPENING_VERTICAL"
  | "OPENING_OVERLAP"
  | "ROOM_POLY"
  | "NORTH_RANGE"
  | "NO_SCALE"
  // topology / metric (lib/plan/geometry.ts planIssues, lib/plan/extract.ts)
  | "NOT_WATERTIGHT"
  | "WALL_DANGLING"
  | "WALL_DIAGONAL"
  | "WALL_SHORT"
  | "OPENING_OFF_WALL"
  | "DOOR_WIDTH"
  | "WINDOW_WIDTH"
  | "ROOM_TINY"
  | "ROOM_HUGE"
  | "ROOM_UNNAMED"
  | "ROOMS_STALE"
  | "MISSING_WALL"
  | "LABEL_ORPHAN"
  | "SCALE_UNCONFIRMED"
  | "TOTAL_AREA"
  | "LUAS_MISMATCH"
  | "SCHEMA";

type PlanFixKind =
  | "merge_nodes"
  | "snap_axis"
  | "attach_opening"
  | "clamp_opening"
  | "delete_wall"
  | "delete_opening";

/** One-click correction attached to an issue; the editor applies it via APPLY_FIX. */
interface PlanFix {
  kind: PlanFixKind;
  /** Indonesian button label, e.g. "Sambungkan", "Luruskan", "Lekatkan", "Hapus" */
  label: string;
  /** safe fixes are applied by "Perbaiki semua yang aman" */
  safe: boolean;
  ids: string[];
  /** merge_nodes: target point (m); attach_opening: target wallId in ids[1] */
  point?: PlanPoint;
}

interface PlanIssue {
  code: PlanIssueCode;
  severity: PlanIssueSeverity;
  message: string;
  /** element ids (wall / opening / room) */
  ids?: string[];
  fix?: PlanFix;
}

type ExtractionFrame = "normalized1000" | "pixels";

interface PlanExtractionMeta {
  model: string;
  frame: ExtractionFrame;
  /** size of the downscaled image that was sent */
  sentSize: PlanImageSize;
  /** ISO timestamp */
  at: string;
  issues: PlanIssue[];
  diagonalWallIds: string[];
  /** model room polygons in METRES (compact; kept in production for the "Layer denah AI" overlay) */
  rawRooms: { id: string; name: string; polygon: PlanPoint[] }[];
  /** full raw tool output; keepRaw only, dropped first by shrinkPlanForSave */
  raw?: unknown;
}

interface FloorPlan {
  version: 1;
  source: "ai" | "manual" | "sample";
  imageSize: PlanImageSize;
  scale: PlanScale;
  /** compass bearing (deg, clockwise) of plan-up (-y); 0 = image-up is north; [0, 360) */
  northOffsetDeg: number;
  walls: PlanWall[];
  openings: PlanOpening[];
  rooms: PlanRoom[];
  materials: PlanMaterials;
  sun: SunSettings;
  rab: RabInputs;
  extraction?: PlanExtractionMeta | null;
  /** ISO; stamped on every owner edit; the worker keeps its stored plan when incoming is older */
  editedAt: string;
}

// Interface merging with the existing DesignItem declaration.
interface DesignItem {
  /** full plan on /get and /save; stripped on /list */
  plan?: FloorPlan | null;
  /** /list only */
  hasPlan?: boolean;
  /** /list only */
  planEditedAt?: string | null;
  /** set by the worker on every save */
  updatedAt?: string | null;
}

interface SaveProjectResponse {
  saved: boolean;
  id: string;
  project: DesignItem;
  /** true when the worker kept its stored plan (incoming absent or older editedAt) */
  planKept?: boolean;
}

interface SavePlanParams {
  id: string;
  plan: FloorPlan | null;
}

type PlanSaveState =
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "error"
  | "conflict";

type ExtractionStatus = "idle" | "running" | "done" | "error";

interface ExtractionState {
  status: ExtractionStatus;
  modelId: string | null;
  /** current step label reported by the job */
  step: string | null;
  startedAt: number | null;
  /** ticks every second while running */
  elapsedMs: number;
  /** ExtractErrorCode string + message; the controller is generic */
  error: { code: string; message: string } | null;
}

/** Generic long-job controller hosted by the visualizer shell (lib/plan/extraction-controller.ts).
 *  A module-level in-flight map keyed by projectId survives route changes; the result is written
 *  through the shell's setPlan, never through the panel that started it. */
interface ExtractionController {
  state: ExtractionState;
  /** Rejected (returns null) while a job for this project is in flight. */
  run: (
    modelId: string,
    job: (report: (step: string) => void) => Promise<FloorPlan>,
  ) => Promise<FloorPlan | null>;
  reset: () => void;
}

/** Provided by app/routes/visualizer.$id.tsx via <Outlet context>; read with useVisualizer(). */
type VisualizerContext = AuthContext & {
  projectId: string;
  project: DesignItem | null;
  /** always the latest project, for saves from async callbacks */
  projectRef: React.RefObject<DesignItem | null>;
  /** normalizePlan(project.plan); null when absent or corrupt */
  plan: FloorPlan | null;
  /** true when project.plan exists but failed normalizePlan ("Denah rusak") */
  planCorrupt: boolean;
  isProjectLoading: boolean;
  isOwner: boolean;
  /** /visualizer/demo: built-in sample, no login, edits stay local (never saved) */
  isDemo: boolean;
  saveState: PlanSaveState;
  saveError: string | null;
  /** Local update always; stamps editedAt + normalizeWallOpenings + autosave only when isOwner. */
  updatePlan: (updater: (plan: FloorPlan) => FloorPlan) => void;
  /** Replace or clear the plan and save immediately (owner only). */
  setPlan: (plan: FloorPlan | null) => Promise<boolean>;
  /** Flush a pending debounced save now. */
  flushSave: () => Promise<boolean>;
  /** Owner only: saves through createProject from the LATEST ref merged with patch; never bumps timestamp. */
  saveProject: (patch: Partial<DesignItem>) => Promise<DesignItem | null>;
  setProject: React.Dispatch<React.SetStateAction<DesignItem | null>>;
  extraction: ExtractionController;
};
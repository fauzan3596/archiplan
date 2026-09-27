import {
  NavLink,
  Outlet,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Box,
  Check,
  Globe,
  Lock,
  RefreshCcw,
  Share2,
  X,
} from "lucide-react";
import Button from "../../components/ui/Button";
import {
  getProjectById,
  savePlan,
  saveProjectRaw,
} from "../../lib/puter.action";
import { useExtractionController } from "../../lib/plan/extraction-controller";
import { normalizePlan, normalizeWallOpenings } from "../../lib/plan/validate";
import { pickNewerPlan, shrinkPlanForSave } from "../../lib/plan/save";
import { AUTOSAVE_DEBOUNCE_MS, touchPlan } from "../../lib/plan/defaults";
import { createDemoProject, DEMO_PROJECT_ID } from "../../lib/plan/demo";

const LINK_COPIED_RESET_MS = 2000;
const CONFLICT_TOAST_MS = 6000;
const CONFLICT_NOTICE = "Denah yang lebih baru ditemukan";
const PLAN_TOO_LARGE = "Denah terlalu besar untuk disimpan";
const SAVE_FAILED = "Gagal menyimpan denah";

const SAVE_STATE_LABELS: Record<PlanSaveState, string> = {
  idle: "",
  dirty: "Belum tersimpan",
  saving: "Menyimpan…",
  saved: "Tersimpan",
  error: "Gagal menyimpan",
  conflict: CONFLICT_NOTICE,
};

const tabClassName = ({ isActive }: { isActive: boolean }) =>
  `tab ${isActive ? "is-active" : ""}`;

const VisualizerId = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const auth = useOutletContext<AuthContext>();
  const { isSignedIn, isAuthReady, userId, signIn } = auth;

  const linkCopiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef(false);
  const projectRef = useRef<DesignItem | null>(null);
  const isOwnerRef = useRef(false);
  const flushSaveRef = useRef<() => Promise<boolean>>(async () => true);

  const [project, setProjectState] = useState<DesignItem | null>(null);
  const [isProjectLoading, setIsProjectLoading] = useState(true);
  const [saveState, setSaveState] = useState<PlanSaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);

  const [isUpdatingVisibility, setIsUpdatingVisibility] = useState(false);
  const [isLinkCopied, setIsLinkCopied] = useState(false);

  // The demo project is editable by everyone, but only in memory.
  const isDemo = id === DEMO_PROJECT_ID;
  const isOwner =
    isDemo || Boolean(project && userId && project.ownerId === userId);
  isOwnerRef.current = isOwner;
  const isDemoRef = useRef(isDemo);
  isDemoRef.current = isDemo;

  // The normalised plan is derived from the project; a stored plan that fails
  // normalisation yields null + planCorrupt.
  const rawPlan = project?.plan ?? null;
  const plan = useMemo(() => (rawPlan ? normalizePlan(rawPlan) : null), [rawPlan]);
  const planCorrupt = Boolean(rawPlan) && plan === null;

  // Every write goes through the ref first so async callbacks (autosave,
  // render save, extraction) always see the latest project.
  const setProject = useCallback<
    React.Dispatch<React.SetStateAction<DesignItem | null>>
  >((action) => {
    const next =
      typeof action === "function" ? action(projectRef.current) : action;
    projectRef.current = next;
    setProjectState(next);
  }, []);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  const adoptServerProject = useCallback(
    (server: SaveProjectResponse): { adoptedServerPlan: boolean } => {
      const local = projectRef.current;
      const localPlan = local?.plan ? normalizePlan(local.plan) : null;
      const serverPlan = server.project.plan
        ? normalizePlan(server.project.plan)
        : null;
      const merged = pickNewerPlan(localPlan, serverPlan);

      // Only a stored plan that is strictly newer than ours is a conflict; an
      // equal editedAt means the worker simply kept the plan we already have.
      const adoptedServerPlan = Boolean(
        server.planKept &&
          serverPlan &&
          merged === serverPlan &&
          (!localPlan || serverPlan.editedAt > localPlan.editedAt),
      );

      const nextPlan = merged ?? local?.plan ?? server.project.plan ?? null;

      setProject({ ...server.project, plan: nextPlan });

      if (adoptedServerPlan) {
        pendingSaveRef.current = false;
        setSaveState("conflict");
        setSaveError(null);
        setConflictNotice(CONFLICT_NOTICE);
      }

      return { adoptedServerPlan };
    },
    [setProject],
  );

  const clearAutosaveTimer = () => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  };

  const flushSave = useCallback(async (): Promise<boolean> => {
    clearAutosaveTimer();

    if (!pendingSaveRef.current) return true;

    const current = projectRef.current;
    if (!current || !isOwnerRef.current || isDemoRef.current) {
      pendingSaveRef.current = false;
      return true;
    }

    pendingSaveRef.current = false;

    const currentPlan = current.plan ?? null;
    const savedEditedAt = currentPlan?.editedAt ?? null;
    let planToSave: FloorPlan | null = null;

    if (currentPlan) {
      const shrunk = shrinkPlanForSave(currentPlan);
      if (!shrunk) {
        setSaveState("error");
        setSaveError(PLAN_TOO_LARGE);
        return false;
      }
      planToSave = shrunk.plan;
    }

    setSaveState("saving");
    setSaveError(null);

    const response = await savePlan({ id: current.id, plan: planToSave });

    if (!response) {
      pendingSaveRef.current = true;
      setSaveState("error");
      setSaveError(SAVE_FAILED);
      return false;
    }

    const { adoptedServerPlan } = adoptServerProject(response);
    if (adoptedServerPlan) return true;

    const latestEditedAt = projectRef.current?.plan?.editedAt ?? null;
    if (pendingSaveRef.current || latestEditedAt !== savedEditedAt) {
      setSaveState("dirty");
    } else {
      setSaveState("saved");
    }

    return true;
  }, [adoptServerProject]);

  flushSaveRef.current = flushSave;

  const scheduleAutosave = useCallback(() => {
    clearAutosaveTimer();
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void flushSaveRef.current();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, []);

  const updatePlan = useCallback(
    (updater: (plan: FloorPlan) => FloorPlan) => {
      const current = projectRef.current;
      const base = current?.plan ? normalizePlan(current.plan) : null;
      if (!current || !base) return;

      let next = updater(base);

      if (isOwnerRef.current) {
        next = touchPlan({
          ...next,
          openings: normalizeWallOpenings(next.openings, next.walls),
        });

        if (!isDemoRef.current) {
          pendingSaveRef.current = true;
          setSaveState("dirty");
          setSaveError(null);
          scheduleAutosave();
        }
      }

      setProject({ ...current, plan: next });
    },
    [scheduleAutosave, setProject],
  );

  const setPlan = useCallback(
    async (nextPlan: FloorPlan | null): Promise<boolean> => {
      const current = projectRef.current;
      if (!current) return false;

      const stamped = nextPlan
        ? touchPlan({
            ...nextPlan,
            openings: normalizeWallOpenings(nextPlan.openings, nextPlan.walls),
          })
        : null;

      setProject({ ...current, plan: stamped });

      if (!isOwnerRef.current || isDemoRef.current) return true;

      pendingSaveRef.current = true;
      return flushSave();
    },
    [flushSave, setProject],
  );

  const saveProject = useCallback(
    async (patch: Partial<DesignItem>): Promise<DesignItem | null> => {
      const current = projectRef.current;
      if (!current || !isOwnerRef.current) return null;

      if (isDemoRef.current) {
        const next = { ...current, ...patch };
        setProject(next);
        return next;
      }

      const item: DesignItem = { ...current, ...patch };

      if (item.plan) {
        const shrunk = shrinkPlanForSave(item.plan);
        if (shrunk) {
          item.plan = shrunk.plan;
        } else {
          // Omitting the plan makes the worker keep its stored copy.
          delete item.plan;
          setSaveState("error");
          setSaveError(PLAN_TOO_LARGE);
        }
      }

      const response = await saveProjectRaw({
        item,
        visibility: item.isPublic ? "public" : "private",
      });

      if (!response) return null;

      adoptServerProject(response);

      return projectRef.current;
    },
    [adoptServerProject],
  );

  const extraction = useExtractionController(id ?? "", setPlan);

  const handleBack = () => navigate("/");

  const updateVisibility = async (isPublic: boolean) => {
    if (!project || !isOwner) return null;

    try {
      setIsUpdatingVisibility(true);
      return await saveProject({ isPublic });
    } finally {
      setIsUpdatingVisibility(false);
    }
  };

  const handleToggleVisibility = () => {
    if (!project) return;
    void updateVisibility(!project.isPublic);
  };

  const handleShare = async () => {
    if (!project) return;

    // Only public projects can be opened by others, so sharing a private
    // project publishes it first.
    if (isOwner && !project.isPublic) {
      const saved = await updateVisibility(true);
      if (!saved) return;
    }

    const shareUrl = window.location.href;

    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      window.prompt("Copy this link to share the project:", shareUrl);
      return;
    }

    setIsLinkCopied(true);
    if (linkCopiedTimeoutRef.current) {
      clearTimeout(linkCopiedTimeoutRef.current);
    }
    linkCopiedTimeoutRef.current = setTimeout(
      () => setIsLinkCopied(false),
      LINK_COPIED_RESET_MS,
    );
  };

  useEffect(() => {
    return () => {
      if (linkCopiedTimeoutRef.current) {
        clearTimeout(linkCopiedTimeoutRef.current);
      }
    };
  }, []);

  // Pending edits are flushed when the tab is hidden/closed and on unmount.
  useEffect(() => {
    const onPageHide = () => {
      void flushSaveRef.current();
    };

    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      void flushSaveRef.current();
    };
  }, []);

  useEffect(() => {
    if (!conflictNotice) return;

    const timer = setTimeout(() => setConflictNotice(null), CONFLICT_TOAST_MS);

    return () => clearTimeout(timer);
  }, [conflictNotice]);

  useEffect(() => {
    let isMounted = true;

    const loadProject = async () => {
      if (id === DEMO_PROJECT_ID) {
        setProject(createDemoProject());
        setSaveState("idle");
        setSaveError(null);
        setIsProjectLoading(false);
        return;
      }

      if (!isAuthReady) return;

      if (!id || !isSignedIn) {
        setProject(null);
        setIsProjectLoading(false);
        return;
      }

      setIsProjectLoading(true);

      const fetchedProject = await getProjectById({ id });

      if (!isMounted) return;

      setProject(fetchedProject);
      setSaveState("idle");
      setSaveError(null);
      setIsProjectLoading(false);
    };

    loadProject();

    return () => {
      isMounted = false;
      // Switching projects flushes whatever the previous one still had pending.
      void flushSaveRef.current();
    };
  }, [id, isSignedIn, isAuthReady, setProject]);

  const renderStatus = () => {
    if (isAuthReady && !isSignedIn && !isDemo) {
      return (
        <div className="rendering-card">
          <Lock className="status-icon" />
          <span className="title">Sign in to view this project</span>
          <span className="subtitle">
            Projects are loaded from your Puter account
          </span>
          <Button size="sm" onClick={() => void signIn()} className="action">
            Log In
          </Button>
        </div>
      );
    }

    if (isProjectLoading) {
      return (
        <div className="rendering-card">
          <RefreshCcw className="spinner" />
          <span className="title">Loading project...</span>
        </div>
      );
    }

    if (!project) {
      return (
        <div className="rendering-card">
          <X className="status-icon" />
          <span className="title">Project not found</span>
          <span className="subtitle">
            It may have been deleted or made private by its owner
          </span>
          <Button size="sm" onClick={handleBack} className="action">
            Back to Home
          </Button>
        </div>
      );
    }

    return null;
  };

  const status = renderStatus();

  const ctx: VisualizerContext = {
    ...auth,
    projectId: id ?? "",
    project,
    projectRef,
    plan,
    planCorrupt,
    isProjectLoading,
    isOwner,
    isDemo,
    saveState,
    saveError,
    updatePlan,
    setPlan,
    flushSave,
    saveProject,
    setProject,
    extraction,
  };

  const showSaveState = isOwner && saveState !== "idle";
  const tabsDisabled = !plan;

  return (
    <div className="visualizer">
      <nav className="topbar">
        <div className="brand">
          <Box className="logo" />
          <span className="name">Archiplan</span>
        </div>
        <Button variant="ghost" size="sm" onClick={handleBack} className="exit">
          <X className="icon" />
          Exit Editor
        </Button>
      </nav>

      <section className="content">
        <div className="panel">
          <div className="panel-header">
            <div className="panel-meta">
              <p>Project</p>
              <h2>{project?.name || `Residence ${id}`}</h2>
              {project && (
                <p className="note">
                  {isDemo
                    ? "Mode demo · perubahan hanya tersimpan di browser ini sampai halaman dimuat ulang"
                    : isOwner
                      ? `Created by You · ${project.isPublic ? "Public" : "Private"}`
                      : `Shared by ${project.ownerName || "a community member"}`}
                  {showSaveState && (
                    <span className="save-state" data-state={saveState}>
                      {saveState === "error"
                        ? saveError || SAVE_STATE_LABELS.error
                        : SAVE_STATE_LABELS[saveState]}
                      {saveState === "error" && (
                        <button
                          type="button"
                          className="retry"
                          onClick={() => {
                            pendingSaveRef.current = true;
                            void flushSave();
                          }}
                        >
                          Coba lagi
                        </button>
                      )}
                    </span>
                  )}
                </p>
              )}
            </div>

            <div className="panel-actions">
              {isOwner && !isDemo && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleToggleVisibility}
                  className="visibility"
                  disabled={isUpdatingVisibility}
                >
                  {project?.isPublic ? (
                    <>
                      <Globe className="w-4 h-4 mr-2" /> Public
                    </>
                  ) : (
                    <>
                      <Lock className="w-4 h-4 mr-2" /> Private
                    </>
                  )}
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleShare}
                className="share"
                disabled={!project || isUpdatingVisibility}
              >
                {isLinkCopied ? (
                  <>
                    <Check className="w-4 h-4 mr-2" /> Link Copied
                  </>
                ) : (
                  <>
                    <Share2 className="w-4 h-4 mr-2" /> Share
                  </>
                )}
              </Button>
            </div>
          </div>

          {project && (
            <nav className="tabs" aria-label="Bagian proyek">
              <NavLink to="." end className={tabClassName}>
                Render
              </NavLink>
              <NavLink to="plan" className={tabClassName}>
                Denah 2D
              </NavLink>
              <NavLink
                to="3d"
                className={tabClassName}
                aria-disabled={tabsDisabled || undefined}
                tabIndex={tabsDisabled ? -1 : undefined}
                onClick={(e) => {
                  if (tabsDisabled) e.preventDefault();
                }}
              >
                Walkthrough 3D
              </NavLink>
              <NavLink
                to="rab"
                className={tabClassName}
                aria-disabled={tabsDisabled || undefined}
                tabIndex={tabsDisabled ? -1 : undefined}
                onClick={(e) => {
                  if (tabsDisabled) e.preventDefault();
                }}
              >
                RAB
              </NavLink>
            </nav>
          )}
        </div>

        {planCorrupt && (
          <div className="panel plan-corrupt">
            <AlertTriangle className="icon" />
            <div className="copy">
              <h3>Denah rusak</h3>
              <p>
                Data denah yang tersimpan tidak dapat dibaca.
                {isOwner
                  ? " Reset denah untuk memulai lagi dari gambar sumber."
                  : " Hubungi pemilik proyek untuk memperbaikinya."}
              </p>
            </div>
            {isOwner && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void setPlan(null)}
                className="reset"
              >
                Reset denah
              </Button>
            )}
          </div>
        )}

        {status ? (
          <div className="panel">
            <div className="status-area">{status}</div>
          </div>
        ) : (
          <Outlet context={ctx} />
        )}
      </section>

      {conflictNotice && (
        <div className="conflict-toast" role="status">
          <AlertTriangle className="icon" />
          <span>{conflictNotice}</span>
          <button
            type="button"
            onClick={() => setConflictNotice(null)}
            aria-label="Tutup"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
};

export default VisualizerId;

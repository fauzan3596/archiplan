// Generic long-job controller hosted by the visualizer shell. The promise and
// the state live in module-level maps keyed by projectId, so switching tabs
// (or remounting the panel that started the job) never loses the result: a
// remounted hook re-attaches to the running state, and the result is written
// through the shell's onDone (setPlan), never through the panel.

import { useCallback, useEffect, useRef, useState } from "react";

const IDLE_STATE: ExtractionState = {
  status: "idle",
  modelId: null,
  step: null,
  startedAt: null,
  elapsedMs: 0,
  error: null,
};

type Listener = (state: ExtractionState) => void;
type OnDone = (plan: FloorPlan) => Promise<boolean>;

export const inFlight = new Map<string, Promise<FloorPlan>>();

const states = new Map<string, ExtractionState>();
const listeners = new Map<string, Set<Listener>>();
const tickers = new Map<string, ReturnType<typeof setInterval>>();
const onDoneHandlers = new Map<string, OnDone>();
const pendingResults = new Map<string, FloorPlan>();

const getState = (projectId: string): ExtractionState =>
  states.get(projectId) ?? IDLE_STATE;

const setState = (projectId: string, patch: Partial<ExtractionState>) => {
  const next = { ...getState(projectId), ...patch };
  states.set(projectId, next);
  listeners.get(projectId)?.forEach((listener) => listener(next));
};

const stopTicker = (projectId: string) => {
  const ticker = tickers.get(projectId);
  if (ticker) clearInterval(ticker);
  tickers.delete(projectId);
};

const startTicker = (projectId: string, startedAt: number) => {
  stopTicker(projectId);
  tickers.set(
    projectId,
    setInterval(() => {
      setState(projectId, { elapsedMs: Date.now() - startedAt });
    }, 1000),
  );
};

const errorOf = (e: unknown): { code: string; message: string } => {
  if (e && typeof e === "object") {
    const rec = e as { code?: unknown; message?: unknown };
    return {
      code: typeof rec.code === "string" ? rec.code : "unknown",
      message:
        typeof rec.message === "string" ? rec.message : "Terjadi kesalahan",
    };
  }
  return { code: "unknown", message: String(e ?? "Terjadi kesalahan") };
};

const deliver = async (projectId: string, plan: FloorPlan) => {
  const handler = onDoneHandlers.get(projectId);
  if (!handler) {
    // Nobody is mounted for this project; hand the plan over on the next mount.
    pendingResults.set(projectId, plan);
    return;
  }
  pendingResults.delete(projectId);
  try {
    await handler(plan);
  } catch (e) {
    console.error("Extraction onDone failed:", e);
  }
};

const runJob = async (
  projectId: string,
  modelId: string,
  job: (report: (step: string) => void) => Promise<FloorPlan>,
): Promise<FloorPlan | null> => {
  if (inFlight.has(projectId)) {
    console.warn("Extraction already running for project", projectId);
    return null;
  }

  const startedAt = Date.now();
  setState(projectId, {
    status: "running",
    modelId,
    step: null,
    startedAt,
    elapsedMs: 0,
    error: null,
  });
  startTicker(projectId, startedAt);

  const report = (step: string) => setState(projectId, { step });
  const promise = job(report);
  inFlight.set(projectId, promise);

  try {
    const plan = await promise;
    stopTicker(projectId);
    inFlight.delete(projectId);
    setState(projectId, {
      status: "done",
      step: null,
      elapsedMs: Date.now() - startedAt,
    });
    await deliver(projectId, plan);
    return plan;
  } catch (e) {
    stopTicker(projectId);
    inFlight.delete(projectId);
    console.error("Extraction failed:", e);
    setState(projectId, {
      status: "error",
      step: null,
      elapsedMs: Date.now() - startedAt,
      error: errorOf(e),
    });
    return null;
  }
};

export const useExtractionController = (
  projectId: string,
  onDone: OnDone,
): ExtractionController => {
  const [state, setLocalState] = useState<ExtractionState>(() =>
    getState(projectId),
  );
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const listener: Listener = (next) => setLocalState(next);
    const set = listeners.get(projectId) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(projectId, set);
    setLocalState(getState(projectId));

    const handler: OnDone = (plan) => onDoneRef.current(plan);
    onDoneHandlers.set(projectId, handler);

    const pending = pendingResults.get(projectId);
    if (pending) void deliver(projectId, pending);

    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(projectId);
      if (onDoneHandlers.get(projectId) === handler) {
        onDoneHandlers.delete(projectId);
      }
    };
  }, [projectId]);

  const run = useCallback<ExtractionController["run"]>(
    (modelId, job) => runJob(projectId, modelId, job),
    [projectId],
  );

  const reset = useCallback(() => {
    if (inFlight.has(projectId)) return;
    stopTicker(projectId);
    setState(projectId, { ...IDLE_STATE });
  }, [projectId]);

  return { state, run, reset };
};

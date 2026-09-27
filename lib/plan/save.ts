// Plan revision merging and size budgets shared by the shell and the worker
// contract (the worker returns 413 above PLAN_HARD_BYTES chars).

export const PLAN_SOFT_BYTES = 300_000;
export const PLAN_HARD_BYTES = 380_000;

export const planJsonBytes = (plan: FloorPlan | null): number => {
  if (!plan) return 0;
  const json = JSON.stringify(plan);
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(json).length;
  }
  return json.length;
};

/** Newer editedAt (lexical ISO compare) wins; ties keep local; null only when both are null. */
export const pickNewerPlan = (
  local: FloorPlan | null,
  server: FloorPlan | null,
): FloorPlan | null => {
  if (!local) return server ?? null;
  if (!server) return local;
  const localAt = local.editedAt ?? "";
  const serverAt = server.editedAt ?? "";
  return serverAt > localAt ? server : local;
};

/** Drops extraction.raw above the soft budget; null (refuse) above the hard budget. */
export const shrinkPlanForSave = (
  plan: FloorPlan,
): { plan: FloorPlan; droppedRaw: boolean } | null => {
  let next = plan;
  let droppedRaw = false;
  let bytes = planJsonBytes(next);

  if (bytes > PLAN_SOFT_BYTES && next.extraction && "raw" in next.extraction) {
    const { raw: _raw, ...extraction } = next.extraction;
    next = { ...next, extraction };
    droppedRaw = true;
    bytes = planJsonBytes(next);
  }

  if (bytes > PLAN_HARD_BYTES) {
    console.error(
      `Plan too large to save: ${bytes} bytes > ${PLAN_HARD_BYTES}`,
    );
    return null;
  }

  return { plan: next, droppedRaw };
};

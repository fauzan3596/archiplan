// Private projects live in each caller's own KV (user.puter). Public projects
// are also mirrored into the deployer's KV (me.puter) so every user can read
// them for the community feed and shared links.
const PROJECT_PREFIX = "archiplan_project_";
const PUBLIC_PREFIX = "archiplan_public_";

// Puter KV values are capped at 400 KB; refuse anything close to it.
const MAX_BODY_CHARS = 380000;

const jsonError = (status, message, extra = {}) => {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
};

const getCaller = async (userPuter) => {
  try {
    const user = await userPuter.auth.getUser();

    return user?.uuid ? { id: user.uuid, name: user.username || null } : null;
  } catch {
    return null;
  }
};

const byNewest = (a, b) => (b.timestamp || 0) - (a.timestamp || 0);

// Reads the JSON body while enforcing the size guard. Returns { body } or
// { error: Response }.
const readJsonBody = async (request) => {
  const text = await request.text();

  if (text.length > MAX_BODY_CHARS) {
    return {
      error: jsonError(413, "Payload too large", {
        limit: MAX_BODY_CHARS,
        size: text.length,
      }),
    };
  }

  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: jsonError(400, "Invalid JSON body") };
  }
};

// editedAt-monotonic plan merge. `incoming === null` clears the plan; an
// absent or older incoming plan keeps the stored one (planKept: true).
const mergePlan = (storedPlan, incomingPlan) => {
  const stored = storedPlan ?? null;

  if (incomingPlan === null) return { plan: null, planKept: false };

  if (incomingPlan === undefined) {
    return { plan: stored, planKept: Boolean(stored) };
  }

  if (
    stored &&
    typeof stored.editedAt === "string" &&
    typeof incomingPlan.editedAt === "string" &&
    incomingPlan.editedAt <= stored.editedAt
  ) {
    return { plan: stored, planKept: true };
  }

  return { plan: incomingPlan, planKept: false };
};

// The /list feed never carries plan JSON, only hasPlan / planEditedAt.
const stripPlan = ({ plan, ...value }) => ({
  ...value,
  hasPlan: Boolean(plan),
  planEditedAt: plan?.editedAt ?? null,
});

router.post("/api/projects/save", async ({ request, user, me }) => {
  try {
    const userPuter = user?.puter;
    if (!userPuter) return jsonError(401, "Authentication failed");

    const caller = await getCaller(userPuter);
    if (!caller) return jsonError(401, "Authentication failed");

    const { body, error } = await readJsonBody(request);
    if (error) return error;

    const project = body?.project;
    const isPublic = body?.visibility === "public";

    if (!project?.id || !project?.sourceImage) {
      return jsonError(400, "Project ID and source image are required");
    }

    const key = `${PROJECT_PREFIX}${project.id}`;
    const publicKey = `${PUBLIC_PREFIX}${project.id}`;

    const existingPublic = await me.puter.kv.get(publicKey);
    if (existingPublic && existingPublic.ownerId !== caller.id) {
      return jsonError(403, "This project belongs to another user");
    }

    // Safety net: never let a save built from a stale client object clobber
    // a newer stored plan.
    const existingOwn = await userPuter.kv.get(key);
    const stored = existingOwn || existingPublic || null;
    const { plan, planKept } = mergePlan(stored?.plan, project.plan);

    const now = new Date().toISOString();
    const payload = {
      ...project,
      plan,
      ownerId: caller.id,
      ownerName: caller.name,
      isPublic,
      sharedAt: isPublic ? existingPublic?.sharedAt || now : null,
      updatedAt: now,
    };

    await userPuter.kv.set(key, payload);

    if (isPublic) {
      await me.puter.kv.set(publicKey, payload);
    } else if (existingPublic) {
      await me.puter.kv.del(publicKey);
    }

    return { saved: true, id: project.id, project: payload, planKept };
  } catch (e) {
    return jsonError(500, "Failed to save project", {
      message: e.message || "Unknown error",
    });
  }
});

// Plan-only save: merges by editedAt, never touches `timestamp`, mirrors to
// the public key when the project is public.
router.post("/api/projects/plan", async ({ request, user, me }) => {
  try {
    const userPuter = user?.puter;
    if (!userPuter) return jsonError(401, "Authentication failed");

    const caller = await getCaller(userPuter);
    if (!caller) return jsonError(401, "Authentication failed");

    const { body, error } = await readJsonBody(request);
    if (error) return error;

    const id = body?.id;
    const incoming = body?.plan;

    if (!id) return jsonError(400, "Project ID is required");

    if (
      incoming !== undefined &&
      incoming !== null &&
      (typeof incoming !== "object" || Array.isArray(incoming))
    ) {
      return jsonError(400, "Plan must be an object or null");
    }

    const key = `${PROJECT_PREFIX}${id}`;
    const publicKey = `${PUBLIC_PREFIX}${id}`;

    const existingPublic = await me.puter.kv.get(publicKey);
    if (existingPublic && existingPublic.ownerId !== caller.id) {
      return jsonError(403, "This project belongs to another user");
    }

    const existingOwn = await userPuter.kv.get(key);
    const stored = existingOwn || existingPublic || null;

    if (!stored) return jsonError(404, "Project not found");

    const { plan, planKept } = mergePlan(stored.plan, incoming);

    const now = new Date().toISOString();
    const payload = {
      ...stored,
      plan,
      ownerId: stored.ownerId ?? caller.id,
      updatedAt: now,
    };

    await userPuter.kv.set(key, payload);

    if (payload.isPublic) {
      await me.puter.kv.set(publicKey, payload);
    }

    return { saved: true, id, project: payload, planKept };
  } catch (e) {
    return jsonError(500, "Failed to save plan", {
      message: e.message || "Unknown error",
    });
  }
});

router.get("/api/projects/list", async ({ user, me }) => {
  try {
    const userPuter = user?.puter;
    if (!userPuter) return jsonError(401, "Authentication failed");

    const caller = await getCaller(userPuter);
    if (!caller) return jsonError(401, "Authentication failed");

    const own = (await userPuter.kv.list(PROJECT_PREFIX, true)).map(
      ({ value }) => ({
        ...stripPlan(value),
        ownerId: value.ownerId ?? caller.id,
        isPublic: Boolean(value.isPublic),
      }),
    );

    const community = (await me.puter.kv.list(PUBLIC_PREFIX, true))
      .map(({ value }) => stripPlan(value))
      .filter((project) => project.ownerId !== caller.id);

    return { projects: [...own, ...community].sort(byNewest) };
  } catch (e) {
    return jsonError(500, "Failed to list projects", {
      message: e.message || "Unknown error",
    });
  }
});

router.get("/api/projects/get", async ({ request, user, me }) => {
  try {
    const userPuter = user?.puter;
    if (!userPuter) return jsonError(401, "Authentication failed");

    const caller = await getCaller(userPuter);
    if (!caller) return jsonError(401, "Authentication failed");

    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (!id) return jsonError(400, "Project ID is required");

    const own = await userPuter.kv.get(`${PROJECT_PREFIX}${id}`);
    if (own) {
      return { project: { ...own, ownerId: own.ownerId ?? caller.id } };
    }

    const shared = await me.puter.kv.get(`${PUBLIC_PREFIX}${id}`);
    if (shared) return { project: shared };

    return jsonError(404, "Project not found");
  } catch (e) {
    return jsonError(500, "Failed to get project", {
      message: e.message || "Unknown error",
    });
  }
});

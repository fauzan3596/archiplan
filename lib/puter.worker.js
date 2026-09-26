// Private projects live in each caller's own KV (user.puter). Public projects
// are also mirrored into the deployer's KV (me.puter) so every user can read
// them for the community feed and shared links.
const PROJECT_PREFIX = "archiplan_project_";
const PUBLIC_PREFIX = "archiplan_public_";

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

router.post("/api/projects/save", async ({ request, user, me }) => {
  try {
    const userPuter = user?.puter;
    if (!userPuter) return jsonError(401, "Authentication failed");

    const caller = await getCaller(userPuter);
    if (!caller) return jsonError(401, "Authentication failed");

    const body = await request.json();
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

    const now = new Date().toISOString();
    const payload = {
      ...project,
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

    return { saved: true, id: project.id, project: payload };
  } catch (e) {
    return jsonError(500, "Failed to save project", {
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
        ...value,
        ownerId: value.ownerId ?? caller.id,
        isPublic: Boolean(value.isPublic),
      }),
    );

    const community = (await me.puter.kv.list(PUBLIC_PREFIX, true))
      .map(({ value }) => value)
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

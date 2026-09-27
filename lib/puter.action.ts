import puter from "@heyputer/puter.js";
import { getOrCreateHostingConfig, uploadImageHosting } from "./puter.hosting";
import { isHostedUrl } from "./utils";
import { PUTER_WORKER_URL } from "./constants";

export const signIn = async () => await puter.auth.signIn();

export const signOut = () => puter.auth.signOut();

export const getCurrentUser = async () => {
  try {
    return await puter.auth.getUser();
  } catch {
    return null;
  }
};

const isSaveResponse = (data: unknown): data is SaveProjectResponse =>
  typeof data === "object" &&
  data !== null &&
  typeof (data as { project?: unknown }).project === "object" &&
  (data as { project?: unknown }).project !== null;

// Hosts the images, then saves the whole project through the worker and
// returns the full worker envelope (project + planKept).
export const saveProjectRaw = async ({
  item,
  visibility = item.isPublic ? "public" : "private",
}: CreateProjectParams): Promise<SaveProjectResponse | null> => {
  if (!PUTER_WORKER_URL) {
    console.warn("Missing VITE_PUTER_WORKER_URL; skipping project save.");
    return null;
  }

  const projectId = item.id;

  let hosting: HostingConfig | null = null;
  try {
    hosting = await getOrCreateHostingConfig();
  } catch (e) {
    console.error("Failed to resolve hosting config:", e);
  }

  const hostedSource = projectId
    ? await uploadImageHosting({
        hosting,
        url: item.sourceImage,
        projectId,
        label: "source",
      })
    : null;

  const hostedRender =
    projectId && item.renderedImage
      ? await uploadImageHosting({
          hosting,
          url: item.renderedImage,
          projectId,
          label: "rendered",
        })
      : null;

  const resolvedSource =
    hostedSource?.url || (isHostedUrl(item.sourceImage) ? item.sourceImage : "");

  if (!resolvedSource) {
    console.warn("Failed to host source image, skipping save.");
    return null;
  }

  const resolvedRender = hostedRender?.url
    ? hostedRender?.url
    : item.renderedImage && isHostedUrl(item.renderedImage)
      ? item.renderedImage
      : undefined;

  const {
    sourcePath: _sourcePath,
    renderedPath: _renderedPath,
    publicPath: _publicPath,
    ...rest
  } = item;

  const payload = {
    ...rest,
    sourceImage: resolvedSource,
    renderedImage: resolvedRender,
  };

  try {
    const response = await puter.workers.exec(
      `${PUTER_WORKER_URL}/api/projects/save`,
      {
        method: "POST",
        body: JSON.stringify({ project: payload, visibility }),
      },
    );

    if (!response.ok) {
      console.error("Failed to save project:", await response.text());
      return null;
    }

    const data: unknown = await response.json();

    return isSaveResponse(data) ? data : null;
  } catch (e) {
    console.error("Failed to save project:", e);
    return null;
  }
};

export const createProject = async (
  params: CreateProjectParams,
): Promise<DesignItem | null> => {
  const saved = await saveProjectRaw(params);
  return saved?.project ?? null;
};

// Plan-only merge save (no image hosting round trip). The worker keeps its
// stored plan when the incoming one is absent or older (planKept: true).
export const savePlan = async ({
  id,
  plan,
}: SavePlanParams): Promise<SaveProjectResponse | null> => {
  if (!PUTER_WORKER_URL) {
    console.warn("Missing VITE_PUTER_WORKER_URL; skipping plan save.");
    return null;
  }

  try {
    const response = await puter.workers.exec(
      `${PUTER_WORKER_URL}/api/projects/plan`,
      {
        method: "POST",
        body: JSON.stringify({ id, plan }),
      },
    );

    if (!response.ok) {
      console.error("Failed to save plan:", await response.text());
      return null;
    }

    const data: unknown = await response.json();

    return isSaveResponse(data) ? data : null;
  } catch (e) {
    console.error("Failed to save plan:", e);
    return null;
  }
};

export const getProjects = async (): Promise<DesignItem[]> => {
  if (!PUTER_WORKER_URL) {
    console.warn("Missing VITE_PUTER_WORKER_URL; skipping projects fetch.");
    return [];
  }

  try {
    const response = await puter.workers.exec(
      `${PUTER_WORKER_URL}/api/projects/list`,
      { method: "GET" },
    );

    if (!response.ok) {
      console.error("Failed to fetch projects:", await response.text());
      return [];
    }

    const data = (await response.json()) as { projects?: DesignItem[] | null };

    return Array.isArray(data?.projects) ? data.projects : [];
  } catch (e) {
    console.error("Failed to fetch projects:", e);
    return [];
  }
};

export const getProjectById = async ({
  id,
}: {
  id: string;
}): Promise<DesignItem | null> => {
  if (!PUTER_WORKER_URL) {
    console.warn("Missing VITE_PUTER_WORKER_URL; skipping project fetch.");
    return null;
  }

  try {
    const response = await puter.workers.exec(
      `${PUTER_WORKER_URL}/api/projects/get?id=${encodeURIComponent(id)}`,
      { method: "GET" },
    );

    if (!response.ok) {
      console.error("Failed to fetch project:", await response.text());
      return null;
    }

    const data = (await response.json()) as { project?: DesignItem | null };

    return data?.project ?? null;
  } catch (e) {
    console.error("Failed to fetch project:", e);
    return null;
  }
};

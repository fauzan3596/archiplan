// One MeshStandardMaterial (with its procedural CanvasTexture) per resolved
// catalog id, shared by every mesh of the 3D scene. Ids are resolved through
// materialById, so unknown or wrong-category ids share the category default's
// material. Materials are created lazily on the first get() and all textures
// and materials are disposed when the owning component unmounts.
//
// The returned materials are SHARED: do not mutate or dispose them. Clone
// (`material.clone()`, and `map.clone()` for a different repeat) when a mesh
// needs different settings.

import { useCallback, useEffect, useMemo, useState } from "react";
import { MeshStandardMaterial } from "three";
import type { CanvasTexture } from "three";
import { materialById } from "../../lib/plan/materials";
import { createMaterialTexture } from "./textures";

interface MaterialEntry {
  texture: CanvasTexture;
  material: MeshStandardMaterial;
}

export interface MaterialLibrary {
  /** Shared material for a catalog id (falls back to the category default). */
  get: (
    id: string | null | undefined,
    category: MaterialCategory,
  ) => MeshStandardMaterial;
}

const createEntry = (def: MaterialDef): MaterialEntry => {
  const texture = createMaterialTexture(def);
  const material = new MeshStandardMaterial({
    name: def.id,
    color: 0xffffff,
    map: texture,
    roughness: def.roughness,
    metalness: 0,
  });
  return { texture, material };
};

const disposeEntry = (entry: MaterialEntry): void => {
  entry.material.dispose();
  entry.texture.dispose();
};

export const useMaterials = (): MaterialLibrary => {
  // A Map held in state (not a ref) so get() may read it during render.
  const [cache] = useState(() => new Map<string, MaterialEntry>());

  const get = useCallback(
    (id: string | null | undefined, category: MaterialCategory) => {
      const def = materialById(id, category);
      let entry = cache.get(def.id);
      if (!entry) {
        entry = createEntry(def);
        cache.set(def.id, entry);
      }
      return entry.material;
    },
    [cache],
  );

  useEffect(
    () => () => {
      // Free GPU resources but keep the entries: when the effect re-runs on
      // the same cache (StrictMode, <Activity>) three re-uploads a disposed
      // texture / recompiles a disposed material on its next render, and the
      // final unmount disposes them again (dispose is idempotent).
      cache.forEach(disposeEntry);
    },
    [cache],
  );

  return useMemo(() => ({ get }), [get]);
};

export default useMaterials;

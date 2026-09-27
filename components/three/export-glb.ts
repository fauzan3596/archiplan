// Binary glTF export of the house group (walls, floors, ceilings, openings).
// Labels (drei <Html>, no mesh) and lights live outside the exported group.
// CanvasTextures are same-origin, so GLTFExporter can re-encode them into the
// .glb buffer; texture.repeat is written as KHR_texture_transform.

import type * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

export const exportGlb = async (
  root: THREE.Object3D,
  filename = "archiplan.glb",
): Promise<void> => {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, {
    binary: true, // -> ArrayBuffer (.glb)
    // Ceilings are hidden outside walk mode but still belong in the export;
    // the exported group holds nothing else that is hidden.
    onlyVisible: false,
    trs: false,
    maxTextureSize: 2048,
  });
  const buffer = result as ArrayBuffer;
  const blob = new Blob([buffer], { type: "model/gltf-binary" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

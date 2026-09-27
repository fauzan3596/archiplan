import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "node:path";

// Puter site hosting redirects any URL with uppercase letters to its
// lowercase form, so every built file name must be lowercase to resolve.
const lowercaseChunk = ({ name }: { name: string }) =>
  `assets/${name.toLowerCase()}-[hash].js`;

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  // A single three instance: drei/fiber must never bundle their own copy.
  resolve: {
    dedupe: ["three"],
  },
  build: {
    rollupOptions: {
      output: {
        hashCharacters: "hex",
        entryFileNames: lowercaseChunk,
        chunkFileNames: lowercaseChunk,
        assetFileNames: ({ names }) =>
          `assets/${path.parse(names[0] ?? "asset").name.toLowerCase()}-[hash][extname]`,
        // No manualChunks: forcing three / @react-three into named chunks made
        // Rollup hoist shared helpers into them, so every route (home
        // included) imported ~1.2 MB of 3D code. Route-level splitting alone
        // keeps three inside the 3d route's chunks.
      },
    },
  },
});

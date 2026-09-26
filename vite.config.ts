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
  build: {
    rollupOptions: {
      output: {
        hashCharacters: "hex",
        entryFileNames: lowercaseChunk,
        chunkFileNames: lowercaseChunk,
        assetFileNames: ({ names }) =>
          `assets/${path.parse(names[0] ?? "asset").name.toLowerCase()}-[hash][extname]`,
      },
    },
  },
});

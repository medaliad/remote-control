import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Dev-time proxy: `npm --workspace web run dev` talks to a separately running
// `npm --workspace server run dev` on :3000. In production everything is
// served from the same origin, so no proxy is needed.
//
// `nodePolyfills` ships the Node built-ins that simple-peer's transitive
// `readable-stream` dep needs at runtime (events/stream/buffer/util) plus
// the `Buffer`, `process`, and `global` globals. Without it Vite leaves
// `inherits()` with an undefined superCtor and the Peer constructor throws
// `Cannot read properties of undefined (reading 'call')`.
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: { Buffer: true, process: true, global: true },
      include: ["buffer", "events", "stream", "util"],
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/ws":     { target: "ws://localhost:3000", ws: true },
      "/health": { target: "http://localhost:3000" },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

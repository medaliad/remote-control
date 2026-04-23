import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-time proxy: `npm --workspace web run dev` talks to a separately running
// `npm --workspace server run dev` on :3000. In production everything is
// served from the same origin, so no proxy is needed.
export default defineConfig({
  plugins: [react()],
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

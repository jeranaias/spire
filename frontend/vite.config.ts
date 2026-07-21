import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const BACKEND_TARGET = process.env.VITE_BACKEND_TARGET || "http://localhost:8000";
const FRONTEND_PORT = Number(process.env.VITE_FRONTEND_PORT || 5000);

// /map is the offline basemap (style.json + the PMTiles archive). It sits
// outside /api deliberately - MapLibre fetches it directly and it carries no
// CUI - so it needs its own proxy entry or the map falls back to "no pack
// installed" whenever the frontend is served by Vite rather than nginx.
const PROXY = {
  "/api": { target: BACKEND_TARGET, changeOrigin: true },
  "/map": { target: BACKEND_TARGET, changeOrigin: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: FRONTEND_PORT,
    strictPort: true,
    allowedHosts: true,
    proxy: PROXY,
  },
  preview: {
    host: "0.0.0.0",
    port: FRONTEND_PORT,
    allowedHosts: true,
    // Preview serves the production bundle, which expects the same
    // same-origin backend the container gives it. Without this, /api and
    // /map 404 and the app looks broken in the one mode that is closest to
    // what actually ships.
    proxy: PROXY,
  },
});

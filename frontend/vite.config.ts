import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const BACKEND_TARGET = process.env.VITE_BACKEND_TARGET || "http://localhost:8000";
const FRONTEND_PORT = Number(process.env.VITE_FRONTEND_PORT || 5000);

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
    proxy: {
      "/api": {
        target: BACKEND_TARGET,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: FRONTEND_PORT,
    allowedHosts: true,
  },
});

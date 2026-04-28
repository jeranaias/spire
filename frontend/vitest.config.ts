import { defineConfig } from "vitest/config";
import path from "node:path";

// @vitejs/plugin-react is intentionally omitted: the Vite-8 build of that
// plugin imports a Rolldown internal that breaks Vitest's resolver. The
// built-in esbuild "automatic" JSX transform is sufficient for tests.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Pin react/react-dom to this package's node_modules so a duplicate
      // copy from the repo root can't trigger "Invalid hook call".
      react: path.resolve(__dirname, "./node_modules/react"),
      "react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
      "react-dom/client": path.resolve(__dirname, "./node_modules/react-dom/client.js"),
    },
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

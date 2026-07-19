import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Object form (not the string shorthand) — the shorthand doesn't set `ws: true`,
      // which the E13 "drop in" WebSocket route (/api/workstreams/:id/interactive)
      // needs to actually get proxied in dev instead of failing the upgrade.
      "/api": { target: "http://127.0.0.1:4180", ws: true },
    },
  },
  build: {
    target: "ES2022",
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});

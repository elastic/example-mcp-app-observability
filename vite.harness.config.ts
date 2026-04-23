/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Vite config for the UI harness.
 *
 * Serves `harness/index.html` at http://localhost:5371/harness/. The critical
 * trick is the `@shared/use-app` alias that swaps the real postMessage-based
 * hook for the harness mock in `harness/mock-use-app`, letting us render each
 * view with a fixture directly instead of round-tripping through an MCP host.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, "harness"),
  plugins: [react()],
  server: {
    port: 5371,
    open: "/",
    strictPort: false,
  },
  resolve: {
    alias: [
      // Swap the postMessage-based hook for our in-process mock.
      {
        find: "@shared/use-app",
        replacement: path.resolve(__dirname, "harness/mock-use-app"),
      },
      // Everything else resolves to the real shared module.
      {
        find: /^@shared\/(.*)$/,
        replacement: path.resolve(__dirname, "src/shared/$1"),
      },
    ],
  },
  optimizeDeps: {
    include: ["axe-core"],
  },
});

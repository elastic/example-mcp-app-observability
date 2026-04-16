/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveViewPath(viewName: string): string {
  const candidates = [
    path.resolve(__dirname, "views", viewName, "mcp-app.html"),
    path.resolve(__dirname, "../../dist/views", viewName, "mcp-app.html"),
    path.resolve(__dirname, "../../../dist/views", viewName, "mcp-app.html"),
    path.resolve(__dirname, "../../views", viewName, "mcp-app.html"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0];
}

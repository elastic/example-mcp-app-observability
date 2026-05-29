/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

export function readPackageVersion(importMetaUrl: string): string {
  let dir = dirname(fileURLToPath(importMetaUrl));
  for (let i = 0; i < 3; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch { /* try parent */ }
    dir = join(dir, "..");
  }
  return "0.0.0";
}

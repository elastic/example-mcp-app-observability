/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { esRequest } from "./client.js";
import type { EsqlResult } from "../shared/types.js";

export async function executeEsql(query: string): Promise<EsqlResult> {
  return esRequest<EsqlResult>("/_query", {
    body: { query },
    params: { format: "json" },
  });
}

export function rowsFromEsql<T>(result: EsqlResult): T[] {
  return result.values.map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((col, i) => {
      obj[col.name] = row[i];
    });
    return obj as T;
  });
}

// Runs an ESQL query, returning rows on success and [] on failure. Failures are
// always logged to stderr. When an `errors` collector is supplied, the error
// message is appended so callers can surface it in tool responses — this is
// how tools avoid the "silent empty result" trap that masks schema drift.
export async function safeEsqlRows<T>(
  query: string,
  errors?: string[]
): Promise<T[]> {
  try {
    const res = await executeEsql(query);
    return rowsFromEsql<T>(res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[elastic-o11y-mcp] ESQL failed: ${msg}\n`);
    if (errors) errors.push(msg);
    return [];
  }
}

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { safeEsqlRows } from "./esql.js";

// Resolve a k8s namespace to the service.name set observed in that namespace over
// the lookback window. Used to scope APM queries by service.name rather than by
// a direct `k8s.namespace.name == X` clause — the pre-aggregated APM summary
// metrics (`metrics-service_*.1m.otel-*`) may not carry k8s.namespace.name as a
// transform dimension, so a direct clause silently returns zero rows even when
// the namespace is populated. service.name is the universal join key across
// OTel rollups, OTel traces, and classic APM — scoping by it works everywhere.
//
// Preference order: OTel traces (`traces-*.otel-*` with `k8s.namespace.name`) →
// classic APM (`traces-apm*` with `kubernetes.namespace`). An empty result is
// the signal for "no APM services in this namespace over this window" — callers
// should short-circuit with a targeted hint rather than issuing downstream
// queries with an empty `IN ()` clause.
export async function resolveServicesInNamespace(
  namespace: string,
  lookback: string,
  errors: string[]
): Promise<string[]> {
  const otelQuery = `
FROM traces-*.otel-*
| WHERE @timestamp > NOW() - ${lookback}
  AND k8s.namespace.name == "${namespace}"
  AND service.name IS NOT NULL
| STATS cnt = COUNT(*) BY service.name
| SORT cnt DESC
| LIMIT 100
`;
  const otelRows = await safeEsqlRows<{ "service.name"?: string }>(otelQuery, errors);
  const out = new Set<string>();
  for (const r of otelRows) if (r["service.name"]) out.add(r["service.name"]);
  if (out.size) return [...out];

  const classicQuery = `
FROM traces-apm*
| WHERE @timestamp > NOW() - ${lookback}
  AND kubernetes.namespace == "${namespace}"
  AND service.name IS NOT NULL
  AND processor.event == "transaction"
| STATS cnt = COUNT(*) BY service.name
| SORT cnt DESC
| LIMIT 100
`;
  const classicRows = await safeEsqlRows<{ "service.name"?: string }>(classicQuery, errors);
  for (const r of classicRows) if (r["service.name"]) out.add(r["service.name"]);
  return [...out];
}

// Build the ES|QL `AND service.name IN ("a", "b", ...)` fragment used to scope
// downstream queries by a resolved service set. Returns "" when no scoping is
// in effect so callers can unconditionally append it to their WHERE clause.
// Double-quotes in service names are escaped defensively.
export function buildServiceFilter(services: string[] | undefined): string {
  if (!services || !services.length) return "";
  const escaped = services.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(", ");
  return `\n  AND service.name IN (${escaped})`;
}

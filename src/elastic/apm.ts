/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { safeEsqlRows } from "./esql.js";
import { CLUSTERS_AVAILABLE_CAP, RESOLUTION_CANDIDATE_CAP } from "../tools/_limits.js";

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

  // Classic APM fallback. `optional: true` because in pure-OTel environments
  // `traces-apm*` may match stub/bootstrap indices that don't carry the classic
  // schema (@timestamp, kubernetes.namespace, processor.event), producing
  // verification_exception errors on every field. Those failures are expected
  // wrong-env signals — not problems the user should see in _query_errors.
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
  const classicRows = await safeEsqlRows<{ "service.name"?: string }>(classicQuery, errors, {
    optional: true,
  });
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

export interface ResolvedNamespace {
  resolved?: string;
  note?: string;
  candidates?: string[];
}

// Fuzzy-resolve a user-supplied namespace string against the set actually
// present in recent telemetry. Users commonly say "otel-demo" when the real
// namespace is "oteldemo-esyox-default" (Elastic demo-env naming convention)
// or "prod" when it's "production-gke-us-east". Exact match → prefix match
// (after normalizing case and stripping -_) → substring match. When no match,
// returns up to 8 candidate names so the caller can surface them to the user.
//
// ECS branch is `optional` because `traces-apm*` in pure-OTel envs can match
// stub indices without kubernetes.namespace — the verification_exception
// isn't a schema-drift signal the user needs to see.
export async function resolveNamespace(
  requested: string | undefined,
  lookback: string,
  errors: string[]
): Promise<ResolvedNamespace> {
  if (!requested) return {};
  const otelEsql = `FROM metrics-kubeletstatsreceiver.otel-*,traces-*.otel-* | WHERE @timestamp > NOW() - ${lookback} | STATS c = COUNT(*) BY k8s.namespace.name | SORT c DESC | LIMIT 50`;
  const ecsEsql = `FROM traces-apm* | WHERE @timestamp > NOW() - ${lookback} AND kubernetes.namespace IS NOT NULL | STATS c = COUNT(*) BY kubernetes.namespace | SORT c DESC | LIMIT 50`;
  const [otelRows, ecsRows] = await Promise.all([
    safeEsqlRows<{ "k8s.namespace.name"?: string }>(otelEsql, errors),
    safeEsqlRows<{ "kubernetes.namespace"?: string }>(ecsEsql, errors, { optional: true }),
  ]);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of otelRows) {
    const n = r["k8s.namespace.name"];
    if (n && !seen.has(n)) {
      seen.add(n);
      names.push(n);
    }
  }
  for (const r of ecsRows) {
    const n = r["kubernetes.namespace"];
    if (n && !seen.has(n)) {
      seen.add(n);
      names.push(n);
    }
  }
  if (!names.length) return {};
  if (names.includes(requested)) return { resolved: requested };
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  const target = norm(requested);
  const prefix = names.find((n) => norm(n).startsWith(target));
  if (prefix) {
    return {
      resolved: prefix,
      note: `Resolved namespace "${requested}" → "${prefix}" (prefix match).`,
    };
  }
  const substr = names.find((n) => norm(n).includes(target));
  if (substr) {
    return {
      resolved: substr,
      note: `Resolved namespace "${requested}" → "${substr}" (fuzzy match).`,
    };
  }
  return {
    note: `Namespace "${requested}" not found in recent telemetry.`,
    candidates: names.slice(0, RESOLUTION_CANDIDATE_CAP),
  };
}

// ─── Cluster resolution + scoping ───────────────────────────────────────────
//
// Cluster naming differs across schemas:
//   - OTel: `k8s.cluster.name` (and sometimes `resource.attributes.k8s.cluster.name`
//     in older indexer versions)
//   - ECS: `orchestrator.cluster.name`
//
// We query both index families and merge results so single-namespace,
// multi-cluster environments are detected regardless of schema. The same
// fuzzy-match → prefix → substring → candidates flow as `resolveNamespace`.
//
// `resolveServicesInCluster` mirrors `resolveServicesInNamespace`: returns
// the set of `service.name` values observed in the named cluster. Callers
// intersect this with the namespace-scoped set when both are supplied.

export interface ResolvedCluster {
  resolved?: string;
  note?: string;
  candidates?: string[];
}

export async function listAvailableClusters(
  lookback: string,
  errors: string[]
): Promise<string[]> {
  // OTel side. The kubeletstats index reliably carries `k8s.cluster.name`
  // when present; traces don't always, so we don't include them in the
  // primary path. Anything missing here gets caught by the ECS fallback.
  const otelEsql = `FROM metrics-kubeletstatsreceiver.otel-* | WHERE @timestamp > NOW() - ${lookback} AND k8s.cluster.name IS NOT NULL | STATS c = COUNT(*) BY k8s.cluster.name | SORT c DESC | LIMIT ${CLUSTERS_AVAILABLE_CAP * 2}`;
  // ECS side — `traces-apm*` carrying `orchestrator.cluster.name`. Marked
  // optional because pure-OTel envs match stub indices that lack the field.
  const ecsEsql = `FROM traces-apm* | WHERE @timestamp > NOW() - ${lookback} AND orchestrator.cluster.name IS NOT NULL | STATS c = COUNT(*) BY orchestrator.cluster.name | SORT c DESC | LIMIT ${CLUSTERS_AVAILABLE_CAP * 2}`;
  const [otelRows, ecsRows] = await Promise.all([
    safeEsqlRows<{ "k8s.cluster.name"?: string }>(otelEsql, errors, { optional: true }),
    safeEsqlRows<{ "orchestrator.cluster.name"?: string }>(ecsEsql, errors, { optional: true }),
  ]);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of otelRows) {
    const n = r["k8s.cluster.name"];
    if (n && !seen.has(n)) { seen.add(n); names.push(n); }
  }
  for (const r of ecsRows) {
    const n = r["orchestrator.cluster.name"];
    if (n && !seen.has(n)) { seen.add(n); names.push(n); }
  }
  return names.slice(0, CLUSTERS_AVAILABLE_CAP);
}

export async function resolveCluster(
  requested: string | undefined,
  lookback: string,
  errors: string[]
): Promise<ResolvedCluster> {
  if (!requested) return {};
  const names = await listAvailableClusters(lookback, errors);
  if (!names.length) return {};
  if (names.includes(requested)) return { resolved: requested };
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  const target = norm(requested);
  const prefix = names.find((n) => norm(n).startsWith(target));
  if (prefix) {
    return {
      resolved: prefix,
      note: `Resolved cluster "${requested}" → "${prefix}" (prefix match).`,
    };
  }
  const substr = names.find((n) => norm(n).includes(target));
  if (substr) {
    return {
      resolved: substr,
      note: `Resolved cluster "${requested}" → "${substr}" (fuzzy match).`,
    };
  }
  return {
    note: `Cluster "${requested}" not found in recent telemetry.`,
    candidates: names.slice(0, RESOLUTION_CANDIDATE_CAP),
  };
}

// Resolve a cluster name to the service.name set observed in that cluster.
// Same rationale as `resolveServicesInNamespace` — we scope downstream APM
// queries by service.name rather than by direct cluster filter, since the
// pre-aggregated APM rollup may not carry cluster as a transform dimension.
export async function resolveServicesInCluster(
  cluster: string,
  lookback: string,
  errors: string[]
): Promise<string[]> {
  const otelQuery = `
FROM traces-*.otel-*,metrics-kubeletstatsreceiver.otel-*
| WHERE @timestamp > NOW() - ${lookback}
  AND k8s.cluster.name == "${cluster}"
  AND service.name IS NOT NULL
| STATS cnt = COUNT(*) BY service.name
| SORT cnt DESC
| LIMIT 200
`;
  const otelRows = await safeEsqlRows<{ "service.name"?: string }>(otelQuery, errors, {
    optional: true,
  });
  const out = new Set<string>();
  for (const r of otelRows) if (r["service.name"]) out.add(r["service.name"]);
  if (out.size) return [...out];

  const classicQuery = `
FROM traces-apm*
| WHERE @timestamp > NOW() - ${lookback}
  AND orchestrator.cluster.name == "${cluster}"
  AND service.name IS NOT NULL
  AND processor.event == "transaction"
| STATS cnt = COUNT(*) BY service.name
| SORT cnt DESC
| LIMIT 200
`;
  const classicRows = await safeEsqlRows<{ "service.name"?: string }>(classicQuery, errors, {
    optional: true,
  });
  for (const r of classicRows) if (r["service.name"]) out.add(r["service.name"]);
  return [...out];
}

/**
 * ES|QL `AND k8s.cluster.name == "x"` fragment for kubeletstats-side queries.
 * APM-side queries don't use this — they scope via `service.name IN (…)`
 * intersected with the cluster-resolved service set. Returns "" when no
 * cluster filter is active.
 */
export function buildClusterFilter(cluster: string | undefined): string {
  if (!cluster) return "";
  const safe = cluster.replace(/"/g, '\\"');
  return `\n  AND k8s.cluster.name == "${safe}"`;
}

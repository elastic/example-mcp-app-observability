/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import fs from "fs";
import { safeEsqlRows } from "../elastic/esql.js";
import { esRequest } from "../elastic/client.js";
import { mlAnomalyIndicesExist } from "../elastic/ml.js";
import {
  resolveServicesInNamespace,
  buildServiceFilter,
  resolveNamespace,
  resolveCluster,
  resolveServicesInCluster,
  buildClusterFilter,
  listAvailableClusters,
} from "../elastic/apm.js";
import { resolveViewPath } from "./view-path.js";
import { ANOMALY_BY_ENTITY_CAP, PODS_BY_APP_CAP } from "./_limits.js";
import { consumeWelcomeNotice } from "../setup/notice.js";

const RESOURCE_URI = "ui://apm-health-summary/mcp-app.html";

interface MetricTimelineBucket {
  ts: number;    // bucket start, epoch ms
  value: number; // MAX in bucket for gauge metrics, SUM/COUNT for rates
}

interface ServiceRow {
  service: string;
  throughput: number;
  error_rate_pct?: number;
  avg_latency_ms?: number;
  /**
   * p99 transaction duration in ms over the lookback window. Reported per
   * service so the view can recompute the namespace-aggregate p99 tile
   * from a filtered subset of services without a tool re-invocation.
   */
  p99_latency_ms?: number;
  /**
   * Application this service belongs to. Resolved from APM service.namespace
   * → labels['app.kubernetes.io/name'] → naming prefix. Undefined when no
   * grouping signal is present; the view buckets these under 'ungrouped'.
   * The same vocabulary appears in scope.service_groups[].label.
   */
  app?: string;
  timeline?: MetricTimelineBucket[];
  peak_throughput?: number;
}

interface PodRow {
  pod: string;
  avg_memory_mb: number;
  avg_cpu_cores: number;
  /**
   * APM service running in this pod, derived from OTel trace resource
   * attributes (k8s.pod.name + service.name correlation). Undefined for
   * pods with no APM service (sidecars, infra pods).
   */
  service?: string;
  /**
   * Application label this pod belongs to. Resolved by chaining
   * `service` -> APM `service.namespace`. Same vocabulary as
   * scope.service_groups[].label and services.details[].app — a
   * single, view-side filter on the app axis filters services + pods
   * consistently.
   */
  app?: string;
  timeline?: MetricTimelineBucket[];
  peak_memory_mb?: number;
}

// Timeline bucket span for pods/services sparklines. 12 cells over a 1h
// lookback — same density as the anomaly heatmap.
const METRIC_TIMELINE_SPAN_MIN = 5;
const METRIC_TIMELINE_SPAN_MS = METRIC_TIMELINE_SPAN_MIN * 60 * 1000;

// ─── KPI tile shape + status-chip thresholds ────────────────────────────────

export type TileStatus = "ok" | "degraded" | "critical";
export type TileSpark = "line" | "bar";

export interface KpiTile {
  key: string;
  label: string;
  value_display: string;          // pre-formatted (e.g. "13.7K", "412 ms", "—")
  unit?: string;                  // separate from value when useful (e.g. "rpm")
  secondary?: string;             // second-line text (e.g. "3 degraded", "5 nodes")
  timeline?: MetricTimelineBucket[];
  peak?: number;
  spark?: TileSpark;              // default "line"; "bar" for discrete-rate metrics
  status?: TileStatus;            // omitted when no universal threshold (e.g. throughput)
}

/** Defaults are documented; callers can swap in customer-tuned thresholds later. */
function statusForLatency(p99Ms: number): TileStatus {
  if (p99Ms >= 1000) return "critical";
  if (p99Ms >= 500) return "degraded";
  return "ok";
}
function statusForErrorRate(pct: number): TileStatus {
  if (pct >= 2) return "critical";
  if (pct >= 1) return "degraded";
  return "ok";
}
function statusForDegradedCount(n: number): TileStatus {
  if (n >= 3) return "critical";
  if (n >= 1) return "degraded";
  return "ok";
}
function statusForCpuUtil(pct: number): TileStatus {
  if (pct >= 90) return "critical";
  if (pct >= 80) return "degraded";
  return "ok";
}
function statusForMemUtil(pct: number): TileStatus {
  if (pct >= 95) return "critical";
  if (pct >= 90) return "degraded";
  return "ok";
}
function statusForRestarts(n: number): TileStatus {
  if (n >= 5) return "critical";
  if (n >= 1) return "degraded";
  return "ok";
}
function statusForPods(pending: number, failed: number): TileStatus {
  if (failed >= 1) return "critical";
  if (pending >= 1) return "degraded";
  return "ok";
}
function statusForNodes(notReady: number): TileStatus {
  if (notReady >= 2) return "critical";
  if (notReady >= 1) return "degraded";
  return "ok";
}

function fmtThroughput(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

/**
 * Intersect the service sets returned by namespace + cluster resolution.
 *   - both sets present: intersection
 *   - one set present:   that set
 *   - neither set:       undefined (caller skips service.name IN scoping)
 *
 * Returning [] (vs undefined) is the signal "scope is set but no services
 * match" — the caller short-circuits the downstream queries to avoid
 * issuing an empty IN-list, which would silently match everything.
 */
function intersectServiceSets(
  a: string[] | undefined,
  b: string[] | undefined
): string[] | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  const setB = new Set(b);
  return a.filter((s) => setB.has(s));
}

interface ServiceGroup {
  label: string;
  services: string[];
  /**
   * Total service count for this app across the entire cluster (regardless
   * of current scope). Set when greater than `services.length` so the view
   * can flag the chip with a ⤴ indicator showing the app extends beyond
   * the active scope.
   */
  total?: number;
}

/**
 * Per-app k8s rollup. Lets the view recompute filtered cpu/mem/restart
 * tiles from the selected app set without a tool re-invocation. All
 * percentages are derived as `use / lim * 100` (NaN-safe — when limits
 * are zero we report 0). `pod_count` is the number of pods in the app.
 */
interface K8sAppRollup {
  pod_count: number;
  cpu_util_pct: number;
  mem_util_pct: number;
  restart_count: number;
}

/**
 * Bucket the in-scope services by their resolved app label and decorate
 * each bucket with the cluster-wide footprint when it differs. Sorted by
 * in-scope service count (descending) so the most-relevant apps render
 * first in the chip strip.
 */
function buildServiceGroups(
  services: ServiceRow[],
  appMap: Map<string, string>,
  footprint: Map<string, number>
): ServiceGroup[] {
  const buckets = new Map<string, string[]>();
  for (const s of services) {
    const app = appMap.get(s.service);
    if (!app) continue;
    const arr = buckets.get(app) ?? [];
    arr.push(s.service);
    buckets.set(app, arr);
  }
  const out: ServiceGroup[] = [];
  for (const [label, list] of buckets) {
    const group: ServiceGroup = { label, services: list };
    const fullFootprint = footprint.get(label);
    if (fullFootprint !== undefined && fullFootprint > list.length) {
      group.total = fullFootprint;
    }
    out.push(group);
  }
  out.sort((a, b) => b.services.length - a.services.length);
  return out;
}

/**
 * Bucket per-pod resource snapshots into per-app rollups using the
 * pod -> service -> service.namespace chain. Pods that don't resolve
 * to an app go under the "_ungrouped" bucket so the view can offer a
 * dedicated chip for them. Caps at PODS_BY_APP_CAP buckets — the
 * remainder collapses into "_other" so totals reconcile with the
 * namespace-aggregate cpu/mem tiles even when the long tail is
 * truncated.
 */
function buildPodsByApp(
  podSnapshots: Map<string, PodResourceSnapshot>,
  podServiceMap: Map<string, string>,
  serviceNamespaceMap: Map<string, string>
): Record<string, K8sAppRollup> | undefined {
  if (!podSnapshots.size) return undefined;

  interface Acc {
    cpu_use: number;
    cpu_lim: number;
    mem_use: number;
    mem_lim: number;
    restart_count: number;
    pod_count: number;
  }
  const acc = new Map<string, Acc>();
  const bump = (key: string, snap: PodResourceSnapshot) => {
    const a = acc.get(key) ?? {
      cpu_use: 0, cpu_lim: 0, mem_use: 0, mem_lim: 0, restart_count: 0, pod_count: 0,
    };
    a.cpu_use += snap.cpu_use_cores;
    a.cpu_lim += snap.cpu_lim_cores;
    a.mem_use += snap.mem_use_bytes;
    a.mem_lim += snap.mem_lim_bytes;
    a.restart_count += snap.restart_delta;
    a.pod_count += 1;
    acc.set(key, a);
  };

  for (const snap of podSnapshots.values()) {
    const svc = podServiceMap.get(snap.pod);
    const app = svc ? serviceNamespaceMap.get(svc) : undefined;
    bump(app ?? "_ungrouped", snap);
  }

  // Cap at PODS_BY_APP_CAP non-pseudo apps; collapse the long tail. The
  // _ungrouped pseudo-bucket is exempt from the cap since it's the
  // catch-all for unmappable pods.
  const realApps = [...acc.entries()]
    .filter(([k]) => !k.startsWith("_"))
    .sort((a, b) => b[1].pod_count - a[1].pod_count);
  const kept = realApps.slice(0, PODS_BY_APP_CAP);
  const tail = realApps.slice(PODS_BY_APP_CAP);
  if (tail.length) {
    const otherAcc = acc.get("_other") ?? {
      cpu_use: 0, cpu_lim: 0, mem_use: 0, mem_lim: 0, restart_count: 0, pod_count: 0,
    };
    for (const [, a] of tail) {
      otherAcc.cpu_use += a.cpu_use;
      otherAcc.cpu_lim += a.cpu_lim;
      otherAcc.mem_use += a.mem_use;
      otherAcc.mem_lim += a.mem_lim;
      otherAcc.restart_count += a.restart_count;
      otherAcc.pod_count += a.pod_count;
    }
    acc.set("_other", otherAcc);
  }

  const out: Record<string, K8sAppRollup> = {};
  const finalize = (key: string) => {
    const a = acc.get(key);
    if (!a) return;
    out[key] = {
      pod_count: a.pod_count,
      cpu_util_pct: a.cpu_lim > 0 ? Math.round((a.cpu_use / a.cpu_lim) * 1000) / 10 : 0,
      mem_util_pct: a.mem_lim > 0 ? Math.round((a.mem_use / a.mem_lim) * 1000) / 10 : 0,
      restart_count: a.restart_count,
    };
  };
  for (const [k] of kept) finalize(k);
  if (acc.has("_ungrouped")) finalize("_ungrouped");
  if (acc.has("_other")) finalize("_other");
  return out;
}

async function queryServiceTransactionRollup(
  serviceFilter: string,
  lookback: string,
  errors: string[]
): Promise<ServiceRow[]> {
  // Scope by service.name IN (…) instead of k8s.namespace.name directly — the rollup
  // transform may not carry the namespace as a dimension, which silently drops all
  // rows even when data is present. See src/elastic/apm.ts for rationale.
  const trimmedFilter = serviceFilter.trim();
  const clause = trimmedFilter ? ` ${trimmedFilter} ` : "";
  const esql = `FROM metrics-service_transaction.1m.otel-* | WHERE @timestamp > NOW() - ${lookback}${clause}| STATS total = COUNT(*) BY service.name | SORT total DESC | LIMIT 30`;
  const rows = await safeEsqlRows<{ "service.name"?: string; total?: number }>(esql, errors);
  return rows
    .filter((r) => !!r["service.name"])
    .map((r) => ({ service: r["service.name"]!, throughput: r.total || 0 }));
}

async function queryServiceTraces(
  serviceFilter: string,
  lookback: string,
  errors: string[]
): Promise<ServiceRow[]> {
  const trimmedFilter = serviceFilter.trim();
  const clause = trimmedFilter ? ` ${trimmedFilter} ` : "";
  const esql = `FROM traces-*.otel-* | WHERE @timestamp > NOW() - ${lookback}${clause}| STATS total_count = COUNT(*) BY service.name | SORT total_count DESC | LIMIT 30`;
  const rows = await safeEsqlRows<{ "service.name"?: string; total_count?: number }>(esql, errors);
  return rows
    .filter((r) => !!r["service.name"])
    .map((r) => ({
      service: r["service.name"]!,
      throughput: r.total_count || 0,
    }));
}

// Tier 3: classic APM agents — traces-apm*. Scopes by service.name IN (…) rather
// than kubernetes.namespace to avoid the "Unknown column [kubernetes.namespace]"
// error on mappings that don't include the ECS k8s fields. Only run when tier-1
// (pre-agg metrics) and tier-2 (OTel traces) return nothing. Marked `optional`
// so verification_exception failures in pure-OTel envs (where traces-apm* can
// match stub indices lacking classic APM fields) don't pollute _query_errors.
async function queryServiceTracesClassic(
  serviceFilter: string,
  lookback: string,
  errors: string[]
): Promise<ServiceRow[]> {
  const trimmedFilter = serviceFilter.trim();
  const clause = trimmedFilter ? ` ${trimmedFilter} ` : "";
  const esql = `FROM traces-apm* | WHERE @timestamp > NOW() - ${lookback} AND processor.event == "transaction"${clause}| STATS total_count = COUNT(*) BY service.name | SORT total_count DESC | LIMIT 30`;
  const rows = await safeEsqlRows<{ "service.name"?: string; total_count?: number }>(esql, errors, {
    optional: true,
  });
  return rows
    .filter((r) => !!r["service.name"])
    .map((r) => ({
      service: r["service.name"]!,
      throughput: r.total_count || 0,
    }));
}

async function queryServices(
  serviceFilter: string,
  lookback: string,
  errors: string[]
): Promise<ServiceRow[]> {
  const rollup = await queryServiceTransactionRollup(serviceFilter, lookback, errors);
  if (rollup.length) return rollup;
  const otel = await queryServiceTraces(serviceFilter, lookback, errors);
  if (otel.length) return otel;
  return queryServiceTracesClassic(serviceFilter, lookback, errors);
}

/**
 * Per-service throughput bucketed over the lookback so each service row can
 * render a sparkline. Always pulls from the service-transaction rollup, which
 * is also the preferred source in queryServices — when the main query fell
 * back to traces/classic APM this may return empty, and the view degrades
 * the row to no-sparkline. Acceptable trade-off for now.
 */
async function queryServicesTimeline(
  serviceNames: string[],
  serviceFilter: string,
  lookback: string,
  errors: string[]
): Promise<Map<string, MetricTimelineBucket[]>> {
  const out = new Map<string, MetricTimelineBucket[]>();
  if (serviceNames.length === 0) return out;
  const trimmed = serviceFilter.trim();
  const clause = trimmed ? ` ${trimmed} ` : "";
  const esql = `FROM metrics-service_transaction.1m.otel-* | WHERE @timestamp > NOW() - ${lookback}${clause}| STATS count = COUNT(*) BY service.name, bucket = BUCKET(@timestamp, ${METRIC_TIMELINE_SPAN_MIN} minute) | SORT bucket ASC`;
  const rows = await safeEsqlRows<{
    "service.name"?: string;
    count?: number;
    bucket?: string | number;
  }>(esql, errors, { optional: true });
  for (const r of rows) {
    const name = r["service.name"];
    if (!name || r.bucket == null) continue;
    const ts = typeof r.bucket === "number" ? r.bucket : Date.parse(r.bucket);
    if (Number.isNaN(ts)) continue;
    const arr = out.get(name) ?? [];
    arr.push({ ts, value: r.count ?? 0 });
    out.set(name, arr);
  }
  return out;
}

/**
 * Per-pod memory working-set bucketed over the lookback so each pod row can
 * render a sparkline with a peak marker. MAX inside the bucket matches the
 * aggregate-metric-double storage (same reason the top-level query uses MAX).
 */
async function queryPodsMemoryTimeline(
  podNames: string[],
  namespace: string | undefined,
  cluster: string | undefined,
  lookback: string,
  errors: string[]
): Promise<Map<string, MetricTimelineBucket[]>> {
  const out = new Map<string, MetricTimelineBucket[]>();
  if (podNames.length === 0) return out;
  const nsFilter = namespace ? `AND k8s.namespace.name == "${namespace}" ` : "";
  const clusterFilter = cluster ? `AND k8s.cluster.name == "${cluster.replace(/"/g, '\\"')}" ` : "";
  const inList = podNames.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(", ");
  const esql = `FROM metrics-kubeletstatsreceiver.otel-* | WHERE @timestamp > NOW() - ${lookback} ${nsFilter}${clusterFilter}AND k8s.pod.name IN (${inList}) | STATS mem = MAX(metrics.k8s.pod.memory.working_set) BY k8s.pod.name, bucket = BUCKET(@timestamp, ${METRIC_TIMELINE_SPAN_MIN} minute) | SORT bucket ASC`;
  const rows = await safeEsqlRows<{
    "k8s.pod.name"?: string;
    mem?: number;
    bucket?: string | number;
  }>(esql, errors, { optional: true });
  for (const r of rows) {
    const pod = r["k8s.pod.name"];
    if (!pod || r.bucket == null) continue;
    const ts = typeof r.bucket === "number" ? r.bucket : Date.parse(r.bucket);
    if (Number.isNaN(ts)) continue;
    const arr = out.get(pod) ?? [];
    arr.push({
      ts,
      value: Math.round(((r.mem || 0) / (1024 * 1024)) * 10) / 10,
    });
    out.set(pod, arr);
  }
  return out;
}

// ─── Per-service KPI rollup ─────────────────────────────────────────────────
//
// Returns p99 latency, error_rate_pct, and avg_latency_ms keyed by
// service.name over the lookback window. The view uses these so client-side
// filtering on application chips can recompute the namespace-aggregate KPI
// tiles from the filtered service set without a tool re-invocation.
//
// We hit `traces-apm*,traces-*.otel-*` (same as the aggregate timeline
// queries) so OTel + classic-APM environments both populate. PERCENTILE
// in ES|QL works on numeric scalars; transaction.duration.us is the field
// universally carried in both schemas.

interface ServiceKpiRow {
  service: string;
  p99_latency_ms: number;
  error_rate_pct: number;
  avg_latency_ms: number;
}

async function queryServiceKpis(
  serviceFilter: string,
  lookback: string,
  errors: string[]
): Promise<Map<string, ServiceKpiRow>> {
  const out = new Map<string, ServiceKpiRow>();
  const trimmed = serviceFilter.trim();
  const clause = trimmed ? ` ${trimmed} ` : "";
  const esql = `FROM traces-apm*,traces-*.otel-* | WHERE @timestamp > NOW() - ${lookback}${clause}| STATS p99_us = PERCENTILE(transaction.duration.us, 99), avg_us = AVG(transaction.duration.us), errs = COUNT(*) WHERE event.outcome == "failure", total = COUNT(*) BY service.name | SORT total DESC | LIMIT 100`;
  const rows = await safeEsqlRows<{
    "service.name"?: string;
    p99_us?: number;
    avg_us?: number;
    errs?: number;
    total?: number;
  }>(esql, errors, { optional: true });
  for (const r of rows) {
    const name = r["service.name"];
    if (!name) continue;
    const total = r.total ?? 0;
    const errPct = total > 0 ? ((r.errs ?? 0) / total) * 100 : 0;
    out.set(name, {
      service: name,
      p99_latency_ms: Math.round((r.p99_us ?? 0) / 1000),
      avg_latency_ms: Math.round((r.avg_us ?? 0) / 1000),
      error_rate_pct: Math.round(errPct * 100) / 100,
    });
  }
  return out;
}

// ─── Service → app (service.namespace) mapping ──────────────────────────────
//
// Resolves each service to its `service.namespace` value when set. This is
// the OTel-canonical "logical app" axis — falls back to undefined when the
// agent doesn't populate it (common). The view's scope card uses this to
// build the applications strip; the tool's response carries the same
// mapping per-service for client-side filtering.
//
// We query the most authoritative source per index family:
//   - OTel:    traces-*.otel-*       (resource.attributes.service.namespace
//                                     is flattened to service.namespace by
//                                     the indexer)
//   - Classic: traces-apm*           (service.environment is sometimes
//                                     misused for app grouping; we ignore
//                                     it here and stick to service.namespace
//                                     so the signal stays consistent)

async function queryServiceNamespaces(
  serviceFilter: string,
  lookback: string,
  errors: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const trimmed = serviceFilter.trim();
  const clause = trimmed ? ` ${trimmed} ` : "";
  const esql = `FROM traces-apm*,traces-*.otel-* | WHERE @timestamp > NOW() - ${lookback} AND service.namespace IS NOT NULL${clause}| STATS c = COUNT(*) BY service.name, service.namespace | SORT c DESC | LIMIT 500`;
  const rows = await safeEsqlRows<{
    "service.name"?: string;
    "service.namespace"?: string;
  }>(esql, errors, { optional: true });
  for (const r of rows) {
    const name = r["service.name"];
    const ns = r["service.namespace"];
    if (!name || !ns) continue;
    // First-write-wins (rows are sorted by count) — if a service emits under
    // multiple namespaces, the most-frequent one is the one we trust.
    if (!out.has(name)) out.set(name, ns);
  }
  return out;
}

// Counts each service.namespace's full footprint across all visible services
// (regardless of whether they're in the current scope's filtered set). Used
// to populate `service_groups[].total` so the view can flag apps that
// extend beyond the current scope with a ⤴ chip indicator.
async function queryServiceNamespaceFootprint(
  lookback: string,
  errors: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const esql = `FROM traces-apm*,traces-*.otel-* | WHERE @timestamp > NOW() - ${lookback} AND service.namespace IS NOT NULL | STATS service_count = COUNT_DISTINCT(service.name) BY service.namespace | LIMIT 200`;
  const rows = await safeEsqlRows<{
    "service.namespace"?: string;
    service_count?: number;
  }>(esql, errors, { optional: true });
  for (const r of rows) {
    const ns = r["service.namespace"];
    if (!ns) continue;
    out.set(ns, r.service_count ?? 0);
  }
  return out;
}

// ─── Per-pod resource snapshot (full namespace) ────────────────────────────
//
// Unlike queryPodResources (which LIMIT 20s for the Top Pods list), this
// pulls every pod in scope so by_app rollups reflect the full namespace.
// Each row gets cpu/mem usage + limits and a restart delta (MAX − MIN over
// the window, since restart_count is monotonic). Used downstream to bucket
// by app and emit pods.by_app.

interface PodResourceSnapshot {
  pod: string;
  cpu_use_cores: number;
  cpu_lim_cores: number;
  mem_use_bytes: number;
  mem_lim_bytes: number;
  restart_delta: number;
}

async function queryPodResourceSnapshot(
  namespace: string | undefined,
  cluster: string | undefined,
  lookback: string,
  errors: string[]
): Promise<Map<string, PodResourceSnapshot>> {
  const out = new Map<string, PodResourceSnapshot>();
  const nsFilter = namespace ? `\n  AND k8s.namespace.name == "${namespace.replace(/"/g, '\\"')}"` : "";
  const clusterFilter = cluster ? `\n  AND k8s.cluster.name == "${cluster.replace(/"/g, '\\"')}"` : "";
  // MAX-MIN on the monotonic restart counter gives delta over the window
  // (matches the existing aggregate-restart-timeline semantics).
  const esql = `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE @timestamp > NOW() - ${lookback}
  AND k8s.pod.name IS NOT NULL${nsFilter}${clusterFilter}
| STATS
    cpu_use = MAX(metrics.k8s.pod.cpu.usage),
    cpu_lim = MAX(metrics.k8s.pod.cpu.limit),
    mem_use = MAX(metrics.k8s.pod.memory.working_set),
    mem_lim = MAX(metrics.k8s.pod.memory.limit),
    restart_max = MAX(metrics.k8s.container.restart_count),
    restart_min = MIN(metrics.k8s.container.restart_count)
  BY k8s.pod.name
| LIMIT 1000`;
  const rows = await safeEsqlRows<{
    "k8s.pod.name"?: string;
    cpu_use?: number;
    cpu_lim?: number;
    mem_use?: number;
    mem_lim?: number;
    restart_max?: number;
    restart_min?: number;
  }>(esql, errors, { optional: true });
  for (const r of rows) {
    const pod = r["k8s.pod.name"];
    if (!pod) continue;
    out.set(pod, {
      pod,
      cpu_use_cores: r.cpu_use ?? 0,
      cpu_lim_cores: r.cpu_lim ?? 0,
      mem_use_bytes: r.mem_use ?? 0,
      mem_lim_bytes: r.mem_lim ?? 0,
      restart_delta: Math.max(0, (r.restart_max ?? 0) - (r.restart_min ?? 0)),
    });
  }
  return out;
}

// ─── Pod → service correlation ──────────────────────────────────────────────
//
// Maps each `k8s.pod.name` to the APM `service.name` running inside it,
// derived from OTel resource attributes carried on traces. Used to:
//   1. Decorate pods.top_memory[] rows with `service` + `app` so the view
//      knows how to filter pods when an app chip is toggled.
//   2. Derive pod→app for the pods.by_app rollup (next commit).
//
// Pure-OTel only — classic-APM `traces-apm*` doesn't carry `k8s.pod.name`
// reliably, and pod metrics index family is OTel anyway, so we don't
// bother with a classic fallback. A pod with no APM service running
// (sidecars, infra pods like nginx-ingress) won't be in the map and ends
// up `app: undefined` in the response, which the view buckets under the
// "ungrouped" pseudo-app.
//
// 1:N pods (multiple services per pod, e.g. service-mesh sidecars) — we
// pick the dominant service by trace volume. Sub-services collapse into
// the dominant one, which is a small loss vs. the alternative (string
// arrays everywhere). Revisit if we see real misclassification in the
// field.

async function queryPodServiceMap(
  namespace: string | undefined,
  cluster: string | undefined,
  lookback: string,
  errors: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const nsFilter = namespace ? `\n  AND k8s.namespace.name == "${namespace.replace(/"/g, '\\"')}"` : "";
  const clusterFilter = cluster ? `\n  AND k8s.cluster.name == "${cluster.replace(/"/g, '\\"')}"` : "";
  const esql = `FROM traces-*.otel-*
| WHERE @timestamp > NOW() - ${lookback}
  AND k8s.pod.name IS NOT NULL
  AND service.name IS NOT NULL${nsFilter}${clusterFilter}
| STATS c = COUNT(*) BY k8s.pod.name, service.name
| SORT c DESC
| LIMIT 1000`;
  const rows = await safeEsqlRows<{
    "k8s.pod.name"?: string;
    "service.name"?: string;
  }>(esql, errors, { optional: true });
  for (const r of rows) {
    const pod = r["k8s.pod.name"];
    const svc = r["service.name"];
    if (!pod || !svc) continue;
    // First-write-wins (rows pre-sorted by COUNT desc) — dominant service
    // claims the pod, sub-services drop.
    if (!out.has(pod)) out.set(pod, svc);
  }
  return out;
}

// ─── Aggregate timeline queries for KPI tiles ───────────────────────────────

async function queryApmAggregateTimeline(
  serviceFilter: string,
  lookback: string,
  errors: string[]
): Promise<MetricTimelineBucket[]> {
  const trimmed = serviceFilter.trim();
  const clause = trimmed ? ` ${trimmed} ` : "";
  const esql = `FROM metrics-service_transaction.1m.otel-* | WHERE @timestamp > NOW() - ${lookback}${clause}| STATS rpm = COUNT(*) BY bucket = BUCKET(@timestamp, ${METRIC_TIMELINE_SPAN_MIN} minute) | SORT bucket ASC`;
  const rows = await safeEsqlRows<{ rpm?: number; bucket?: string | number }>(esql, errors, {
    optional: true,
  });
  return rows
    .filter((r) => r.bucket != null)
    .map((r) => {
      const ts = typeof r.bucket === "number" ? r.bucket! : Date.parse(r.bucket as string);
      return { ts, value: r.rpm ?? 0 };
    })
    .filter((b) => !Number.isNaN(b.ts));
}

async function queryApmLatencyTimeline(
  serviceFilter: string,
  lookback: string,
  errors: string[]
): Promise<MetricTimelineBucket[]> {
  const trimmed = serviceFilter.trim();
  const clause = trimmed ? ` ${trimmed} ` : "";
  // traces-apm* + traces-*.otel-* both carry transaction.duration.us;
  // PERCENTILE on either yields a per-bucket p99 in microseconds.
  const esql = `FROM traces-apm*,traces-*.otel-* | WHERE @timestamp > NOW() - ${lookback}${clause}| STATS p99_us = PERCENTILE(transaction.duration.us, 99) BY bucket = BUCKET(@timestamp, ${METRIC_TIMELINE_SPAN_MIN} minute) | SORT bucket ASC`;
  const rows = await safeEsqlRows<{ p99_us?: number; bucket?: string | number }>(esql, errors, {
    optional: true,
  });
  return rows
    .filter((r) => r.bucket != null)
    .map((r) => {
      const ts = typeof r.bucket === "number" ? r.bucket! : Date.parse(r.bucket as string);
      return { ts, value: Math.round((r.p99_us ?? 0) / 1000) }; // µs → ms
    })
    .filter((b) => !Number.isNaN(b.ts));
}

async function queryApmErrorRateTimeline(
  serviceFilter: string,
  lookback: string,
  errors: string[]
): Promise<MetricTimelineBucket[]> {
  const trimmed = serviceFilter.trim();
  const clause = trimmed ? ` ${trimmed} ` : "";
  const esql = `FROM traces-apm*,traces-*.otel-* | WHERE @timestamp > NOW() - ${lookback}${clause}| STATS errs = COUNT(*) WHERE event.outcome == "failure", total = COUNT(*) BY bucket = BUCKET(@timestamp, ${METRIC_TIMELINE_SPAN_MIN} minute) | SORT bucket ASC`;
  const rows = await safeEsqlRows<{
    errs?: number;
    total?: number;
    bucket?: string | number;
  }>(esql, errors, { optional: true });
  return rows
    .filter((r) => r.bucket != null)
    .map((r) => {
      const ts = typeof r.bucket === "number" ? r.bucket! : Date.parse(r.bucket as string);
      const total = r.total ?? 0;
      const errs = r.errs ?? 0;
      const pct = total > 0 ? (errs / total) * 100 : 0;
      return { ts, value: Math.round(pct * 10) / 10 };
    })
    .filter((b) => !Number.isNaN(b.ts));
}

// ─── K8s aggregate timelines + node counts ──────────────────────────────────

async function queryK8sUtilizationTimeline(
  namespace: string | undefined,
  cluster: string | undefined,
  lookback: string,
  errors: string[]
): Promise<{
  cpu: MetricTimelineBucket[];
  mem: MetricTimelineBucket[];
}> {
  const nsFilter = namespace ? `AND k8s.namespace.name == "${namespace}" ` : "";
  const clusterFilter = cluster ? `AND k8s.cluster.name == "${cluster.replace(/"/g, '\\"')}" ` : "";
  // Sums per bucket over the cluster: usage / limit yields utilization %.
  // If limits aren't populated, the divide returns 0/null and we surface the
  // raw usage instead in the calling code.
  const esql = `FROM metrics-kubeletstatsreceiver.otel-* | WHERE @timestamp > NOW() - ${lookback} ${nsFilter}${clusterFilter}| STATS cpu_use = SUM(metrics.k8s.pod.cpu.usage), cpu_lim = SUM(metrics.k8s.pod.cpu.limit), mem_use = SUM(metrics.k8s.pod.memory.working_set), mem_lim = SUM(metrics.k8s.pod.memory.limit) BY bucket = BUCKET(@timestamp, ${METRIC_TIMELINE_SPAN_MIN} minute) | SORT bucket ASC`;
  const rows = await safeEsqlRows<{
    cpu_use?: number;
    cpu_lim?: number;
    mem_use?: number;
    mem_lim?: number;
    bucket?: string | number;
  }>(esql, errors, { optional: true });
  const cpu: MetricTimelineBucket[] = [];
  const mem: MetricTimelineBucket[] = [];
  for (const r of rows) {
    if (r.bucket == null) continue;
    const ts = typeof r.bucket === "number" ? r.bucket! : Date.parse(r.bucket as string);
    if (Number.isNaN(ts)) continue;
    const cpuPct = r.cpu_lim && r.cpu_lim > 0 ? ((r.cpu_use ?? 0) / r.cpu_lim) * 100 : 0;
    const memPct = r.mem_lim && r.mem_lim > 0 ? ((r.mem_use ?? 0) / r.mem_lim) * 100 : 0;
    cpu.push({ ts, value: Math.round(cpuPct * 10) / 10 });
    mem.push({ ts, value: Math.round(memPct * 10) / 10 });
  }
  return { cpu, mem };
}

async function queryK8sRestartTimeline(
  namespace: string | undefined,
  cluster: string | undefined,
  lookback: string,
  errors: string[]
): Promise<MetricTimelineBucket[]> {
  const nsFilter = namespace ? `AND k8s.namespace.name == "${namespace}" ` : "";
  const clusterFilter = cluster ? `AND k8s.cluster.name == "${cluster.replace(/"/g, '\\"')}" ` : "";
  // restart_count is a monotonic counter per container; SUM per bucket gives a
  // rough activity proxy without diffing. Good enough for a sparkline; can
  // refine to deltas later if needed.
  const esql = `FROM metrics-kubeletstatsreceiver.otel-* | WHERE @timestamp > NOW() - ${lookback} ${nsFilter}${clusterFilter}| STATS restarts = MAX(metrics.k8s.container.restart_count) BY bucket = BUCKET(@timestamp, ${METRIC_TIMELINE_SPAN_MIN} minute) | SORT bucket ASC`;
  const rows = await safeEsqlRows<{ restarts?: number; bucket?: string | number }>(esql, errors, {
    optional: true,
  });
  // Convert the cumulative max into per-bucket deltas (clamped to ≥ 0).
  let prev: number | null = null;
  const out: MetricTimelineBucket[] = [];
  for (const r of rows) {
    if (r.bucket == null) continue;
    const ts = typeof r.bucket === "number" ? r.bucket! : Date.parse(r.bucket as string);
    if (Number.isNaN(ts)) continue;
    const cur = r.restarts ?? 0;
    const delta = prev == null ? 0 : Math.max(0, cur - prev);
    prev = cur;
    out.push({ ts, value: delta });
  }
  return out;
}

async function queryK8sNodeRollup(
  errors: string[]
): Promise<{ total: number; not_ready: number }> {
  const esql = `FROM metrics-kubeletstatsreceiver.otel-* | WHERE @timestamp > NOW() - 5m | STATS nodes = COUNT_DISTINCT(k8s.node.name)`;
  const rows = await safeEsqlRows<{ nodes?: number }>(esql, errors, { optional: true });
  const total = rows[0]?.nodes ?? 0;
  // not-ready needs a node phase / condition signal; kubeletstats doesn't
  // carry it directly. Leave at 0 for now and surface a follow-up ticket.
  return { total, not_ready: 0 };
}

function deriveTimelineWindow(
  timelinesByKey: Map<string, MetricTimelineBucket[]>
): { start_ms: number; end_ms: number; bucket_span_ms: number } | undefined {
  const first = [...timelinesByKey.values()].find((t) => t.length > 0);
  if (!first) return undefined;
  return {
    start_ms: first[0].ts,
    end_ms: first[first.length - 1].ts + METRIC_TIMELINE_SPAN_MS,
    bucket_span_ms: METRIC_TIMELINE_SPAN_MS,
  };
}

function deriveWindowFromBuckets(
  buckets: MetricTimelineBucket[]
): { start_ms: number; end_ms: number; bucket_span_ms: number } | undefined {
  if (!buckets.length) return undefined;
  return {
    start_ms: buckets[0].ts,
    end_ms: buckets[buckets.length - 1].ts + METRIC_TIMELINE_SPAN_MS,
    bucket_span_ms: METRIC_TIMELINE_SPAN_MS,
  };
}

function peakOf(buckets: MetricTimelineBucket[] | undefined): number | undefined {
  if (!buckets || !buckets.length) return undefined;
  return buckets.reduce((m, b) => (b.value > m ? b.value : m), -Infinity);
}

async function queryPodResources(
  namespace: string | undefined,
  cluster: string | undefined,
  lookback: string,
  errors: string[]
): Promise<PodRow[]> {
  const nsFilter = namespace
    ? `| WHERE k8s.namespace.name == "${namespace}" `
    : "";
  const clusterFilter = cluster
    ? `| WHERE k8s.cluster.name == "${cluster.replace(/"/g, '\\"')}" `
    : "";
  // MAX instead of AVG for memory: AVG on aggregate_metric_double fields (how
  // Elastic stores downsampled OTel gauges) can return sum-of-sums rather than
  // a true mean, inflating the number massively. MAX returns max-of-maxes — a
  // sound upper bound regardless of the field's storage shape, and operationally
  // more useful (peak memory usage).
  const esql = `FROM metrics-kubeletstatsreceiver.otel-* | WHERE @timestamp > NOW() - ${lookback} ${nsFilter}${clusterFilter}| STATS avg_mem = MAX(metrics.k8s.pod.memory.working_set), avg_cpu = AVG(metrics.k8s.pod.cpu.usage) BY k8s.pod.name | SORT avg_mem DESC | LIMIT 20`;
  const rows = await safeEsqlRows<{
    "k8s.pod.name"?: string;
    avg_mem?: number;
    avg_cpu?: number;
  }>(esql, errors);
  return rows
    .filter((r) => !!r["k8s.pod.name"])
    .map((r) => ({
      pod: r["k8s.pod.name"]!,
      avg_memory_mb: Math.round(((r.avg_mem || 0) / (1024 * 1024)) * 10) / 10,
      avg_cpu_cores: Math.round((r.avg_cpu || 0) * 1000) / 1000,
    }));
}

interface TimelineBucket {
  ts: number;        // bucket start, epoch ms
  max_score: number; // 0 when no anomaly fired in this bucket for this entity
}

interface TimelineWindow {
  start_ms: number;
  end_ms: number;
  bucket_span_ms: number;
}

interface AnomalyEntityRollup {
  total: number;
  by_severity: Record<string, number>;
}

interface AnomalyRollup {
  total: number;
  by_severity: Record<string, number>;
  top_entities: { entity: string; max_score: number; timeline?: TimelineBucket[] }[];
  /**
   * Per-entity count breakdown so the view can recompute the donut + total
   * chip when the user filters by application chip. Keyed by entity string
   * (e.g. "service.name=checkout", "k8s.pod.name=payments-api-…"). Capped
   * at ANOMALY_BY_ENTITY_CAP entries; long tail collapses into the `_other`
   * pseudo-key so totals reconcile when the cap is exceeded.
   */
  by_entity?: Record<string, AnomalyEntityRollup>;
  timeline_window?: TimelineWindow;
  error?: string;
}

// 1-hour lookback split into 5-minute buckets = 12 cells. Matches the Kibana
// anomaly-explorer heatmap density at this zoom.
const TIMELINE_BUCKET_SPAN = "5m";
const TIMELINE_BUCKET_SPAN_MS = 5 * 60 * 1000;

async function queryActiveAnomalies(
  namespace: string | undefined,
  cluster: string | undefined,
  jobFilter: string | undefined,
  excludeEntities: string | undefined
): Promise<AnomalyRollup> {
  if (!(await mlAnomalyIndicesExist())) {
    return { total: 0, by_severity: {}, top_entities: [] };
  }

  const must: unknown[] = [
    { range: { record_score: { gte: 50 } } },
    { term: { result_type: "record" } },
    { range: { timestamp: { gte: "now-1h" } } },
  ];

  if (namespace) {
    must.push({
      nested: {
        path: "influencers",
        query: {
          bool: {
            must: [
              {
                terms: {
                  "influencers.influencer_field_name": [
                    "k8s.namespace.name",
                    "resource.attributes.k8s.namespace.name",
                  ],
                },
              },
              { term: { "influencers.influencer_field_values": namespace } },
            ],
          },
        },
      },
    });
  }
  if (cluster) {
    must.push({
      nested: {
        path: "influencers",
        query: {
          bool: {
            must: [
              {
                terms: {
                  "influencers.influencer_field_name": [
                    "k8s.cluster.name",
                    "resource.attributes.k8s.cluster.name",
                    "orchestrator.cluster.name",
                  ],
                },
              },
              { term: { "influencers.influencer_field_values": cluster } },
            ],
          },
        },
      },
    });
  }
  if (jobFilter) must.push({ prefix: { job_id: jobFilter } });

  const mustNot: unknown[] = [];
  if (excludeEntities) {
    mustNot.push({
      nested: {
        path: "influencers",
        query: { wildcard: { "influencers.influencer_field_values": excludeEntities } },
      },
    });
  }

  const body = {
    size: 0,
    query: { bool: mustNot.length ? { must, must_not: mustNot } : { must } },
    aggs: {
      by_severity: {
        range: {
          field: "record_score",
          ranges: [
            { key: "minor", from: 50, to: 75 },
            { key: "major", from: 75, to: 90 },
            { key: "critical", from: 90 },
          ],
        },
      },
      top_entities_by_influencer: {
        nested: { path: "influencers" },
        aggs: {
          pods_only: {
            filter: {
              terms: {
                "influencers.influencer_field_name": [
                  "k8s.pod.name",
                  "resource.attributes.k8s.pod.name",
                  "service.name",
                  "resource.attributes.service.name",
                ],
              },
            },
            aggs: {
              by_value: {
                terms: {
                  field: "influencers.influencer_field_values",
                  size: 5,
                  order: { "parent>max_score": "desc" },
                },
                aggs: {
                  parent: {
                    reverse_nested: {},
                    aggs: {
                      max_score: { max: { field: "record_score" } },
                      // Per-entity timeline for the heatmap. Empty buckets
                      // are preserved (min_doc_count 0 + extended_bounds)
                      // so the UI can render contiguous cells.
                      timeline: {
                        date_histogram: {
                          field: "timestamp",
                          fixed_interval: TIMELINE_BUCKET_SPAN,
                          min_doc_count: 0,
                          extended_bounds: { min: "now-1h", max: "now" },
                        },
                        aggs: {
                          max_score: { max: { field: "record_score" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      top_entities_by_partition: {
        terms: { field: "partition_field_value", size: 5, order: { max_score: "desc" } },
        aggs: {
          max_score: { max: { field: "record_score" } },
          timeline: {
            date_histogram: {
              field: "timestamp",
              fixed_interval: TIMELINE_BUCKET_SPAN,
              min_doc_count: 0,
              extended_bounds: { min: "now-1h", max: "now" },
            },
            aggs: {
              max_score: { max: { field: "record_score" } },
            },
          },
        },
      },
      // Per-entity count breakdown for filter recomputation. Same nested
      // path + filter as top_entities_by_influencer but a wider cap and a
      // different ordering (default: doc_count desc — counts, not max
      // score) so the by_entity payload reflects "where do anomalies
      // concentrate" rather than "what's the worst right now".
      entities_by_count: {
        nested: { path: "influencers" },
        aggs: {
          pods_only: {
            filter: {
              terms: {
                "influencers.influencer_field_name": [
                  "k8s.pod.name",
                  "resource.attributes.k8s.pod.name",
                  "service.name",
                  "resource.attributes.service.name",
                ],
              },
            },
            aggs: {
              by_value: {
                terms: {
                  field: "influencers.influencer_field_values",
                  size: ANOMALY_BY_ENTITY_CAP,
                },
                aggs: {
                  parent: {
                    reverse_nested: {},
                    aggs: {
                      by_severity: {
                        range: {
                          field: "record_score",
                          ranges: [
                            { key: "minor", from: 50, to: 75 },
                            { key: "major", from: 75, to: 90 },
                            { key: "critical", from: 90 },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  try {
    type HistoBucket = { key: number; max_score?: { value: number | null } };
    type HistoAgg = { buckets: HistoBucket[] };
    type InfluencerBucket = {
      key: string;
      parent?: {
        max_score?: { value: number };
        timeline?: HistoAgg;
      };
    };
    type PartitionBucket = {
      key: string;
      max_score: { value: number };
      timeline?: HistoAgg;
    };
    type CountEntityBucket = {
      key: string;
      doc_count: number;
      parent?: {
        by_severity?: { buckets: { key: string; doc_count: number }[] };
      };
    };
    type AggResp = {
      hits: { total: { value: number } | number };
      aggregations?: {
        by_severity?: { buckets: { key: string; doc_count: number }[] };
        top_entities_by_influencer?: {
          pods_only?: { by_value?: { buckets: InfluencerBucket[] } };
        };
        top_entities_by_partition?: { buckets: PartitionBucket[] };
        entities_by_count?: {
          pods_only?: { by_value?: { buckets: CountEntityBucket[] } };
        };
      };
    };
    const resp = await esRequest<AggResp>("/.ml-anomalies-*/_search", { body });
    const total = typeof resp.hits.total === "number" ? resp.hits.total : resp.hits.total.value;
    const sevBuckets = resp.aggregations?.by_severity?.buckets || [];
    const bySeverity: Record<string, number> = {};
    for (const b of sevBuckets) if (b.doc_count > 0) bySeverity[b.key] = b.doc_count;

    const influencerBuckets =
      resp.aggregations?.top_entities_by_influencer?.pods_only?.by_value?.buckets || [];
    const partitionBuckets = resp.aggregations?.top_entities_by_partition?.buckets || [];
    const usedInfluencer = influencerBuckets.length > 0;
    const buckets: Array<InfluencerBucket | PartitionBucket> = usedInfluencer
      ? influencerBuckets
      : partitionBuckets;

    const mapTimeline = (histo: HistoAgg | undefined): TimelineBucket[] | undefined => {
      if (!histo) return undefined;
      return histo.buckets.map((hb) => ({
        ts: hb.key,
        max_score: Math.round(((hb.max_score?.value ?? 0) || 0) * 10) / 10,
      }));
    };

    const topEntities = buckets.map((b) => {
      if (usedInfluencer) {
        const ib = b as InfluencerBucket;
        const score = ib.parent?.max_score?.value ?? 0;
        return {
          entity: ib.key,
          max_score: Math.round(score * 10) / 10,
          timeline: mapTimeline(ib.parent?.timeline),
        };
      }
      const pb = b as PartitionBucket;
      return {
        entity: pb.key,
        max_score: Math.round(pb.max_score.value * 10) / 10,
        timeline: mapTimeline(pb.timeline),
      };
    });

    // Derive the window from the first entity's timeline (all entities share
    // the same extended_bounds so the grid is uniform). Fall back to the
    // fixed 1-hour lookback if no buckets were returned.
    const firstTimeline = topEntities.find((e) => e.timeline?.length)?.timeline ?? [];
    const now = Date.now();
    const timelineWindow: TimelineWindow = firstTimeline.length
      ? {
          start_ms: firstTimeline[0].ts,
          end_ms: firstTimeline[firstTimeline.length - 1].ts + TIMELINE_BUCKET_SPAN_MS,
          bucket_span_ms: TIMELINE_BUCKET_SPAN_MS,
        }
      : {
          start_ms: now - 60 * 60 * 1000,
          end_ms: now,
          bucket_span_ms: TIMELINE_BUCKET_SPAN_MS,
        };

    // Per-entity count breakdown — only emitted on the influencer path
    // (partition fallback doesn't carry the same dimensions, and the
    // ordering of by_entity is "where do anomalies concentrate" rather
    // than "highest peak score", so it's the influencer-side signal that
    // matters here).
    const countBuckets =
      resp.aggregations?.entities_by_count?.pods_only?.by_value?.buckets || [];
    let byEntity: Record<string, AnomalyEntityRollup> | undefined;
    if (countBuckets.length) {
      byEntity = {};
      let inScopeTotal = 0;
      for (const cb of countBuckets) {
        const sevAgg = cb.parent?.by_severity?.buckets || [];
        const sev: Record<string, number> = {};
        let entityTotal = 0;
        for (const sb of sevAgg) {
          if (sb.doc_count > 0) {
            sev[sb.key] = sb.doc_count;
            entityTotal += sb.doc_count;
          }
        }
        byEntity[cb.key] = { total: entityTotal, by_severity: sev };
        inScopeTotal += entityTotal;
      }
      // Long-tail bucket so totals reconcile when the cap is exceeded.
      // total - inScopeTotal can also include entities that never matched
      // the field-name filter (e.g. host.name influencers); we surface
      // both as _other since the view only needs the residual count.
      const remainder = total - inScopeTotal;
      if (remainder > 0) {
        byEntity._other = { total: remainder, by_severity: {} };
      }
    }

    return {
      total,
      by_severity: bySeverity,
      top_entities: topEntities,
      timeline_window: timelineWindow,
      ...(byEntity ? { by_entity: byEntity } : {}),
    };
  } catch (exc) {
    return {
      total: 0,
      by_severity: {},
      top_entities: [],
      error: exc instanceof Error ? exc.message : String(exc),
    };
  }
}

function assessHealth(
  services: ServiceRow[],
  anomalies: AnomalyRollup
): { health: string; degraded: { service: string; reasons: string[] }[] } {
  const degraded: { service: string; reasons: string[] }[] = [];
  for (const svc of services) {
    const reasons: string[] = [];
    if ((svc.error_rate_pct || 0) > 5) reasons.push(`error rate ${svc.error_rate_pct}%`);
    if ((svc.avg_latency_ms || 0) > 2000) reasons.push(`latency ${svc.avg_latency_ms}ms`);
    if (reasons.length) degraded.push({ service: svc.service, reasons });
  }

  const critical = anomalies.by_severity?.critical || 0;
  let health: string;
  if (critical > 0 || degraded.length >= 3) health = "critical";
  else if (degraded.length >= 1 || (anomalies.total || 0) > 5) health = "degraded";
  else health = "healthy";

  return { health, degraded };
}

export function registerApmHealthSummaryTool(server: McpServer) {
  registerAppTool(
    server,
    "apm-health-summary",
    {
      title: "APM Health Summary",
      description:
        "Requires: Elastic APM. Optional: Kubernetes (kubeletstats) for pod resource context, ML anomaly jobs " +
        "for anomaly rollup. Returns a cluster-level health summary from live APM service telemetry with pod-resource " +
        "and ML-anomaly context layered in when those backends are present. Use for a quick 'how is my cluster doing?' " +
        "or 'what's broken right now?' check before drilling into specific services. Gracefully degrades — without " +
        "K8s metrics, omits the pods section; without ML jobs, omits the anomalies section. The response includes " +
        "a data_coverage field showing which backends contributed.",
      inputSchema: {
        cluster: z.string().optional().describe(
          "Kubernetes cluster name to scope to — e.g. 'prod-us-east'. Resolves against k8s.cluster.name " +
          "(OTel) or orchestrator.cluster.name (ECS). Fuzzy-matched against the set of clusters present " +
          "in recent telemetry; if not found, the response includes candidates. Omit for single-cluster " +
          "deployments or to span all clusters."
        ),
        namespace: z.string().optional().describe(
          "Kubernetes namespace to scope to — e.g. 'otel-demo', 'prod', 'checkout'. Only applicable if services " +
          "are K8s-deployed. Omit for all namespaces or non-K8s deployments."
        ),
        lookback: z.string().optional().describe(
          "Time range to assess. Default '15m'. Examples: '5m' (very recent), '15m' (default, good for 'right now'), " +
          "'1h' (wider trend)."
        ),
        job_filter: z.string().optional().describe(
          "Only include ML anomalies from jobs whose id starts with this prefix — e.g. 'k8s-' to see only the " +
          "Kubernetes-scoped jobs. Omit for all jobs."
        ),
        exclude_entities: z.string().optional().describe(
          "Wildcard pattern to exclude from anomaly rollup — e.g. 'chaos-*' to hide known synthetic noise. " +
          "Matches against influencer field values."
        ),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ cluster, namespace, lookback, job_filter, exclude_entities }) => {
      const lb = lookback || "15m";
      const queryErrors: string[] = [];

      // Resolve cluster + namespace in parallel so a fuzzy match on either
      // doesn't add round-trips. Resolution is independent — namespace
      // resolution doesn't care which cluster you're in (we'd need to
      // re-think this if the same namespace name exists in multiple
      // clusters and the user meant a specific one; for now first-match
      // wins, mirroring how `resolveNamespace` already works).
      const [clusterResolution, nsResolution] = await Promise.all([
        resolveCluster(cluster, lb, queryErrors),
        resolveNamespace(namespace, lb, queryErrors),
      ]);
      const effectiveCluster = clusterResolution.resolved ?? cluster;
      const effectiveNs = nsResolution.resolved ?? namespace;

      // Service tiers scope by service.name IN (…) to dodge schema-drift gotchas
      // (pre-agg rollups missing k8s.namespace.name as a dimension; traces-apm*
      // missing kubernetes.namespace in some mappings). Pod resources still scope
      // by k8s.namespace.name / k8s.cluster.name directly — kubeletstats reliably
      // carries them and pods aren't addressable via service.name anyway.
      //
      // When both cluster + namespace are supplied we intersect their service
      // sets so the APM scope is the conjunction. When only one is supplied,
      // we scope by that one alone.
      const [servicesInNs, servicesInCluster] = await Promise.all([
        effectiveNs ? resolveServicesInNamespace(effectiveNs, lb, queryErrors) : Promise.resolve(undefined),
        effectiveCluster ? resolveServicesInCluster(effectiveCluster, lb, queryErrors) : Promise.resolve(undefined),
      ]);
      const intersected = intersectServiceSets(servicesInNs, servicesInCluster);
      const serviceFilter = buildServiceFilter(intersected);

      const noServicesInScope =
        ((effectiveNs && servicesInNs && servicesInNs.length === 0) ||
          (effectiveCluster && servicesInCluster && servicesInCluster.length === 0)) ?? false;

      const [services, pods, anomalies] = await Promise.all([
        noServicesInScope
          ? Promise.resolve<ServiceRow[]>([])
          : queryServices(serviceFilter, lb, queryErrors),
        queryPodResources(effectiveNs, effectiveCluster, lb, queryErrors),
        queryActiveAnomalies(effectiveNs, effectiveCluster, job_filter, exclude_entities),
      ]);

      // Fetch per-item timelines for the top rows the view actually renders +
      // aggregate timelines for the KPI tile rows. Run them in parallel so the
      // overall round-trip stays close to the slowest single query.
      const topServiceNames = services.slice(0, 15).map((s) => s.service);
      const topPodNames = pods.slice(0, 5).map((p) => p.pod);
      const [
        serviceTimelines,
        podTimelines,
        apmThroughputTl,
        apmLatencyTl,
        apmErrorRateTl,
        k8sUtil,
        k8sRestartTl,
        k8sNodes,
        clustersAvailable,
        serviceKpis,
        serviceNamespaceMap,
        serviceNamespaceFootprint,
        podServiceMap,
        podSnapshots,
      ] = await Promise.all([
        queryServicesTimeline(topServiceNames, serviceFilter, lb, queryErrors),
        queryPodsMemoryTimeline(topPodNames, effectiveNs, effectiveCluster, lb, queryErrors),
        queryApmAggregateTimeline(serviceFilter, lb, queryErrors),
        queryApmLatencyTimeline(serviceFilter, lb, queryErrors),
        queryApmErrorRateTimeline(serviceFilter, lb, queryErrors),
        queryK8sUtilizationTimeline(effectiveNs, effectiveCluster, lb, queryErrors),
        queryK8sRestartTimeline(effectiveNs, effectiveCluster, lb, queryErrors),
        queryK8sNodeRollup(queryErrors),
        listAvailableClusters(lb, queryErrors),
        queryServiceKpis(serviceFilter, lb, queryErrors),
        queryServiceNamespaces(serviceFilter, lb, queryErrors),
        // Footprint must NOT be scoped — that's the whole point: it tells us
        // whether each app extends beyond the current scope so we can flag
        // partial-app chips with the ⤴ indicator.
        queryServiceNamespaceFootprint(lb, queryErrors),
        queryPodServiceMap(effectiveNs, effectiveCluster, lb, queryErrors),
        queryPodResourceSnapshot(effectiveNs, effectiveCluster, lb, queryErrors),
      ]);

      // Attach timeline + peak + per-service KPIs + app group to each row.
      for (const svc of services) {
        const tl = serviceTimelines.get(svc.service);
        if (tl && tl.length) {
          svc.timeline = tl;
          svc.peak_throughput = Math.max(...tl.map((b) => b.value));
        }
        const kpi = serviceKpis.get(svc.service);
        if (kpi) {
          svc.p99_latency_ms = kpi.p99_latency_ms;
          svc.avg_latency_ms = kpi.avg_latency_ms;
          svc.error_rate_pct = kpi.error_rate_pct;
        }
        const ns = serviceNamespaceMap.get(svc.service);
        if (ns) svc.app = ns;
      }
      for (const pod of pods) {
        const tl = podTimelines.get(pod.pod);
        if (tl && tl.length) {
          pod.timeline = tl;
          pod.peak_memory_mb = Math.round(Math.max(...tl.map((b) => b.value)) * 10) / 10;
        }
        const svc = podServiceMap.get(pod.pod);
        if (svc) {
          pod.service = svc;
          const app = serviceNamespaceMap.get(svc);
          if (app) pod.app = app;
        }
      }
      const servicesTimelineWindow = deriveTimelineWindow(serviceTimelines);
      const podsTimelineWindow = deriveTimelineWindow(podTimelines);

      const { health, degraded } = assessHealth(services, anomalies);

      const anomalyJobsSeen = (anomalies.total || 0) > 0 || Object.keys(anomalies.by_severity).length > 0;

      const dataCoverage = {
        apm: services.length > 0,
        kubernetes: pods.length > 0,
        ml_anomalies: anomalyJobsSeen,
      };

      const result: Record<string, unknown> = {
        overall_health: health,
        namespace: effectiveNs || namespace || "all",
        lookback: lb,
        data_coverage: dataCoverage,
        services: {
          total: services.length,
          degraded_count: degraded.length,
          details: services.slice(0, 15),
          ...(servicesTimelineWindow ? { timeline_window: servicesTimelineWindow } : {}),
        },
        degraded_services: degraded,
      };
      if (namespace && effectiveNs && effectiveNs !== namespace) {
        result.namespace_requested = namespace;
      }
      if (nsResolution.note) result.namespace_note = nsResolution.note;
      if (nsResolution.candidates) result.namespace_candidates = nsResolution.candidates;
      if (cluster && effectiveCluster && effectiveCluster !== cluster) {
        result.cluster_requested = cluster;
      }
      if (clusterResolution.note) result.cluster_note = clusterResolution.note;
      if (clusterResolution.candidates) result.cluster_candidates = clusterResolution.candidates;
      if (exclude_entities) result.exclude_filter = exclude_entities;

      // Scope card payload — purely informational, the view never mutates
      // it. Axes are reported based on data_coverage so the view branches
      // cleanly between the three coverage states (k8s only / apm only /
      // both).
      const scope: Record<string, unknown> = {};
      if (effectiveCluster) scope.current_cluster = effectiveCluster;
      if (effectiveNs && dataCoverage.kubernetes) scope.k8s_namespace = effectiveNs;
      if (dataCoverage.apm) scope.service_count = services.length;
      if (dataCoverage.kubernetes) {
        scope.pod_count = pods.length;
        if (k8sNodes.total) scope.node_count = k8sNodes.total;
      }
      if (clustersAvailable.length > 1) scope.clusters_available = clustersAvailable;

      // Application grouping. Only `service.namespace` is consulted in this
      // commit; k8s-label and naming-prefix fallbacks land alongside the
      // pod→service mapping commit (where the k8s-side label query lives).
      // When no service.namespace is present anywhere, omit service_groups
      // entirely so the view's apps strip stays hidden rather than showing
      // a single "ungrouped" bucket.
      const serviceGroups = buildServiceGroups(
        services,
        serviceNamespaceMap,
        serviceNamespaceFootprint
      );
      if (serviceGroups.length > 0) {
        scope.service_groups = serviceGroups;
        scope.service_groups_source = "service.namespace";
      }

      if (Object.keys(scope).length > 0) result.scope = scope;

      // ─── APM KPI tiles ───────────────────────────────────────────────────
      if (services.length) {
        const totalRpm = services.reduce((s, x) => s + x.throughput, 0);
        const peakLatency = peakOf(apmLatencyTl) ?? 0;
        const currentP99 = apmLatencyTl.length
          ? apmLatencyTl[apmLatencyTl.length - 1].value
          : 0;
        const peakErr = peakOf(apmErrorRateTl) ?? 0;
        const currentErr = apmErrorRateTl.length
          ? apmErrorRateTl[apmErrorRateTl.length - 1].value
          : 0;
        const apmTiles: KpiTile[] = [
          {
            key: "throughput",
            label: "Throughput",
            value_display: fmtThroughput(totalRpm),
            unit: "rpm",
            timeline: apmThroughputTl,
            peak: peakOf(apmThroughputTl),
            // Throughput has no universal threshold — no status chip.
          },
          {
            key: "latency_p99",
            label: "p99 latency",
            value_display: `${currentP99}`,
            unit: "ms",
            timeline: apmLatencyTl,
            peak: peakLatency,
            status: currentP99 > 0 ? statusForLatency(currentP99) : undefined,
          },
          {
            key: "error_rate",
            label: "Error rate",
            value_display: `${currentErr.toFixed(2)}`,
            unit: "%",
            timeline: apmErrorRateTl,
            peak: peakErr,
            status: statusForErrorRate(currentErr),
          },
          {
            key: "services",
            label: "Services",
            value_display: `${services.length}`,
            secondary: degraded.length ? `${degraded.length} degraded` : "all healthy",
            status: statusForDegradedCount(degraded.length),
          },
        ];
        const apmTilesWindow = deriveWindowFromBuckets(apmThroughputTl);
        result.apm_tiles = {
          tiles: apmTiles,
          ...(apmTilesWindow ? { timeline_window: apmTilesWindow } : {}),
        };
      }

      // ─── K8s KPI tiles ───────────────────────────────────────────────────
      if (pods.length) {
        const cpuLatest = k8sUtil.cpu.length ? k8sUtil.cpu[k8sUtil.cpu.length - 1].value : 0;
        const memLatest = k8sUtil.mem.length ? k8sUtil.mem[k8sUtil.mem.length - 1].value : 0;
        const restartTotal = k8sRestartTl.reduce((s, b) => s + b.value, 0);
        const k8sTiles: KpiTile[] = [
          {
            key: "cpu",
            label: "CPU",
            value_display: cpuLatest > 0 ? `${cpuLatest.toFixed(0)}` : "—",
            unit: cpuLatest > 0 ? "%" : undefined,
            timeline: k8sUtil.cpu,
            peak: peakOf(k8sUtil.cpu),
            status: cpuLatest > 0 ? statusForCpuUtil(cpuLatest) : undefined,
          },
          {
            key: "memory",
            label: "Memory",
            value_display: memLatest > 0 ? `${memLatest.toFixed(0)}` : "—",
            unit: memLatest > 0 ? "%" : undefined,
            timeline: k8sUtil.mem,
            peak: peakOf(k8sUtil.mem),
            status: memLatest > 0 ? statusForMemUtil(memLatest) : undefined,
          },
          {
            key: "restarts",
            label: "Restarts",
            value_display: `${restartTotal}`,
            secondary: `last ${lb}`,
            timeline: k8sRestartTl,
            peak: peakOf(k8sRestartTl),
            spark: "bar",
            status: statusForRestarts(restartTotal),
          },
          {
            key: "nodes",
            label: "Nodes",
            value_display: `${k8sNodes.total || pods.length}`,
            secondary: k8sNodes.not_ready
              ? `${k8sNodes.not_ready} not ready`
              : k8sNodes.total
                ? "all ready"
                : `${pods.length} pods`,
            status: k8sNodes.total ? statusForNodes(k8sNodes.not_ready) : undefined,
          },
        ];
        const k8sTilesWindow = deriveWindowFromBuckets(k8sUtil.cpu.length ? k8sUtil.cpu : k8sRestartTl);
        result.k8s_tiles = {
          tiles: k8sTiles,
          ...(k8sTilesWindow ? { timeline_window: k8sTilesWindow } : {}),
        };
      }

      if (pods.length) {
        const byApp = buildPodsByApp(podSnapshots, podServiceMap, serviceNamespaceMap);
        result.pods = {
          total: pods.length,
          top_memory: pods.slice(0, 5),
          ...(podsTimelineWindow ? { timeline_window: podsTimelineWindow } : {}),
          ...(byApp ? { by_app: byApp } : {}),
        };
      } else {
        result.pods_note =
          "No Kubernetes pod metrics found (metrics-kubeletstatsreceiver.otel-* with k8s.pod.name populated). " +
          "Running in APM-only mode — expected if services aren't K8s-deployed or kubeletstats isn't shipping.";
      }

      if (anomalyJobsSeen) {
        result.anomalies = anomalies;
      } else {
        result.anomalies_note =
          "No ML anomaly jobs contributed results. " +
          "Configure anomaly detection jobs in Kibana ML to enrich this summary with anomaly signals.";
      }

      if (!services.length) {
        result.warning =
          "No APM service telemetry found. This tool requires Elastic APM — if you're a logs- or metrics-only " +
          "customer, reach for 'ml-anomalies', 'observe', or 'manage-alerts' instead.";
      } else if (degraded.length) {
        result.recommendation = `Investigate ${degraded[0].service}: ${degraded[0].reasons.join(", ")}. Use ml-anomalies for details.`;
      }

      // Investigation-action buttons for the view footer.
      const actions: { label: string; prompt: string }[] = [];
      const topEntity = anomalies.top_entities?.[0]?.entity;
      const topPod = pods[0]?.pod;
      if (topPod) {
        const shortPod = topPod.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "");
        actions.push({
          label: `Drill into ${shortPod}`,
          prompt: `Use ml-anomalies with entity "${shortPod}" and lookback "1h" to explain anomalies for this pod.`,
        });
      }
      if (pods[1]) {
        const shortPod = pods[1].pod.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "");
        actions.push({
          label: `Drill into ${shortPod}`,
          prompt: `Use ml-anomalies with entity "${shortPod}" and lookback "1h" to explain anomalies for this pod.`,
        });
      }
      if (degraded.length) {
        actions.push({
          label: `Investigate ${degraded[0].service}`,
          prompt: `Use ml-anomalies with entity "${degraded[0].service}" and lookback "1h" to find the root cause.`,
        });
      }
      // Note: do NOT suggest k8s-blast-radius here. APM service telemetry proves the services
      // exist, but not that kubeletstats pod/node metrics are available in the customer's ingest.
      // Recommendations must stay within tools whose data requirements are a subset of what
      // this call already proved.
      if (actions.length) result.investigation_actions = actions;

      // Rerun context for the view's time-range chip row.
      const rerunParts = ["lookback \"{lookback}\""];
      if (effectiveNs) rerunParts.push(`namespace "${effectiveNs}"`);
      if (job_filter) rerunParts.push(`job_filter "${job_filter}"`);
      if (exclude_entities) rerunParts.push(`exclude_entities "${exclude_entities}"`);
      result.rerun_context = {
        tool: "apm-health-summary",
        current_lookback: lb,
        prompt_template: `Use apm-health-summary with ${rerunParts.join(" and ")}`,
      };

      if (queryErrors.length) result._query_errors = queryErrors;

      const welcome = consumeWelcomeNotice();
      if (welcome) result._setup_notice = welcome;

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  const viewPath = resolveViewPath("apm-health-summary");
  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const html = fs.readFileSync(viewPath, "utf-8");
      return {
        contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    }
  );
}

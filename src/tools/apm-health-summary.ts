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
  listNamespacesInCluster,
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
/** "0.5", "1.2", "12" — one decimal under 10, integer above. */
function formatCores(cores: number): string {
  if (cores < 10) return cores.toFixed(2).replace(/\.?0+$/, "") || "0";
  return cores.toFixed(0);
}
/** Convert bytes to a compact display + unit pair (e.g. "1.2" + "GB"). */
function formatBytes(bytes: number): { value: string; unit: string } {
  if (bytes >= 1e12) return { value: (bytes / 1e12).toFixed(1), unit: "TB" };
  if (bytes >= 1e9) return { value: (bytes / 1e9).toFixed(1), unit: "GB" };
  if (bytes >= 1e6) return { value: (bytes / 1e6).toFixed(0), unit: "MB" };
  if (bytes >= 1e3) return { value: (bytes / 1e3).toFixed(0), unit: "KB" };
  return { value: bytes.toFixed(0), unit: "B" };
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

/**
 * Per-pod resource snapshot. Splits the query the same way as the
 * utilization timeline (usage column always exists; limits + restart
 * are optional). When the optional columns are missing the snapshot
 * still returns usage values; consumers must tolerate zeros.
 */
async function queryPodResourceSnapshot(
  namespace: string | undefined,
  cluster: string | undefined,
  lookback: string,
  errors: string[]
): Promise<Map<string, PodResourceSnapshot>> {
  const out = new Map<string, PodResourceSnapshot>();
  const nsFilter = namespace ? `\n  AND k8s.namespace.name == "${namespace.replace(/"/g, '\\"')}"` : "";
  const clusterFilter = cluster ? `\n  AND k8s.cluster.name == "${cluster.replace(/"/g, '\\"')}"` : "";
  const usageEsql = `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE @timestamp > NOW() - ${lookback}
  AND k8s.pod.name IS NOT NULL${nsFilter}${clusterFilter}
| STATS
    cpu_use = MAX(metrics.k8s.pod.cpu.usage),
    mem_use = MAX(metrics.k8s.pod.memory.working_set)
  BY k8s.pod.name
| LIMIT 1000`;
  const limitsEsql = `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE @timestamp > NOW() - ${lookback}
  AND k8s.pod.name IS NOT NULL${nsFilter}${clusterFilter}
| STATS
    cpu_lim = MAX(metrics.k8s.pod.cpu.limit),
    mem_lim = MAX(metrics.k8s.pod.memory.limit)
  BY k8s.pod.name
| LIMIT 1000`;
  const restartEsql = `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE @timestamp > NOW() - ${lookback}
  AND k8s.pod.name IS NOT NULL${nsFilter}${clusterFilter}
| STATS
    restart_max = MAX(metrics.k8s.container.restart_count),
    restart_min = MIN(metrics.k8s.container.restart_count)
  BY k8s.pod.name
| LIMIT 1000`;

  const [usageRows, limitsRows, restartRows] = await Promise.all([
    safeEsqlRows<{
      "k8s.pod.name"?: string;
      cpu_use?: number;
      mem_use?: number;
    }>(usageEsql, errors, { optional: true }),
    safeEsqlRows<{
      "k8s.pod.name"?: string;
      cpu_lim?: number;
      mem_lim?: number;
    }>(limitsEsql, errors, { optional: true }),
    safeEsqlRows<{
      "k8s.pod.name"?: string;
      restart_max?: number;
      restart_min?: number;
    }>(restartEsql, errors, { optional: true }),
  ]);

  const limitsByPod = new Map<string, { cpu_lim: number; mem_lim: number }>();
  for (const r of limitsRows) {
    const pod = r["k8s.pod.name"];
    if (!pod) continue;
    limitsByPod.set(pod, { cpu_lim: r.cpu_lim ?? 0, mem_lim: r.mem_lim ?? 0 });
  }
  const restartByPod = new Map<string, number>();
  for (const r of restartRows) {
    const pod = r["k8s.pod.name"];
    if (!pod) continue;
    restartByPod.set(pod, Math.max(0, (r.restart_max ?? 0) - (r.restart_min ?? 0)));
  }

  for (const r of usageRows) {
    const pod = r["k8s.pod.name"];
    if (!pod) continue;
    const lim = limitsByPod.get(pod);
    out.set(pod, {
      pod,
      cpu_use_cores: r.cpu_use ?? 0,
      cpu_lim_cores: lim?.cpu_lim ?? 0,
      mem_use_bytes: r.mem_use ?? 0,
      mem_lim_bytes: lim?.mem_lim ?? 0,
      restart_delta: restartByPod.get(pod) ?? 0,
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

interface K8sUtilizationTimeline {
  cpu: MetricTimelineBucket[];
  mem: MetricTimelineBucket[];
  /**
   * "pct" when CPU limits are populated (cpu = % utilization across the
   * cluster), "cores" when limits are absent (cpu = total cores in use).
   * The view formats accordingly.
   */
  cpuMode: "pct" | "cores";
  memMode: "pct" | "bytes";
}

/**
 * Pod CPU/memory utilization timeline. The OTel kubeletstats receiver
 * doesn't always emit `metrics.k8s.pod.cpu.limit` / `mem.limit` — some
 * cluster configurations only ship usage. Querying for a missing
 * column 400s the WHOLE query, so we run a usage-only query first
 * (always works) and a separate optional query for limits. When
 * limits come back we report % utilization; otherwise we report
 * cores/bytes (`cpuMode`/`memMode`) and the view formats accordingly.
 */
async function queryK8sUtilizationTimeline(
  namespace: string | undefined,
  cluster: string | undefined,
  lookback: string,
  errors: string[]
): Promise<K8sUtilizationTimeline> {
  const nsFilter = namespace ? `AND k8s.namespace.name == "${namespace}" ` : "";
  const clusterFilter = cluster ? `AND k8s.cluster.name == "${cluster.replace(/"/g, '\\"')}" ` : "";

  const usageEsql = `FROM metrics-kubeletstatsreceiver.otel-* | WHERE @timestamp > NOW() - ${lookback} ${nsFilter}${clusterFilter}| STATS cpu_use = SUM(metrics.k8s.pod.cpu.usage), mem_use = SUM(metrics.k8s.pod.memory.working_set) BY bucket = BUCKET(@timestamp, ${METRIC_TIMELINE_SPAN_MIN} minute) | SORT bucket ASC`;
  const limitsEsql = `FROM metrics-kubeletstatsreceiver.otel-* | WHERE @timestamp > NOW() - ${lookback} ${nsFilter}${clusterFilter}| STATS cpu_lim = SUM(metrics.k8s.pod.cpu.limit), mem_lim = SUM(metrics.k8s.pod.memory.limit) BY bucket = BUCKET(@timestamp, ${METRIC_TIMELINE_SPAN_MIN} minute) | SORT bucket ASC`;

  const [usageRowsAll, limitsRowsAll] = await Promise.all([
    safeEsqlRows<{
      cpu_use?: number;
      mem_use?: number;
      bucket?: string | number;
    }>(usageEsql, errors, { optional: true }),
    // Optional: silently empty when the cluster doesn't track limits.
    safeEsqlRows<{
      cpu_lim?: number;
      mem_lim?: number;
      bucket?: string | number;
    }>(limitsEsql, errors, { optional: true }),
  ]);

  // Index limits by bucket for cheap lookup when joining with usage.
  const limitsByBucket = new Map<number, { cpu_lim: number; mem_lim: number }>();
  for (const r of limitsRowsAll) {
    if (r.bucket == null) continue;
    const ts = typeof r.bucket === "number" ? r.bucket : Date.parse(r.bucket as string);
    if (Number.isNaN(ts)) continue;
    limitsByBucket.set(ts, { cpu_lim: r.cpu_lim ?? 0, mem_lim: r.mem_lim ?? 0 });
  }

  // Re-shape usage rows to look like the original combined-row format,
  // pulling matching limits from the lookup. Lets the existing
  // pct/cores/bytes selection logic stay the same.
  const rows = usageRowsAll.map((r) => {
    const ts = r.bucket == null ? null : typeof r.bucket === "number" ? r.bucket : Date.parse(r.bucket as string);
    const lim = ts != null && !Number.isNaN(ts) ? limitsByBucket.get(ts) : undefined;
    return {
      cpu_use: r.cpu_use,
      mem_use: r.mem_use,
      cpu_lim: lim?.cpu_lim ?? 0,
      mem_lim: lim?.mem_lim ?? 0,
      bucket: r.bucket,
    };
  });

  // Decide mode per metric based on whether limits are populated anywhere
  // in the lookback window. If they are, we report % utilization. If they
  // aren't (common in real clusters where pods don't set resource limits),
  // we fall back to raw usage — total cores in use for CPU, total bytes
  // working-set for memory. Without this fallback the tile shows '—'
  // even when the cluster is reporting plenty of usage data.
  const cpuLimSeen = rows.some((r) => (r.cpu_lim ?? 0) > 0);
  const memLimSeen = rows.some((r) => (r.mem_lim ?? 0) > 0);
  const cpuMode: "pct" | "cores" = cpuLimSeen ? "pct" : "cores";
  const memMode: "pct" | "bytes" = memLimSeen ? "pct" : "bytes";

  const cpu: MetricTimelineBucket[] = [];
  const mem: MetricTimelineBucket[] = [];
  for (const r of rows) {
    if (r.bucket == null) continue;
    const ts = typeof r.bucket === "number" ? r.bucket! : Date.parse(r.bucket as string);
    if (Number.isNaN(ts)) continue;
    const cpuVal =
      cpuMode === "pct"
        ? r.cpu_lim && r.cpu_lim > 0 ? ((r.cpu_use ?? 0) / r.cpu_lim) * 100 : 0
        : r.cpu_use ?? 0;
    const memVal =
      memMode === "pct"
        ? r.mem_lim && r.mem_lim > 0 ? ((r.mem_use ?? 0) / r.mem_lim) * 100 : 0
        : r.mem_use ?? 0;
    cpu.push({ ts, value: Math.round(cpuVal * 10) / 10 });
    mem.push({ ts, value: Math.round(memVal * 10) / 10 });
  }
  return { cpu, mem, cpuMode, memMode };
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
  }>(esql, errors, { optional: true });
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

// ─── Fired alerts rollup ────────────────────────────────────────────────────
//
// Pulled from Kibana's `.alerts-*` index (the catch-all union — covers
// observability.threshold, observability.metrics, stack.alerts, custom rules).
// We aggregate by status (active vs recovered) and by rule name, plus surface
// a few sample reasons so the payload is useful for triage without bloating
// context. Cluster-scoping is best-effort: alerts don't carry k8s.cluster.name
// reliably, so we filter by lookback window only and let the user/agent
// recognize cluster-relevant alerts from the rule name + reason text.

interface AlertsRollup {
  active_count: number;
  recovered_count: number;
  top_rules: { name: string; count: number; severity?: string }[];
  /** Full reason text + instance for the highest-priority handful of active
   *  alerts. Caps at 5 to keep the payload compact. */
  active_samples: {
    rule: string;
    reason: string;
    instance_id?: string;
    severity?: string;
    started_ms?: number;
  }[];
  error?: string;
}

async function queryFiredAlerts(lookback: string): Promise<AlertsRollup> {
  const empty: AlertsRollup = {
    active_count: 0,
    recovered_count: 0,
    top_rules: [],
    active_samples: [],
  };
  try {
    const body = {
      size: 5,
      query: {
        bool: {
          must: [
            { range: { "@timestamp": { gte: `now-${lookback}` } } },
          ],
          should: [{ term: { "kibana.alert.status": "active" } }],
        },
      },
      // Active alerts first; within those, most-recent first.
      sort: [
        { "kibana.alert.status": { order: "asc" } }, // "active" sorts before "recovered"
        { "@timestamp": { order: "desc" } },
      ],
      aggs: {
        by_status: {
          terms: { field: "kibana.alert.status", size: 5 },
        },
        active_only: {
          filter: { term: { "kibana.alert.status": "active" } },
          aggs: {
            by_rule: {
              terms: { field: "kibana.alert.rule.name", size: 10 },
              aggs: {
                top_severity: {
                  top_hits: {
                    size: 1,
                    _source: ["kibana.alert.severity"],
                  },
                },
              },
            },
          },
        },
      },
      _source: [
        "@timestamp",
        "kibana.alert.rule.name",
        "kibana.alert.status",
        "kibana.alert.reason",
        "kibana.alert.start",
        "kibana.alert.severity",
        "kibana.alert.instance.id",
      ],
    };
    const res = await esRequest<{
      aggregations?: {
        by_status?: { buckets: { key: string; doc_count: number }[] };
        active_only?: {
          by_rule?: {
            buckets: {
              key: string;
              doc_count: number;
              top_severity?: { hits?: { hits?: { _source?: { kibana?: { alert?: { severity?: string } } } }[] } };
            }[];
          };
        };
      };
      hits?: {
        hits?: {
          _source?: {
            "@timestamp"?: string;
            kibana?: {
              alert?: {
                rule?: { name?: string };
                status?: string;
                reason?: string;
                start?: string;
                severity?: string;
                instance?: { id?: string };
              };
            };
          };
        }[];
      };
    }>(`/.alerts-*/_search`, { method: "POST", body });

    const statusBuckets = res.aggregations?.by_status?.buckets ?? [];
    let active = 0;
    let recovered = 0;
    for (const b of statusBuckets) {
      if (b.key === "active") active = b.doc_count;
      else if (b.key === "recovered") recovered = b.doc_count;
    }

    const ruleBuckets = res.aggregations?.active_only?.by_rule?.buckets ?? [];
    const top_rules: AlertsRollup["top_rules"] = ruleBuckets.slice(0, 8).map((b) => ({
      name: b.key,
      count: b.doc_count,
      severity:
        b.top_severity?.hits?.hits?.[0]?._source?.kibana?.alert?.severity || undefined,
    }));

    const sampleHits = res.hits?.hits ?? [];
    const active_samples: AlertsRollup["active_samples"] = [];
    for (const h of sampleHits) {
      const a = h._source?.kibana?.alert;
      if (!a) continue;
      active_samples.push({
        rule: a.rule?.name || "(unnamed)",
        reason: a.reason || "",
        instance_id: a.instance?.id,
        severity: a.severity,
        started_ms: a.start ? Date.parse(a.start) : undefined,
      });
    }

    return { active_count: active, recovered_count: recovered, top_rules, active_samples };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 404 = no alerting indices in this env — return empty silently.
    if (msg.includes("404") || msg.includes("index_not_found_exception")) return empty;
    return { ...empty, error: msg };
  }
}

// ─── SLO status ─────────────────────────────────────────────────────────────
//
// Pulled from the SLO summary index `.slo-observability.summary-v3*` —
// authoritative for SLO health regardless of whether burn-rate alerting
// rules are attached. (Previously we hit the alerts index, which only has
// data when explicit SLO alerting rules fire — meaning SLOs that were
// "VIOLATED" per the transform but had no alert rule looked healthy here.)

interface SloStatus {
  configured: boolean;
  violated_count?: number;
  healthy_count?: number;
  /** Up to 12 currently-violated SLOs, sorted by lowest sliValue first
   *  (worst breaches first). Includes target + burn rate so the view +
   *  agent can prioritize by severity. */
  top_violations?: {
    name: string;
    sli_value: number;
    target: number;
    error_budget_remaining?: number;
    one_hour_burn_rate?: number;
    one_day_burn_rate?: number;
    indicator_type?: string;
    last_evaluated_ms?: number;
  }[];
  /** Note shown when no SLOs are configured (the common case in stock envs). */
  note?: string;
}

async function querySloStatus(): Promise<SloStatus> {
  try {
    const body = {
      size: 0,
      query: { term: { isTempDoc: false } },
      aggs: {
        by_status: { terms: { field: "status", size: 5 } },
        violations: {
          filter: { term: { status: "VIOLATED" } },
          aggs: {
            top: {
              top_hits: {
                size: 12,
                sort: [{ sliValue: { order: "asc" } }],
                _source: [
                  "slo.name",
                  "slo.objective.target",
                  "slo.indicator.type",
                  "status",
                  "sliValue",
                  "errorBudgetRemaining",
                  "errorBudgetConsumed",
                  "oneHourBurnRate.value",
                  "oneDayBurnRate.value",
                  "summaryUpdatedAt",
                ],
              },
            },
          },
        },
      },
    };
    const res = await esRequest<{
      aggregations?: {
        by_status?: { buckets: { key: string; doc_count: number }[] };
        violations?: { top?: { hits?: { hits: { _source?: Record<string, unknown> }[] } } };
      };
    }>(`/.slo-observability.summary-v3*/_search`, { method: "POST", body });

    const buckets = res.aggregations?.by_status?.buckets ?? [];
    if (buckets.length === 0) {
      return {
        configured: false,
        note: "No SLOs configured for this cluster. Create SLOs in Kibana → Observability → SLOs to track service-level objectives in this view.",
      };
    }
    let violated = 0;
    let healthy = 0;
    for (const b of buckets) {
      if (b.key === "VIOLATED") violated = b.doc_count;
      else if (b.key === "HEALTHY") healthy = b.doc_count;
    }

    const top_violations: NonNullable<SloStatus["top_violations"]> = [];
    for (const h of res.aggregations?.violations?.top?.hits?.hits ?? []) {
      const s = h._source as {
        slo?: { name?: string; objective?: { target?: number }; indicator?: { type?: string } };
        status?: string;
        sliValue?: number;
        errorBudgetRemaining?: number;
        oneHourBurnRate?: { value?: number };
        oneDayBurnRate?: { value?: number };
        summaryUpdatedAt?: string;
      };
      top_violations.push({
        name: s.slo?.name || "(unnamed SLO)",
        sli_value: typeof s.sliValue === "number" ? s.sliValue : 0,
        target: s.slo?.objective?.target ?? 0,
        error_budget_remaining: s.errorBudgetRemaining,
        one_hour_burn_rate: s.oneHourBurnRate?.value,
        one_day_burn_rate: s.oneDayBurnRate?.value,
        indicator_type: s.slo?.indicator?.type,
        last_evaluated_ms: s.summaryUpdatedAt ? Date.parse(s.summaryUpdatedAt) : undefined,
      });
    }

    return {
      configured: true,
      violated_count: violated,
      healthy_count: healthy,
      top_violations,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404") || msg.includes("index_not_found_exception")) {
      return {
        configured: false,
        note: "No SLOs configured for this cluster. Create SLOs in Kibana → Observability → SLOs to track service-level objectives in this view.",
      };
    }
    return { configured: false, note: `SLO status unavailable: ${msg.slice(0, 120)}` };
  }
}

async function queryActiveAnomalies(
  namespace: string | undefined,
  cluster: string | undefined,
  jobFilter: string | undefined,
  excludeEntities: string | undefined,
  // Namespaces present in the supplied cluster (via kubeletstats). Used as
  // a permissive fallback when the strict cluster-influencer filter would
  // miss anomalies — most ML jobs use k8s.namespace.name as an influencer
  // but NOT k8s.cluster.name, so requiring cluster.name to match excludes
  // valid in-cluster anomalies. With this list we OR (cluster.name match)
  // with (namespace IN cluster_namespaces) and recover the missed ones.
  clusterNamespaces: string[] | undefined
): Promise<AnomalyRollup> {
  if (!(await mlAnomalyIndicesExist())) {
    return { total: 0, by_severity: {}, top_entities: [] };
  }

  const must: unknown[] = [
    // Floor at score 1 (any actual anomaly record). Was 50, which silently
    // filtered to "minor or worse" — turning the rollup into a critical-
    // ish view rather than a general overview. The skill positions this
    // tool as "what's been going on?", not "what's broken right now?",
    // so all anomalies belong here. Heatmap also renders denser.
    { range: { record_score: { gte: 1 } } },
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
    const clusterInfluencerMatch = {
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
    };
    if (clusterNamespaces && clusterNamespaces.length > 0) {
      // OR the strict cluster-influencer match with "namespace IN
      // cluster_namespaces" so jobs that only carry k8s.namespace.name
      // as an influencer aren't excluded.
      const namespaceInClusterMatch = {
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
                {
                  terms: { "influencers.influencer_field_values": clusterNamespaces },
                },
              ],
            },
          },
        },
      };
      must.push({
        bool: {
          should: [clusterInfluencerMatch, namespaceInClusterMatch],
          minimum_should_match: 1,
        },
      });
    } else {
      must.push(clusterInfluencerMatch);
    }
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
          // "warning" (1-49) added so weak anomalies have a bucket once
          // the score floor dropped from 50 → 1. Without this they'd
          // count toward total but disappear from the donut, making
          // the rollup feel incomplete.
          ranges: [
            { key: "warning", from: 1, to: 50 },
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
                  size: 10,
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
        terms: { field: "partition_field_value", size: 10, order: { max_score: "desc" } },
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
                            { key: "warning", from: 1, to: 50 },
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

  // Health verdict counts MINOR-OR-WORSE anomalies only. With the score
  // floor dropped to 1 the rollup includes "warning" tier (1-49) for
  // visibility, but those are weak signals and shouldn't tip the
  // overall verdict — otherwise a quiet cluster with 6 statistical
  // warnings would falsely flip to "degraded".
  const critical = anomalies.by_severity?.critical || 0;
  const major = anomalies.by_severity?.major || 0;
  const minor = anomalies.by_severity?.minor || 0;
  const significantAnomalies = critical + major + minor;
  let health: string;
  if (critical > 0 || degraded.length >= 3) health = "critical";
  else if (degraded.length >= 1 || significantAnomalies > 5) health = "degraded";
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
          "PASS THIS whenever the user names a cluster, even partially or vaguely — phrases like " +
          "'the X cluster', 'my X env', 'how is X doing' (where X looks like a cluster identifier) " +
          "should map here. Resolves against k8s.cluster.name (OTel) or orchestrator.cluster.name (ECS); " +
          "fuzzy-matched (exact → prefix → substring). When the input is ambiguous (multiple matches) " +
          "or doesn't match anything, the tool returns `disambiguation_needed` with " +
          "`cluster_candidates` instead of running the analysis — surface those candidates to the " +
          "user and re-call with the chosen exact name. Omit only when the user clearly wants a " +
          "cross-cluster view or there's only one cluster in the env."
        ),
        namespace: z.string().optional().describe(
          "Kubernetes namespace to scope to — e.g. 'otel-demo', 'prod', 'checkout'. Same fuzzy-match + " +
          "disambiguation flow as `cluster`: when ambiguous or absent the tool returns " +
          "`namespace_candidates` for clarification. Only applicable if services are K8s-deployed."
        ),
        lookback: z.string().optional().describe(
          "Time range to assess. Default '1h'. Examples: '5m' / '15m' (right-now snapshots), " +
          "'1h' (default — good general-purpose window), '6h' / '24h' (wider trend). When the user " +
          "gives an explicit time window in their prompt ('over the past 30 minutes', 'in the last 6 hours'), " +
          "pass that literally."
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
      // Default 1h — matches user expectation for unqualified "show me the
      // health of X" prompts, gives enough window to surface degradation
      // patterns. 15m default was too tight for vague-symptom investigations.
      const lb = lookback || "1h";
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

      // Disambiguation short-circuit: when the user-supplied cluster or
      // namespace either matches multiple candidates (ambiguous) or
      // matches none (not found in telemetry), return early with the
      // candidate list. Running the rest of the queries with a silently-
      // picked first match — or no filter at all — would mislead the
      // user about what they're looking at. Claude reads
      // `disambiguation_needed` and asks the user to pick one before
      // re-calling.
      const clusterNeedsClarify = !!cluster && !clusterResolution.resolved && !!clusterResolution.candidates?.length;
      const nsNeedsClarify = !!namespace && !nsResolution.resolved && !!nsResolution.candidates?.length;
      if (clusterNeedsClarify || nsNeedsClarify) {
        const ambiguous: Record<string, unknown> = {
          disambiguation_needed: clusterNeedsClarify && nsNeedsClarify ? "cluster_and_namespace" : clusterNeedsClarify ? "cluster" : "namespace",
          lookback: lb,
        };
        if (clusterNeedsClarify) {
          ambiguous.cluster_requested = cluster;
          ambiguous.cluster_candidates = clusterResolution.candidates;
          ambiguous.cluster_note = clusterResolution.note;
          ambiguous.cluster_match = clusterResolution.ambiguous ? "multiple" : "none";
        }
        if (nsNeedsClarify) {
          ambiguous.namespace_requested = namespace;
          ambiguous.namespace_candidates = nsResolution.candidates;
          ambiguous.namespace_note = nsResolution.note;
          ambiguous.namespace_match = nsResolution.ambiguous ? "multiple" : "none";
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(ambiguous, null, 2) }],
          structuredContent: ambiguous,
        };
      }

      const effectiveCluster = clusterResolution.resolved;
      const effectiveNs = nsResolution.resolved;

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

      // Resolve cluster namespaces ahead of the anomaly query so it can
      // OR (cluster.name match) with (namespace IN cluster_namespaces).
      // Other queries don't depend on this and run in parallel.
      const clusterNamespacesPromise = effectiveCluster
        ? listNamespacesInCluster(effectiveCluster, lb, queryErrors)
        : Promise.resolve<string[] | undefined>(undefined);

      const [services, pods, anomalies, alerts, slos] = await Promise.all([
        noServicesInScope
          ? Promise.resolve<ServiceRow[]>([])
          : queryServices(serviceFilter, lb, queryErrors),
        queryPodResources(effectiveNs, effectiveCluster, lb, queryErrors),
        clusterNamespacesPromise.then((ns) =>
          queryActiveAnomalies(effectiveNs, effectiveCluster, job_filter, exclude_entities, ns)
        ),
        queryFiredAlerts(lb),
        querySloStatus(),
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
        cluster: effectiveCluster || cluster || "all",
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
        // CPU formatting: when limits aren't populated (cpuMode === "cores")
        // we report total cores in use rather than %; thresholds only apply
        // in pct mode. Memory the same — bytes vs %.
        const cpuTile: KpiTile =
          k8sUtil.cpuMode === "pct"
            ? {
                key: "cpu",
                label: "CPU",
                value_display: cpuLatest > 0 ? `${cpuLatest.toFixed(0)}` : "—",
                unit: cpuLatest > 0 ? "%" : undefined,
                timeline: k8sUtil.cpu,
                peak: peakOf(k8sUtil.cpu),
                status: cpuLatest > 0 ? statusForCpuUtil(cpuLatest) : undefined,
              }
            : {
                key: "cpu",
                label: "CPU",
                value_display: cpuLatest > 0 ? formatCores(cpuLatest) : "—",
                unit: cpuLatest > 0 ? "cores" : undefined,
                secondary: "limits not set",
                timeline: k8sUtil.cpu,
                peak: peakOf(k8sUtil.cpu),
              };
        const memTile: KpiTile =
          k8sUtil.memMode === "pct"
            ? {
                key: "memory",
                label: "Memory",
                value_display: memLatest > 0 ? `${memLatest.toFixed(0)}` : "—",
                unit: memLatest > 0 ? "%" : undefined,
                timeline: k8sUtil.mem,
                peak: peakOf(k8sUtil.mem),
                status: memLatest > 0 ? statusForMemUtil(memLatest) : undefined,
              }
            : (() => {
                const formatted = memLatest > 0 ? formatBytes(memLatest) : null;
                return {
                  key: "memory",
                  label: "Memory",
                  value_display: formatted ? formatted.value : "—",
                  unit: formatted ? formatted.unit : undefined,
                  secondary: "limits not set",
                  timeline: k8sUtil.mem,
                  peak: peakOf(k8sUtil.mem),
                };
              })();
        // Restart count is optional in the OTel kubeletstats receiver — when
        // the cluster doesn't export `metrics.k8s.container.restart_count`,
        // the timeline query 400s and we fall through to an empty array.
        // Distinguish "metric absent" (show — / "not tracked") from a real
        // zero ("0 / last 1h"). Without the distinction the tile lies.
        const restartTracked = k8sRestartTl.length > 0;
        const restartTile: KpiTile = restartTracked
          ? {
              key: "restarts",
              label: "Restarts",
              value_display: `${restartTotal}`,
              secondary: `last ${lb}`,
              timeline: k8sRestartTl,
              peak: peakOf(k8sRestartTl),
              spark: "bar",
              status: statusForRestarts(restartTotal),
            }
          : {
              key: "restarts",
              label: "Restarts",
              value_display: "—",
              secondary: "not tracked",
            };
        const k8sTiles: KpiTile[] = [
          cpuTile,
          memTile,
          restartTile,
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

      // Fired alerts rollup. Always emitted (even if zero) so the view
      // can render a stable "no alerts in window" state. Saves Claude
      // a separate manage-alerts call for the common "what fired
      // recently?" question.
      result.alerts = alerts;

      // SLO status stub. When SLOs aren't configured, the `note` field
      // tells Claude (and the view) to surface the gap as a
      // configuration nudge rather than a missing-data error.
      result.slos = slos;

      if (!services.length) {
        result.warning =
          "No APM service telemetry found. This tool requires Elastic APM — if you're a logs- or metrics-only " +
          "customer, reach for 'ml-anomalies', 'observe', or 'manage-alerts' instead.";
      } else if (degraded.length) {
        // Single-tool recommendation. apm-service-dependencies is the
        // highest-yield drilldown for a named-degraded service — topology
        // is universally available and almost always points at the
        // upstream/downstream causing the symptom. We avoid chaining a
        // "then optionally drill into ml-anomalies" sentence: Claude
        // reads that as a parallel tool call and fires both at once,
        // cluttering the chat with an empty anomaly widget. Users can
        // ask for ml-anomalies explicitly as a follow-up.
        const svc = degraded[0].service;
        const reasons = degraded[0].reasons.join(", ");
        result.recommendation = `Investigate ${svc}: ${reasons}. Use apm-service-dependencies (entity "${svc}") to map the neighborhood and spot upstream/downstream root causes.`;
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
        const svc = degraded[0].service;
        // Single-tool prompt — see the recommendation comment above for
        // why we don't chain "then optionally call ml-anomalies".
        actions.push({
          label: `Map dependencies for ${svc}`,
          prompt: `Use apm-service-dependencies with service "${svc}" and lookback "1h" to map the neighborhood and spot upstream/downstream root causes.`,
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

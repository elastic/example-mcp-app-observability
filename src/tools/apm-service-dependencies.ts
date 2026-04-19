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
import {
  resolveServicesInNamespace,
  buildServiceFilter,
  resolveNamespace,
} from "../elastic/apm.js";
import { resolveViewPath } from "./view-path.js";

const RESOURCE_URI = "ui://apm-service-dependencies/mcp-app.html";

interface EdgeRow {
  "service.name"?: string;
  "span.destination.service.resource"?: string;
  "service.target.name"?: string;
  "service.target.type"?: string;
  total_count?: number;
  total_duration_us?: number;
}

interface HealthRow {
  "service.name"?: string;
  span_count?: number;
  avg_duration_us?: number;
  p99_duration_us?: number;
  error_count?: number;
}

interface MetadataRow {
  "service.name"?: string;
  "service.language.name"?: string;
  "k8s.deployment.name"?: string;
  "k8s.namespace.name"?: string;
}

interface ResolutionRow {
  "rpc.service"?: string;
  "service.name"?: string;
  cnt?: number;
}

// Heuristic fallback for gRPC FQN / host:port targets when rpc.service-based resolution
// didn't find a match (e.g. the receiving service emits no SERVER-kind spans). Strips the
// common "oteldemo.CartService" → "cart" and "flagd:8013" → "flagd" patterns and matches
// against the authoritative service.name set we already pulled from metadata + health.
//
// When no known service matches, falls back to a SYNTHETIC canonical name so that multiple
// aliases for the same backend coalesce into a single graph node. E.g. when flagd emits no
// spans of its own, `flagd.evaluation.v1.Service` and `flagd:8013` both resolve to the
// synthetic name "flagd" and collapse into one leaf instead of two parallel leaves.
function fuzzyResolveTarget(target: string, known: Set<string>): string | undefined {
  if (known.has(target)) return target;

  // HOST:PORT → try the HOST part. If HOST matches a known service, use it. Otherwise
  // return HOST as a synthetic canonical (so flagd:8013 and flagd:9000 coalesce).
  const colon = target.lastIndexOf(":");
  if (colon > 0) {
    const maybePort = target.slice(colon + 1);
    if (/^\d+$/.test(maybePort)) {
      const host = target.slice(0, colon);
      return matchKnown(host, known) ?? host;
    }
  }

  // gRPC FQN. Two patterns to handle:
  //   1. `package.XService` (1-dot, e.g. `oteldemo.CartService`) — last segment carries
  //      the service name; strip "Service" suffix and kebab-case.
  //   2. `package.sub.vN.Service` (deep namespace ending in bare "Service", e.g.
  //      `flagd.evaluation.v1.Service`) — first segment carries the service name.
  if (target.includes(".")) {
    const lastDot = target.lastIndexOf(".");
    const last = target.slice(lastDot + 1);
    const firstDot = target.indexOf(".");
    const first = target.slice(0, firstDot);

    if (last === "Service") {
      // Pattern 2: flagd.evaluation.v1.Service → flagd.
      return matchKnown(first, known) ?? first;
    }
    if (last.endsWith("Service")) {
      // Pattern 1: oteldemo.CartService → cart (or Cart synthetic).
      const trimmed = last.slice(0, -"Service".length);
      const hit = matchKnown(trimmed, known);
      if (hit) return hit;
      const kebab = trimmed.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      return kebab || trimmed;
    }
  }

  return undefined;
}

function matchKnown(candidate: string, known: Set<string>): string | undefined {
  if (!candidate) return undefined;
  if (known.has(candidate)) return candidate;
  const lower = candidate.toLowerCase();
  const kebab = candidate.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  for (const s of known) {
    const sl = s.toLowerCase();
    if (sl === lower || sl === kebab) return s;
  }
  return undefined;
}

function parseDestination(resource: string): {
  raw: string;
  protocol?: string;
  target_service: string;
  port?: string;
} {
  let r = resource;
  let protocol: string | undefined;
  for (const proto of ["dns:///", "http://", "https://", "grpc://"]) {
    if (r.startsWith(proto)) {
      protocol = proto.replace(/[:/]+$/, "");
      r = r.slice(proto.length);
      break;
    }
  }
  let target = r;
  let port: string | undefined;
  const idx = r.lastIndexOf(":");
  if (idx >= 0) {
    const maybePort = r.slice(idx + 1);
    const portNum = parseInt(maybePort, 10);
    if (Number.isFinite(portNum) && String(portNum) === maybePort) {
      target = r.slice(0, idx);
      port = String(portNum);
    }
  }
  return { raw: resource, protocol, target_service: target, port };
}

// Map gRPC service FQN (e.g. "oteldemo.AdService") to the actual service.name
// of the receiving service (e.g. "ad"), so edge targets and health data line up.
async function fetchTargetResolution(
  lb: string,
  serviceFilter: string,
  errors: string[]
): Promise<Map<string, string>> {
  const query = `
FROM traces-*.otel-*
| WHERE @timestamp > NOW() - ${lb}
  AND rpc.service IS NOT NULL
  AND service.name IS NOT NULL
  AND kind IN ("Server", "SERVER")${serviceFilter}
| STATS cnt = COUNT(*) BY rpc.service, service.name
| SORT cnt DESC
| LIMIT 500
`;
  const rows = await safeEsqlRows<ResolutionRow>(query, errors);
  const best = new Map<string, { serviceName: string; count: number }>();
  for (const row of rows) {
    const rpc = row["rpc.service"];
    const sn = row["service.name"];
    if (!rpc || !sn) continue;
    const count = row.cnt ?? 0;
    const existing = best.get(rpc);
    if (!existing || count > existing.count) {
      best.set(rpc, { serviceName: sn, count });
    }
  }
  const out = new Map<string, string>();
  for (const [rpc, v] of best) out.set(rpc, v.serviceName);
  return out;
}

// Metadata (language, deployment, namespace) — OTel traces first, classic APM (traces-apm*
// + kubernetes.*) as fallback so classic-agent customers still see language/k8s context.
// When a namespace was requested, `serviceFilter` (service.name IN …) has already scoped
// the service set — no separate namespace clause is needed on either branch. Classic
// branch is `optional` — in pure-OTel envs, traces-apm* can match stub indices without
// the classic schema, and those verification_exceptions are expected wrong-env signals.
async function fetchMetadata(
  lb: string,
  serviceFilter: string,
  otelQuery: string,
  errors: string[]
): Promise<MetadataRow[]> {
  const otelRows = await safeEsqlRows<MetadataRow>(otelQuery, errors);
  if (otelRows.length) return otelRows;
  const classicQuery = `
FROM traces-apm*
| WHERE service.name IS NOT NULL
  AND @timestamp > NOW() - ${lb}
  AND processor.event == "transaction"${serviceFilter}
| STATS
    trace_count = COUNT(*)
  BY service.name, service.language.name, kubernetes.deployment.name, kubernetes.namespace
| SORT trace_count DESC
| LIMIT 100
`;
  type ClassicMetaRow = {
    "service.name"?: string;
    "service.language.name"?: string;
    "kubernetes.deployment.name"?: string;
    "kubernetes.namespace"?: string;
  };
  const rows = await safeEsqlRows<ClassicMetaRow>(classicQuery, errors, { optional: true });
  return rows.map((r) => ({
    "service.name": r["service.name"],
    "service.language.name": r["service.language.name"],
    "k8s.deployment.name": r["kubernetes.deployment.name"],
    "k8s.namespace.name": r["kubernetes.namespace"],
  }));
}

async function fetchHealth(
  lb: string,
  serviceFilter: string,
  errors: string[]
): Promise<HealthRow[]> {
  // Span counts from pre-aggregated summary metrics are reliable (SUM of a
  // per-minute gauge across the window). Latency is NOT read from
  // transaction.duration.summary — it's an aggregate_metric_double where
  // ES|QL's AVG/SUM/COUNT operate on default_metric components and can't
  // reproduce the weighted mean (SUM(sum) / SUM(value_count)). Verified
  // against oteldemo-esyox: the summary-metric AVG inflated some services
  // by 2–5× (and up to 600s for low-volume services) relative to a raw
  // traces AVG. We use traces as the authoritative latency source.
  //
  // Scoping note: `serviceFilter` (service.name IN …) is used on every branch.
  // That's intentional — the service_summary / service_destination transforms
  // may not carry k8s.namespace.name as a dimension (silent-empty bug the user
  // hit), so we scope by the universal service.name join key instead.
  const summaryQuery = `
FROM metrics-service_summary.1m.otel-*
| WHERE @timestamp > NOW() - ${lb}
  AND service.name IS NOT NULL${serviceFilter}
| STATS
    span_count = SUM(service_summary)
  BY service.name
| LIMIT 200
`;

  const tracesQuery = `
FROM traces-*.otel-*
| WHERE @timestamp > NOW() - ${lb}
  AND service.name IS NOT NULL${serviceFilter}
| EVAL duration_us = duration / 1000
| STATS
    traces_span_count = COUNT(*),
    avg_duration_us = AVG(duration_us),
    p99_duration_us = PERCENTILE(duration_us, 99),
    error_count = COUNT(CASE(status.code == "Error", 1, NULL))
  BY service.name
| LIMIT 200
`;

  const [summaryRows, tracesRows] = await Promise.all([
    safeEsqlRows<HealthRow & { traces_span_count?: number }>(summaryQuery, errors),
    safeEsqlRows<HealthRow & { traces_span_count?: number }>(tracesQuery, errors),
  ]);

  if (summaryRows.length || tracesRows.length) {
    const merged = new Map<string, HealthRow>();
    for (const row of summaryRows) {
      const name = row["service.name"];
      if (name) merged.set(name, { "service.name": name, span_count: row.span_count });
    }
    for (const row of tracesRows) {
      const name = row["service.name"];
      if (!name) continue;
      const existing = merged.get(name) || { "service.name": name };
      merged.set(name, {
        ...existing,
        // prefer summary-metric span_count when present; fall back to traces count
        span_count: existing.span_count ?? row.traces_span_count,
        avg_duration_us: row.avg_duration_us,
        p99_duration_us: row.p99_duration_us,
        error_count: row.error_count,
      });
    }
    return [...merged.values()];
  }

  // Tier 3: classic APM agents — traces-apm* with transaction.duration.us and event.outcome.
  // Only queried when both tier-1 metrics and tier-2 OTel traces return nothing, so OTel-native
  // deployments don't pay the extra call. Marked `optional` so verification_exceptions in
  // pure-OTel envs (where traces-apm* may match stubs without classic schema) don't surface.
  const classicQuery = `
FROM traces-apm*
| WHERE @timestamp > NOW() - ${lb}
  AND service.name IS NOT NULL
  AND processor.event == "transaction"${serviceFilter}
| STATS
    span_count = COUNT(*),
    avg_duration_us = AVG(transaction.duration.us),
    error_count = COUNT(CASE(event.outcome == "failure", 1, NULL))
  BY service.name
| LIMIT 200
`;
  return safeEsqlRows<HealthRow>(classicQuery, errors, { optional: true });
}

export function registerApmServiceDependenciesTool(server: McpServer) {
  registerAppTool(
    server,
    "apm-service-dependencies",
    {
      title: "APM Service Dependencies",
      description:
        "Requires: Elastic APM (OTel-instrumented services producing span.destination.service.resource or service.target.name). " +
        "Returns the service dependency graph from APM telemetry — which services call which, over what protocols, " +
        "with call volume and latency. Use when the user asks 'what calls X', 'what depends on X', 'show me the " +
        "topology', or is doing root-cause investigation and needs to know upstream/downstream neighbors. Optional " +
        "Kubernetes namespace filter — resolved to the set of services observed in that namespace, then used to " +
        "scope every downstream query by service.name (the pre-aggregated APM summary-metric indices may not carry " +
        "k8s.namespace.name as a transform dimension, so the resolution step is what makes the filter work reliably). " +
        "Health data comes from pre-aggregated APM service metrics when available, otherwise from raw OTel traces. " +
        "Not useful for log-only or metrics-only customers.",
      inputSchema: {
        service: z.string().optional().describe(
          "Focal service to center the graph on. Returns only its direct upstream (who calls it) and downstream " +
          "(what it calls) neighbors. Must be the exact OTel service.name as deployed — typically lowercase and " +
          "hyphenated for multi-word services, e.g. 'frontend', 'checkout', 'product-catalog'. Do NOT concatenate " +
          "spaces (user says 'checkout service' → pass 'checkout', not 'checkoutservice'). Omit for the full graph."
        ),
        namespace: z.string().optional().describe(
          "Kubernetes namespace to scope the query, e.g. 'otel-demo', 'prod'. Matched against k8s.namespace.name " +
          "(OTel semconv). Only applicable if services are k8s-deployed and the namespace attribute is being captured."
        ),
        lookback: z.string().optional().describe(
          "How far back to aggregate. Default '1h'. Examples: '15m', '1h', '6h', '24h'. Wider windows smooth out " +
          "transient topology changes; narrow windows capture the current state."
        ),
        include_health: z.boolean().optional().describe(
          "Include per-service health metrics (span count, latency, error count). Default true. Set false for " +
          "a faster, topology-only response."
        ),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ service, namespace, lookback, include_health }) => {
      const lb = lookback || "1h";
      const includeHealth = include_health !== false;
      const queryErrors: string[] = [];

      // Namespace scoping goes through service.name resolution rather than a direct
      // `k8s.namespace.name == X` clause. Rationale: the pre-aggregated APM summary
      // metrics (`metrics-service_*.1m.otel-*`) may not carry k8s.namespace.name as a
      // transform dimension, so a direct clause silently returns zero rows even when
      // the namespace is populated. service.name is the universal join key across
      // OTel rollups, OTel traces, and classic APM — scoping by it works everywhere.
      //
      // Fuzzy-resolve the user-supplied name first so that "otel-demo" matches
      // "oteldemo-esyox-default" (common demo-env pattern). Without this step,
      // exact-match resolution returns zero services and we short-circuit with
      // a misleading "namespace has no APM services" hint.
      let resolvedServices: string[] | undefined;
      let nsResolution: Awaited<ReturnType<typeof resolveNamespace>> = {};
      if (namespace) {
        nsResolution = await resolveNamespace(namespace, lb, queryErrors);
        const effectiveNs = nsResolution.resolved ?? namespace;
        resolvedServices = await resolveServicesInNamespace(effectiveNs, lb, queryErrors);
        if (!resolvedServices.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  services: [],
                  edges: [],
                  service_count: 0,
                  edge_count: 0,
                  data_coverage: { apm: false },
                  filters: {
                    lookback: lb,
                    namespace,
                    ...(nsResolution.resolved && nsResolution.resolved !== namespace
                      ? { namespace_resolved: nsResolution.resolved }
                      : {}),
                  },
                  ...(nsResolution.note ? { namespace_note: nsResolution.note } : {}),
                  ...(nsResolution.candidates
                    ? { namespace_candidates: nsResolution.candidates }
                    : {}),
                  hint:
                    `No APM services observed in namespace "${effectiveNs}" over the last ${lb}. ` +
                    `Possible causes: (1) the namespace doesn't exist in this environment, ` +
                    `(2) services in this namespace aren't APM-instrumented, or (3) the ` +
                    `k8s.namespace.name resource attribute isn't being propagated to spans ` +
                    `by the collector pipeline. Use apm-health-summary (without a namespace ` +
                    `filter) to discover which namespaces are currently reporting services.`,
                  ...(queryErrors.length ? { _query_errors: queryErrors } : {}),
                }),
              },
            ],
          };
        }
      }
      const serviceFilter = buildServiceFilter(resolvedServices);

      const edgesQuery = `
FROM metrics-service_destination.1m.otel-*
| WHERE @timestamp > NOW() - ${lb}
  AND service.name IS NOT NULL
  AND (span.destination.service.resource IS NOT NULL OR service.target.name IS NOT NULL)${serviceFilter}
| STATS
    total_count = SUM(span.destination.service.response_time.count),
    total_duration_us = SUM(span.destination.service.response_time.sum.us)
  BY service.name,
     span.destination.service.resource,
     service.target.name,
     service.target.type
| WHERE total_count > 0
| SORT total_count DESC
| LIMIT 200
`;

      const metadataQuery = `
FROM traces-*.otel-*
| WHERE service.name IS NOT NULL
  AND @timestamp > NOW() - ${lb}${serviceFilter}
| STATS
    trace_count = COUNT(*)
  BY service.name, service.language.name, k8s.deployment.name, k8s.namespace.name
| SORT trace_count DESC
| LIMIT 100
`;

      const [edgeRows, healthRows, metadataRows, targetResolution] = await Promise.all([
        safeEsqlRows<EdgeRow>(edgesQuery, queryErrors),
        includeHealth ? fetchHealth(lb, serviceFilter, queryErrors) : Promise.resolve([]),
        fetchMetadata(lb, serviceFilter, metadataQuery, queryErrors),
        fetchTargetResolution(lb, serviceFilter, queryErrors),
      ]);

      if (!edgeRows.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                services: [],
                edges: [],
                service_count: 0,
                edge_count: 0,
                data_coverage: { apm: false },
                hint:
                  `No service dependency data in the last ${lb}. This tool requires Elastic APM traces ` +
                  `(traces-*.otel-*) with span.destination.service.resource or service.target.name populated. ` +
                  `If this is a log/metrics-only deployment, this tool does not apply — consider ` +
                  `ml-anomalies, watch, or create-alert-rule instead.`,
              }),
            },
          ],
        };
      }

      // Authoritative service.name set from metadata + health + edge sources. Used as the
      // match target for gRPC-FQN / host:port fuzzy resolution below.
      const knownServices = new Set<string>();
      for (const r of metadataRows) if (r["service.name"]) knownServices.add(r["service.name"]!);
      for (const r of healthRows) if (r["service.name"]) knownServices.add(r["service.name"]!);
      for (const r of edgeRows) if (r["service.name"]) knownServices.add(r["service.name"]!);

      type RawEdge = {
        source: string;
        target: string;
        protocol?: string;
        port?: string;
        call_count: number;
        total_duration_us: number;
      };
      const rawEdges: RawEdge[] = [];
      const servicesSeen = new Set<string>();

      for (const row of edgeRows) {
        const source = row["service.name"];
        const targetName = row["service.target.name"];
        const targetType = row["service.target.type"];
        const destResource = row["span.destination.service.resource"];
        if (!source || (!targetName && !destResource)) continue;

        let target: string;
        let protocol: string | undefined;
        let port: string | undefined;
        if (destResource) {
          const parsed = parseDestination(destResource);
          target = targetName || parsed.target_service;
          protocol = targetType || parsed.protocol;
          port = parsed.port;
        } else {
          target = targetName!;
          protocol = targetType;
        }

        // Resolution priority: rpc.service lookup (SERVER-kind spans) first, then fuzzy
        // match against known services (handles cases where the target emits no server spans).
        const resolved = targetResolution.get(target) ?? fuzzyResolveTarget(target, knownServices);
        if (resolved) target = resolved;

        rawEdges.push({
          source,
          target,
          protocol,
          port,
          call_count: row.total_count || 0,
          total_duration_us: row.total_duration_us || 0,
        });
        servicesSeen.add(source);
        servicesSeen.add(target);
      }

      // Aggregate edges that collapsed onto the same (source, target, protocol) after
      // resolution — e.g. "flagd.evaluation.v1.Service" and "flagd:8013" both folding into
      // "flagd" used to show up as two parallel edges with half the call volume each.
      const edgeMap = new Map<string, RawEdge>();
      for (const e of rawEdges) {
        const key = `${e.source}\u0000${e.target}\u0000${e.protocol ?? ""}`;
        const existing = edgeMap.get(key);
        if (existing) {
          existing.call_count += e.call_count;
          existing.total_duration_us += e.total_duration_us;
          if (!existing.port && e.port) existing.port = e.port;
        } else {
          edgeMap.set(key, { ...e });
        }
      }
      let edges: Record<string, unknown>[] = [...edgeMap.values()].map((e) => {
        const edge: Record<string, unknown> = {
          source: e.source,
          target: e.target,
          call_count: e.call_count,
        };
        if (e.protocol) edge.protocol = e.protocol;
        if (e.port) edge.port = e.port;
        if (e.total_duration_us && e.call_count > 0) {
          edge.avg_latency_us = Math.round((e.total_duration_us / e.call_count) * 10) / 10;
        }
        return edge;
      });
      edges.sort((a, b) => (b.call_count as number) - (a.call_count as number));

      if (service) {
        const upstream = edges.filter((e) => e.target === service);
        const downstream = edges.filter((e) => e.source === service);
        edges = [...upstream, ...downstream];
        const focalNeighbors = new Set<string>([service]);
        for (const e of edges) {
          focalNeighbors.add(e.source as string);
          focalNeighbors.add(e.target as string);
        }
        servicesSeen.clear();
        for (const s of focalNeighbors) servicesSeen.add(s);
      }

      const metaMap = new Map<string, Record<string, unknown>>();
      for (const row of metadataRows) {
        const name = row["service.name"];
        if (name && !metaMap.has(name)) {
          const meta: Record<string, unknown> = {};
          if (row["service.language.name"]) meta.language = row["service.language.name"];
          if (row["k8s.deployment.name"]) meta.deployment = row["k8s.deployment.name"];
          if (row["k8s.namespace.name"]) meta.namespace = row["k8s.namespace.name"];
          if (Object.keys(meta).length) metaMap.set(name, meta);
        }
      }

      const healthMap = new Map<string, HealthRow>();
      for (const row of healthRows) {
        if (row["service.name"]) healthMap.set(row["service.name"]!, row);
      }

      const services: Record<string, unknown>[] = [];
      for (const name of [...servicesSeen].sort()) {
        const node: Record<string, unknown> = { name };
        const meta = metaMap.get(name);
        if (meta) Object.assign(node, meta);
        if (includeHealth && healthMap.has(name)) {
          const h = healthMap.get(name)!;
          const health: Record<string, unknown> = {};
          if (h.span_count != null) health.span_count = h.span_count;
          if (h.avg_duration_us != null) {
            health.avg_duration_us = Math.round(h.avg_duration_us * 10) / 10;
          }
          if (h.p99_duration_us != null) {
            health.p99_duration_us = Math.round(h.p99_duration_us * 10) / 10;
          }
          if (h.error_count != null && h.error_count > 0) health.error_count = h.error_count;
          if (Object.keys(health).length) node.health = health;
        }
        const hasIncoming = edges.some((e) => e.target === name);
        const hasOutgoing = edges.some((e) => e.source === name);
        if (hasOutgoing && !hasIncoming) node.role = "root";
        else if (hasIncoming && !hasOutgoing) node.role = "leaf";
        else node.role = "internal";
        services.push(node);
      }

      const result: Record<string, unknown> = {
        services,
        edges,
        service_count: services.length,
        edge_count: edges.length,
      };

      if (service) {
        result.focal_service = service;
        const upstreamList = edges.filter((e) => e.target === service).map((e) => e.source);
        const downstreamList = edges.filter((e) => e.source === service).map((e) => e.target);
        result.upstream = upstreamList;
        result.downstream = downstreamList;

        // Surface likely-instrumentation-gap cases explicitly. A focal service with inbound
        // traffic but zero observed outbound calls usually reflects an ingest gap (partial
        // eBPF auto-instrumentation, client spans dropped, etc.), not a truly terminal
        // service. The "leaf" role on its own reads as a confident architectural claim —
        // this note makes the data uncertainty legible to both the view and the LLM.
        if (upstreamList.length > 0 && downstreamList.length === 0) {
          result.data_coverage_note =
            `No downstream edges observed for '${service}' over ${lb}. This usually indicates ` +
            `an instrumentation gap (e.g. client spans not captured, partial eBPF coverage) ` +
            `rather than a truly terminal service. Treat the 'leaf' role as 'no outbound spans ` +
            `seen in this window', not 'definitely makes no outbound calls'.`;
        }
      }

      result.filters =
        namespace && resolvedServices
          ? {
              lookback: lb,
              namespace,
              ...(nsResolution.resolved && nsResolution.resolved !== namespace
                ? { namespace_resolved: nsResolution.resolved }
                : {}),
              resolved_service_count: resolvedServices.length,
            }
          : { lookback: lb };
      if (nsResolution.note) result.namespace_note = nsResolution.note;

      // Opinionated next-step prompts. Prioritize the most-likely-interesting follow-up given
      // what we found: unhealthy services → anomaly drill-down, focal service → blast radius,
      // otherwise cluster rollup.
      const unhealthy = services
        .map((s) => {
          const h = (s as { health?: { error_count?: number; span_count?: number } }).health;
          if (!h || !h.span_count) return null;
          const rate = (h.error_count ?? 0) / h.span_count;
          return rate > 0.02 ? { name: s.name as string, rate } : null;
        })
        .filter((x): x is { name: string; rate: number } => x !== null)
        .sort((a, b) => b.rate - a.rate);

      const actions: { label: string; prompt: string }[] = [];
      if (unhealthy[0]) {
        actions.push({
          label: `Investigate ${unhealthy[0].name}`,
          prompt: `Use ml-anomalies with entity "${unhealthy[0].name}" and lookback "1h" to find the root cause of elevated errors.`,
        });
      }
      if (unhealthy[1] && unhealthy[1].name !== unhealthy[0]?.name) {
        actions.push({
          label: `Investigate ${unhealthy[1].name}`,
          prompt: `Use ml-anomalies with entity "${unhealthy[1].name}" and lookback "1h" to find the root cause.`,
        });
      }
      if (service) {
        const upstreamList = edges.filter((e) => e.target === service).map((e) => e.source as string);
        if (upstreamList[0]) {
          actions.push({
            label: `Check upstream ${upstreamList[0]}`,
            prompt: `Use ml-anomalies with entity "${upstreamList[0]}" and lookback "1h" to see if the caller is the source of any issue.`,
          });
        }
      }
      const rootService = services.find((s) => (s as { role?: string }).role === "root") as
        | { name?: string }
        | undefined;
      if (rootService?.name) {
        actions.push({
          label: "Cluster health rollup",
          prompt: `Use apm-health-summary${namespace ? ` with namespace "${namespace}"` : ""} to see overall service health alongside this topology.`,
        });
      } else if (!actions.length) {
        actions.push({
          label: "Cluster health rollup",
          prompt: `Use apm-health-summary${namespace ? ` with namespace "${namespace}"` : ""} to see overall service health.`,
        });
      }
      // Note: do NOT suggest k8s-blast-radius here. Finding a k8s.namespace.name attribute on
      // APM spans proves the services are k8s-deployed, but not that the customer's ingest path
      // includes kubeletstats metrics (which is what blast-radius actually needs). Recommendations
      // should stay within tools whose data requirements are a subset of what this call proved.
      result.investigation_actions = actions;

      const rerunParts = ["lookback \"{lookback}\""];
      if (service) rerunParts.push(`service "${service}"`);
      if (namespace) rerunParts.push(`namespace "${namespace}"`);
      if (include_health === false) rerunParts.push("include_health false");
      result.rerun_context = {
        tool: "apm-service-dependencies",
        current_lookback: lb,
        prompt_template: `Use apm-service-dependencies with ${rerunParts.join(" and ")}`,
      };

      if (queryErrors.length) result._query_errors = queryErrors;

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  const viewPath = resolveViewPath("apm-service-dependencies");
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

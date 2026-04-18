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
function fuzzyResolveTarget(target: string, known: Set<string>): string | undefined {
  if (known.has(target)) return target;

  // HOST:PORT → try the HOST part.
  const colon = target.lastIndexOf(":");
  if (colon > 0) {
    const maybePort = target.slice(colon + 1);
    if (/^\d+$/.test(maybePort)) {
      const host = target.slice(0, colon);
      const hit = matchKnown(host, known);
      if (hit) return hit;
    }
  }

  // gRPC FQN "package.sub.CartService" → last dot-segment → strip trailing "Service".
  if (target.includes(".")) {
    const last = target.slice(target.lastIndexOf(".") + 1);
    const trimmed = last.endsWith("Service") ? last.slice(0, -"Service".length) : last;
    const hit = matchKnown(trimmed, known);
    if (hit) return hit;
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
  nsFilter: string,
  errors: string[]
): Promise<Map<string, string>> {
  const query = `
FROM traces-*.otel-*
| WHERE @timestamp > NOW() - ${lb}
  AND rpc.service IS NOT NULL
  AND service.name IS NOT NULL
  AND kind IN ("Server", "SERVER")${nsFilter}
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
async function fetchMetadata(
  lb: string,
  nsFilterEcs: string,
  otelQuery: string,
  errors: string[]
): Promise<MetadataRow[]> {
  const otelRows = await safeEsqlRows<MetadataRow>(otelQuery, errors);
  if (otelRows.length) return otelRows;
  const classicQuery = `
FROM traces-apm*
| WHERE service.name IS NOT NULL
  AND @timestamp > NOW() - ${lb}
  AND processor.event == "transaction"${nsFilterEcs}
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
  const rows = await safeEsqlRows<ClassicMetaRow>(classicQuery, errors);
  return rows.map((r) => ({
    "service.name": r["service.name"],
    "service.language.name": r["service.language.name"],
    "k8s.deployment.name": r["kubernetes.deployment.name"],
    "k8s.namespace.name": r["kubernetes.namespace"],
  }));
}

async function fetchHealth(
  lb: string,
  nsFilter: string,
  nsFilterEcs: string,
  errors: string[]
): Promise<HealthRow[]> {
  const summaryQuery = `
FROM metrics-service_summary.1m.otel-*
| WHERE @timestamp > NOW() - ${lb}
  AND service.name IS NOT NULL${nsFilter}
| STATS
    span_count = SUM(service_summary)
  BY service.name
| LIMIT 200
`;

  const txnQuery = `
FROM metrics-service_transaction.1m.otel-*
| WHERE @timestamp > NOW() - ${lb}
  AND service.name IS NOT NULL${nsFilter}
| STATS
    avg_duration_us = AVG(transaction.duration.summary)
  BY service.name
| LIMIT 200
`;

  const [summaryRows, txnRows] = await Promise.all([
    safeEsqlRows<HealthRow>(summaryQuery, errors),
    safeEsqlRows<HealthRow>(txnQuery, errors),
  ]);

  if (summaryRows.length || txnRows.length) {
    const merged = new Map<string, HealthRow>();
    for (const row of summaryRows) {
      const name = row["service.name"];
      if (name) merged.set(name, { "service.name": name, span_count: row.span_count });
    }
    for (const row of txnRows) {
      const name = row["service.name"];
      if (!name) continue;
      const existing = merged.get(name) || { "service.name": name };
      merged.set(name, {
        ...existing,
        avg_duration_us: row.avg_duration_us,
      });
    }
    return [...merged.values()];
  }

  const tracesQuery = `
FROM traces-*.otel-*
| WHERE @timestamp > NOW() - ${lb}
  AND service.name IS NOT NULL${nsFilter}
| EVAL duration_us = duration / 1000
| STATS
    span_count = COUNT(*),
    avg_duration_us = AVG(duration_us),
    p99_duration_us = PERCENTILE(duration_us, 99),
    error_count = COUNT(CASE(status.code == "Error", 1, NULL))
  BY service.name
| LIMIT 200
`;
  const tracesRows = await safeEsqlRows<HealthRow>(tracesQuery, errors);
  if (tracesRows.length) return tracesRows;

  // Tier 3: classic APM agents — traces-apm* with transaction.duration.us and event.outcome.
  // Only queried when both tier-1 metrics and tier-2 OTel traces return nothing, so OTel-native
  // deployments don't pay the extra call.
  const classicQuery = `
FROM traces-apm*
| WHERE @timestamp > NOW() - ${lb}
  AND service.name IS NOT NULL
  AND processor.event == "transaction"${nsFilterEcs}
| STATS
    span_count = COUNT(*),
    avg_duration_us = AVG(transaction.duration.us),
    error_count = COUNT(CASE(event.outcome == "failure", 1, NULL))
  BY service.name
| LIMIT 200
`;
  return safeEsqlRows<HealthRow>(classicQuery, errors);
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
        "Kubernetes namespace filter (OTel semconv: k8s.namespace.name). Health data comes from pre-aggregated APM " +
        "service metrics when available, otherwise from raw OTel traces. Not useful for log-only or metrics-only customers.",
      inputSchema: {
        service: z.string().optional().describe(
          "Focal service to center the graph on. Returns only its direct upstream (who calls it) and downstream " +
          "(what it calls) neighbors. Matched against service.name — e.g. 'frontend', 'checkoutservice', " +
          "'payment-service'. Omit for the full graph."
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
      const nsFilter = namespace ? `\n  AND k8s.namespace.name == "${namespace}"` : "";
      const nsFilterEcs = namespace ? `\n  AND kubernetes.namespace == "${namespace}"` : "";

      const edgesQuery = `
FROM metrics-service_destination.1m.otel-*
| WHERE @timestamp > NOW() - ${lb}
  AND service.name IS NOT NULL
  AND (span.destination.service.resource IS NOT NULL OR service.target.name IS NOT NULL)${nsFilter}
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
  AND @timestamp > NOW() - ${lb}${nsFilter}
| STATS
    trace_count = COUNT(*)
  BY service.name, service.language.name, k8s.deployment.name, k8s.namespace.name
| SORT trace_count DESC
| LIMIT 100
`;

      const queryErrors: string[] = [];
      const [edgeRows, healthRows, metadataRows, targetResolution] = await Promise.all([
        safeEsqlRows<EdgeRow>(edgesQuery, queryErrors),
        includeHealth ? fetchHealth(lb, nsFilter, nsFilterEcs, queryErrors) : Promise.resolve([]),
        fetchMetadata(lb, nsFilterEcs, metadataQuery, queryErrors),
        fetchTargetResolution(lb, nsFilter, queryErrors),
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
        result.upstream = edges.filter((e) => e.target === service).map((e) => e.source);
        result.downstream = edges.filter((e) => e.source === service).map((e) => e.target);
      }

      result.filters = namespace ? { lookback: lb, namespace } : { lookback: lb };

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

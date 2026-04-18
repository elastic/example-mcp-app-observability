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

async function fetchHealth(
  lb: string,
  nsFilter: string,
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
  return safeEsqlRows<HealthRow>(tracesQuery, errors);
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
        includeHealth ? fetchHealth(lb, nsFilter, queryErrors) : Promise.resolve([]),
        safeEsqlRows<MetadataRow>(metadataQuery, queryErrors),
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

      let edges: Record<string, unknown>[] = [];
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

        const resolved = targetResolution.get(target);
        if (resolved) target = resolved;

        const edge: Record<string, unknown> = {
          source,
          target,
          call_count: row.total_count || 0,
        };
        if (protocol) edge.protocol = protocol;
        if (port) edge.port = port;
        if (row.total_duration_us && row.total_count && row.total_count > 0) {
          edge.avg_latency_us = Math.round((row.total_duration_us / row.total_count) * 10) / 10;
        }
        edges.push(edge);
        servicesSeen.add(source);
        servicesSeen.add(target);
      }

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

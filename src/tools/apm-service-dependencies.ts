/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { executeEsql, rowsFromEsql } from "../elastic/esql.js";

interface EdgeRow {
  "service.name"?: string;
  "span.destination.service.resource"?: string;
  call_count?: number;
  total_duration_us?: number;
  total_count?: number;
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
  "kubernetes.deployment.name"?: string;
  "kubernetes.namespace"?: string;
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

async function runEsql<T>(query: string): Promise<T[]> {
  try {
    const res = await executeEsql(query);
    return rowsFromEsql<T>(res);
  } catch {
    return [];
  }
}

export function registerApmServiceDependenciesTool(server: McpServer) {
  registerAppTool(
    server,
    "apm-service-dependencies",
    {
      title: "APM Service Dependencies",
      description:
        "Requires: Elastic APM (OTel-instrumented services producing span.destination.service.resource). " +
        "Returns the service dependency graph from APM telemetry — which services call which, over what protocols, " +
        "with call volume and latency. Use when the user asks 'what calls X', 'what depends on X', 'show me the " +
        "topology', or is doing root-cause investigation and needs to know upstream/downstream neighbors. Optional " +
        "Kubernetes namespace filter if services are k8s-deployed. Not useful for log-only or metrics-only customers.",
      inputSchema: {
        service: z.string().optional().describe(
          "Focal service to center the graph on. Returns only its direct upstream (who calls it) and downstream " +
          "(what it calls) neighbors. Matched against service.name — e.g. 'frontend', 'checkoutservice', " +
          "'payment-service'. Omit for the full graph."
        ),
        namespace: z.string().optional().describe(
          "Kubernetes namespace to scope the query, e.g. 'otel-demo', 'prod'. Only applicable if services are " +
          "deployed in Kubernetes and the namespace attribute is being captured. Omit for non-K8s or cross-namespace."
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
      _meta: { ui: {} },
    },
    async ({ service, namespace, lookback, include_health }) => {
      const lb = lookback || "1h";
      const includeHealth = include_health !== false;
      const nsFilter = namespace ? `\n    | WHERE kubernetes.namespace == "${namespace}"` : "";
      const nsFilterTrace = namespace ? `\n      AND kubernetes.namespace == "${namespace}"` : "";

      const edgesQuery = `
FROM metrics-service_destination.1m.otel-*
| WHERE @timestamp > NOW() - ${lb}${nsFilter}
| STATS
    call_count = COUNT(*),
    total_duration_us = SUM(span.destination.service.response_time.sum.us),
    total_count = SUM(span.destination.service.response_time.count)
  BY service.name, span.destination.service.resource
| WHERE service.name IS NOT NULL
  AND span.destination.service.resource IS NOT NULL
| SORT call_count DESC
| LIMIT 200
`;

      const healthQuery = `
FROM traces-generic.otel-*
| WHERE service.name IS NOT NULL
  AND @timestamp > NOW() - ${lb}${nsFilterTrace}
| STATS
    span_count = COUNT(*),
    avg_duration_us = AVG(span.duration.us),
    p99_duration_us = PERCENTILE(span.duration.us, 99),
    error_count = COUNT_DISTINCT(CASE(span.status.code == "Error", span.name, NULL))
  BY service.name
| SORT span_count DESC
| LIMIT 100
`;

      const metadataQuery = `
FROM traces-generic.otel-*
| WHERE service.name IS NOT NULL
  AND @timestamp > NOW() - ${lb}${nsFilterTrace}
| STATS
    trace_count = COUNT(*)
  BY service.name, service.language.name, kubernetes.deployment.name, kubernetes.namespace
| SORT trace_count DESC
| LIMIT 100
`;

      const [edgeRows, healthRows, metadataRows] = await Promise.all([
        runEsql<EdgeRow>(edgesQuery),
        includeHealth ? runEsql<HealthRow>(healthQuery) : Promise.resolve([]),
        runEsql<MetadataRow>(metadataQuery),
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
                  `(traces-apm*, traces-generic.otel-*) with span.destination.service.resource populated. ` +
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
        const destResource = row["span.destination.service.resource"];
        if (!source || !destResource) continue;
        const parsed = parseDestination(destResource);
        const target = parsed.target_service;
        const edge: Record<string, unknown> = {
          source,
          target,
          call_count: row.call_count || 0,
        };
        if (parsed.protocol) edge.protocol = parsed.protocol;
        if (parsed.port) edge.port = parsed.port;
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
          if (row["kubernetes.deployment.name"]) meta.deployment = row["kubernetes.deployment.name"];
          if (row["kubernetes.namespace"]) meta.namespace = row["kubernetes.namespace"];
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
          const health: Record<string, unknown> = {
            span_count: h.span_count || 0,
            avg_duration_us: Math.round((h.avg_duration_us || 0) * 10) / 10,
          };
          if (h.p99_duration_us) health.p99_duration_us = Math.round(h.p99_duration_us * 10) / 10;
          if (h.error_count) health.error_count = h.error_count;
          node.health = health;
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

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );
}

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

const RESOURCE_URI = "ui://k8s-blast-radius/mcp-app.html";

function fmtBytes(b: number | null | undefined): string {
  if (!b) return "—";
  const gb = b / 1_073_741_824;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(b / 1_048_576).toFixed(0)} MB`;
}


interface PodRow {
  deployment?: string | null;
  namespace?: string | null;
  replica_count?: number | null;
  memory_bytes?: number | null;
}

interface TotalRow {
  deployment?: string | null;
  namespace?: string | null;
  total_replicas?: number | null;
  total_memory_bytes?: number | null;
}

interface CapacityRow {
  total_available_memory_bytes?: number | null;
  remaining_node_count?: number | null;
}

interface ApmRow {
  "service.name"?: string | null;
  "k8s.namespace.name"?: string | null;
  "k8s.deployment.name"?: string | null;
}

interface ApmClassicRow {
  "service.name"?: string | null;
  "kubernetes.namespace"?: string | null;
  "kubernetes.deployment.name"?: string | null;
}

export function registerK8sBlastRadiusTool(server: McpServer) {
  registerAppTool(
    server,
    "k8s-blast-radius",
    {
      title: "Kubernetes Blast Radius",
      description:
        "Requires: Kubernetes (kubeletstats receiver metrics). Optional: Elastic APM for downstream user-facing " +
        "service impact. Shows the impact of a Kubernetes node going offline — which deployments lose all replicas " +
        "(full outage), which lose partial capacity (degraded), which are unaffected, and whether the cluster has " +
        "enough spare capacity to reschedule. Core output (pod impact + rescheduling feasibility) works from K8s " +
        "metrics alone; if APM data is present, the response adds a downstream_services section naming user-facing " +
        "services in affected namespaces. Use when the user asks about the impact of draining a node, a maintenance " +
        "window, or 'what happens if this node goes away'. Renders an inline radial diagram — center = the node, " +
        "ring 1 = affected deployments (red=full outage, amber=degraded), ring 2 = downstream namespaces.",
      inputSchema: {
        node: z.string().describe(
          "Kubernetes node name to analyze. Matched exactly against k8s.node.name (OTel semconv) — e.g. " +
          "'gke-prod-pool-1-abc123', 'ip-10-0-1-42.ec2.internal'. If the user describes a node ambiguously " +
          "('the noisy node', 'the one running frontend'), confirm the exact node name before calling."
        ),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ node }) => {
      // Memory queries use a two-level STATS: first collapse each pod / node's
      // time samples to a MAX (peak need over the window), then SUM across
      // pods / nodes. MAX rather than AVG because:
      //   1. Capacity planning should budget for peak, not average.
      //   2. AVG on `aggregate_metric_double`-typed fields (how Elastic stores
      //      downsampled OTel gauges) can return sum-of-sums rather than a
      //      proper mean, inflating the number by 1000s of ×. MAX returns the
      //      max-of-maxes — a tight upper bound regardless of storage shape.
      // A 10-minute time bound keeps the window tight enough that MAX reflects
      // current state rather than stale peaks.
      const podsQuery = `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE @timestamp > NOW() - 10 minutes
  AND k8s.node.name == "${node}"
  AND k8s.pod.name IS NOT NULL
  AND metrics.k8s.pod.memory.working_set IS NOT NULL
| STATS
    pod_memory_bytes = MAX(metrics.k8s.pod.memory.working_set)
  BY k8s.pod.name, deployment = k8s.deployment.name, namespace = k8s.namespace.name
| STATS
    replica_count = COUNT(k8s.pod.name),
    memory_bytes = SUM(pod_memory_bytes)
  BY deployment, namespace
| WHERE deployment IS NOT NULL
| SORT replica_count DESC`;

      const totalsQuery = `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE @timestamp > NOW() - 10 minutes
  AND k8s.pod.name IS NOT NULL
  AND metrics.k8s.pod.memory.working_set IS NOT NULL
| STATS
    pod_memory_bytes = MAX(metrics.k8s.pod.memory.working_set)
  BY k8s.pod.name, deployment = k8s.deployment.name, namespace = k8s.namespace.name
| STATS
    total_replicas = COUNT(k8s.pod.name),
    total_memory_bytes = SUM(pod_memory_bytes)
  BY deployment, namespace
| WHERE deployment IS NOT NULL
| SORT total_replicas DESC`;

      const capacityQuery = `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE @timestamp > NOW() - 10 minutes
  AND k8s.node.name IS NOT NULL
  AND k8s.node.name != "${node}"
  AND metrics.k8s.node.memory.available IS NOT NULL
| STATS
    node_memory_bytes = MAX(metrics.k8s.node.memory.available)
  BY k8s.node.name
| STATS
    total_available_memory_bytes = SUM(node_memory_bytes),
    remaining_node_count = COUNT(k8s.node.name)`;

      const apmQuery = `FROM traces-*.otel-*
| WHERE @timestamp > NOW() - 1h
  AND k8s.namespace.name IS NOT NULL
| STATS service_count = COUNT(*)
    BY service.name, k8s.namespace.name, k8s.deployment.name
| WHERE k8s.deployment.name IS NOT NULL
| SORT service_count DESC
| LIMIT 200`;

      // Classic APM fallback (traces-apm* + kubernetes.* fields). Only consulted if the OTel APM
      // query returns nothing, so OTel-native customers don't pay the extra call.
      const apmClassicQuery = `FROM traces-apm*
| WHERE @timestamp > NOW() - 1h
  AND processor.event == "transaction"
  AND kubernetes.namespace IS NOT NULL
| STATS service_count = COUNT(*)
    BY service.name, kubernetes.namespace, kubernetes.deployment.name
| WHERE kubernetes.deployment.name IS NOT NULL
| SORT service_count DESC
| LIMIT 200`;

      const queryErrors: string[] = [];
      const [podsOnNode, totalReplicas, clusterCapacity, apmServicesOtel] = await Promise.all([
        safeEsqlRows<PodRow>(podsQuery, queryErrors),
        safeEsqlRows<TotalRow>(totalsQuery, queryErrors),
        safeEsqlRows<CapacityRow>(capacityQuery, queryErrors),
        safeEsqlRows<ApmRow>(apmQuery, queryErrors),
      ]);

      let apmServices: ApmRow[] = apmServicesOtel;
      if (!apmServicesOtel.length) {
        const classicRows = await safeEsqlRows<ApmClassicRow>(apmClassicQuery, queryErrors);
        apmServices = classicRows.map((r) => ({
          "service.name": r["service.name"],
          "k8s.namespace.name": r["kubernetes.namespace"],
          "k8s.deployment.name": r["kubernetes.deployment.name"],
        }));
      }

      if (!podsOnNode.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                node,
                summary: { full_outage: [], degraded: [], unaffected: [] },
                message: `No pods found on node '${node}' in the last 10 minutes. Node may be healthy or metrics not yet ingested.`,
              }),
            },
          ],
        };
      }

      const totalsMap = new Map<string, TotalRow>();
      for (const r of totalReplicas) {
        totalsMap.set(`${r.deployment || ""}|${r.namespace || ""}`, r);
      }

      const fullOutage: Record<string, unknown>[] = [];
      const degraded: Record<string, unknown>[] = [];
      const affectedNs = new Set<string>();
      let totalMemoryAtRisk = 0;

      for (const pod of podsOnNode) {
        const dep = pod.deployment || "";
        const ns = pod.namespace || "";
        const onNode = pod.replica_count || 0;
        const mem = pod.memory_bytes || 0;
        const total = totalsMap.get(`${dep}|${ns}`)?.total_replicas ?? onNode;
        const surviving = total - onNode;

        const entry = {
          deployment: dep,
          namespace: ns,
          pods_on_node: onNode,
          pods_total: total,
          surviving,
          memory: fmtBytes(mem),
          memory_bytes: mem,
        };
        totalMemoryAtRisk += mem;
        if (surviving <= 0) fullOutage.push(entry);
        else degraded.push(entry);
        affectedNs.add(ns);
      }

      const onNodeKeys = new Set(
        podsOnNode.map((p) => `${p.deployment || ""}|${p.namespace || ""}`)
      );
      const unaffected = totalReplicas
        .filter((r) => !onNodeKeys.has(`${r.deployment || ""}|${r.namespace || ""}`))
        .map((r) => ({
          deployment: r.deployment,
          namespace: r.namespace,
          pods_total: r.total_replicas || 0,
        }));

      const cap = clusterCapacity[0] || {};
      const availBytes = cap.total_available_memory_bytes || 0;
      const remainingNodes = cap.remaining_node_count || 0;
      const feasible = availBytes ? availBytes >= totalMemoryAtRisk : null;

      const rescheduling = {
        memory_required: fmtBytes(totalMemoryAtRisk),
        memory_available: fmtBytes(availBytes),
        remaining_nodes: remainingNodes,
        feasible,
      };

      const downstream = apmServices
        .filter((r) => r["k8s.namespace.name"] && affectedNs.has(r["k8s.namespace.name"]!))
        .map((r) => ({
          service: r["service.name"],
          namespace: r["k8s.namespace.name"],
        }));

      let status: string;
      if (fullOutage.length) status = "AT RISK";
      else if (degraded.length) status = "PARTIAL RISK";
      else status = "SAFE";

      const apmPresent = apmServices.length > 0;

      const result: Record<string, unknown> = {
        node,
        status,
        data_coverage: { kubernetes: true, apm: apmPresent },
        pods_at_risk: podsOnNode.reduce((sum, p) => sum + (p.replica_count || 0), 0),
        full_outage: fullOutage,
        degraded,
        unaffected_count: unaffected.length,
        unaffected: unaffected.slice(0, 10),
        rescheduling,
      };

      if (apmPresent) {
        result.downstream_services = downstream;
      } else {
        result.downstream_services_note =
          "No APM telemetry found (traces-*.otel-*). Node-level impact is reported from kubeletstats; " +
          "downstream user-facing service impact cannot be inferred without APM.";
      }

      const actions: { label: string; prompt: string }[] = [];
      const spof = fullOutage.find((d: any) => d.pods_total === 1);
      if (spof) {
        actions.push({
          label: `Investigate SPOF: ${spof.deployment}`,
          prompt: `Use ml-anomalies with entity "${spof.deployment}" and lookback "1h" to check for anomalies on this single-replica deployment.`,
        });
      }
      const topFull = fullOutage[0] as any;
      if (topFull && (!spof || topFull.deployment !== spof.deployment)) {
        actions.push({
          label: `Check ${topFull.deployment} health`,
          prompt: `Use ml-anomalies with entity "${topFull.deployment}" and lookback "1h" to see if this deployment is already struggling.`,
        });
      }
      if (feasible === false) {
        actions.push({
          label: "Create capacity alert",
          prompt: `Use create-alert-rule to watch cluster memory headroom. Rule name "Cluster headroom below rescheduling need", metric field "k8s.node.memory.available", threshold ${totalMemoryAtRisk}, comparator "<".`,
        });
      }
      // Only recommend apm-health-summary when we've proven APM telemetry is actually present
      // for this cluster — otherwise the follow-up returns an empty rollup and the user
      // backtracks. Same scope principle: recommended tools must have a data-requirements
      // subset of what this call already proved.
      if (apmPresent) {
        actions.push({
          label: "Cluster health rollup",
          prompt: "Use apm-health-summary to see overall namespace health and correlate with this blast radius.",
        });
      }
      result.investigation_actions = actions;
      if (queryErrors.length) result._query_errors = queryErrors;

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  const viewPath = resolveViewPath("k8s-blast-radius");
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

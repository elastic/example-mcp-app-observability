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

const RENDER_SUMMARY =
  "Render as a self-contained HTML artifact. " +
  "Frame as hypothetical: 'If [node name] goes offline...' " +
  "LAYOUT — compact, summary-first, NOT a long list: " +
  "1) Hero banner: node name (truncated middle with '...'), status badge (red/amber/green), big number 'N deployments lose pods'. " +
  "2) Severity bar: horizontal stacked bar showing red/amber/green proportions with counts. " +
  "3) Three COLLAPSIBLE sections (ALL COLLAPSED by default, click header to expand): " +
  "   - 'Full Outage (N)' — red accent. When expanded, show deployments as compact pills/chips (name + namespace + 'N/N pods'), NOT full cards. Wrap in a flex grid. " +
  "   - 'Degraded (N)' — amber accent. Same pill layout. " +
  "   - 'Unaffected (N)' — green accent, muted. Show count only; expand shows first 10 names. " +
  "4) Rescheduling footer: single line — 'X GB required / Y GB available across N nodes' with green checkmark or red X. " +
  "5) Downstream services panel (only if data present): compact pill list. " +
  "Dark bg #0f172a, card bg #1e293b, text #f1f5f9 / #94a3b8. " +
  "No external dependencies. Keep the entire visualization under ~600px tall when collapsed.";

const RENDER_RADIAL =
  "Render as a self-contained HTML artifact — a RADIAL blast-radius diagram. " +
  "Frame as hypothetical: 'If node X goes offline...' " +
  "Center: the node (circle, labeled). " +
  "Inner ring (red #ef4444): full_outage deployments — each a dot/circle sized by pods_total, labeled. " +
  "Middle ring (amber #f59e0b): degraded deployments. " +
  "Outer ring (green #22c55e, faded): unaffected deployments (show only first 10, with '+N more' label). " +
  "Draw lines from center to each affected deployment. " +
  "Top-right: summary box — status badge, pods at risk, rescheduling feasibility. " +
  "If downstream_services present, show them as small diamonds connected to their parent deployment. " +
  "Use SVG for the diagram. Dark bg #0f172a, text #f1f5f9 / #94a3b8. " +
  "No external dependencies. Tooltip on hover showing deployment details. " +
  "The visual should immediately communicate impact through spatial proximity to center = severity.";

function fmtBytes(b: number | null | undefined): string {
  if (!b) return "—";
  const gb = b / 1_073_741_824;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(b / 1_048_576).toFixed(0)} MB`;
}

async function runEsql<T>(query: string): Promise<T[]> {
  try {
    const res = await executeEsql(query);
    return rowsFromEsql<T>(res);
  } catch {
    return [];
  }
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
        "window, or 'what happens if this node goes away'. Includes render instructions for an inline HTML visualization.",
      inputSchema: {
        node: z.string().describe(
          "Kubernetes node name to analyze. Matched exactly against kubernetes.node.name — e.g. " +
          "'gke-prod-pool-1-abc123', 'ip-10-0-1-42.ec2.internal'. If the user describes a node ambiguously " +
          "('the noisy node', 'the one running frontend'), confirm the exact node name before calling."
        ),
        layout: z.enum(["summary", "radial"]).optional().describe(
          "Visualization layout. 'summary' (default) renders a compact severity-grouped view; " +
          "'radial' renders a concentric-ring diagram where proximity-to-center encodes severity."
        ),
      },
      _meta: { ui: {} },
    },
    async ({ node, layout }) => {
      const podsQuery = `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE kubernetes.node.name == "${node}"
  AND kubernetes.pod.name IS NOT NULL
  AND metrics.k8s.pod.memory.working_set IS NOT NULL
| STATS
    replica_count = COUNT_DISTINCT(kubernetes.pod.name),
    memory_bytes = SUM(metrics.k8s.pod.memory.working_set)
  BY deployment = kubernetes.deployment.name, namespace = kubernetes.namespace
| WHERE deployment IS NOT NULL
| SORT replica_count DESC`;

      const totalsQuery = `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE kubernetes.pod.name IS NOT NULL
  AND metrics.k8s.pod.memory.working_set IS NOT NULL
| STATS
    total_replicas = COUNT_DISTINCT(kubernetes.pod.name),
    total_memory_bytes = SUM(metrics.k8s.pod.memory.working_set)
  BY deployment = kubernetes.deployment.name, namespace = kubernetes.namespace
| WHERE deployment IS NOT NULL
| SORT total_replicas DESC`;

      const capacityQuery = `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE kubernetes.node.name IS NOT NULL
  AND kubernetes.node.name != "${node}"
  AND metrics.k8s.node.memory.available IS NOT NULL
| STATS
    available_memory_bytes = SUM(metrics.k8s.node.memory.available),
    node_count = COUNT_DISTINCT(kubernetes.node.name)
  BY kubernetes.node.name
| STATS
    total_available_memory_bytes = SUM(available_memory_bytes),
    remaining_node_count = COUNT(kubernetes.node.name)`;

      const apmQuery = `FROM traces-apm*
| WHERE kubernetes.namespace IS NOT NULL
| STATS service_count = COUNT(*)
    BY service.name, kubernetes.namespace, kubernetes.deployment.name
| WHERE kubernetes.deployment.name IS NOT NULL
| SORT service_count DESC
| LIMIT 50`;

      const [podsOnNode, totalReplicas, clusterCapacity, apmServices] = await Promise.all([
        runEsql<PodRow>(podsQuery),
        runEsql<TotalRow>(totalsQuery),
        runEsql<CapacityRow>(capacityQuery),
        runEsql<ApmRow>(apmQuery),
      ]);

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
        .filter((r) => r["kubernetes.namespace"] && affectedNs.has(r["kubernetes.namespace"]!))
        .map((r) => ({
          service: r["service.name"],
          namespace: r["kubernetes.namespace"],
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
        render_instructions: layout === "radial" ? RENDER_RADIAL : RENDER_SUMMARY,
      };

      if (apmPresent) {
        result.downstream_services = downstream;
      } else {
        result.downstream_services_note =
          "No APM telemetry found (traces-apm*). Node-level impact is reported from kubeletstats; " +
          "downstream user-facing service impact cannot be inferred without APM.";
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );
}

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
import {
  mlAnomalyIndicesExist,
  queryAnomalies,
  type AnomalyQueryResult,
} from "../elastic/ml.js";
import { resolveViewPath } from "./view-path.js";

const RESOURCE_URI = "ui://anomaly-explainer/mcp-app.html";

type InvestigationAction = { label: string; prompt: string };

interface Enriched extends AnomalyQueryResult {
  investigation_actions?: InvestigationAction[];
  detail?: Record<string, unknown>;
  time_series_title?: string;
}

function detectUnit(jobId: string, fieldName?: string): "bytes" | "ms" | "pct" | "raw" {
  const s = `${jobId} ${fieldName || ""}`.toLowerCase();
  if (s.includes("memory") || s.includes("bytes") || s.includes("working_set")) return "bytes";
  if (s.includes("latency") || s.includes("duration")) return "ms";
  if (s.includes("cpu") || s.includes("utilization") || s.includes("pct")) return "pct";
  return "raw";
}

function enrichForView(
  result: AnomalyQueryResult,
  filters: { entity?: string; jobId?: string; lookback?: string }
): Enriched {
  const anomalies = result.anomalies || [];
  const enriched: Enriched = { ...result };

  // Build investigation actions based on what came back
  const actions: InvestigationAction[] = [];
  const top = anomalies[0];

  if (top) {
    const entityName =
      top.entity?.split("=").pop() ||
      Object.values(top.influencers || {}).flat()[0];

    const affectedServices = new Set<string>();
    for (const a of anomalies) {
      for (const [field, values] of Object.entries(a.influencers || {})) {
        const lower = field.toLowerCase();
        if (lower.includes("service") || lower.includes("pod") || lower.includes("deployment")) {
          for (const v of values) affectedServices.add(v);
        }
      }
    }
    const firstService = [...affectedServices][0];

    if (firstService) {
      actions.push({
        label: "Service dependencies",
        prompt: `Use apm-service-dependencies to show upstream/downstream for ${firstService}.`,
      });
    }
    if (entityName) {
      actions.push({
        label: "Blast radius",
        prompt: `Use k8s-blast-radius to assess impact if the node hosting ${entityName} fails.`,
      });
    }
    actions.push({
      label: "Broaden anomaly search",
      prompt: `Re-run ml-anomalies with min_score 50 and lookback 6h to find related anomalies.`,
    });

    if (top.fieldName && typeof firstNum(top.actual) === "number") {
      const actualVal = firstNum(top.actual)!;
      actions.push({
        label: "Create alert rule",
        prompt: `Use create-alert-rule to create a rule watching ${top.fieldName} > ${Math.round(actualVal * 0.9)} for the affected entity.`,
      });
    }
  }

  if (actions.length) enriched.investigation_actions = actions;

  // Detail metadata — helps the view render contextual labels
  if (top) {
    const unit = detectUnit(top.jobId, top.fieldName);
    const namespaceInfluencer =
      top.influencers?.["resource.attributes.k8s.namespace.name"]?.[0] ||
      top.influencers?.["kubernetes.namespace"]?.[0];
    const entityLabel =
      top.entity?.split("=").pop() ||
      Object.values(top.influencers || {}).flat()[0];

    enriched.detail = {
      entity_label: entityLabel,
      namespace: namespaceInfluencer,
      actual_label: unit === "bytes" ? "Actual memory" : unit === "ms" ? "Actual latency" : unit === "pct" ? "Actual utilization" : "Actual",
      typical_label: unit === "bytes" ? "Typical memory" : unit === "ms" ? "Typical latency" : unit === "pct" ? "Typical utilization" : "Typical",
      actual_sub: top.fieldName?.split(".").pop(),
      typical_sub: "learned baseline",
      unit_format: unit,
    };

    if (top.fieldName) {
      const readableField = top.fieldName.split(".").slice(-2).join(".");
      enriched.time_series_title = `${readableField} — actual vs typical`;
    }
  }

  return enriched;
}

function firstNum(v: number | number[] | undefined): number | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

export function registerMlAnomaliesTool(server: McpServer) {
  registerAppTool(
    server,
    "ml-anomalies",
    {
      title: "ML Anomalies",
      description:
        "Requires: Elastic ML anomaly detection jobs configured and running. Returns pre-computed anomaly findings " +
        "from those jobs — which entities are behaving anomalously, severity scores (0-100), actual vs typical values, " +
        "and the baseline the anomaly was scored against. Use when the user asks 'what's anomalous', 'why is X slow', " +
        "'is anything unusual happening', or for memory growth, restart patterns, CPU spikes, or network I/O anomalies. " +
        "Renders an anomaly-explainer app inline with a severity gauge, plain-English explanation, and per-entity " +
        "deviation breakdown. Backend-agnostic — works against any ML jobs (K8s, APM, custom).",
      inputSchema: {
        job_id: z.string().optional().describe(
          "ML job ID to filter — e.g. 'k8s-memory-usage', 'apm-latency-by-service'. Omit to search across all jobs. " +
          "Use when the user names a specific job or signal domain ('memory anomalies', 'latency anomalies')."
        ),
        min_score: z.number().optional().describe(
          "Minimum anomaly score 0-100. Default 50. Guidance: 50-74 minor (worth noting), 75-89 major (investigate), " +
          "90+ critical (likely real issue). Raise the floor to cut noise; lower it to cast a wider net."
        ),
        entity: z.string().optional().describe(
          "Influencer value — typically a pod name, deployment, service name, or host. Matched against all influencer " +
          "fields. Derived from the user's request — e.g. 'frontend', 'checkout-76fd4', 'node-gke-pool-1'. Omit for " +
          "a cluster-wide scan."
        ),
        lookback: z.string().optional().describe(
          "How far back to search. Default '24h'. Examples: '1h' (acute), '6h' (shift), '24h' (day-over-day), " +
          "'7d' (weekly trend)."
        ),
        limit: z.number().optional().describe(
          "Max anomalies to return. Default 25. Raise for a full audit; lower for 'show me the worst offender'."
        ),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ job_id, min_score, entity, lookback, limit }) => {
      if (!(await mlAnomalyIndicesExist())) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                anomalies: [],
                total: 0,
                hint: "No ML anomaly indices found. Configure anomaly detection jobs in Kibana ML for metrics like k8s.pod.memory.working_set, k8s.pod.cpu.utilization, or kubernetes.container.restarts.",
              }),
            },
          ],
        };
      }

      const result = await queryAnomalies({
        jobId: job_id,
        minScore: min_score,
        entity,
        lookback,
        limit,
      });

      const enriched = enrichForView(result, { entity, jobId: job_id, lookback });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(enriched) }],
      };
    }
  );

  const viewPath = resolveViewPath("anomaly-explainer");
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

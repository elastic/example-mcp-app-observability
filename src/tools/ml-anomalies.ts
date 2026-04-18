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
import { esRequest } from "../elastic/client.js";
import { resolveViewPath } from "./view-path.js";

const RESOURCE_URI = "ui://anomaly-explainer/mcp-app.html";

type InvestigationAction = { label: string; prompt: string };

interface TimePoint {
  timestamp: number;
  value: number;
  typical?: number;
}

interface Enriched extends AnomalyQueryResult {
  investigation_actions?: InvestigationAction[];
  detail?: Record<string, unknown>;
  time_series_title?: string;
  time_series?: TimePoint[];
  rerun_context?: {
    tool: string;
    current_lookback: string;
    prompt_template: string;
  };
}

interface ModelPlotHit {
  _source: {
    timestamp?: number;
    actual?: number | number[];
    model_median?: number;
  };
}

async function fetchModelPlot(
  top: AnomalyQueryResult["anomalies"][number] & {
    jobId: string;
    byFieldValue?: string;
    partitionFieldValue?: string;
    overFieldValue?: string;
  },
  lookback: string
): Promise<TimePoint[]> {
  // Extend lookback so the chart has enough buckets even when the user asked for a short window.
  const extended = /^\d+m$/.test(lookback) ? "3h" : lookback;
  const must: unknown[] = [
    { term: { result_type: "model_plot" } },
    { term: { job_id: top.jobId } },
    { range: { timestamp: { gte: `now-${extended}` } } },
  ];
  if (top.byFieldValue) must.push({ term: { by_field_value: top.byFieldValue } });
  if (top.partitionFieldValue)
    must.push({ term: { partition_field_value: top.partitionFieldValue } });
  if (top.overFieldValue) must.push({ term: { over_field_value: top.overFieldValue } });

  const body = {
    size: 500,
    sort: [{ timestamp: { order: "asc" } }],
    query: { bool: { must } },
    _source: ["timestamp", "actual", "model_median"],
  };

  try {
    const resp = await esRequest<{ hits: { hits: ModelPlotHit[] } }>(
      "/.ml-anomalies-*/_search",
      { body }
    );
    return resp.hits.hits
      .map((h) => {
        const s = h._source;
        const actual = Array.isArray(s.actual) ? s.actual[0] : s.actual;
        if (actual == null || s.timestamp == null) return null;
        return {
          timestamp: s.timestamp,
          value: actual,
          typical: s.model_median,
        } as TimePoint;
      })
      .filter((p): p is TimePoint => p !== null);
  } catch {
    return [];
  }
}

function detectUnit(jobId: string, fieldName?: string): "bytes" | "ms" | "pct" | "raw" {
  const s = `${jobId} ${fieldName || ""}`.toLowerCase();
  if (s.includes("memory") || s.includes("bytes") || s.includes("working_set")) return "bytes";
  if (s.includes("latency") || s.includes("duration")) return "ms";
  if (s.includes("cpu") || s.includes("utilization") || s.includes("pct")) return "pct";
  return "raw";
}

async function enrichForView(
  result: AnomalyQueryResult,
  filters: { entity?: string; jobId?: string; lookback?: string }
): Promise<Enriched> {
  const anomalies = result.anomalies || [];
  const enriched: Enriched = { ...result };

  // Build investigation actions based on what came back
  const actions: InvestigationAction[] = [];
  const top = anomalies[0];

  if (top) {
    const entityName =
      top.entity?.split("=").pop() ||
      Object.values(top.influencers || {}).flat()[0];

    // Scope service-dependency recommendation to service.name influencers only — pod /
    // deployment / node are K8s entities, not APM services, and don't resolve in the APM graph.
    const apmServices = new Set<string>();
    for (const a of anomalies) {
      for (const [field, values] of Object.entries(a.influencers || {})) {
        const lower = field.toLowerCase();
        if (lower.includes("service.name") || lower === "service" || lower.endsWith(".service")) {
          for (const v of values) apmServices.add(v);
        }
      }
    }
    const firstService = [...apmServices][0];

    if (firstService) {
      actions.push({
        label: "Service dependencies",
        prompt: `Use apm-service-dependencies to show upstream/downstream for ${firstService}.`,
      });
    }

    // Note: do NOT suggest k8s-blast-radius unconditionally. ML anomaly jobs can run on any
    // backend (APM, logs, metrics) — finding an influencer value doesn't prove kubeletstats
    // pod/node metrics are available. Recommendations must stay within the data shape already
    // proven by this call.
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
      top.influencers?.["k8s.namespace.name"]?.[0] ||
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

    // Fetch model_plot time series when the view is likely to render in detail mode:
    // explicit entity/job filter, a single returned anomaly, or the top anomaly is clearly
    // identifiable via by/partition/over field values.
    const uniqueEntities = new Set(
      anomalies.map((a) => a.byFieldValue || a.partitionFieldValue || a.entity)
    );
    const detailLikely =
      !!filters.entity ||
      !!filters.jobId ||
      anomalies.length === 1 ||
      uniqueEntities.size === 1;
    const hasIdentifier =
      !!top.byFieldValue || !!top.partitionFieldValue || !!top.overFieldValue;
    if (detailLikely && hasIdentifier) {
      const ts = await fetchModelPlot(
        top as Parameters<typeof fetchModelPlot>[0],
        filters.lookback || "6h"
      );
      if (ts.length >= 2) enriched.time_series = ts;
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
                hint: "No ML anomaly indices found. Configure anomaly detection jobs in Kibana ML for metrics like k8s.pod.memory.working_set, k8s.pod.cpu.utilization, or k8s.container.restarts.",
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

      const enriched = await enrichForView(result, { entity, jobId: job_id, lookback });

      const effectiveLb = lookback || "24h";
      const rerunParts = ['lookback "{lookback}"'];
      if (entity) rerunParts.push(`entity "${entity}"`);
      if (job_id) rerunParts.push(`job_id "${job_id}"`);
      if (min_score !== undefined) rerunParts.push(`min_score ${min_score}`);
      if (limit !== undefined) rerunParts.push(`limit ${limit}`);
      enriched.rerun_context = {
        tool: "ml-anomalies",
        current_lookback: effectiveLb,
        prompt_template: `Use ml-anomalies with ${rerunParts.join(" and ")}`,
      };

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

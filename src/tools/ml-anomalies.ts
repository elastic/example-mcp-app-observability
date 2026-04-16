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
import { mlAnomalyIndicesExist, queryAnomalies } from "../elastic/ml.js";
import { resolveViewPath } from "./view-path.js";

const RESOURCE_URI = "ui://anomaly-explainer/mcp-app.html";

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

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
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

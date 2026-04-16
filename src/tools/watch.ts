/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { mlAnomalyIndicesExist, queryAnomalies, severityLabel } from "../elastic/ml.js";
import { executeEsql } from "../elastic/esql.js";

type Comparator = "<" | "<=" | ">" | ">=" | "==";

const CONDITION_RE = /^\s*(<=?|>=?|==)\s*([+-]?\d+(?:\.\d+)?)\s*$/;
const NUMERIC_TYPES = new Set([
  "long", "integer", "double", "float",
  "unsigned_long", "half_float", "scaled_float",
]);

function parseCondition(s: string): { comparator: Comparator; threshold: number } | null {
  const m = CONDITION_RE.exec(s);
  if (!m) return null;
  return { comparator: m[1] as Comparator, threshold: parseFloat(m[2]) };
}

function evaluate(value: number, comparator: Comparator, threshold: number): boolean {
  switch (comparator) {
    case "<": return value < threshold;
    case "<=": return value <= threshold;
    case ">": return value > threshold;
    case ">=": return value >= threshold;
    case "==": return value === threshold;
  }
}

async function pollMetric(esql: string): Promise<number | null> {
  let result;
  try {
    result = await executeEsql(esql);
  } catch {
    return null;
  }
  const rows = result.values;
  if (!rows.length || !rows[0].length) return null;

  for (let i = 0; i < result.columns.length; i++) {
    if (NUMERIC_TYPES.has(result.columns[i].type)) {
      const v = rows[0][i];
      const num = typeof v === "number" ? v : parseFloat(String(v));
      if (Number.isFinite(num)) return num;
    }
  }
  const fallback = parseFloat(String(rows[0][0]));
  return Number.isFinite(fallback) ? fallback : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface WatchInput {
  mode?: "anomaly" | "metric";
  min_score?: number;
  interval?: number;
  max_wait?: number;
  namespace?: string;
  lookback?: string;
  esql?: string;
  condition?: string;
  description?: string;
}

async function handleAnomalyMode(args: WatchInput) {
  const minScore = args.min_score ?? 75;
  const interval = args.interval ?? 30;
  const maxWait = args.max_wait ?? 600;
  const namespace = args.namespace;
  const lookback = args.lookback ?? "5m";

  if (!(await mlAnomalyIndicesExist())) {
    return {
      status: "NO_ML_JOBS",
      message: "No ML anomaly indices found. Configure anomaly detection jobs in Kibana ML.",
    };
  }

  let elapsed = 0;
  let polls = 0;

  while (elapsed < maxWait) {
    polls++;
    const res = await queryAnomalies({
      minScore,
      lookback,
      limit: 50,
      entity: namespace,
    });

    if (res.anomalies.length) {
      return buildAlert(res.anomalies, elapsed);
    }

    const remaining = maxWait - elapsed;
    const sleepTime = Math.min(interval, remaining);
    if (sleepTime <= 0) break;
    await sleep(sleepTime * 1000);
    elapsed += sleepTime;
  }

  return {
    status: "QUIET",
    message: `No anomalies above score ${minScore} detected in ${maxWait}s (${polls} polls, lookback ${lookback}).`,
    suggestion: "Try: lower min_score to 50, extend max_wait, or verify ML jobs are running in Kibana → Machine Learning → Anomaly Detection.",
  };
}

function buildAlert(anomalies: Awaited<ReturnType<typeof queryAnomalies>>["anomalies"], elapsed: number) {
  const affectedEntities: string[] = [];
  const affectedServices = new Set<string>();
  const seen = new Set<string>();

  for (const a of anomalies) {
    if (a.entity && !seen.has(a.entity)) {
      affectedEntities.push(a.entity);
      seen.add(a.entity);
    }
    for (const [field, values] of Object.entries(a.influencers || {})) {
      const lower = field.toLowerCase();
      if (lower.includes("service") || lower.includes("pod") || lower.includes("deployment")) {
        for (const v of values) affectedServices.add(v);
      }
    }
  }

  const top = anomalies[0];
  const sev = severityLabel(top.recordScore);
  const headlineParts: string[] = [];
  if (sev === "critical") headlineParts.push("CRITICAL");
  headlineParts.push(`${top.functionName || "anomaly"} on ${top.fieldName || "unknown"}`);
  if (top.entity) headlineParts.push(`(${top.entity})`);
  headlineParts.push(`— score ${top.recordScore}`);
  if (typeof top.deviationPercent === "number") {
    const sign = top.deviationPercent >= 0 ? "+" : "";
    headlineParts.push(`(${sign}${top.deviationPercent.toFixed(0)}% from typical)`);
  }

  const jobs: Record<string, number> = {};
  for (const a of anomalies) jobs[a.jobId] = (jobs[a.jobId] || 0) + 1;

  const hints: { tool: string; reason: string; args: Record<string, unknown> }[] = [];
  const services = [...affectedServices].sort();
  if (services.length) {
    hints.push({
      tool: "apm-service-dependencies",
      reason: `Map upstream/downstream dependencies for ${services.slice(0, 3).join(", ")} (requires APM)`,
      args: { service: services[0] },
    });
  }
  hints.push({
    tool: "ml-anomalies",
    reason: "Drill into full anomaly details with broader lookback",
    args: { min_score: 50, lookback: "1h" },
  });
  if (services.length) {
    hints.push({
      tool: "k8s-blast-radius",
      reason: "Assess K8s node-level impact if a node is implicated (requires Kubernetes)",
      args: {},
    });
  }

  return {
    status: "ALERT",
    headline: headlineParts.join(" "),
    detected_after_seconds: elapsed,
    anomaly_count: anomalies.length,
    top_anomalies: anomalies.slice(0, 10),
    affected_entities: affectedEntities.slice(0, 20),
    affected_services: services,
    jobs_summary: jobs,
    investigation_hints: hints,
    investigation_guidance:
      "Anomalies detected. Recommended investigation sequence: " +
      "1) Check service dependencies to understand the topology around affected services. " +
      "2) Query ML anomalies with a broader lookback and lower threshold to find related signals. " +
      "3) If a node or infrastructure component is involved, assess the blast radius. " +
      "4) Correlate the timeline: did the anomaly start on one service and propagate? " +
      "Narrate your reasoning at each step — explain what you found and what it implies.",
  };
}

async function handleMetricMode(args: WatchInput) {
  const esql = args.esql || "";
  const conditionStr = args.condition || "";
  const interval = args.interval ?? 30;
  const maxWait = args.max_wait ?? 300;
  const description = args.description || "";

  if (!esql) return { error: "Metric mode requires 'esql' parameter with an ES|QL query." };
  if (!conditionStr) return { error: "Metric mode requires 'condition' parameter (e.g. '< 80000000')." };

  const parsed = parseCondition(conditionStr);
  if (!parsed) {
    return {
      error: `Invalid condition '${conditionStr}'. Expected format: '<comparator> <number>' (e.g. '< 80000000', '>= 3').`,
    };
  }

  let elapsed = 0;
  let polls = 0;
  const history: { elapsed_seconds: number; value: number }[] = [];

  while (elapsed < maxWait) {
    polls++;
    const value = await pollMetric(esql);

    if (value !== null) {
      history.push({ elapsed_seconds: elapsed, value });
      if (evaluate(value, parsed.comparator, parsed.threshold)) {
        const desc = description || "watched metric";
        return {
          status: "CONDITION_MET",
          description: desc,
          final_value: value,
          condition: conditionStr,
          detected_after_seconds: elapsed,
          polls,
          trend: history.slice(-10),
          message: `${desc} reached ${value.toFixed(2)} (condition: ${conditionStr}) after ${elapsed}s.`,
        };
      }
    }

    const remaining = maxWait - elapsed;
    const sleepTime = Math.min(interval, remaining);
    if (sleepTime <= 0) break;
    await sleep(sleepTime * 1000);
    elapsed += sleepTime;
  }

  const lastValue = history.length ? history[history.length - 1].value : null;
  const desc = description || "watched metric";
  return {
    status: "TIMEOUT",
    description: desc,
    condition: conditionStr,
    last_value: lastValue,
    polls,
    elapsed_seconds: elapsed,
    trend: history.slice(-10),
    message: `${desc} did not meet condition '${conditionStr}' within ${maxWait}s. Last value: ${lastValue}.`,
  };
}

export function registerWatchTool(server: McpServer) {
  registerAppTool(
    server,
    "watch",
    {
      title: "Watch",
      description:
        "Requires: nothing in metric mode (works on any ES|QL-queryable numeric field); ML anomaly jobs in anomaly mode. " +
        "Actively polls and blocks until a condition is met — the agent's 'wait-and-see' primitive. Two modes:\n\n" +
        "**Anomaly mode** (default): polls ML anomaly detection jobs and fires when a significant anomaly is detected. " +
        "Returns a structured alert with affected entities, severity, and investigation hints. Starting point for " +
        "autonomous incident investigation.\n\n" +
        "**Metric mode** (mode='metric'): polls an ES|QL query and fires when a condition is satisfied " +
        "(e.g. 'value < 80000000'). Use to watch for stabilization after remediation, or for short-lived " +
        "monitoring that doesn't warrant a persistent Kibana alert rule. Unlike `create-alert-rule`, this is " +
        "transient and session-scoped — nothing is persisted to Kibana.",
      inputSchema: {
        mode: z.enum(["anomaly", "metric"]).optional().describe(
          "Watch mode. 'anomaly' (default) polls ML anomaly results — use when the user asks 'tell me when anything " +
          "unusual fires'. 'metric' polls an ES|QL query against a threshold — use when the user names a specific " +
          "metric and condition ('wait until memory drops below 80MB')."
        ),
        min_score: z.number().optional().describe(
          "[Anomaly mode] Minimum anomaly score 0-100 to trigger. Default 75 (major+). Lower to 50 to include " +
          "minor anomalies; raise to 90 for critical-only."
        ),
        interval: z.number().optional().describe(
          "Polling interval in seconds. Default 30. Lower for fast-moving signals, higher to reduce load."
        ),
        max_wait: z.number().optional().describe(
          "Maximum seconds to wait before giving up. Default 600 (anomaly mode), 300 (metric mode). Set generously — " +
          "the tool returns immediately on trigger, so longer waits have no cost unless nothing fires."
        ),
        namespace: z.string().optional().describe(
          "[Anomaly mode] Kubernetes namespace to scope monitoring to — e.g. 'otel-demo'. Only applicable if ML " +
          "jobs capture namespace as an influencer."
        ),
        lookback: z.string().optional().describe(
          "[Anomaly mode] How far back each poll checks. Default '5m'. Keep short so you see fresh anomalies, not " +
          "stale history."
        ),
        esql: z.string().optional().describe(
          "[Metric mode] ES|QL query to poll — first numeric column of first row is evaluated. Construct from context, " +
          "e.g. `FROM metrics-* | WHERE host.name == \"foo\" | STATS v = AVG(system.memory.used.bytes)`. Should " +
          "return a single row with the current value."
        ),
        condition: z.string().optional().describe(
          "[Metric mode] Condition '<comparator> <threshold>'. Examples: '< 80000000' (watch for memory to drop " +
          "below 80MB), '>= 3' (watch for count to reach 3), '> 500' (watch for latency over 500ms)."
        ),
        description: z.string().optional().describe(
          "[Metric mode] Human-readable description of what's being watched — surfaces in the final alert message. " +
          "E.g. 'frontend memory working set', 'checkout p99 latency'."
        ),
      },
      _meta: { ui: {} },
    },
    async (args: WatchInput) => {
      const mode = args.mode || "anomaly";
      const result = mode === "metric"
        ? await handleMetricMode(args)
        : await handleAnomalyMode(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );
}

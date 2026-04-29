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
import { mlAnomalyIndicesExist, queryAnomalies, severityLabel } from "../elastic/ml.js";
import { executeEsql } from "../elastic/esql.js";
import type { EsqlResult } from "../shared/types.js";
import { resolveViewPath } from "./view-path.js";
import { detectSkillGap } from "../setup/skill-check.js";
import { consumeWelcomeNotice } from "../setup/notice.js";

const RESOURCE_URI = "ui://observe/mcp-app.html";

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

interface ObserveInput {
  mode?: "anomaly" | "metric" | "now" | "table";
  min_score?: number;
  interval?: number;
  max_wait?: number;
  namespace?: string;
  lookback?: string;
  esql?: string;
  condition?: string;
  description?: string;
  row_cap?: number;
}

const TABLE_DEFAULT_ROW_CAP = 50;

async function handleTableMode(args: ObserveInput) {
  const esql = args.esql || "";
  const description = args.description || "";
  if (!esql) {
    return {
      status: "ERROR" as const,
      message: "Table mode requires 'esql' parameter with an ES|QL query.",
      evaluated_at_ms: Date.now(),
    };
  }

  const cap = Math.max(1, args.row_cap ?? TABLE_DEFAULT_ROW_CAP);
  let result: EsqlResult;
  try {
    result = await executeEsql(esql);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // When the failure pattern matches something the observe skill
    // specifically teaches (ECS field on OTel index, etc.), enrich the
    // error response with a setup notice the view renders as a banner
    // pointing the user at skill installation.
    const skillGap = detectSkillGap(esql, msg);
    return {
      status: "ERROR" as const,
      description: description || undefined,
      message: `ES|QL query failed: ${msg}`,
      evaluated_at_ms: Date.now(),
      ...(skillGap ? { _setup_notice: skillGap } : {}),
    };
  }

  const columns = result.columns.map((c) => ({ name: c.name, type: c.type }));
  const totalRows = result.values.length;
  const truncated = totalRows > cap;
  const rows = truncated ? result.values.slice(0, cap) : result.values;
  const desc = description || "ES|QL table";

  return {
    status: "TABLE" as const,
    description: desc,
    columns,
    rows,
    row_count: totalRows,
    truncated,
    row_cap: cap,
    evaluated_at_ms: Date.now(),
    message: truncated
      ? `${desc}: ${totalRows} row${totalRows === 1 ? "" : "s"} (showing first ${cap}).`
      : `${desc}: ${totalRows} row${totalRows === 1 ? "" : "s"}.`,
  };
}

async function handleNowMode(args: ObserveInput) {
  const esql = args.esql || "";
  const description = args.description || "";
  if (!esql) return { error: "Now mode requires 'esql' parameter with an ES|QL query." };

  const value = await pollMetric(esql);
  const desc = description || "metric";
  return {
    status: "NOW",
    description: desc,
    value,
    evaluated_at_ms: Date.now(),
    message:
      value === null
        ? `${desc}: query returned no numeric value.`
        : `${desc}: ${value}`,
  };
}

async function handleAnomalyMode(args: ObserveInput) {
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
  // Note: do NOT suggest k8s-blast-radius from service-named anomalies. Service influencers
  // prove APM data, not kubeletstats pod/node metrics. Recommendations stay within the
  // data shape the current call has already proven exists.

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

function observeKey(esql: string, condition?: string): string {
  let h = 0;
  const s = `${esql}|${condition || ""}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `w_${Math.abs(h).toString(36)}`;
}

async function handleMetricMode(args: ObserveInput) {
  const esql = args.esql || "";
  const conditionStr = args.condition;
  const interval = args.interval ?? 5;
  const maxWait = args.max_wait ?? 60;
  const description = args.description || "";

  if (!esql) return { error: "Metric mode requires 'esql' parameter with an ES|QL query." };

  const parsed = conditionStr ? parseCondition(conditionStr) : null;
  if (conditionStr && !parsed) {
    return {
      error: `Invalid condition '${conditionStr}'. Expected format: '<comparator> <number>' (e.g. '< 80000000', '>= 3').`,
    };
  }

  let elapsed = 0;
  let polls = 0;
  const history: { elapsed_seconds: number; value: number; timestamp_ms: number }[] = [];
  const key = observeKey(esql, conditionStr);
  const desc = description || "observed metric";

  while (elapsed < maxWait) {
    polls++;
    const pollStart = Date.now();
    const value = await pollMetric(esql);

    if (value !== null) {
      history.push({ elapsed_seconds: elapsed, value, timestamp_ms: pollStart });
      if (parsed && evaluate(value, parsed.comparator, parsed.threshold)) {
        return {
          status: "CONDITION_MET",
          description: desc,
          final_value: value,
          condition: conditionStr,
          detected_after_seconds: elapsed,
          polls,
          poll_interval_seconds: interval,
          trend: history,
          observe_key: key,
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
  // Without a condition, "timeout" means we completed a live-sampling window, not a failure.
  const status = parsed ? "TIMEOUT" : "SAMPLED";
  const msg = parsed
    ? `${desc} did not meet condition '${conditionStr}' within ${maxWait}s. Last value: ${lastValue}.`
    : `${desc}: sampled ${polls} points over ${maxWait}s. Last value: ${lastValue}.`;

  return {
    status,
    description: desc,
    condition: conditionStr,
    last_value: lastValue,
    polls,
    elapsed_seconds: elapsed,
    poll_interval_seconds: interval,
    trend: history,
    observe_key: key,
    message: msg,
  };
}

export function registerObserveTool(server: McpServer) {
  registerAppTool(
    server,
    "observe",
    {
      title: "Observe",
      description:
        "Requires: nothing in metric/now/table mode (works on any ES|QL-queryable data); ML anomaly jobs in anomaly " +
        "mode. The agent's Elastic-access primitive — run an ES|QL (or ML anomaly) query once, live-sample it over a " +
        "window, or block until a condition fires. Four modes:\n\n" +
        "**Anomaly mode** (default): polls ML anomaly detection jobs and fires when a significant anomaly is detected. " +
        "Returns a structured alert with affected entities, severity, and investigation hints. Starting point for " +
        "autonomous incident investigation.\n\n" +
        "**Metric mode** (mode='metric'): polls an ES|QL query and either (a) fires when a condition is satisfied " +
        "(e.g. 'value < 80000000'), or (b) if no condition is given, live-samples the metric for the full max_wait " +
        "window and returns the trend — use this for 'show me a live chart of X' style prompts. Default interval 5s, " +
        "max_wait 60s → ~12 samples. Tool returns include an `observe_key` so the UI can accumulate samples across repeated calls.\n\n" +
        "**Now mode** (mode='now'): runs the ES|QL query once and returns the current scalar value in a compact card — " +
        "use this for 'what is X right now' style prompts. Extracts the first numeric value of the first row, so it's " +
        "only suitable for single-value reads.\n\n" +
        "**Table mode** (mode='table'): runs the ES|QL query once and returns the full tabular result — all rows, all " +
        "columns, all types (string, numeric, boolean, date). Use this for 'list', 'group by', 'which …', or any query " +
        "that returns mixed-type rows (e.g. pod → node mappings, clusters with counts, top-N with labels). Rows are " +
        "capped (default 50) to keep responses compact; use LIMIT in the ES|QL or raise `row_cap` to get more.\n\n" +
        "Unlike `manage-alerts`, observe is transient and session-scoped — nothing is persisted to Kibana.",
      inputSchema: {
        mode: z.enum(["anomaly", "metric", "now", "table"]).optional().describe(
          "Observe mode. 'anomaly' (default) polls ML anomaly results — use when the user asks 'tell me when anything " +
          "unusual fires'. 'metric' polls an ES|QL query over time — use when the user names a specific metric " +
          "and wants a live trend or a threshold condition ('wait until memory drops below 80MB', 'show me a live " +
          "chart'). 'now' runs the query once and returns a single scalar value — use when the user asks 'what is " +
          "X right now' and X is a single number. 'table' runs the query once and returns all rows and columns — " +
          "use when the query groups, lists, or returns mixed-type data ('list pods by node', 'which clusters are reporting')."
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
          "[Metric/now/table mode] ES|QL query. In metric/now mode the first numeric column of the first row is " +
          "evaluated; table mode returns the full result. Construct from context, e.g. `FROM metrics-* | WHERE " +
          "host.name == \"foo\" | STATS v = AVG(system.memory.used.bytes)`. IMPORTANT: **pick the index pattern " +
          "from the layer the field lives in.** Infrastructure fields (`k8s.node.name`, `k8s.pod.name`, CPU/memory " +
          "gauges) live in `metrics-*` / `metrics-kubeletstatsreceiver.otel*` — they do NOT exist in `traces-apm*` " +
          "or `traces-*.otel-*`, which only carry APM-layer fields (`service.name`, `transaction.duration.us`, " +
          "`event.outcome`). Cross-layer joins like 'which node runs the most services' must query `metrics-*`, " +
          "because OTel resource attributes propagate both `k8s.node.name` and `service.name` onto metric docs; " +
          "querying `traces-apm*` with `k8s.node.name` will fail with verification_exception. IMPORTANT: for " +
          "sampled gauge metrics (memory, cpu, latency), use AVG/MAX/MIN — NEVER SUM, because SUM multiplies the " +
          "current value by the number of samples in the window. Reserve SUM for pre-aggregated counters (e.g. " +
          "transaction counts in 1-minute rollup indices) or when you want a real cumulative total across entities."
        ),
        condition: z.string().optional().describe(
          "[Metric mode] Optional condition '<comparator> <threshold>'. Examples: '< 80000000' (fire when memory " +
          "drops below 80MB), '>= 3' (fire when count reaches 3), '> 500' (fire when latency exceeds 500ms). Omit " +
          "for live-sampling — the tool polls for the full max_wait window and returns the trend."
        ),
        description: z.string().optional().describe(
          "[Metric/now/table mode] Human-readable description of what's being observed — surfaces as the card title. " +
          "E.g. 'frontend memory working set', 'checkout p99 latency', 'k8s clusters'."
        ),
        row_cap: z.number().optional().describe(
          "[Table mode] Maximum rows to return. Default 50. Prefer tightening the ES|QL with LIMIT/SORT rather " +
          "than raising this cap — very large tables are hard to read and inflate context."
        ),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async (args: ObserveInput) => {
      const mode = args.mode || "anomaly";
      const raw =
        mode === "metric"
          ? await handleMetricMode(args)
          : mode === "now"
          ? await handleNowMode(args)
          : mode === "table"
          ? await handleTableMode(args)
          : await handleAnomalyMode(args);
      const result = enrichForView(raw, args) as Record<string, unknown>;
      // Attach welcome notice unless something more specific (skill-gap)
      // is already present — skill-gap is the higher-priority signal.
      if (!result._setup_notice) {
        const welcome = consumeWelcomeNotice();
        if (welcome) result._setup_notice = welcome;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  const viewPath = resolveViewPath("observe");
  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const html = fs.readFileSync(viewPath, "utf-8");
      return { contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }] };
    }
  );
}

function detectUnit(description: string, esql?: string): "bytes" | "ms" | "pct" | "raw" {
  const s = `${description || ""} ${esql || ""}`.toLowerCase();
  if (s.includes("memory") || s.includes("bytes") || s.includes("working_set")) return "bytes";
  if (s.includes("latency") || s.includes("duration") || s.includes("ms")) return "ms";
  if (s.includes("cpu") || s.includes("utilization") || s.includes("pct")) return "pct";
  return "raw";
}

function enrichForView(result: Record<string, unknown>, args: ObserveInput): Record<string, unknown> {
  const enriched = { ...result };
  const actions: { label: string; prompt: string }[] = [];

  if (result.status === "TABLE") {
    enriched.esql = args.esql;
    enriched.namespace = args.namespace;
    actions.push({
      label: "Re-run query",
      prompt: `Re-run observe in table mode with the same ESQL "${args.esql}" to refresh the result.`,
    });
    if (enriched.investigation_actions === undefined) enriched.investigation_actions = actions;
    return enriched;
  }

  if (result.status === "ERROR") {
    enriched.esql = args.esql;
    return enriched;
  }

  if (result.status === "NOW") {
    enriched.esql = args.esql;
    enriched.namespace = args.namespace;
    enriched.unit = detectUnit(String(result.description || ""), args.esql);
    actions.push({
      label: "Re-check now",
      prompt: `Re-run observe in now mode with the same ESQL "${args.esql}" to refresh the current value.`,
    });
    actions.push({
      label: "Observe live (60s)",
      prompt: `Switch to a live observation: run observe in metric mode with the same ESQL "${args.esql}" (no condition) to draw a live chart.`,
    });
    actions.push({
      label: "Create alert rule",
      prompt: `Use manage-alerts (operation "create") against the same ES|QL target to persist a threshold for this metric.`,
    });
    if (actions.length) enriched.investigation_actions = actions;
    return enriched;
  }

  if (
    result.status === "CONDITION_MET" ||
    result.status === "TIMEOUT" ||
    result.status === "SAMPLED"
  ) {
    enriched.esql = args.esql;
    enriched.namespace = args.namespace;
    enriched.unit = detectUnit(String(result.description || ""), args.esql);

    // "Extend" always available — re-runs the same query for another window.
    const extendPrompt = args.condition
      ? `Re-run observe in metric mode with the same ESQL "${args.esql}" and condition "${args.condition}" for another ${args.max_wait ?? 60}s.`
      : `Re-run observe in metric mode with the same ESQL "${args.esql}" (no condition — live sample) for another ${args.max_wait ?? 60}s.`;
    actions.push({ label: "Extend observation (+60s)", prompt: extendPrompt });

    if (result.status === "CONDITION_MET") {
      actions.push({
        label: "Create alert rule",
        prompt: `Now that the metric meets the condition, persist monitoring with manage-alerts (operation "create"). Use the same ES|QL target and threshold.`,
      });
    } else if (result.status === "TIMEOUT") {
      actions.push({
        label: "Check anomalies",
        prompt: "Use ml-anomalies with lookback 1h to see if the metric's failure to stabilize has fired an anomaly.",
      });
      actions.push({
        label: "Persist as alert rule",
        prompt: "Use manage-alerts (operation \"create\") to turn this observation into a persistent Kibana rule that will page if the condition ever fires.",
      });
    } else {
      // SAMPLED (no condition) — offer to pivot into a real rule or threshold condition.
      actions.push({
        label: "Create alert rule",
        prompt: `Use manage-alerts (operation "create") to set a persistent threshold against the same ES|QL target. Pick a threshold informed by the sampled trend.`,
      });
    }
    // Note: observe is universal (any ES|QL target). We cannot assume APM is deployed, so
    // do NOT add "Confirm cluster health → apm-health-summary" here. Recommendations must
    // stay within tools whose data requirements are a subset of what this call required.
  } else if (result.status === "ALERT") {
    // Anomaly-mode alerts: derive investigation actions from the hints.
    const hints = (result.investigation_hints as { tool: string; reason: string; args: Record<string, unknown> }[]) || [];
    for (const h of hints) {
      const argStr = Object.entries(h.args || {})
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      const label = h.tool === "ml-anomalies"
        ? "Drill into anomalies"
        : h.tool === "apm-service-dependencies"
        ? "Service dependencies"
        : h.tool === "k8s-blast-radius"
        ? "Blast radius"
        : h.tool;
      actions.push({
        label,
        prompt: `Use ${h.tool}${argStr ? ` with ${argStr}` : ""}. ${h.reason}`,
      });
    }
  }

  if (actions.length) enriched.investigation_actions = actions;
  return enriched;
}

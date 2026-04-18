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
import { esRequest } from "../elastic/client.js";
import { mlAnomalyIndicesExist } from "../elastic/ml.js";
import { resolveViewPath } from "./view-path.js";

const RESOURCE_URI = "ui://apm-health-summary/mcp-app.html";

interface ServiceRow {
  service: string;
  throughput: number;
  error_rate_pct?: number;
  avg_latency_ms?: number;
}

interface PodRow {
  pod: string;
  avg_memory_mb: number;
  avg_cpu_cores: number;
}

async function queryServiceTransactionRollup(
  namespace: string | undefined,
  lookback: string,
  errors: string[]
): Promise<ServiceRow[]> {
  const nsFilter = namespace ? `AND k8s.namespace.name == "${namespace}" ` : "";
  const esql = `FROM metrics-service_transaction.1m.otel-* | WHERE @timestamp > NOW() - ${lookback} ${nsFilter}| STATS total = COUNT(*) BY service.name | SORT total DESC | LIMIT 30`;
  const rows = await safeEsqlRows<{ "service.name"?: string; total?: number }>(esql, errors);
  return rows
    .filter((r) => !!r["service.name"])
    .map((r) => ({ service: r["service.name"]!, throughput: r.total || 0 }));
}

interface ResolvedNamespace {
  resolved?: string;
  note?: string;
  candidates?: string[];
}

async function resolveNamespace(
  requested: string | undefined,
  lookback: string,
  errors: string[]
): Promise<ResolvedNamespace> {
  if (!requested) return {};
  const otelEsql = `FROM metrics-kubeletstatsreceiver.otel-*,traces-*.otel-* | WHERE @timestamp > NOW() - ${lookback} | STATS c = COUNT(*) BY k8s.namespace.name | SORT c DESC | LIMIT 50`;
  const ecsEsql = `FROM traces-apm* | WHERE @timestamp > NOW() - ${lookback} AND kubernetes.namespace IS NOT NULL | STATS c = COUNT(*) BY kubernetes.namespace | SORT c DESC | LIMIT 50`;
  const [otelRows, ecsRows] = await Promise.all([
    safeEsqlRows<{ "k8s.namespace.name"?: string }>(otelEsql, errors),
    safeEsqlRows<{ "kubernetes.namespace"?: string }>(ecsEsql, errors),
  ]);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of otelRows) {
    const n = r["k8s.namespace.name"];
    if (n && !seen.has(n)) { seen.add(n); names.push(n); }
  }
  for (const r of ecsRows) {
    const n = r["kubernetes.namespace"];
    if (n && !seen.has(n)) { seen.add(n); names.push(n); }
  }
  if (!names.length) return {};
  if (names.includes(requested)) return { resolved: requested };
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  const target = norm(requested);
  const prefix = names.find((n) => norm(n).startsWith(target));
  if (prefix) {
    return {
      resolved: prefix,
      note: `Resolved namespace "${requested}" → "${prefix}" (prefix match).`,
    };
  }
  const substr = names.find((n) => norm(n).includes(target));
  if (substr) {
    return {
      resolved: substr,
      note: `Resolved namespace "${requested}" → "${substr}" (fuzzy match).`,
    };
  }
  return {
    note: `Namespace "${requested}" not found in recent telemetry.`,
    candidates: names.slice(0, 8),
  };
}

async function queryServiceTraces(
  namespace: string | undefined,
  lookback: string,
  errors: string[]
): Promise<ServiceRow[]> {
  const nsFilter = namespace
    ? `| WHERE k8s.namespace.name == "${namespace}" `
    : "";
  const esql = `FROM traces-*.otel-* | WHERE @timestamp > NOW() - ${lookback} ${nsFilter}| STATS total_count = COUNT(*) BY service.name | SORT total_count DESC | LIMIT 30`;
  const rows = await safeEsqlRows<{ "service.name"?: string; total_count?: number }>(esql, errors);
  return rows
    .filter((r) => !!r["service.name"])
    .map((r) => ({
      service: r["service.name"]!,
      throughput: r.total_count || 0,
    }));
}

// Tier 3: classic APM agents — traces-apm* with ECS-style kubernetes.* namespace filter.
// Only run when tier-1 (pre-agg metrics) and tier-2 (OTel traces) return nothing, so OTel-native
// deployments don't pay the extra call.
async function queryServiceTracesClassic(
  namespace: string | undefined,
  lookback: string,
  errors: string[]
): Promise<ServiceRow[]> {
  const nsFilter = namespace
    ? `AND kubernetes.namespace == "${namespace}" `
    : "";
  const esql = `FROM traces-apm* | WHERE @timestamp > NOW() - ${lookback} AND processor.event == "transaction" ${nsFilter}| STATS total_count = COUNT(*) BY service.name | SORT total_count DESC | LIMIT 30`;
  const rows = await safeEsqlRows<{ "service.name"?: string; total_count?: number }>(esql, errors);
  return rows
    .filter((r) => !!r["service.name"])
    .map((r) => ({
      service: r["service.name"]!,
      throughput: r.total_count || 0,
    }));
}

async function queryServices(
  namespace: string | undefined,
  lookback: string,
  errors: string[]
): Promise<ServiceRow[]> {
  const rollup = await queryServiceTransactionRollup(namespace, lookback, errors);
  if (rollup.length) return rollup;
  const otel = await queryServiceTraces(namespace, lookback, errors);
  if (otel.length) return otel;
  return queryServiceTracesClassic(namespace, lookback, errors);
}

async function queryPodResources(
  namespace: string | undefined,
  lookback: string,
  errors: string[]
): Promise<PodRow[]> {
  const nsFilter = namespace
    ? `| WHERE k8s.namespace.name == "${namespace}" `
    : "";
  const esql = `FROM metrics-kubeletstatsreceiver.otel-* | WHERE @timestamp > NOW() - ${lookback} ${nsFilter}| STATS avg_mem = AVG(metrics.k8s.pod.memory.working_set), avg_cpu = AVG(metrics.k8s.pod.cpu.usage) BY k8s.pod.name | SORT avg_mem DESC | LIMIT 20`;
  const rows = await safeEsqlRows<{
    "k8s.pod.name"?: string;
    avg_mem?: number;
    avg_cpu?: number;
  }>(esql, errors);
  return rows
    .filter((r) => !!r["k8s.pod.name"])
    .map((r) => ({
      pod: r["k8s.pod.name"]!,
      avg_memory_mb: Math.round(((r.avg_mem || 0) / (1024 * 1024)) * 10) / 10,
      avg_cpu_cores: Math.round((r.avg_cpu || 0) * 1000) / 1000,
    }));
}

interface AnomalyRollup {
  total: number;
  by_severity: Record<string, number>;
  top_entities: { entity: string; max_score: number }[];
  error?: string;
}

async function queryActiveAnomalies(
  namespace: string | undefined,
  jobFilter: string | undefined,
  excludeEntities: string | undefined
): Promise<AnomalyRollup> {
  if (!(await mlAnomalyIndicesExist())) {
    return { total: 0, by_severity: {}, top_entities: [] };
  }

  const must: unknown[] = [
    { range: { record_score: { gte: 50 } } },
    { term: { result_type: "record" } },
    { range: { timestamp: { gte: "now-1h" } } },
  ];

  if (namespace) {
    must.push({
      nested: {
        path: "influencers",
        query: {
          bool: {
            must: [
              {
                terms: {
                  "influencers.influencer_field_name": [
                    "k8s.namespace.name",
                    "resource.attributes.k8s.namespace.name",
                  ],
                },
              },
              { term: { "influencers.influencer_field_values": namespace } },
            ],
          },
        },
      },
    });
  }
  if (jobFilter) must.push({ prefix: { job_id: jobFilter } });

  const mustNot: unknown[] = [];
  if (excludeEntities) {
    mustNot.push({
      nested: {
        path: "influencers",
        query: { wildcard: { "influencers.influencer_field_values": excludeEntities } },
      },
    });
  }

  const body = {
    size: 0,
    query: { bool: mustNot.length ? { must, must_not: mustNot } : { must } },
    aggs: {
      by_severity: {
        range: {
          field: "record_score",
          ranges: [
            { key: "minor", from: 50, to: 75 },
            { key: "major", from: 75, to: 90 },
            { key: "critical", from: 90 },
          ],
        },
      },
      top_entities_by_influencer: {
        nested: { path: "influencers" },
        aggs: {
          pods_only: {
            filter: {
              terms: {
                "influencers.influencer_field_name": [
                  "k8s.pod.name",
                  "resource.attributes.k8s.pod.name",
                  "service.name",
                  "resource.attributes.service.name",
                ],
              },
            },
            aggs: {
              by_value: {
                terms: {
                  field: "influencers.influencer_field_values",
                  size: 5,
                  order: { "parent>max_score": "desc" },
                },
                aggs: {
                  parent: {
                    reverse_nested: {},
                    aggs: { max_score: { max: { field: "record_score" } } },
                  },
                },
              },
            },
          },
        },
      },
      top_entities_by_partition: {
        terms: { field: "partition_field_value", size: 5, order: { max_score: "desc" } },
        aggs: { max_score: { max: { field: "record_score" } } },
      },
    },
  };

  try {
    type AggResp = {
      hits: { total: { value: number } | number };
      aggregations?: {
        by_severity?: { buckets: { key: string; doc_count: number }[] };
        top_entities_by_influencer?: {
          pods_only?: {
            by_value?: {
              buckets: {
                key: string;
                parent?: { max_score?: { value: number } };
              }[];
            };
          };
        };
        top_entities_by_partition?: {
          buckets: { key: string; max_score: { value: number } }[];
        };
      };
    };
    const resp = await esRequest<AggResp>("/.ml-anomalies-*/_search", { body });
    const total = typeof resp.hits.total === "number" ? resp.hits.total : resp.hits.total.value;
    const sevBuckets = resp.aggregations?.by_severity?.buckets || [];
    const bySeverity: Record<string, number> = {};
    for (const b of sevBuckets) if (b.doc_count > 0) bySeverity[b.key] = b.doc_count;

    const influencerBuckets =
      resp.aggregations?.top_entities_by_influencer?.pods_only?.by_value?.buckets || [];
    const partitionBuckets = resp.aggregations?.top_entities_by_partition?.buckets || [];
    const buckets = influencerBuckets.length ? influencerBuckets : partitionBuckets;
    const topEntities = buckets.map((b) => {
      const score =
        "parent" in b
          ? b.parent?.max_score?.value ?? 0
          : (b as { max_score: { value: number } }).max_score.value;
      return { entity: b.key, max_score: Math.round(score * 10) / 10 };
    });
    return { total, by_severity: bySeverity, top_entities: topEntities };
  } catch (exc) {
    return {
      total: 0,
      by_severity: {},
      top_entities: [],
      error: exc instanceof Error ? exc.message : String(exc),
    };
  }
}

function assessHealth(
  services: ServiceRow[],
  anomalies: AnomalyRollup
): { health: string; degraded: { service: string; reasons: string[] }[] } {
  const degraded: { service: string; reasons: string[] }[] = [];
  for (const svc of services) {
    const reasons: string[] = [];
    if ((svc.error_rate_pct || 0) > 5) reasons.push(`error rate ${svc.error_rate_pct}%`);
    if ((svc.avg_latency_ms || 0) > 2000) reasons.push(`latency ${svc.avg_latency_ms}ms`);
    if (reasons.length) degraded.push({ service: svc.service, reasons });
  }

  const critical = anomalies.by_severity?.critical || 0;
  let health: string;
  if (critical > 0 || degraded.length >= 3) health = "critical";
  else if (degraded.length >= 1 || (anomalies.total || 0) > 5) health = "degraded";
  else health = "healthy";

  return { health, degraded };
}

export function registerApmHealthSummaryTool(server: McpServer) {
  registerAppTool(
    server,
    "apm-health-summary",
    {
      title: "APM Health Summary",
      description:
        "Requires: Elastic APM. Optional: Kubernetes (kubeletstats) for pod resource context, ML anomaly jobs " +
        "for anomaly rollup. Returns a cluster-level health summary from live APM service telemetry with pod-resource " +
        "and ML-anomaly context layered in when those backends are present. Use for a quick 'how is my cluster doing?' " +
        "or 'what's broken right now?' check before drilling into specific services. Gracefully degrades — without " +
        "K8s metrics, omits the pods section; without ML jobs, omits the anomalies section. The response includes " +
        "a data_coverage field showing which backends contributed.",
      inputSchema: {
        namespace: z.string().optional().describe(
          "Kubernetes namespace to scope to — e.g. 'otel-demo', 'prod', 'checkout'. Only applicable if services " +
          "are K8s-deployed. Omit for all namespaces or non-K8s deployments."
        ),
        lookback: z.string().optional().describe(
          "Time range to assess. Default '15m'. Examples: '5m' (very recent), '15m' (default, good for 'right now'), " +
          "'1h' (wider trend)."
        ),
        job_filter: z.string().optional().describe(
          "Only include ML anomalies from jobs whose id starts with this prefix — e.g. 'k8s-' to see only the " +
          "Kubernetes-scoped jobs. Omit for all jobs."
        ),
        exclude_entities: z.string().optional().describe(
          "Wildcard pattern to exclude from anomaly rollup — e.g. 'chaos-*' to hide known synthetic noise. " +
          "Matches against influencer field values."
        ),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ namespace, lookback, job_filter, exclude_entities }) => {
      const lb = lookback || "15m";
      const queryErrors: string[] = [];
      const nsResolution = await resolveNamespace(namespace, lb, queryErrors);
      const effectiveNs = nsResolution.resolved ?? namespace;
      const [services, pods, anomalies] = await Promise.all([
        queryServices(effectiveNs, lb, queryErrors),
        queryPodResources(effectiveNs, lb, queryErrors),
        queryActiveAnomalies(effectiveNs, job_filter, exclude_entities),
      ]);

      const { health, degraded } = assessHealth(services, anomalies);

      const anomalyJobsSeen = (anomalies.total || 0) > 0 || Object.keys(anomalies.by_severity).length > 0;

      const dataCoverage = {
        apm: services.length > 0,
        kubernetes: pods.length > 0,
        ml_anomalies: anomalyJobsSeen,
      };

      const result: Record<string, unknown> = {
        overall_health: health,
        namespace: effectiveNs || namespace || "all",
        lookback: lb,
        data_coverage: dataCoverage,
        services: {
          total: services.length,
          degraded_count: degraded.length,
          details: services.slice(0, 15),
        },
        degraded_services: degraded,
      };
      if (namespace && effectiveNs && effectiveNs !== namespace) {
        result.namespace_requested = namespace;
      }
      if (nsResolution.note) result.namespace_note = nsResolution.note;
      if (nsResolution.candidates) result.namespace_candidates = nsResolution.candidates;
      if (exclude_entities) result.exclude_filter = exclude_entities;

      if (pods.length) {
        result.pods = { total: pods.length, top_memory: pods.slice(0, 5) };
      } else {
        result.pods_note =
          "No Kubernetes pod metrics found (metrics-kubeletstatsreceiver.otel-* with k8s.pod.name populated). " +
          "Running in APM-only mode — expected if services aren't K8s-deployed or kubeletstats isn't shipping.";
      }

      if (anomalyJobsSeen) {
        result.anomalies = anomalies;
      } else {
        result.anomalies_note =
          "No ML anomaly jobs contributed results. " +
          "Configure anomaly detection jobs in Kibana ML to enrich this summary with anomaly signals.";
      }

      if (!services.length) {
        result.warning =
          "No APM service telemetry found. This tool requires Elastic APM — if you're a logs- or metrics-only " +
          "customer, reach for 'ml-anomalies', 'watch', or 'create-alert-rule' instead.";
      } else if (degraded.length) {
        result.recommendation = `Investigate ${degraded[0].service}: ${degraded[0].reasons.join(", ")}. Use ml-anomalies for details.`;
      }

      // Investigation-action buttons for the view footer.
      const actions: { label: string; prompt: string }[] = [];
      const topEntity = anomalies.top_entities?.[0]?.entity;
      const topPod = pods[0]?.pod;
      if (topPod) {
        const shortPod = topPod.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "");
        actions.push({
          label: `Drill into ${shortPod}`,
          prompt: `Use ml-anomalies with entity "${shortPod}" and lookback "1h" to explain anomalies for this pod.`,
        });
      }
      if (pods[1]) {
        const shortPod = pods[1].pod.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "");
        actions.push({
          label: `Drill into ${shortPod}`,
          prompt: `Use ml-anomalies with entity "${shortPod}" and lookback "1h" to explain anomalies for this pod.`,
        });
      }
      if (degraded.length) {
        actions.push({
          label: `Investigate ${degraded[0].service}`,
          prompt: `Use ml-anomalies with entity "${degraded[0].service}" and lookback "1h" to find the root cause.`,
        });
      }
      if (topEntity) {
        actions.push({
          label: "Check blast radius",
          prompt: `Use k8s-blast-radius to assess impact if the node hosting ${topEntity} fails.`,
        });
      }
      if (actions.length) result.investigation_actions = actions;

      // Rerun context for the view's time-range chip row.
      const rerunParts = ["lookback \"{lookback}\""];
      if (effectiveNs) rerunParts.push(`namespace "${effectiveNs}"`);
      if (job_filter) rerunParts.push(`job_filter "${job_filter}"`);
      if (exclude_entities) rerunParts.push(`exclude_entities "${exclude_entities}"`);
      result.rerun_context = {
        tool: "apm-health-summary",
        current_lookback: lb,
        prompt_template: `Use apm-health-summary with ${rerunParts.join(" and ")}`,
      };

      if (queryErrors.length) result._query_errors = queryErrors;

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  const viewPath = resolveViewPath("apm-health-summary");
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

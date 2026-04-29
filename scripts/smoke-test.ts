/*
 * Live smoke test — exercises the core ES|QL / Kibana path of each tool
 * against a real cluster. Does NOT create any persistent objects.
 *
 * Usage:
 *   ELASTICSEARCH_URL=... ELASTICSEARCH_API_KEY=... \
 *   KIBANA_URL=... KIBANA_API_KEY=... \
 *   npx tsx scripts/smoke-test.ts
 */

import { executeEsql, rowsFromEsql } from "../src/elastic/esql.js";
import { esRequest, kibanaRequest } from "../src/elastic/client.js";
import {
  listAvailableClusters,
  resolveServicesInCluster,
} from "../src/elastic/apm.js";

type Outcome = "PASS" | "EMPTY" | "FAIL";
interface Result {
  name: string;
  outcome: Outcome;
  detail: string;
}

const results: Result[] = [];

function record(name: string, outcome: Outcome, detail: string) {
  results.push({ name, outcome, detail });
  const icon = outcome === "PASS" ? "✓" : outcome === "EMPTY" ? "○" : "✗";
  console.log(`${icon} [${outcome}] ${name} — ${detail}`);
}

async function trySql(name: string, query: string, expectRows = true) {
  try {
    const res = await executeEsql(query);
    const rows = rowsFromEsql<Record<string, unknown>>(res);
    if (rows.length === 0) {
      record(name, expectRows ? "EMPTY" : "PASS", `0 rows`);
    } else {
      record(name, "PASS", `${rows.length} row(s); first: ${JSON.stringify(rows[0]).slice(0, 120)}`);
    }
    return rows;
  } catch (err) {
    record(name, "FAIL", (err as Error).message.slice(0, 200));
    return [];
  }
}

async function main() {
  console.log(`\n🔍 Smoke testing against ${process.env.ELASTICSEARCH_URL}\n`);

  // ── ml-anomalies ─────────────────────────────────────────────
  await trySql(
    "ml-anomalies: .ml-anomalies-* reachable",
    `FROM .ml-anomalies-*
| WHERE result_type == "record"
| STATS count = COUNT(*) BY job_id
| LIMIT 5`
  );

  // ── apm-health-summary ───────────────────────────────────────
  await trySql(
    "apm-health-summary: APM service transaction metrics",
    `FROM metrics-service_transaction*
| WHERE service.name IS NOT NULL AND @timestamp > NOW() - 15 minutes
| STATS tx_count = COUNT(*) BY service.name
| LIMIT 5`
  );

  await trySql(
    "apm-health-summary: kubeletstats pods (K8s optional)",
    `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE kubernetes.pod.name IS NOT NULL AND @timestamp > NOW() - 15 minutes
| STATS pod_count = COUNT_DISTINCT(kubernetes.pod.name) BY kubernetes.namespace
| LIMIT 5`
  );

  // ── k8s-blast-radius ─────────────────────────────────────────
  const nodes = await trySql(
    "k8s-blast-radius: kubeletstats nodes available",
    `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE kubernetes.node.name IS NOT NULL AND @timestamp > NOW() - 15 minutes
| STATS pod_count = COUNT_DISTINCT(kubernetes.pod.name) BY kubernetes.node.name
| SORT pod_count DESC
| LIMIT 5`
  );

  if (nodes.length) {
    const node = nodes[0]["kubernetes.node.name"] as string;
    await trySql(
      `k8s-blast-radius: pod-on-node query for '${node}'`,
      `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE kubernetes.node.name == "${node}"
  AND kubernetes.pod.name IS NOT NULL
  AND metrics.k8s.pod.memory.working_set IS NOT NULL
| STATS
    replica_count = COUNT_DISTINCT(kubernetes.pod.name),
    memory_bytes = SUM(metrics.k8s.pod.memory.working_set)
  BY deployment = kubernetes.deployment.name, namespace = kubernetes.namespace
| WHERE deployment IS NOT NULL
| LIMIT 5`
    );
  }

  // ── apm-service-dependencies ─────────────────────────────────
  await trySql(
    "apm-service-dependencies: service destination metrics",
    `FROM metrics-service_destination.1m.otel-*
| WHERE service.name IS NOT NULL
  AND span.destination.service.resource IS NOT NULL
  AND @timestamp > NOW() - 15 minutes
| STATS call_count = COUNT(*) BY service.name, span.destination.service.resource
| LIMIT 5`
  );

  // ── observe (metric mode, universal) ─────────────────────────
  await trySql(
    "observe: generic ES|QL runs against cluster",
    `FROM metrics-*
| STATS doc_count = COUNT(*)
| LIMIT 1`
  );

  // ── manage-alerts (Kibana reachability) ──────────────────────
  try {
    await kibanaRequest("/api/status");
    record("manage-alerts: Kibana /api/status reachable", "PASS", "Kibana OK");
  } catch (err) {
    record("manage-alerts: Kibana /api/status reachable", "FAIL", (err as Error).message.slice(0, 200));
  }

  // ── v1.0.17 release surfaces ────────────────────────────────
  //
  // These probes exercise the new fields and helpers introduced by the UX
  // refresh + multi-cluster + per-app commits. EMPTY here is informational
  // (the field path is correct; no data in the lookback window) — only
  // FAIL means the field-name assumption was wrong.

  console.log("\n── v1.0.17 release surfaces ──");

  // -- Multi-cluster scoping (apm-health-summary, k8s-blast-radius) --
  // Field paths the queries assume:
  //   OTel:    k8s.cluster.name
  //   ECS:     orchestrator.cluster.name
  await trySql(
    "cluster scoping: OTel k8s.cluster.name on kubeletstats",
    `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE k8s.cluster.name IS NOT NULL AND @timestamp > NOW() - 1h
| STATS c = COUNT(*) BY k8s.cluster.name
| LIMIT 5`
  );
  await trySql(
    "cluster scoping: ECS orchestrator.cluster.name on traces-apm*",
    `FROM traces-apm*
| WHERE orchestrator.cluster.name IS NOT NULL AND @timestamp > NOW() - 1h
| STATS c = COUNT(*) BY orchestrator.cluster.name
| LIMIT 5`
  );

  try {
    const clusters = await listAvailableClusters("1h", []);
    if (clusters.length === 0) {
      record("listAvailableClusters helper", "EMPTY", "no clusters returned");
    } else {
      record("listAvailableClusters helper", "PASS", `${clusters.length}: ${clusters.slice(0, 3).join(", ")}${clusters.length > 3 ? "…" : ""}`);
    }
    if (clusters[0]) {
      const services = await resolveServicesInCluster(clusters[0], "1h", []);
      record(
        `resolveServicesInCluster('${clusters[0]}')`,
        services.length ? "PASS" : "EMPTY",
        `${services.length} service(s)`
      );
    }
  } catch (err) {
    record("listAvailableClusters helper", "FAIL", (err as Error).message.slice(0, 200));
  }

  // -- Application grouping (apm-health-summary scope.service_groups) --
  // Resolved primarily from APM service.namespace; fallback chain is
  // documented in the tool but not exercised here (this probe just
  // validates whether the canonical signal is populated in real data).
  await trySql(
    "app grouping: APM service.namespace populated",
    `FROM traces-apm*,traces-*.otel-*
| WHERE service.namespace IS NOT NULL AND @timestamp > NOW() - 1h
| STATS c = COUNT(*) BY service.namespace, service.name
| LIMIT 5`
  );

  // -- Pod → service correlation (apm-health-summary pods[].service) --
  // The pod→service map is built from k8s.pod.name + service.name pairs
  // on OTel traces. EMPTY means traces don't carry pod attributes (e.g.
  // APM agents running outside k8s); not a failure.
  await trySql(
    "pod->service correlation: k8s.pod.name + service.name on traces",
    `FROM traces-*.otel-*
| WHERE k8s.pod.name IS NOT NULL AND service.name IS NOT NULL AND @timestamp > NOW() - 1h
| STATS c = COUNT(*) BY k8s.pod.name, service.name
| LIMIT 5`
  );

  // -- Per-pod resource snapshot (apm-health-summary pods.by_app) --
  // Validates the MAX-MIN restart delta + sum-able resource fields needed
  // for buildPodsByApp. Same fields as queryPodResourceSnapshot.
  await trySql(
    "per-pod resource snapshot: kubeletstats sums + restart delta",
    `FROM metrics-kubeletstatsreceiver.otel-*
| WHERE @timestamp > NOW() - 1h AND k8s.pod.name IS NOT NULL
| STATS
    cpu_use = MAX(metrics.k8s.pod.cpu.usage),
    cpu_lim = MAX(metrics.k8s.pod.cpu.limit),
    mem_use = MAX(metrics.k8s.pod.memory.working_set),
    mem_lim = MAX(metrics.k8s.pod.memory.limit),
    restart_max = MAX(metrics.k8s.container.restart_count),
    restart_min = MIN(metrics.k8s.container.restart_count)
  BY k8s.pod.name
| LIMIT 5`
  );

  // -- Per-service KPIs (apm-health-summary services.details[].p99_latency_ms) --
  await trySql(
    "per-service KPIs: PERCENTILE(transaction.duration.us, 99) BY service.name",
    `FROM traces-apm*,traces-*.otel-*
| WHERE @timestamp > NOW() - 1h
| STATS p99_us = PERCENTILE(transaction.duration.us, 99), avg_us = AVG(transaction.duration.us) BY service.name
| LIMIT 5`
  );

  // -- Per-entity anomaly counts (anomalies.by_entity) --
  // Uses ES query DSL not ES|QL — the new entities_by_count agg with the
  // reverse_nested + range-on-record_score sub-aggs. We just confirm the
  // shape parses and returns SOMETHING; counts are 0 in idle clusters.
  try {
    type AggResp = {
      hits: { total: { value: number } | number };
      aggregations?: {
        entities_by_count?: {
          pods_only?: {
            by_value?: { buckets: Array<{ key: string; doc_count: number }> };
          };
        };
      };
    };
    const body = {
      size: 0,
      query: {
        bool: {
          must: [
            { range: { record_score: { gte: 50 } } },
            { term: { result_type: "record" } },
            { range: { timestamp: { gte: "now-1h" } } },
          ],
        },
      },
      aggs: {
        entities_by_count: {
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
                  terms: { field: "influencers.influencer_field_values", size: 50 },
                  aggs: {
                    parent: {
                      reverse_nested: {},
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
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const resp = await esRequest<AggResp>("/.ml-anomalies-*/_search", { body });
    const buckets = resp.aggregations?.entities_by_count?.pods_only?.by_value?.buckets ?? [];
    record(
      "anomalies.by_entity: nested influencer + reverse_nested + severity range",
      buckets.length ? "PASS" : "EMPTY",
      `${buckets.length} entity bucket(s)`
    );
  } catch (err) {
    record(
      "anomalies.by_entity: nested influencer + reverse_nested + severity range",
      "FAIL",
      (err as Error).message.slice(0, 200)
    );
  }

  // -- Issue #8 fix (observe skill): exception.* on OTel traces --
  // Confirms the field family the new skill guidance points at exists in
  // real OTel data; an EMPTY result here means no recent failures, not
  // a broken assumption.
  await trySql(
    "exception.* on OTel traces (issue #8 skill guidance)",
    `FROM traces-*.otel-*
| WHERE @timestamp > NOW() - 1h
  AND event.outcome == "failure"
  AND exception.message IS NOT NULL
| KEEP @timestamp, exception.type, exception.message
| LIMIT 5`
  );

  // ── summary ──────────────────────────────────────────────────
  const pass = results.filter((r) => r.outcome === "PASS").length;
  const empty = results.filter((r) => r.outcome === "EMPTY").length;
  const fail = results.filter((r) => r.outcome === "FAIL").length;
  console.log(`\n── Summary ──`);
  console.log(`   ${pass} pass   ${empty} empty   ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});

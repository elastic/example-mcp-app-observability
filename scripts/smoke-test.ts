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
import { kibanaRequest } from "../src/elastic/client.js";

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

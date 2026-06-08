export {};
import { setConfig, esRequest } from "../src/elastic/client.js";
import { executeEsql } from "../src/elastic/esql.js";

async function main() {
  const url = process.env.USER_ES_URL || "";
  const key = process.env.USER_ES_KEY || "";
  setConfig({
    elasticsearchUrl: url,
    elasticsearchApiKey: key,
    kibanaUrl: url.replace(".es.", ".kb."),
    kibanaApiKey: key,
  });

  // 1. Find an actual k8s cluster name (handoff assumed "oteldemo-dvdkd").
  const clusters = await executeEsql(
    `TS metrics-kubeletstatsreceiver.otel*
     | WHERE k8s.node.network.io IS NOT NULL
     | STATS n = COUNT(k8s.node.network.io) BY k8s.cluster.name
     | SORT n DESC
     | LIMIT 5`
  );
  console.log("─── available clusters (by network.io rows) ───");
  console.log("columns:", JSON.stringify(clusters.columns));
  for (const r of clusters.values) console.log("  ", JSON.stringify(r));

  const clusterName = clusters.values?.[0]?.[clusters.columns.findIndex((c) => c.name === "k8s.cluster.name")];
  if (!clusterName) {
    console.log("\n⚠️  No cluster with k8s.node.network.io found — cannot run verification query.");
    return;
  }

  // 2. Run the EXACT verification query shape against the real cluster.
  const q = `TS metrics-kubeletstatsreceiver.otel*
| WHERE k8s.cluster.name == "${clusterName}"
  AND @timestamp > NOW() - 24 hours
  AND k8s.node.network.io IS NOT NULL
| STATS throughput_bps = SUM(RATE(k8s.node.network.io))
  BY bucket = BUCKET(@timestamp, 1 hour), direction
| SORT bucket ASC`;

  console.log(`\n─── verification query (cluster="${clusterName}") ───`);
  const res = await executeEsql(q);
  console.log("COLUMN METADATA (what observe returns as columns[].type):");
  console.log(JSON.stringify(res.columns, null, 2));
  console.log(`\nrow_count: ${res.values.length}`);
  console.log("first 4 rows:");
  for (const r of res.values.slice(0, 4)) console.log("  ", JSON.stringify(r));

  const directionCol = res.columns.find((c) => c.name === "direction");
  console.log(`\n>>> direction column type = ${JSON.stringify(directionCol?.type)} <<<`);
  const distinctDirections = [
    ...new Set(res.values.map((r) => r[res.columns.findIndex((c) => c.name === "direction")])),
  ];
  console.log(">>> distinct direction values =", JSON.stringify(distinctDirections));
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});

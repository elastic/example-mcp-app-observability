/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { type FixtureSet, fixture } from "./types";

function trend(count = 40, base = 220, peak = 920) {
  const out: { elapsed_seconds: number; value: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = i * 15;
    const ramp = Math.min(1, Math.max(0, (i - 22) / 8));
    const noise = Math.sin(i * 0.6) * 18 + Math.cos(i * 0.31) * 11;
    const value = base + ramp * (peak - base) + noise;
    out.push({ elapsed_seconds: t, value: Math.round(value) });
  }
  return out;
}

export const observeFixtures: FixtureSet = {
  conditionMet: fixture("CONDITION_MET (latency)", {
    status: "CONDITION_MET",
    description: "p99 latency for checkout over last 1m",
    final_value: 921,
    condition: "> 800",
    detected_after_seconds: 384,
    elapsed_seconds: 610,
    polls: 41,
    poll_interval_seconds: 15,
    trend: trend(),
    observe_key: "checkout-p99-8abc",
    message: "Condition met after 6m24s.",
    esql: "FROM traces-apm-* | WHERE service.name==\"checkout\" | STATS p99 = PERCENTILE(transaction.duration.us, 99) BY BUCKET(@timestamp, 1m)",
    namespace: "prod-us",
    threshold_label: "800 ms",
    unit: "ms",
    baseline_value: 185,
    peak_value: 921,
    peak_label: "peak",
    investigation_actions: [
      { label: "Explain the anomaly", prompt: "Explain anomalies for service.name=checkout in prod-us" },
      { label: "Service dependencies", prompt: "Show service dependencies centered on checkout" },
    ],
  }),
  timeout: fixture("TIMEOUT", {
    status: "TIMEOUT",
    description: "p99 latency for checkout over last 1m",
    last_value: 212,
    condition: "> 800",
    elapsed_seconds: 1800,
    polls: 120,
    poll_interval_seconds: 15,
    trend: trend(60, 210, 260),
    observe_key: "checkout-p99-quiet",
    message: "No threshold breach in the observation window.",
    threshold_label: "800 ms",
    unit: "ms",
    baseline_value: 210,
  }),
  now: fixture("NOW (single value)", {
    status: "NOW",
    description: "Current pod count in prod-us",
    value: 147,
    evaluated_at_ms: Date.parse("2026-04-23T14:20:00Z"),
    message: "Evaluated once.",
    esql: "FROM metrics-kubeletstats-* | STATS count = COUNT_DISTINCT(kubernetes.pod.uid)",
    namespace: "prod-us",
    unit: "raw",
  }),
  table: fixture("TABLE", {
    status: "TABLE",
    description: "Top 5 services by throughput, last 1h",
    columns: [
      { name: "service.name", type: "keyword" },
      { name: "rpm", type: "double" },
      { name: "p99_ms", type: "double" },
      { name: "error_rate", type: "double" },
    ],
    rows: [
      ["frontend", 5620, 118, 0.001],
      ["search", 3210, 89, 0.0005],
      ["inventory", 2104, 56, 0],
      ["checkout", 1203, 412, 0.023],
      ["payments", 980, 245, 0.018],
    ],
    row_count: 5,
    truncated: false,
    evaluated_at_ms: Date.parse("2026-04-23T14:20:00Z"),
    message: "Returned 5 rows.",
    esql: "FROM traces-apm-* | STATS rpm = COUNT(*) / 60, p99_ms = PERCENTILE(transaction.duration.us, 99)/1000, error_rate = AVG(CASE(event.outcome==\"failure\", 1, 0)) BY service.name | SORT rpm DESC | LIMIT 5",
  }),
  alert: fixture("ALERT (anomaly)", {
    status: "ALERT",
    headline: "Spike detected on checkout p99 latency",
    detected_after_seconds: 90,
    anomaly_count: 3,
    affected_entities: ["service.name=checkout"],
    affected_services: ["checkout"],
    jobs_summary: { "apm-p99-latency": 3 },
    investigation_hints: [
      { tool: "anomaly-explainer", reason: "Detail on the fired anomaly", args: { entity: "service.name=checkout" } },
    ],
    message: "Anomaly alert fired.",
  }),
  error: fixture("ERROR", {
    status: "ERROR",
    description: "",
    message: "ES|QL compile error: unknown function `PERCENTILE_OF`",
    evaluated_at_ms: Date.parse("2026-04-23T14:20:00Z"),
    esql: "FROM traces-apm-* | STATS PERCENTILE_OF(duration, 99)",
  }),
};

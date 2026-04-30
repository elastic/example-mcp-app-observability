/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { type FixtureSet, fixture } from "./types";

const now = Date.parse("2026-04-23T14:20:00Z");

function timeSeries(count = 30, base = 180, spikeAt = 24, spike = 520) {
  const out: { timestamp: number; value: number; typical?: number }[] = [];
  for (let i = 0; i < count; i++) {
    const ts = now - (count - i) * 60_000;
    const noise = (Math.sin(i * 0.7) + Math.cos(i * 0.3)) * 18;
    const value = i >= spikeAt ? spike - (i - spikeAt) * 18 + noise : base + noise;
    const typical = base + noise * 0.3;
    out.push({ timestamp: ts, value: Math.round(value), typical: Math.round(typical) });
  }
  return out;
}

export const anomalyExplainerFixtures: FixtureSet = {
  detail: fixture("Detail — checkout latency", {
    headline: "checkout · p99 latency spiked 2.8× typical",
    total: 1,
    returned: 1,
    anomalies: [
      {
        jobId: "apm-p99-latency",
        recordScore: 93.2,
        severity: "critical",
        timestamp: now - 90_000,
        functionName: "high_mean",
        fieldName: "transaction.duration.us",
        entity: "service.name=checkout",
        actual: [520],
        typical: [185],
        deviationPercent: 181,
        influencers: {
          "host.name": ["node-us-east-4"],
          "service.environment": ["production"],
        },
      },
    ],
    filters: { entity: "service.name=checkout", jobId: "apm-p99-latency", lookback: "1h" },
    detail: {
      entity_label: "checkout",
      namespace: "prod-us",
      actual_label: "current p99",
      typical_label: "typical",
      unit_format: "ms",
    },
    time_series: timeSeries(30, 185, 24, 520),
    time_series_title: "p99 latency · last 30m",
    time_series_note: "Anomaly detected 90s ago. Score 93.2.",
    chart_window: "30m",
    chart_points: 30,
    investigation_actions: [
      { label: "Service dependencies", prompt: "Show service dependencies around checkout in prod-us" },
      { label: "Related alerts", prompt: "Show active alerts for service.name=checkout" },
    ],
    rerun_context: {
      tool: "anomaly-explainer",
      current_lookback: "1h",
      prompt_template: "Explain checkout anomaly over the last {lookback}",
      presets: ["15m", "1h", "6h", "24h"],
    },
  }),
  overview: fixture("Overview — 12 anomalies", {
    headline: "12 anomalies across 4 services in prod-us over the last hour",
    total: 12,
    returned: 12,
    anomalies: [
      // Top entry mirrors the standalone "Detail — checkout latency" fixture
      // exactly so demos that click into this card see the same facts the
      // dedicated detail fixture would show: function, field, actual, typical,
      // deviation, influencers all populated. Score 93.2 keeps it at the
      // top of the default score-sorted list.
      {
        jobId: "apm-p99-latency",
        recordScore: 93.2,
        severity: "critical",
        timestamp: now - 90_000,
        entity: "service.name=checkout",
        functionName: "high_mean",
        fieldName: "transaction.duration.us",
        actual: [520],
        typical: [185],
        deviationPercent: 181,
        influencers: {
          "host.name": ["node-us-east-4"],
          "service.environment": ["production"],
        },
      },
      { jobId: "apm-p99-latency", recordScore: 78.4, severity: "major", timestamp: now - 180_000, entity: "service.name=shipping" },
      { jobId: "apm-error-rate", recordScore: 64.1, severity: "major", timestamp: now - 240_000, entity: "service.name=payments" },
      { jobId: "apm-error-rate", recordScore: 54.9, severity: "minor", timestamp: now - 300_000, entity: "service.name=checkout" },
      { jobId: "k8s-memory-utilization", recordScore: 48.2, severity: "minor", timestamp: now - 420_000, entity: "host.name=node-us-east-4" },
      { jobId: "k8s-memory-utilization", recordScore: 45.0, severity: "minor", timestamp: now - 480_000, entity: "host.name=node-us-west-1" },
    ],
    jobsSummary: {
      "apm-p99-latency": 4,
      "apm-error-rate": 3,
      "k8s-memory-utilization": 5,
    },
    affected_services: ["checkout", "shipping", "payments"],
    filters: { lookback: "1h" },
    // Detail-pane labels: matches the actual_label / typical_label the
    // standalone detail fixture uses ("current p99" / "typical") so the
    // FactCol renders identically when the top card is clicked. Other
    // anomaly types (memory, error-rate) inherit the same labels — a
    // small fidelity tradeoff acceptable for the demo flow, since the
    // primary click target IS the checkout latency card.
    detail: {
      actual_label: "current p99",
      typical_label: "typical",
    },
    investigation_actions: [
      { label: "Drill into checkout", prompt: "Explain anomalies for service.name=checkout over the last 1h" },
    ],
  }),
  empty: fixture("No anomalies", {
    headline: "No anomalies in the selected window.",
    total: 0,
    returned: 0,
    anomalies: [],
    filters: { lookback: "1h" },
  }),
};

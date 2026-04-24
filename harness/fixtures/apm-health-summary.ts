/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { type FixtureSet, fixture } from "./types";

const BUCKET_SPAN_MS = 5 * 60 * 1000;
const now = Date.parse("2026-04-23T14:20:00Z");
const bucketStart = now - 60 * 60 * 1000; // 1h ago

/**
 * Twelve 5-minute buckets worth of max-score values. 0 means "no anomaly
 * fired in that bucket for this entity" — the heatmap renders an empty cell.
 * Scores map to severity at 50 / 75 / 90 thresholds.
 */
function timeline(scores: number[]) {
  return scores.map((s, i) => ({
    ts: bucketStart + i * BUCKET_SPAN_MS,
    max_score: s,
  }));
}

/** Metric timeline (throughput or memory) — value field, same buckets. */
function metricTimeline(values: number[]) {
  return values.map((v, i) => ({
    ts: bucketStart + i * BUCKET_SPAN_MS,
    value: v,
  }));
}

const METRIC_WINDOW = {
  start_ms: bucketStart,
  end_ms: now,
  bucket_span_ms: BUCKET_SPAN_MS,
};

export const apmHealthSummaryFixtures: FixtureSet = {
  degraded: fixture("Degraded cluster", {
    overall_health: "degraded",
    namespace: "prod-us",
    lookback: "1h",
    data_coverage: { apm: true, kubernetes: true, ml_anomalies: true },
    services: {
      total: 18,
      degraded_count: 3,
      details: [
        {
          service: "checkout",
          throughput: 1203,
          avg_latency_ms: 412,
          error_rate_pct: 2.3,
          timeline: metricTimeline([1100, 1120, 1180, 1240, 1290, 1310, 1280, 1220, 1190, 1170, 1190, 1203]),
          peak_throughput: 1310,
        },
        {
          service: "frontend",
          throughput: 5620,
          avg_latency_ms: 118,
          error_rate_pct: 0.1,
          timeline: metricTimeline([5100, 5180, 5260, 5340, 5420, 5500, 5580, 5620, 5680, 5700, 5690, 5620]),
          peak_throughput: 5700,
        },
        {
          service: "search",
          throughput: 3210,
          avg_latency_ms: 89,
          error_rate_pct: 0.05,
          timeline: metricTimeline([3100, 3180, 3240, 3280, 3300, 3280, 3260, 3240, 3220, 3210, 3200, 3210]),
          peak_throughput: 3300,
        },
        {
          service: "payments",
          throughput: 980,
          avg_latency_ms: 245,
          error_rate_pct: 1.8,
          timeline: metricTimeline([920, 940, 960, 985, 1010, 1020, 1000, 990, 970, 975, 985, 980]),
          peak_throughput: 1020,
        },
        {
          service: "inventory",
          throughput: 2104,
          avg_latency_ms: 56,
          error_rate_pct: 0,
          timeline: metricTimeline([2100, 2098, 2105, 2110, 2108, 2104, 2101, 2099, 2103, 2106, 2104, 2104]),
          peak_throughput: 2110,
        },
        {
          service: "shipping",
          throughput: 420,
          avg_latency_ms: 302,
          error_rate_pct: 3.5,
          timeline: metricTimeline([500, 480, 470, 460, 450, 440, 430, 425, 420, 418, 419, 420]),
          peak_throughput: 500,
        },
      ],
      timeline_window: METRIC_WINDOW,
    },
    degraded_services: [
      { service: "checkout", reasons: ["p99 latency > 800ms", "error rate 2.3%"] },
      { service: "payments", reasons: ["error rate 1.8%"] },
      { service: "shipping", reasons: ["error rate 3.5%", "5 anomalies active"] },
    ],
    pods: {
      total: 147,
      top_memory: [
        {
          pod: "checkout-api-7fd9-xk12",
          avg_memory_mb: 1820,
          avg_cpu_cores: 0.9,
          timeline: metricTimeline([1620, 1660, 1690, 1720, 1760, 1790, 1810, 1830, 1850, 1890, 1870, 1820]),
          peak_memory_mb: 1890,
        },
        {
          pod: "payments-worker-3ab0-qq7p",
          avg_memory_mb: 1640,
          avg_cpu_cores: 0.55,
          timeline: metricTimeline([1580, 1595, 1610, 1620, 1625, 1630, 1640, 1650, 1660, 1655, 1645, 1640]),
          peak_memory_mb: 1660,
        },
        {
          pod: "frontend-6f4d-11zz",
          avg_memory_mb: 1410,
          avg_cpu_cores: 0.4,
          timeline: metricTimeline([1380, 1385, 1392, 1398, 1402, 1406, 1410, 1412, 1415, 1418, 1414, 1410]),
          peak_memory_mb: 1418,
        },
        {
          pod: "search-indexer-aa12-k0ll",
          avg_memory_mb: 1280,
          avg_cpu_cores: 0.7,
          timeline: metricTimeline([1200, 1210, 1220, 1235, 1250, 1260, 1270, 1280, 1285, 1290, 1295, 1280]),
          peak_memory_mb: 1295,
        },
      ],
      timeline_window: METRIC_WINDOW,
    },
    anomalies: {
      total: 11,
      by_severity: { critical: 2, major: 4, minor: 5 },
      top_entities: [
        {
          entity: "service.name=checkout",
          max_score: 93.2,
          timeline: timeline([0, 0, 55, 62, 71, 82, 88, 91, 93, 85, 72, 61]),
        },
        {
          entity: "service.name=shipping",
          max_score: 78.5,
          timeline: timeline([0, 0, 0, 0, 51, 63, 78, 74, 58, 0, 0, 0]),
        },
        {
          entity: "service.name=payments",
          max_score: 64.1,
          timeline: timeline([0, 0, 0, 52, 64, 62, 55, 0, 0, 0, 0, 0]),
        },
        {
          entity: "host.name=node-us-east-4",
          max_score: 56.8,
          timeline: timeline([0, 0, 0, 0, 0, 0, 52, 56, 54, 0, 0, 0]),
        },
        {
          entity: "host.name=node-us-west-1",
          max_score: 51.2,
          timeline: timeline([0, 0, 0, 0, 0, 0, 0, 0, 0, 51, 50, 0]),
        },
      ],
      timeline_window: {
        start_ms: bucketStart,
        end_ms: now,
        bucket_span_ms: BUCKET_SPAN_MS,
      },
    },
    recommendation: "Investigate checkout — p99 latency and error rate both breached baseline in the last 15 minutes.",
    investigation_actions: [
      { label: "Explain the checkout anomaly", prompt: "Explain anomalies for service.name=checkout in prod-us over the last hour" },
      { label: "Service dependencies for checkout", prompt: "Show the service dependencies centered on checkout in prod-us" },
    ],
    rerun_context: {
      tool: "apm-health-summary",
      current_lookback: "1h",
      prompt_template: "Summarize APM health for namespace prod-us over the last {lookback}",
      presets: ["15m", "1h", "6h", "24h"],
    },
  }),
  healthy: fixture("Healthy", {
    overall_health: "healthy",
    namespace: "prod-eu",
    lookback: "1h",
    data_coverage: { apm: true, kubernetes: true, ml_anomalies: true },
    services: {
      total: 12,
      degraded_count: 0,
      details: [
        { service: "frontend", throughput: 4210, avg_latency_ms: 92, error_rate_pct: 0.02 },
        { service: "checkout", throughput: 980, avg_latency_ms: 110, error_rate_pct: 0.0 },
        { service: "search", throughput: 2010, avg_latency_ms: 64, error_rate_pct: 0.01 },
      ],
    },
    degraded_services: [],
    anomalies: { total: 0, by_severity: {} },
    recommendation: "All services are within baseline for the selected window.",
  }),
  criticalOnly: fixture("Critical only", {
    overall_health: "critical",
    namespace: "prod-us",
    lookback: "15m",
    data_coverage: { apm: true, kubernetes: false, ml_anomalies: true },
    services: {
      total: 18,
      degraded_count: 5,
      details: [],
    },
    degraded_services: [
      { service: "checkout", reasons: ["p99 latency > 1.2s", "error rate 9.4%"] },
      { service: "payments", reasons: ["error rate 7.1%", "3 anomalies active"] },
      { service: "shipping", reasons: ["unreachable (no traces in 5m)"] },
      { service: "inventory", reasons: ["p99 latency > 900ms"] },
      { service: "auth", reasons: ["error rate 4.2%"] },
    ],
    anomalies: {
      total: 8,
      by_severity: { critical: 6, major: 2 },
      top_entities: [
        {
          entity: "service.name=checkout",
          max_score: 97.8,
          timeline: timeline([0, 0, 0, 0, 0, 0, 0, 0, 78, 92, 95, 97]),
        },
        {
          entity: "service.name=payments",
          max_score: 94.3,
          timeline: timeline([0, 0, 0, 0, 0, 0, 0, 0, 0, 82, 91, 94]),
        },
      ],
      timeline_window: {
        start_ms: bucketStart,
        end_ms: now,
        bucket_span_ms: BUCKET_SPAN_MS,
      },
    },
    warning: "Kubernetes telemetry is unavailable — pod-level context is hidden.",
    pods_note: "Add kubeletstats integration to see pod-level memory/CPU.",
  }),
};

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { type FixtureSet, fixture } from "./types";

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
        { service: "checkout", throughput: 1203, avg_latency_ms: 412, error_rate_pct: 2.3 },
        { service: "frontend", throughput: 5620, avg_latency_ms: 118, error_rate_pct: 0.1 },
        { service: "search", throughput: 3210, avg_latency_ms: 89, error_rate_pct: 0.05 },
        { service: "payments", throughput: 980, avg_latency_ms: 245, error_rate_pct: 1.8 },
        { service: "inventory", throughput: 2104, avg_latency_ms: 56, error_rate_pct: 0 },
        { service: "shipping", throughput: 420, avg_latency_ms: 302, error_rate_pct: 3.5 },
      ],
    },
    degraded_services: [
      { service: "checkout", reasons: ["p99 latency > 800ms", "error rate 2.3%"] },
      { service: "payments", reasons: ["error rate 1.8%"] },
      { service: "shipping", reasons: ["error rate 3.5%", "5 anomalies active"] },
    ],
    pods: {
      total: 147,
      top_memory: [
        { pod: "checkout-api-7fd9-xk12", avg_memory_mb: 1820, avg_cpu_cores: 0.9 },
        { pod: "payments-worker-3ab0-qq7p", avg_memory_mb: 1640, avg_cpu_cores: 0.55 },
        { pod: "frontend-6f4d-11zz", avg_memory_mb: 1410, avg_cpu_cores: 0.4 },
        { pod: "search-indexer-aa12-k0ll", avg_memory_mb: 1280, avg_cpu_cores: 0.7 },
      ],
    },
    anomalies: {
      total: 11,
      by_severity: { critical: 2, major: 4, minor: 5 },
      top_entities: [
        { entity: "service.name=checkout", max_score: 93.2 },
        { entity: "service.name=shipping", max_score: 78.5 },
        { entity: "service.name=payments", max_score: 64.1 },
      ],
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
        { entity: "service.name=checkout", max_score: 97.8 },
        { entity: "service.name=payments", max_score: 94.3 },
      ],
    },
    warning: "Kubernetes telemetry is unavailable — pod-level context is hidden.",
    pods_note: "Add kubeletstats integration to see pod-level memory/CPU.",
  }),
};

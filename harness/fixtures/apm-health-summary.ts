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
    scope: {
      current_cluster: "prod-us-east",
      k8s_namespace: "prod-us",
      service_count: 10,
      pod_count: 42,
      service_groups_source: "service.namespace",
      service_groups: [
        // checkout app spans this namespace + prod-payments → ⤴ chip
        { label: "checkout", services: ["checkout", "cart", "inventory"], total: 5 },
        { label: "payments", services: ["payments", "billing", "ledger", "fraud"] },
        { label: "frontend", services: ["frontend", "search"] },
        { label: "infra", services: ["auth"] },
      ],
    },
    services: {
      total: 18,
      degraded_count: 3,
      details: [
        {
          service: "checkout",
          app: "checkout",
          throughput: 1203,
          avg_latency_ms: 412,
          p99_latency_ms: 612,
          error_rate_pct: 2.3,
          timeline: metricTimeline([1100, 1120, 1180, 1240, 1290, 1310, 1280, 1220, 1190, 1170, 1190, 1203]),
          peak_throughput: 1310,
        },
        {
          service: "frontend",
          app: "frontend",
          throughput: 5620,
          avg_latency_ms: 118,
          p99_latency_ms: 240,
          error_rate_pct: 0.1,
          timeline: metricTimeline([5100, 5180, 5260, 5340, 5420, 5500, 5580, 5620, 5680, 5700, 5690, 5620]),
          peak_throughput: 5700,
        },
        {
          service: "search",
          app: "frontend",
          throughput: 3210,
          avg_latency_ms: 89,
          p99_latency_ms: 180,
          error_rate_pct: 0.05,
          timeline: metricTimeline([3100, 3180, 3240, 3280, 3300, 3280, 3260, 3240, 3220, 3210, 3200, 3210]),
          peak_throughput: 3300,
        },
        {
          service: "payments",
          app: "payments",
          throughput: 980,
          avg_latency_ms: 245,
          p99_latency_ms: 480,
          error_rate_pct: 1.8,
          timeline: metricTimeline([920, 940, 960, 985, 1010, 1020, 1000, 990, 970, 975, 985, 980]),
          peak_throughput: 1020,
        },
        {
          service: "inventory",
          app: "checkout",
          throughput: 2104,
          avg_latency_ms: 56,
          p99_latency_ms: 110,
          error_rate_pct: 0,
          timeline: metricTimeline([2100, 2098, 2105, 2110, 2108, 2104, 2101, 2099, 2103, 2106, 2104, 2104]),
          peak_throughput: 2110,
        },
        {
          service: "shipping",
          app: "checkout",
          throughput: 420,
          avg_latency_ms: 302,
          p99_latency_ms: 720,
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
          service: "checkout",
          app: "checkout",
          avg_memory_mb: 1820,
          avg_cpu_cores: 0.9,
          timeline: metricTimeline([1620, 1660, 1690, 1720, 1760, 1790, 1810, 1830, 1850, 1890, 1870, 1820]),
          peak_memory_mb: 1890,
        },
        {
          pod: "payments-worker-3ab0-qq7p",
          service: "payments",
          app: "payments",
          avg_memory_mb: 1640,
          avg_cpu_cores: 0.55,
          timeline: metricTimeline([1580, 1595, 1610, 1620, 1625, 1630, 1640, 1650, 1660, 1655, 1645, 1640]),
          peak_memory_mb: 1660,
        },
        {
          pod: "frontend-6f4d-11zz",
          service: "frontend",
          app: "frontend",
          avg_memory_mb: 1410,
          avg_cpu_cores: 0.4,
          timeline: metricTimeline([1380, 1385, 1392, 1398, 1402, 1406, 1410, 1412, 1415, 1418, 1414, 1410]),
          peak_memory_mb: 1418,
        },
        {
          pod: "search-indexer-aa12-k0ll",
          service: "search",
          app: "frontend",
          avg_memory_mb: 1280,
          avg_cpu_cores: 0.7,
          timeline: metricTimeline([1200, 1210, 1220, 1235, 1250, 1260, 1270, 1280, 1285, 1290, 1295, 1280]),
          peak_memory_mb: 1295,
        },
      ],
      timeline_window: METRIC_WINDOW,
      // Full-namespace per-app rollups so the K8s tile recomputation is
      // honest under filter. Pseudo-keys carry edge cases:
      //   _ungrouped: pods with no resolvable app (sidecars / infra).
      //   _other:     long tail past PODS_BY_APP_CAP, omitted here.
      by_app: {
        checkout: { pod_count: 38, cpu_util_pct: 72, mem_util_pct: 81, restart_count: 3 },
        frontend: { pod_count: 24, cpu_util_pct: 65, mem_util_pct: 68, restart_count: 0 },
        payments: { pod_count: 31, cpu_util_pct: 82, mem_util_pct: 88, restart_count: 4 },
        infra: { pod_count: 14, cpu_util_pct: 41, mem_util_pct: 52, restart_count: 0 },
        _ungrouped: { pod_count: 6, cpu_util_pct: 38, mem_util_pct: 44, restart_count: 0 },
      },
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
      // Per-entity counts so the donut + total chip recompute under
      // filter. Sum of (entity totals) + _other reconciles to the
      // namespace-wide total above.
      by_entity: {
        "service.name=checkout": { total: 4, by_severity: { critical: 1, major: 2, minor: 1 } },
        "service.name=shipping": { total: 3, by_severity: { critical: 1, major: 1, minor: 1 } },
        "service.name=payments": { total: 2, by_severity: { major: 1, minor: 1 } },
        "host.name=node-us-east-4": { total: 1, by_severity: { minor: 1 } },
        "host.name=node-us-west-1": { total: 1, by_severity: { minor: 1 } },
      },
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
    apm_tiles: {
      tiles: [
        {
          key: "throughput",
          label: "Throughput",
          value_display: "13.7K",
          unit: "rpm",
          timeline: metricTimeline([12200, 12400, 12700, 13000, 13200, 13400, 13500, 13600, 13680, 13720, 13700, 13700]),
          peak: 13720,
        },
        {
          key: "latency_p99",
          label: "p99 latency",
          value_display: "612",
          unit: "ms",
          timeline: metricTimeline([320, 340, 360, 410, 480, 520, 580, 610, 640, 660, 630, 612]),
          peak: 660,
          status: "degraded",
        },
        {
          key: "error_rate",
          label: "Error rate",
          value_display: "0.61",
          unit: "%",
          timeline: metricTimeline([0.1, 0.2, 0.2, 0.3, 0.4, 0.5, 0.6, 0.65, 0.72, 0.78, 0.65, 0.61]),
          peak: 0.78,
          status: "ok",
        },
        {
          key: "services",
          label: "Services",
          value_display: "18",
          secondary: "3 degraded",
          status: "critical",
        },
      ],
      timeline_window: METRIC_WINDOW,
    },
    k8s_tiles: {
      tiles: [
        {
          key: "cpu",
          label: "CPU",
          value_display: "62",
          unit: "%",
          timeline: metricTimeline([45, 48, 52, 55, 57, 60, 62, 64, 65, 64, 63, 62]),
          peak: 65,
          status: "ok",
        },
        {
          key: "memory",
          label: "Memory",
          value_display: "84",
          unit: "%",
          timeline: metricTimeline([72, 74, 76, 78, 80, 82, 83, 84, 85, 86, 85, 84]),
          peak: 86,
          status: "degraded",
        },
        {
          key: "restarts",
          label: "Restarts",
          value_display: "3",
          secondary: "last 1h",
          timeline: metricTimeline([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0]),
          peak: 1,
          spark: "bar",
          status: "degraded",
        },
        {
          key: "nodes",
          label: "Nodes",
          value_display: "5",
          secondary: "all ready",
          status: "ok",
        },
      ],
      timeline_window: METRIC_WINDOW,
    },
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
  apmOnly: fixture("APM only (no k8s)", {
    overall_health: "critical",
    namespace: "prod-us",
    lookback: "15m",
    data_coverage: { apm: true, kubernetes: false, ml_anomalies: true },
    scope: {
      // No cluster / k8s_namespace — APM-only deployments don't have those.
      // Environment is the primary scope axis here.
      environment: "production",
      service_count: 18,
      service_groups_source: "service.namespace",
      service_groups: [
        { label: "checkout", services: ["checkout", "cart", "inventory"] },
        { label: "payments", services: ["payments", "billing", "ledger", "fraud"] },
        { label: "frontend", services: ["frontend", "search", "shipping"] },
        { label: "infra", services: ["auth", "notifications"] },
      ],
    },
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
      by_entity: {
        "service.name=checkout": { total: 4, by_severity: { critical: 3, major: 1 } },
        "service.name=payments": { total: 3, by_severity: { critical: 2, major: 1 } },
        "service.name=shipping": { total: 1, by_severity: { critical: 1 } },
      },
      timeline_window: {
        start_ms: bucketStart,
        end_ms: now,
        bucket_span_ms: BUCKET_SPAN_MS,
      },
    },
    warning: "Kubernetes telemetry is unavailable — pod-level context is hidden.",
    pods_note: "Add kubeletstats integration to see pod-level memory/CPU.",
  }),
  k8sOnly: fixture("K8s only (no APM)", {
    overall_health: "degraded",
    namespace: "prod-us",
    lookback: "1h",
    data_coverage: { apm: false, kubernetes: true, ml_anomalies: true },
    scope: {
      current_cluster: "prod-us-east",
      k8s_namespace: "prod-us",
      pod_count: 42,
      node_count: 6,
      service_groups_source: "k8s_label",
      service_groups: [
        // App grouping derived from `app.kubernetes.io/name` since APM
        // isn't around to provide service.namespace.
        { label: "payments", services: ["payments-api", "payments-worker", "ledger"] },
        { label: "frontend", services: ["frontend-web", "frontend-bff"] },
        { label: "infra", services: ["nginx-ingress", "cert-manager", "prometheus"] },
      ],
    },
    services: {
      // No APM = no service-level telemetry; the view should hide the
      // service throughput section. Counts here are the k8s-side view of
      // "deployments observable via labels", not APM services.
      total: 0,
      degraded_count: 0,
      details: [],
    },
    degraded_services: [],
    pods: {
      total: 42,
      top_memory: [
        {
          pod: "payments-api-7d8f9c-x4n2k",
          // App resolved from k8s label app.kubernetes.io/name in this
          // coverage state (no APM = no service.namespace).
          app: "payments",
          avg_memory_mb: 1820,
          peak_memory_mb: 2010,
          timeline: metricTimeline([1700, 1740, 1780, 1820, 1860, 1900, 1950, 2010, 1980, 1900, 1850, 1820]),
        },
        {
          pod: "ledger-6b9d-xyz12",
          app: "payments",
          avg_memory_mb: 1340,
          peak_memory_mb: 1480,
          timeline: metricTimeline([1280, 1300, 1320, 1340, 1360, 1400, 1440, 1480, 1450, 1400, 1360, 1340]),
        },
        {
          pod: "frontend-web-5c7-abc34",
          app: "frontend",
          avg_memory_mb: 920,
          peak_memory_mb: 980,
          timeline: metricTimeline([880, 890, 900, 920, 940, 960, 980, 970, 950, 930, 920, 920]),
        },
      ],
      timeline_window: METRIC_WINDOW,
      by_app: {
        payments: { pod_count: 18, cpu_util_pct: 84, mem_util_pct: 92, restart_count: 5 },
        frontend: { pod_count: 12, cpu_util_pct: 64, mem_util_pct: 70, restart_count: 1 },
        infra: { pod_count: 9, cpu_util_pct: 38, mem_util_pct: 51, restart_count: 1 },
        _ungrouped: { pod_count: 3, cpu_util_pct: 22, mem_util_pct: 31, restart_count: 0 },
      },
    },
    k8s_tiles: {
      timeline_window: METRIC_WINDOW,
      tiles: [
        {
          key: "cpu_util",
          label: "CPU utilization",
          value_display: "78",
          unit: "%",
          status: "degraded",
          timeline: metricTimeline([62, 64, 68, 72, 75, 78, 82, 85, 84, 80, 79, 78]),
          spark: "line",
        },
        {
          key: "mem_util",
          label: "Memory utilization",
          value_display: "91",
          unit: "%",
          status: "critical",
          timeline: metricTimeline([78, 80, 83, 85, 87, 89, 91, 93, 92, 91, 91, 91]),
          spark: "line",
        },
        {
          key: "restarts",
          label: "Pod restarts",
          value_display: "7",
          status: "degraded",
          secondary: "across 3 pods",
          timeline: metricTimeline([0, 0, 1, 0, 2, 0, 1, 0, 1, 0, 2, 0]),
          spark: "bar",
        },
        { key: "pods", label: "Pods", value_display: "42", status: "ok" },
        { key: "nodes", label: "Nodes", value_display: "6", status: "ok" },
      ],
    },
    anomalies: {
      total: 4,
      by_severity: { major: 2, minor: 2 },
      top_entities: [
        {
          entity: "k8s.pod.name=payments-api-7d8f9c-x4n2k",
          max_score: 84,
          timeline: timeline([0, 0, 0, 0, 0, 60, 70, 78, 82, 84, 80, 76]),
        },
        {
          entity: "host.name=node-us-east-3",
          max_score: 71,
          timeline: timeline([0, 0, 0, 0, 0, 0, 55, 62, 68, 71, 69, 65]),
        },
      ],
      by_entity: {
        // Pod entity → maps to "payments" app via podToApp on the view.
        "k8s.pod.name=payments-api-7d8f9c-x4n2k": { total: 2, by_severity: { major: 2 } },
        // Host-level entity doesn't resolve to any app — counts as
        // _other when the user filters down to just app(s).
        "host.name=node-us-east-3": { total: 2, by_severity: { minor: 2 } },
      },
      timeline_window: METRIC_WINDOW,
    },
    warning: "APM telemetry is unavailable — service-level latency / error rates are hidden.",
  }),
};

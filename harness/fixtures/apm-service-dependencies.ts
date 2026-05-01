/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { type FixtureSet, fixture } from "./types";

export const apmServiceDependenciesFixtures: FixtureSet = {
  checkoutGraph: fixture("Checkout subgraph", {
    service_count: 8,
    edge_count: 9,
    focal_service: "checkout",
    upstream: ["frontend"],
    downstream: ["payments", "inventory", "shipping"],
    services: [
      { name: "frontend", role: "root", language: "nodejs", deployment: "frontend", namespace: "prod-us",
        health: { span_count: 56200, avg_duration_us: 92000, p99_duration_us: 220000, error_count: 45 } },
      { name: "checkout", role: "internal", language: "go", deployment: "checkout-api", namespace: "prod-us",
        health: { span_count: 12300, avg_duration_us: 412000, p99_duration_us: 890000, error_count: 280 } },
      { name: "payments", role: "internal", language: "java", deployment: "payments", namespace: "prod-us",
        health: { span_count: 9800, avg_duration_us: 245000, p99_duration_us: 540000, error_count: 178 } },
      { name: "inventory", role: "internal", language: "python", deployment: "inventory", namespace: "prod-us",
        health: { span_count: 21000, avg_duration_us: 56000, p99_duration_us: 140000, error_count: 8 } },
      { name: "shipping", role: "leaf", language: "rust", deployment: "shipping", namespace: "prod-us",
        health: { span_count: 4200, avg_duration_us: 302000, p99_duration_us: 710000, error_count: 149 } },
      { name: "postgres-primary", role: "leaf", deployment: "postgres", namespace: "data-prod-us",
        health: { span_count: 18200, avg_duration_us: 8000, p99_duration_us: 36000, error_count: 2 } },
      { name: "redis-cache", role: "leaf", deployment: "redis", namespace: "data-prod-us",
        health: { span_count: 42000, avg_duration_us: 900, p99_duration_us: 3200 } },
      { name: "stripe-gateway", role: "leaf", deployment: "external", namespace: "external",
        health: { span_count: 3800, avg_duration_us: 186000, p99_duration_us: 420000, error_count: 41 } },
    ],
    edges: [
      { source: "frontend", target: "checkout", call_count: 12300, protocol: "HTTP", port: "8080", avg_latency_us: 412000 },
      { source: "checkout", target: "payments", call_count: 9800, protocol: "HTTP", port: "8080" },
      { source: "checkout", target: "inventory", call_count: 11200, protocol: "gRPC", port: "9090" },
      { source: "checkout", target: "shipping", call_count: 4100, protocol: "HTTP", port: "8080" },
      { source: "checkout", target: "postgres-primary", call_count: 14100, protocol: "pgwire", port: "5432" },
      { source: "checkout", target: "redis-cache", call_count: 38400, protocol: "RESP", port: "6379" },
      { source: "payments", target: "postgres-primary", call_count: 4100, protocol: "pgwire", port: "5432" },
      { source: "payments", target: "stripe-gateway", call_count: 3800, protocol: "HTTPS", port: "443" },
      { source: "shipping", target: "postgres-primary", call_count: 4000, protocol: "pgwire", port: "5432" },
    ],
    filters: { lookback: "1h", namespace: "prod-us" },
    data_coverage: { apm: true },
    investigation_actions: [
      { label: "Explain the checkout anomaly", prompt: "Explain anomalies for service.name=checkout over the last 1h" },
    ],
    rerun_context: {
      tool: "apm-service-dependencies",
      current_lookback: "1h",
      prompt_template: "Show service dependencies centered on checkout over the last {lookback}",
      presets: ["15m", "1h", "6h", "24h"],
    },
  }, "Show me what checkout depends on."),
  small: fixture("Minimal (3 services)", {
    service_count: 3,
    edge_count: 2,
    focal_service: "frontend",
    services: [
      { name: "frontend", role: "root", language: "nodejs", health: { span_count: 2100, avg_duration_us: 80000, error_count: 2 } },
      { name: "api", role: "internal", language: "go", health: { span_count: 2050, avg_duration_us: 45000 } },
      { name: "postgres", role: "leaf", health: { span_count: 2000, avg_duration_us: 8000 } },
    ],
    edges: [
      { source: "frontend", target: "api", call_count: 2050, protocol: "HTTP" },
      { source: "api", target: "postgres", call_count: 2000, protocol: "pgwire" },
    ],
    filters: { lookback: "1h" },
    data_coverage: { apm: true },
  }, "Map the service graph for frontend."),
  empty: fixture("No APM data", {
    service_count: 0,
    edge_count: 0,
    services: [],
    edges: [],
    filters: { lookback: "1h" },
    data_coverage: { apm: false },
    data_coverage_note: "No APM traces found for the selected window.",
  }, "What's calling what in prod-us?"),
  // Demo for severity-aware edges + "called slowly" tag + anomalies
  // banner. The recommendation → flagd edge sits at 600s avg latency
  // — way past the 10s critical floor and 3000× the next-slowest
  // edge. Triggers the red edge styling, the leaf-node "called slowly"
  // tag on flagd, and the top-of-graph anomalies banner.
  criticalEdge: fixture("Critical-latency edge (flagd timeout pattern)", {
    focal_service: "recommendation",
    upstream: ["frontend"],
    downstream: ["product-catalog", "flagd"],
    service_count: 4,
    edge_count: 3,
    services: [
      {
        name: "frontend",
        role: "root",
        language: "nodejs",
        deployment: "frontend",
        namespace: "oteldemo",
        health: { span_count: 157402, avg_duration_us: 161742, p99_duration_us: 2617851, error_count: 739 },
      },
      {
        name: "recommendation",
        role: "internal",
        language: "python",
        namespace: "oteldemo",
        health: { span_count: 17396, avg_duration_us: 14035379, p99_duration_us: 600005543, error_count: 91 },
      },
      {
        name: "product-catalog",
        role: "leaf",
        health: { span_count: 2710, avg_duration_us: 11687 },
      },
      {
        name: "flagd",
        role: "leaf",
        health: { span_count: 4140, avg_duration_us: 240 },
      },
    ],
    edges: [
      { source: "frontend", target: "recommendation", call_count: 83, protocol: "grpc", port: "8080", avg_latency_us: 529001 },
      { source: "recommendation", target: "product-catalog", call_count: 43, protocol: "grpc", avg_latency_us: 11687 },
      { source: "recommendation", target: "flagd", call_count: 6, protocol: "grpc", avg_latency_us: 600005572 },
    ],
    filters: { lookback: "1h" },
    investigation_actions: [
      {
        label: "Check flagd pod health",
        prompt: "Use apm-health-summary to check the pod hosting flagd for resource pressure or restarts.",
      },
    ],
  }, "Map dependencies for recommendation — and tell me why everyone's hanging."),
};

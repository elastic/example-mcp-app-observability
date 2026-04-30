/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { type FixtureSet, fixture } from "./types";

export const k8sBlastRadiusFixtures: FixtureSet = {
  atRisk: fixture("Node at risk", {
    node: "ip-10-0-12-84.us-east-2.compute.internal",
    status: "AT RISK",
    data_coverage: { kubernetes: true, apm: true },
    pods_at_risk: 14,
    full_outage: [
      { deployment: "checkout-api", namespace: "prod-us", pods_on_node: 3, pods_total: 3, surviving: 0, memory: "6.4 GB", memory_bytes: 6871947673 },
      { deployment: "redis-cache", namespace: "data-prod-us", pods_on_node: 2, pods_total: 2, surviving: 0, memory: "2.0 GB", memory_bytes: 2147483648 },
    ],
    degraded: [
      { deployment: "frontend", namespace: "prod-us", pods_on_node: 2, pods_total: 6, surviving: 4, memory: "4.1 GB", memory_bytes: 4402341478 },
      { deployment: "payments", namespace: "prod-us", pods_on_node: 1, pods_total: 3, surviving: 2, memory: "1.8 GB", memory_bytes: 1932735283 },
      { deployment: "inventory", namespace: "prod-us", pods_on_node: 2, pods_total: 4, surviving: 2, memory: "2.4 GB", memory_bytes: 2576980377 },
      { deployment: "shipping", namespace: "prod-us", pods_on_node: 1, pods_total: 2, surviving: 1, memory: "1.2 GB", memory_bytes: 1288490188 },
    ],
    unaffected_count: 31,
    unaffected: [
      { deployment: "search", namespace: "prod-us", pods_total: 4 },
      { deployment: "auth", namespace: "prod-us", pods_total: 3 },
    ],
    rescheduling: {
      memory_required: "17.9 GB",
      memory_available: "11.2 GB",
      remaining_nodes: 5,
      feasible: false,
    },
    downstream_services: [
      { service: "checkout", namespace: "prod-us" },
      { service: "frontend", namespace: "prod-us" },
      { service: "payments", namespace: "prod-us" },
      { service: "shipping", namespace: "prod-us" },
    ],
    investigation_actions: [
      { label: "Identify pods to evict first", prompt: "List pods on ip-10-0-12-84 sorted by memory" },
      { label: "Add capacity", prompt: "Show available node groups in us-east-2" },
    ],
  }, "What happens if I drain ip-10-0-12-84.us-east-2.compute.internal?"),
  partial: fixture("Partial risk", {
    node: "ip-10-0-20-14.us-east-2.compute.internal",
    status: "PARTIAL RISK",
    data_coverage: { kubernetes: true, apm: true },
    pods_at_risk: 4,
    full_outage: [],
    degraded: [
      { deployment: "search", namespace: "prod-us", pods_on_node: 1, pods_total: 4, surviving: 3, memory: "1.1 GB", memory_bytes: 1181116006 },
      { deployment: "auth", namespace: "prod-us", pods_on_node: 1, pods_total: 3, surviving: 2, memory: "0.7 GB", memory_bytes: 751619276 },
      { deployment: "frontend", namespace: "prod-us", pods_on_node: 2, pods_total: 6, surviving: 4, memory: "4.1 GB", memory_bytes: 4402341478 },
    ],
    unaffected_count: 44,
    unaffected: [],
    rescheduling: {
      memory_required: "5.9 GB",
      memory_available: "18.4 GB",
      remaining_nodes: 7,
      feasible: true,
    },
    investigation_actions: [],
  }, "Blast radius for ip-10-0-20-14 — safe to take it offline?"),
  safe: fixture("Safe", {
    node: "ip-10-0-30-07.us-east-2.compute.internal",
    status: "SAFE",
    data_coverage: { kubernetes: true, apm: false },
    pods_at_risk: 0,
    full_outage: [],
    degraded: [],
    unaffected_count: 58,
    unaffected: [],
    rescheduling: {
      memory_required: "0 GB",
      memory_available: "22.0 GB",
      remaining_nodes: 7,
      feasible: true,
    },
    downstream_services_note: "APM not configured — downstream user-facing service impact is unavailable.",
  }, "Is it safe to drain ip-10-0-30-07 for maintenance?"),
};

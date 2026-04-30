/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { type FixtureSet, fixture } from "./types";

const ruleA = {
  id: "8f3a-b2c1-001",
  name: "frontend · p99 latency above 800ms",
  rule_type_id: ".esql-query",
  enabled: true,
  tags: ["frontend", "latency", "sre"],
  schedule_interval: "1m",
  execution_status: "active",
  last_run_outcome: "succeeded",
  active_alert_count: 3,
  created_at: "2026-03-14T10:12:00Z",
  updated_at: "2026-04-22T14:08:00Z",
  condition: "> 800",
  window: "5m",
  index_pattern: "traces-apm-*",
  kql_filter: "service.name: checkout",
};

const ruleB = {
  id: "6d19-a4e7-002",
  name: "postgres · connection pool saturation",
  rule_type_id: ".threshold",
  enabled: true,
  tags: ["db", "postgres"],
  schedule_interval: "30s",
  execution_status: "active",
  last_run_outcome: "succeeded",
  active_alert_count: 0,
  created_at: "2026-02-02T08:30:00Z",
  updated_at: "2026-04-19T09:02:00Z",
  condition: ">= 90",
  window: "2m",
  index_pattern: "metrics-postgres.*",
  kql_filter: null,
};

const ruleC = {
  id: "2c71-8b04-003",
  name: "checkout · error rate > 2%",
  rule_type_id: ".esql-query",
  enabled: false,
  tags: ["checkout", "errors"],
  schedule_interval: "1m",
  execution_status: "warning",
  last_run_outcome: "warning",
  active_alert_count: null,
  created_at: "2026-01-21T17:00:00Z",
  updated_at: "2026-04-05T11:47:00Z",
  condition: "> 0.02",
  window: "10m",
  index_pattern: "logs-*",
  kql_filter: "log.level: error AND service.name: checkout",
};

const ruleD = {
  id: "91fa-ccd5-004",
  name: "node memory pressure — prod-us",
  rule_type_id: ".threshold",
  enabled: true,
  tags: ["k8s", "memory", "prod-us"],
  schedule_interval: "1m",
  execution_status: "error",
  last_run_outcome: "failed",
  active_alert_count: 1,
  created_at: "2026-04-01T06:00:00Z",
  updated_at: "2026-04-23T07:34:00Z",
  condition: "> 0.92",
  window: "3m",
  index_pattern: "metrics-kubeletstats-*",
  kql_filter: null,
};

export const manageAlertsFixtures: FixtureSet = {
  list: fixture("List (4 rules)", {
    status: "success",
    operation: "list",
    total: 4,
    returned: 4,
    page: 1,
    per_page: 25,
    filter_summary: "all rules",
    rules: [ruleA, ruleB, ruleC, ruleD],
    investigation_actions: [
      { label: "Disable failing rule", prompt: "Disable rule 91fa-ccd5-004" },
      { label: "Show only enabled rules", prompt: "List alert rules where enabled=true" },
    ],
  }, "List my alert rules."),
  listEmpty: fixture("List (no rules)", {
    status: "success",
    operation: "list",
    total: 0,
    returned: 0,
    page: 1,
    per_page: 25,
    rules: [],
    message: "No alert rules found in this Kibana space.",
  }, "What alert rules are configured?"),
  get: fixture("Detail (single rule)", {
    status: "success",
    operation: "get",
    rule: ruleA,
    investigation_actions: [
      { label: "Disable this rule", prompt: `Disable rule ${ruleA.id}` },
      { label: "Delete this rule", prompt: `Delete rule ${ruleA.id}` },
    ],
  }, "Show me the checkout p99 latency alert rule."),
  create: fixture("Created", {
    status: "success",
    operation: "create",
    rule_id: "new-7ab2-005",
    rule_name: "checkout · p95 latency above 400ms",
    rule_type: ".esql-query",
    threshold: 400,
    comparator: ">",
    check_interval: "1m",
    time_size: 5,
    time_unit: "m",
    kql_filter: "service.name: checkout",
    index_pattern: "traces-apm-*",
    tags: ["checkout", "latency"],
    enabled: true,
    message: "Rule created and enabled.",
  }, "Create an alert for checkout when p95 latency exceeds 400ms."),
  error: fixture("Error", {
    status: "error",
    error: "kibana_unreachable",
    message: "Kibana API returned 503 (connect ECONNREFUSED).",
  }, "List my alert rules."),
  deleteConfirm: fixture(
    "Delete (confirmation pending)",
    {
      status: "success",
      operation: "delete",
      rule_id: ruleA.id,
      deleted: false,
      confirmation_required: true,
      preview: ruleA,
      investigation_actions: [
        { label: "Cancel deletion", prompt: "Cancel the deletion of this rule." },
      ],
    },
    "Delete the alert rule 'checkout · p99 latency above 800ms'."
  ),
};

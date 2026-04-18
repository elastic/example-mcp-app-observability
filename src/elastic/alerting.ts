/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { kibanaRequest } from "./client.js";

/**
 * Produce a human-readable Kibana saved-object id from the rule name + check interval:
 * lowercase slug of alphanumeric + hyphen, capped at 60 chars, suffixed with the
 * check interval. Example: "Frontend Pod Memory > 80MB" @ 5m → "frontend-pod-memory-80mb-5m".
 *
 * The id is deterministic from (ruleName, checkInterval) — creating the same rule twice
 * surfaces as a Kibana 409 conflict rather than silently producing a duplicate. That's
 * intentional: it's easier for an operator to reconcile ("you already have that rule")
 * than to clean up a quiet pile of near-duplicates.
 *
 * The `elastic-o11y-mcp` provenance is carried by the tag, so it isn't duplicated here.
 */
function buildReadableRuleId(ruleName: string, checkInterval: string): string {
  const slug = ruleName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  const intervalSlug = checkInterval
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 8);
  const safeInterval = intervalSlug || "interval";
  return slug ? `${slug}-${safeInterval}` : `rule-${safeInterval}`;
}

export type Comparator = ">" | ">=" | "<" | "<=";
export type AggType = "avg" | "max" | "min" | "sum" | "count";
export type TimeUnit = "m" | "h" | "d";

export interface CreateThresholdRuleInput {
  ruleName: string;
  metricField: string;
  threshold: number;
  comparator?: Comparator;
  kqlFilter?: string;
  checkInterval?: string;
  aggType?: AggType;
  timeSize?: number;
  timeUnit?: TimeUnit;
  indexPattern?: string;
  tags?: string[];
}

export interface CreatedRule {
  id: string;
  name: string;
  tags: string[];
  enabled: boolean;
  rule_type_id: string;
}

export interface RuleExecutionStatus {
  status?: string;
  last_execution_date?: string;
  last_duration?: number;
  error?: { reason?: string; message?: string };
}

export interface ListedRule {
  id: string;
  name: string;
  tags: string[];
  enabled: boolean;
  rule_type_id: string;
  consumer?: string;
  schedule?: { interval?: string };
  params?: Record<string, unknown>;
  execution_status?: RuleExecutionStatus;
  last_run?: {
    outcome?: string;
    outcome_msg?: string[] | string | null;
    alerts_count?: { active?: number; new?: number; recovered?: number; ignored?: number };
  };
  mute_all?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ListRulesInput {
  tags?: string[];
  search?: string;
  ruleTypeIds?: string[];
  perPage?: number;
  page?: number;
}

export interface ListRulesResult {
  page: number;
  per_page: number;
  total: number;
  data: ListedRule[];
}

export async function createCustomThresholdRule(
  input: CreateThresholdRuleInput
): Promise<CreatedRule> {
  const body = {
    name: input.ruleName,
    rule_type_id: "observability.rules.custom_threshold",
    consumer: "alerts",
    schedule: { interval: input.checkInterval ?? "5m" },
    params: {
      criteria: [
        {
          metrics: [
            {
              name: "A",
              aggType: input.aggType ?? "avg",
              field: input.metricField,
            },
          ],
          comparator: input.comparator ?? ">",
          threshold: [input.threshold],
          timeSize: input.timeSize ?? 5,
          timeUnit: input.timeUnit ?? "m",
        },
      ],
      searchConfiguration: {
        index: input.indexPattern ?? "metrics-*",
        query: {
          query: input.kqlFilter ?? "",
          language: "kuery",
        },
      },
      alertOnNoData: true,
      alertOnGroupDisappear: true,
    },
    actions: [],
    tags: input.tags ?? ["elastic-o11y-mcp"],
    enabled: true,
  };

  const id = buildReadableRuleId(input.ruleName, input.checkInterval ?? "5m");
  return kibanaRequest<CreatedRule>(`/api/alerting/rule/${encodeURIComponent(id)}`, { body });
}

export async function listRules(input: ListRulesInput = {}): Promise<ListRulesResult> {
  const params: Record<string, string> = {
    per_page: String(input.perPage ?? 50),
    page: String(input.page ?? 1),
  };

  // Kibana's `_find` KQL-style filter runs against the raw saved-object document,
  // so fields must be namespaced as `alert.attributes.<field>`.
  const filterClauses: string[] = [];
  if (input.tags && input.tags.length) {
    const tagExpr = input.tags.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(" OR ");
    filterClauses.push(`alert.attributes.tags:(${tagExpr})`);
  }
  if (input.ruleTypeIds && input.ruleTypeIds.length) {
    const typeExpr = input.ruleTypeIds.map((t) => `"${t}"`).join(" OR ");
    filterClauses.push(`alert.attributes.alertTypeId:(${typeExpr})`);
  }
  if (filterClauses.length) {
    params.filter = filterClauses.join(" AND ");
  }
  if (input.search) {
    params.search = input.search;
    params.search_fields = "name";
  }

  return kibanaRequest<ListRulesResult>("/api/alerting/rules/_find", {
    method: "GET",
    params,
  });
}

export async function getRule(ruleId: string): Promise<ListedRule> {
  return kibanaRequest<ListedRule>(`/api/alerting/rule/${encodeURIComponent(ruleId)}`, {
    method: "GET",
  });
}

export async function deleteRule(ruleId: string): Promise<void> {
  await kibanaRequest(`/api/alerting/rule/${encodeURIComponent(ruleId)}`, {
    method: "DELETE",
  });
}

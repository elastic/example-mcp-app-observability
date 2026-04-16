/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { kibanaRequest } from "./client.js";

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

export async function createCustomThresholdRule(
  input: CreateThresholdRuleInput
): Promise<CreatedRule> {
  const body = {
    name: input.ruleName,
    rule_type_id: "observability.rules.custom_threshold",
    consumer: "alerts",
    schedule: { interval: input.checkInterval ?? "1m" },
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

  return kibanaRequest<CreatedRule>("/api/alerting/rule", { body });
}

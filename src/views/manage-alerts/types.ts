/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { InvestigationAction } from "@shared/components";

export interface RuleSummary {
  id: string;
  name: string;
  rule_type_id: string;
  enabled: boolean;
  tags?: string[];
  schedule_interval?: string | null;
  execution_status?: string | null;
  last_run_outcome?: string | null;
  active_alert_count?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  condition?: string | null;
  window?: string | null;
  index_pattern?: string | null;
  kql_filter?: string | null;
}

export interface CreateResult {
  status: "success";
  operation: "create";
  rule_id: string;
  rule_name: string;
  rule_type?: string;
  metric_field?: string;
  threshold?: number;
  comparator?: string;
  check_interval?: string;
  agg_type?: string;
  time_size?: number;
  time_unit?: string;
  kql_filter?: string;
  index_pattern?: string;
  tags?: string[];
  enabled?: boolean;
  message?: string;
  investigation_actions?: InvestigationAction[];
}

export interface ListResult {
  status: "success";
  operation: "list";
  total: number;
  returned: number;
  page: number;
  per_page: number;
  filter_summary?: string;
  filter_tags?: string[] | null;
  rules: RuleSummary[];
  message?: string;
  investigation_actions?: InvestigationAction[];
}

export interface GetResult {
  status: "success";
  operation: "get";
  rule: RuleSummary;
  message?: string;
  investigation_actions?: InvestigationAction[];
}

export interface DeleteResult {
  status: "success";
  operation: "delete";
  rule_id: string;
  deleted: boolean;
  confirmation_required?: boolean;
  preview?: RuleSummary;
  message?: string;
  investigation_actions?: InvestigationAction[];
}

export interface ErrorResult {
  status: "error";
  error?: string;
  message?: string;
}

export type Result = CreateResult | ListResult | GetResult | DeleteResult | ErrorResult;

/** Derived health bucket for a rule — drives stripe color + "Errors" tab. */
export type RuleHealth = "ok" | "alerting" | "disabled" | "error";

/** Status filter tab keys. */
export type StatusTab = "all" | "enabled" | "disabled" | "errors";

/** Sort options exposed in the list toolkit. */
export type SortKey = "attention" | "name" | "updated" | "enabled-first";

/** Group-by keys exposed in the list toolkit. */
export type GroupKey = "none" | "rule-type" | "status" | "tag" | "index";

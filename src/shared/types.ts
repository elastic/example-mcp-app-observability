/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export interface ElasticConfig {
  elasticsearchUrl: string;
  elasticsearchApiKey: string;
  kibanaUrl: string;
  kibanaApiKey: string;
}

export interface EsqlResult {
  columns: { name: string; type: string }[];
  values: unknown[][];
}

export type Severity = "minor" | "major" | "critical";

export const SEVERITY_COLORS: Record<Severity, string> = {
  minor: "#54b399",
  major: "#d6bf57",
  critical: "#e7664c",
};

export const SEVERITY_ORDER: Record<Severity, number> = {
  minor: 0,
  major: 1,
  critical: 2,
};

export interface AnomalyRecord {
  timestamp: string;
  jobId: string;
  resultType: string;
  recordScore: number;
  initialRecordScore: number;
  isInterim: boolean;
  detectorIndex: number;
  actual?: number[];
  typical?: number[];
  functionName?: string;
  fieldName?: string;
  partitionFieldName?: string;
  partitionFieldValue?: string;
  byFieldName?: string;
  byFieldValue?: string;
  overFieldName?: string;
  overFieldValue?: string;
  severity: Severity;
  deviationPercent?: number;
}

export interface AlertRulePayload {
  name: string;
  ruleTypeId: string;
  consumer: string;
  schedule: { interval: string };
  params: Record<string, unknown>;
  actions: unknown[];
  tags?: string[];
  notifyWhen?: string;
  throttle?: string | null;
  enabled?: boolean;
}

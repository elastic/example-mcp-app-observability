/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { InvestigationAction } from "@shared/components";
import type { RerunContext } from "@shared/components";

export type AnomalySeverity = "critical" | "major" | "minor";

export interface Anomaly {
  jobId: string;
  recordScore: number;
  severity: AnomalySeverity;
  timestamp: string | number;
  functionName?: string;
  fieldName?: string;
  entity?: string;
  actual?: number | number[];
  typical?: number | number[];
  deviationPercent?: number;
  influencers?: Record<string, string[]>;
}

export interface TimePoint {
  timestamp: string | number;
  value: number;
  typical?: number;
}

export interface AnomalyData {
  anomalies?: Anomaly[];
  top_anomalies?: Anomaly[];
  total?: number;
  returned?: number;
  jobsSummary?: Record<string, number>;
  filters?: { entity?: string; jobId?: string; minScore?: number; lookback?: string };
  /**
   * Tool-side message attached when the query succeeded but returned 0
   * anomalies (e.g. "No anomalies above score 1 in the last 1h …"). The
   * view uses it as the empty-state body instead of the generic
   * "Waiting for anomaly data…" placeholder, which previously rendered
   * for both "no result yet" AND "definitive empty result."
   */
  hint?: string;
  headline?: string;
  affected_services?: string[];
  time_series?: TimePoint[];
  time_series_title?: string;
  time_series_note?: string;
  chart_window?: string;
  chart_points?: number;
  investigation_actions?: InvestigationAction[];
  rerun_context?: RerunContext;
  detail?: {
    entity_label?: string;
    namespace?: string;
    actual_label?: string;
    typical_label?: string;
    actual_sub?: string;
    typical_sub?: string;
    unit_format?: "bytes" | "ms" | "pct" | "raw";
  };
}

export type ValueUnit = "bytes" | "ms" | "pct" | "raw";

export type SortKey = "score" | "newest" | "oldest" | "name";
export type GroupKey = "none" | "severity" | "job";

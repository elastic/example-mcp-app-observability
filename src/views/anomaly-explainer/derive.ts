/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Pure helpers for the anomaly-explainer view.
 */

import type {
  Anomaly,
  AnomalyData,
  AnomalySeverity,
  GroupKey,
  SortKey,
  ValueUnit,
} from "./types";

const ERROR_OUTCOMES = new Set(["failed", "error"]);
void ERROR_OUTCOMES; // reserved for future use; not needed yet

export function firstNum(v: number | number[] | undefined): number | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

export function severityFromScore(score: number): AnomalySeverity {
  if (score >= 90) return "critical";
  if (score >= 75) return "major";
  return "minor";
}

export function entityLabel(a: Anomaly): string {
  if (a.entity) return a.entity.split("=").pop() || a.entity;
  const infl = Object.values(a.influencers || {}).flat()[0];
  return infl ?? "unknown";
}

// Re-export so existing call sites keep importing from this file. The
// implementation lives in src/shared/infer-unit.ts and is shared with
// the ml-anomalies tool — preventing tool/view drift.
export { inferUnit } from "@shared/infer-unit";

export function fmtValue(v: number | undefined, unit: ValueUnit): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  if (unit === "bytes") {
    if (Math.abs(v) >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
    if (Math.abs(v) >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
    if (Math.abs(v) >= 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${v.toFixed(0)} B`;
  }
  if (unit === "ms") return `${v.toFixed(v < 10 ? 2 : 0)} ms`;
  if (unit === "pct") return `${(v * (v <= 1 ? 100 : 1)).toFixed(1)}%`;
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export function fmtRelativeTime(t: string | number): string {
  const ms = typeof t === "number" ? t : Date.parse(t);
  if (Number.isNaN(ms)) return "";
  const diffMs = Date.now() - ms;
  if (diffMs < 0) return new Date(ms).toLocaleString();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function severityCounts(anomalies: Anomaly[]): Record<AnomalySeverity, number> {
  const out: Record<AnomalySeverity, number> = { critical: 0, major: 0, minor: 0 };
  for (const a of anomalies) out[a.severity] = (out[a.severity] ?? 0) + 1;
  return out;
}

/**
 * "Detail" mode is appropriate when the result is focused on a single entity:
 * one anomaly, an explicit entity / job filter, or a multi-anomaly result that
 * still resolves to a single entity. Otherwise the view shows an overview.
 */
export function pickMode(data: AnomalyData | null): "detail" | "overview" | null {
  if (!data?.anomalies?.length) return null;
  const anomalies = data.anomalies;
  if (anomalies.length === 1) return "detail";
  if (data.filters?.entity || data.filters?.jobId) return "detail";
  const entities = new Set(anomalies.map((a) => a.entity || entityLabel(a)));
  if (entities.size === 1) return "detail";
  return "overview";
}

export function applySort(anomalies: Anomaly[], sort: SortKey): Anomaly[] {
  const arr = [...anomalies];
  switch (sort) {
    case "name":
      arr.sort((a, b) => entityLabel(a).localeCompare(entityLabel(b)));
      break;
    case "newest":
      arr.sort((a, b) => tsOf(b.timestamp) - tsOf(a.timestamp));
      break;
    case "oldest":
      arr.sort((a, b) => tsOf(a.timestamp) - tsOf(b.timestamp));
      break;
    case "score":
    default:
      arr.sort((a, b) => b.recordScore - a.recordScore);
  }
  return arr;
}

export function applyGroup(
  anomalies: Anomaly[],
  group: GroupKey,
): { key: string; label: string; anomalies: Anomaly[] }[] {
  if (group === "none") return [{ key: "all", label: "", anomalies }];

  const buckets = new Map<string, { label: string; anomalies: Anomaly[] }>();
  const push = (k: string, l: string, a: Anomaly) => {
    const b = buckets.get(k) ?? { label: l, anomalies: [] };
    b.anomalies.push(a);
    buckets.set(k, b);
  };

  for (const a of anomalies) {
    if (group === "severity") {
      const s = a.severity;
      const label = s === "critical" ? "Critical" : s === "major" ? "Major" : "Minor";
      push(s, label, a);
    } else if (group === "job") {
      push(a.jobId, a.jobId, a);
    }
  }

  const order = group === "severity"
    ? ["critical", "major", "minor"]
    : [...buckets.keys()].sort((a, b) => a.localeCompare(b));

  const out: { key: string; label: string; anomalies: Anomaly[] }[] = [];
  for (const k of order) {
    const b = buckets.get(k);
    if (b) out.push({ key: k, label: b.label, anomalies: b.anomalies });
  }
  return out;
}

function tsOf(t: string | number): number {
  const ms = typeof t === "number" ? t : Date.parse(t);
  return Number.isNaN(ms) ? 0 : ms;
}

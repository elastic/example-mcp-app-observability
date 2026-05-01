/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Single source of truth for unit inference from a job-id + field-name pair.
 * Tools and views must use the SAME logic — otherwise the tool stamps
 * `unit_format: "raw"` on the payload and the view trusts it, even though
 * the view's own heuristic would have recognized the field as bytes/ms/pct.
 * Drift here was the bug behind raw bytes (71021033499) showing in the
 * anomaly-detail facts when the field was metrics.k8s.pod.network.io.
 */

export type ValueUnit = "bytes" | "ms" | "pct" | "raw";

const BYTE_FIELD_RE =
  /(?:memory|working_set|bytes|filesystem\.?usage|storage|network\.?io|disk\.?io|fs\.?usage)/;

export function inferUnit(jobId: string | undefined, fieldName: string | undefined): ValueUnit {
  const s = `${jobId ?? ""} ${fieldName ?? ""}`.toLowerCase();
  if (BYTE_FIELD_RE.test(s)) return "bytes";
  if (s.includes("latency") || s.includes("duration") || s.includes("ms")) return "ms";
  if (s.includes("cpu") || s.includes("utilization") || s.includes("pct")) return "pct";
  return "raw";
}

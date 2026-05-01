/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { esRequest } from "./client.js";
import type { AnomalyRecord, Severity } from "../shared/types.js";

const ANOMALY_INDEX = ".ml-anomalies-*";

interface RawAnomalyHit {
  _source: {
    job_id?: string;
    detector_index?: number;
    record_score?: number;
    initial_record_score?: number;
    timestamp?: string;
    function?: string;
    function_description?: string;
    field_name?: string;
    by_field_name?: string;
    by_field_value?: string;
    over_field_name?: string;
    over_field_value?: string;
    partition_field_name?: string;
    partition_field_value?: string;
    typical?: number[];
    actual?: number[];
    influencers?: { influencer_field_name: string; influencer_field_values: string[] }[];
    is_interim?: boolean;
    result_type?: string;
  };
}

interface SearchResponse {
  hits: {
    total: { value: number } | number;
    hits: RawAnomalyHit[];
  };
}

export interface AnomalyQueryInput {
  jobId?: string;
  minScore?: number;
  entity?: string;
  lookback?: string;
  limit?: number;
}

export interface AnomalyQueryResult {
  anomalies: (AnomalyRecord & {
    influencers?: Record<string, string[]>;
    entity?: string;
  })[];
  total: number;
  returned: number;
  jobsSummary: Record<string, number>;
  filters: { minScore: number; lookback: string; jobId?: string; entity?: string };
  hint?: string;
}

export function severityLabel(score: number): Severity {
  if (score >= 90) return "critical";
  if (score >= 75) return "major";
  return "minor";
}

/**
 * Normalize the user-supplied `entity` argument into a single matchable
 * value. Accepts:
 *   - "kube-proxy-…"                                 → "kube-proxy-…"
 *   - "k8s.pod.name=kube-proxy-…"                    → "kube-proxy-…"
 *   - "attributes.direction=receive; k8s.pod.name=X" → "X"
 *
 * The composite form is exactly what `formatAnomaly` emits as `entity`
 * on each result, so the LLM commonly pastes it back in. Without this
 * normalization the wildcard `*<whole_string>*` matches nothing.
 *
 * For the multi-pair composite we return the LAST value, not all of
 * them. ML anomalies use partition (often direction/category) and by
 * (often the actual entity name like a pod) fields; `formatAnomaly`
 * orders them partition → by → over, so the trailing value is the
 * most specific. OR-ing all values would over-broaden — e.g. matching
 * every anomaly with partition=receive across all pods.
 */
export function parseEntityArg(raw: string): string {
  const parts = raw.split(";").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return raw;
  const last = parts[parts.length - 1];
  const eq = last.indexOf("=");
  const value = eq === -1 ? last : last.slice(eq + 1).trim();
  return value || raw;
}

function formatAnomaly(hit: RawAnomalyHit) {
  const src = hit._source;
  const entityParts: string[] = [];
  for (const kind of ["partition", "by", "over"] as const) {
    const name = src[`${kind}_field_name`];
    const value = src[`${kind}_field_value`];
    if (name && value) entityParts.push(`${name}=${value}`);
  }

  const influencers: Record<string, string[]> = {};
  for (const inf of src.influencers || []) {
    if (inf.influencer_field_name && inf.influencer_field_values?.length) {
      influencers[inf.influencer_field_name] = inf.influencer_field_values;
    }
  }

  const score = src.record_score || 0;
  const actual = src.actual || [];
  const typical = src.typical || [];

  let deviationPercent: number | undefined;
  if (actual.length === 1 && typical.length === 1 && typical[0] !== 0) {
    deviationPercent = Math.round(((actual[0] - typical[0]) / typical[0]) * 1000) / 10;
  }

  return {
    jobId: src.job_id || "",
    resultType: src.result_type || "record",
    recordScore: Math.round(score * 10) / 10,
    initialRecordScore: src.initial_record_score ?? score,
    timestamp: src.timestamp || "",
    isInterim: !!src.is_interim,
    detectorIndex: src.detector_index ?? 0,
    functionName: src.function_description || src.function,
    fieldName: src.field_name,
    partitionFieldName: src.partition_field_name,
    partitionFieldValue: src.partition_field_value,
    byFieldName: src.by_field_name,
    byFieldValue: src.by_field_value,
    overFieldName: src.over_field_name,
    overFieldValue: src.over_field_value,
    actual,
    typical,
    severity: severityLabel(score),
    deviationPercent,
    entity: entityParts.length ? entityParts.join("; ") : undefined,
    influencers: Object.keys(influencers).length ? influencers : undefined,
  };
}

export async function mlAnomalyIndicesExist(): Promise<boolean> {
  try {
    await esRequest(`/${ANOMALY_INDEX}/_search`, {
      body: { size: 0, track_total_hits: false },
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("index_not_found_exception") || msg.includes("404")) return false;
    return true;
  }
}

export async function queryAnomalies(input: AnomalyQueryInput): Promise<AnomalyQueryResult> {
  // Default minScore = 1 (any actual anomaly record). Was 50 ("minor or
  // worse"), which silently filtered out everything below the "minor"
  // band — turning a vague "what anomalies do we have?" into "what
  // minor-or-worse anomalies do we have?" without making that
  // assumption visible. Score 1 includes everything ML flagged; the
  // limit + score-desc sort still surfaces the worst ones first, so a
  // noisy environment doesn't drown the user.
  const minScore = input.minScore ?? 1;
  const lookback = input.lookback ?? "24h";
  const limit = input.limit ?? 25;

  const must: unknown[] = [
    { range: { record_score: { gte: minScore } } },
    { term: { result_type: "record" } },
    { range: { timestamp: { gte: `now-${lookback}` } } },
  ];

  if (input.jobId) must.push({ term: { job_id: input.jobId } });
  if (input.entity) {
    // Normalize composite "field=value; field=value" inputs (the format
    // formatAnomaly emits on results) down to the last/most-specific
    // value. See parseEntityArg.
    const entityValue = parseEntityArg(input.entity);
    must.push({
      bool: {
        should: [
          {
            nested: {
              path: "influencers",
              query: {
                wildcard: {
                  "influencers.influencer_field_values": `*${entityValue}*`,
                },
              },
            },
          },
          { wildcard: { partition_field_value: `*${entityValue}*` } },
          { wildcard: { by_field_value: `*${entityValue}*` } },
          { wildcard: { over_field_value: `*${entityValue}*` } },
        ],
        minimum_should_match: 1,
      },
    });
  }

  const body = {
    size: limit,
    sort: [{ record_score: { order: "desc" } }, { timestamp: { order: "desc" } }],
    query: { bool: { must } },
    _source: [
      "job_id",
      "detector_index",
      "record_score",
      "initial_record_score",
      "timestamp",
      "bucket_span",
      "function",
      "function_description",
      "field_name",
      "by_field_name",
      "by_field_value",
      "over_field_name",
      "over_field_value",
      "partition_field_name",
      "partition_field_value",
      "typical",
      "actual",
      "influencers",
      "is_interim",
      "result_type",
    ],
  };

  const resp = await esRequest<SearchResponse>(`/${ANOMALY_INDEX}/_search`, { body });
  const anomalies = resp.hits.hits.map(formatAnomaly);
  const total = typeof resp.hits.total === "number" ? resp.hits.total : resp.hits.total.value;

  const jobsSummary: Record<string, number> = {};
  for (const a of anomalies) {
    jobsSummary[a.jobId] = (jobsSummary[a.jobId] || 0) + 1;
  }

  const result: AnomalyQueryResult = {
    anomalies,
    total,
    returned: anomalies.length,
    jobsSummary,
    filters: { minScore, lookback, jobId: input.jobId, entity: input.entity },
  };

  if (!anomalies.length) {
    // Informational, NOT imperative. Earlier wording ("Try lowering /
    // extending…") read as an instruction, so the LLM auto-retried —
    // producing 2-3 empty "Waiting for anomaly data…" widgets in the
    // chat that looked like the tool was broken. Now the hint just
    // states the result. The skill tells the LLM to OFFER a broader
    // search rather than run one automatically.
    result.hint = `No anomalies above score ${minScore} in the last ${lookback}. Tell the user this is the answer for the requested params; do NOT auto-retry. If they want a wider net, ask them first or surface the option as a single-click follow-up.`;
  }

  return result;
}

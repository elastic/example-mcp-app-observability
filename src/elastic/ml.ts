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
  const minScore = input.minScore ?? 50;
  const lookback = input.lookback ?? "24h";
  const limit = input.limit ?? 25;

  const must: unknown[] = [
    { range: { record_score: { gte: minScore } } },
    { term: { result_type: "record" } },
    { range: { timestamp: { gte: `now-${lookback}` } } },
  ];

  if (input.jobId) must.push({ term: { job_id: input.jobId } });
  if (input.entity) {
    must.push({
      bool: {
        should: [
          { wildcard: { "influencers.influencer_field_values": `*${input.entity}*` } },
          { wildcard: { partition_field_value: `*${input.entity}*` } },
          { wildcard: { by_field_value: `*${input.entity}*` } },
          { wildcard: { over_field_value: `*${input.entity}*` } },
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
    result.hint = `No anomalies above score ${minScore} in the last ${lookback}. Try lowering min_score or extending lookback.`;
  }

  return result;
}

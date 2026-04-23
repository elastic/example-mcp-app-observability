/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Detail-mode body for anomaly-explainer: ScoreRing summary, FactCol of metrics,
 * time-series chart (when provided), collapsible related-anomalies preview, and
 * a row of investigation-action buttons rendered as the Take Action bar.
 */

import React, { useState } from "react";
import { ExpandSection, FactCol, SeverityChip, type InvestigationAction } from "@shared/components";
import type { Anomaly, AnomalyData } from "../types";
import {
  entityLabel,
  firstNum,
  fmtRelativeTime,
  fmtValue,
  inferUnit,
  severityFromScore,
} from "../derive";
import { ScoreRing } from "./ScoreRing";
import { TimeSeriesChart } from "./TimeSeriesChart";

export function AnomalyDetailView({
  top,
  data,
  onSend,
}: {
  top: Anomaly;
  data: AnomalyData;
  onSend: (prompt: string) => void;
}) {
  const sev = top.severity || severityFromScore(top.recordScore);
  const actual = firstNum(top.actual);
  const typical = firstNum(top.typical);
  const dev = top.deviationPercent;
  const unit = data.detail?.unit_format ?? inferUnit(top.jobId, top.fieldName);

  const label = data.detail?.entity_label || entityLabel(top);
  const namespace = data.detail?.namespace;
  const actualLabel = data.detail?.actual_label || "Actual";
  const typicalLabel = data.detail?.typical_label || "Typical";

  const fnField = top.functionName && top.fieldName
    ? `${top.functionName}(${top.fieldName})`
    : top.fieldName ?? null;

  const headline = data.headline ?? `${label} · score ${top.recordScore.toFixed(1)}`;
  const subtitleBits = [
    fmtRelativeTime(top.timestamp),
    typical !== undefined && actual !== undefined
      ? `${(actual / typical).toFixed(1)}× ${typicalLabel.toLowerCase()}`
      : null,
    namespace ? `namespace ${namespace}` : null,
  ].filter(Boolean);

  const facts: { label: React.ReactNode; value: React.ReactNode }[] = [
    { label: "Function", value: top.functionName ?? null },
    { label: "Field", value: top.fieldName ?? null },
    { label: "Entity", value: label },
    {
      label: actualLabel,
      value: actual !== undefined ? fmtValue(actual, unit) : null,
    },
    {
      label: typicalLabel,
      value: typical !== undefined ? fmtValue(typical, unit) : null,
    },
    {
      label: "Deviation",
      value:
        dev !== undefined
          ? `${dev >= 0 ? "+" : ""}${dev.toFixed(1)}%`
          : null,
    },
    { label: "Detected", value: fmtRelativeTime(top.timestamp) },
  ];

  for (const [k, vs] of Object.entries(top.influencers ?? {})) {
    if (vs?.length) facts.push({ label: k, value: vs.join(", ") });
  }

  // Related anomalies preview — when the result has more than one anomaly.
  const related = (data.anomalies ?? []).filter((a) => a !== top).slice(0, 5);
  const [openRelated, setOpenRelated] = useState(false);

  const actions: InvestigationAction[] = [
    ...(data.investigation_actions ?? []),
  ];

  return (
    <>
      <div className="anom-summary">
        <ScoreRing score={top.recordScore} severity={sev} />
        <div className="anom-summary-text">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <SeverityChip severity={sev} label={sev} />
            <span className="anom-summary-headline">{headline}</span>
          </div>
          {subtitleBits.length > 0 && (
            <div className="anom-summary-sub">{subtitleBits.join(" · ")}</div>
          )}
          {fnField && (
            <div className="anom-summary-sub">{fnField}</div>
          )}
        </div>
      </div>

      <div className="anom-section">
        <div className="anom-section-title">Anomaly facts</div>
        <FactCol items={facts} />
      </div>

      {data.time_series && data.time_series.length > 1 && (
        <div className="anom-section">
          <div className="anom-section-title">
            {data.time_series_title ?? "Value over time"}
          </div>
          <TimeSeriesChart
            points={data.time_series}
            actualLabel={actualLabel.toLowerCase()}
            typicalLabel={typicalLabel.toLowerCase()}
            yFormat={(v) => fmtValue(v, unit)}
          />
          {(data.chart_window || data.time_series_note) && (
            <div className="anom-chart-meta">
              {data.chart_window && <span>window: {data.chart_window}</span>}
              {data.chart_window && data.chart_points !== undefined && (
                <span> · {data.chart_points} points</span>
              )}
              {data.time_series_note && (
                <div style={{ marginTop: 4 }}>{data.time_series_note}</div>
              )}
            </div>
          )}
        </div>
      )}

      {related.length > 0 && (
        <div className="anom-section">
          <ExpandSection
            title="Related anomalies in this window"
            count={related.length}
            open={openRelated}
            onToggle={() => setOpenRelated((v) => !v)}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {related.map((a, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "6px 8px",
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-sm)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--text-secondary)",
                  }}
                >
                  <span>{entityLabel(a)} · {a.jobId}</span>
                  <span>{Math.round(a.recordScore)}</span>
                </div>
              ))}
            </div>
          </ExpandSection>
        </div>
      )}

      {actions.length > 0 && (
        <div className="anom-actions">
          {actions.map((a, i) => (
            <button
              key={i}
              type="button"
              className={`anom-action${i === 0 ? " anom-action-primary" : ""}`}
              onClick={() => onSend(a.prompt)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

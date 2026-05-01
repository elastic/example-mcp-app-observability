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
import { ExpandSection, SeverityChip, type InvestigationAction } from "@shared/components";
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
  onDrillDown,
}: {
  top: Anomaly;
  data: AnomalyData;
  onSend: (prompt: string) => void;
  /**
   * When provided, prepends a "Get full details" button to the action bar.
   * Used by the overview-mode detail pane, which shows whatever per-anomaly
   * data the overview payload carries (sparse — no time series, no actual /
   * typical values, no influencers) and offers an explicit drill-through to
   * have the LLM fetch the full payload.
   */
  onDrillDown?: () => void;
}) {
  const sev = top.severity || severityFromScore(top.recordScore);
  const actual = firstNum(top.actual);
  const typical = firstNum(top.typical);
  const dev = top.deviationPercent;
  // Derive everything from `top` (the anomaly being rendered RIGHT NOW),
  // not from `data.detail.*` / `data.headline`. The tool sets those
  // strings from `data.anomalies[0]` once at response time. In overview
  // drilldown mode, `top` is the row the user clicked — which may be a
  // different anomaly than `[0]`. Falling back to the cached strings
  // produced the bug where the headline showed the worst anomaly's
  // entity even after the user clicked a different one in the list.
  const unit = inferUnit(top.jobId, top.fieldName);
  const label = entityLabel(top);
  const actualLabel =
    unit === "bytes"
      ? "Actual memory"
      : unit === "ms"
        ? "Actual latency"
        : unit === "pct"
          ? "Actual utilization"
          : "Actual";
  const typicalLabel =
    unit === "bytes"
      ? "Typical memory"
      : unit === "ms"
        ? "Typical latency"
        : unit === "pct"
          ? "Typical utilization"
          : "Typical";

  const headline = `${label} · score ${top.recordScore.toFixed(1)}`;

  // Information-density redesign for the detail panel:
  //   - Drop the "Anomaly facts" header (context is clear from the
  //     summary row above it).
  //   - Skip Entity (already in the summary headline).
  //   - Group fields into rows with explicit column counts:
  //       Row 1 (3 cols): Function / Deviation / Detected   — short values
  //       Row 2 (2 cols): Actual / Typical                  — medium-length pair
  //       Row 3 (1 col):  Field                             — long
  //       Row 4+ (1 col): each influencer                   — long, full width
  //   - Order is "what kind → how surprising → when → magnitude → field
  //     → context", matching how an SRE actually reads an anomaly.
  const deviationStr = dev !== undefined ? `${dev >= 0 ? "+" : ""}${dev.toFixed(1)}%` : null;
  const actualStr = actual !== undefined ? fmtValue(actual, unit) : null;
  const typicalStr = typical !== undefined ? fmtValue(typical, unit) : null;
  const detectedStr = fmtRelativeTime(top.timestamp);
  const influencerEntries: { label: string; value: string }[] = [];
  for (const [k, vs] of Object.entries(top.influencers ?? {})) {
    if (vs?.length) influencerEntries.push({ label: k, value: vs.join(", ") });
  }

  // Related anomalies preview — when the result has more than one anomaly.
  const related = (data.anomalies ?? []).filter((a) => a !== top).slice(0, 5);
  const [openRelated, setOpenRelated] = useState(false);

  const actions: InvestigationAction[] = data.investigation_actions ?? [];

  return (
    <>
      <div className="anom-summary">
        <ScoreRing score={top.recordScore} severity={sev} />
        <div className="anom-summary-text">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <SeverityChip severity={sev} label={sev} />
            <span className="anom-summary-headline">{headline}</span>
          </div>
          {/* Subtitle and fnField removed — Detected, Deviation, Function,
              Field, and namespace influencer all live in the fact grid
              just below, so duplicating them here only ate vertical
              space in an already-cramped right pane. */}
        </div>
      </div>

      <div className="anom-section">
        <div className="anom-fact-grid">
          <div className="anom-fact-row anom-fact-row-3">
            <FactItem label="Function" value={top.functionName} />
            <FactItem label="Deviation" value={deviationStr} />
            <FactItem label="Detected" value={detectedStr} />
          </div>
          {(actualStr || typicalStr) && (
            <div className="anom-fact-row anom-fact-row-2">
              <FactItem label={actualLabel} value={actualStr} />
              <FactItem label={typicalLabel} value={typicalStr} />
            </div>
          )}
          <FactItem label="Field" value={top.fieldName} />
          {influencerEntries.map((it) => (
            <FactItem key={it.label} label={it.label} value={it.value} />
          ))}
        </div>
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

      {(onDrillDown || actions.length > 0) && (
        <div className="anom-actions">
          {onDrillDown && (
            <button
              type="button"
              className="anom-action anom-action-primary"
              onClick={onDrillDown}
            >
              Get full details
            </button>
          )}
          {actions.map((a, i) => (
            <button
              key={i}
              type="button"
              className={`anom-action${!onDrillDown && i === 0 ? " anom-action-primary" : ""}`}
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

/**
 * One label/value cell for the anomaly fact grid. Empty values render
 * an em-dash so column alignment stays even.
 */
function FactItem({
  label,
  value,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="anom-fact-item">
      <div className="anom-fact-label">{label}</div>
      <div className="anom-fact-value">{empty ? "—" : value}</div>
    </div>
  );
}

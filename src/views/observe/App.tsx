/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Observe view — renders results from the `observe` tool.
 *
 * Two modes mirroring the tool:
 *
 *   METRIC   condition_met / timeout against an ES|QL metric. Header, 4 stat cards
 *            (current / threshold / peak / baseline), bar chart of the trend, and
 *            recommended-next-step buttons.
 *
 *   ANOMALY  ALERT fired from ML jobs. Headline, severity, affected entities,
 *            investigation-hint buttons.
 *
 * Quiet/timeout states render a compact waiting card.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useApp, AppLike, ToolResultParams } from "@shared/use-app";
import { parseToolResult } from "@shared/parse-tool-result";
import { theme, baseStyles } from "@shared/theme";
import {
  StatCard,
  StatGrid,
  SectionCard,
  StatusBadge,
  BadgeTone,
  HBarRow,
  InvestigationActions,
  InvestigationAction,
} from "@shared/components";

type TrendPoint = { elapsed_seconds: number; value: number; timestamp_ms?: number };

type MetricResult = {
  status: "CONDITION_MET" | "TIMEOUT" | "SAMPLED";
  description: string;
  final_value?: number;
  last_value?: number | null;
  condition?: string;
  detected_after_seconds?: number;
  elapsed_seconds?: number;
  polls: number;
  poll_interval_seconds?: number;
  trend: TrendPoint[];
  observe_key?: string;
  message: string;
  esql?: string;
  namespace?: string;
  threshold_label?: string;
  unit?: "bytes" | "ms" | "pct" | "raw";
  baseline_value?: number;
  peak_value?: number;
  peak_label?: string;
  investigation_actions?: InvestigationAction[];
};

type NowResult = {
  status: "NOW";
  description: string;
  value: number | null;
  evaluated_at_ms: number;
  message: string;
  esql?: string;
  namespace?: string;
  unit?: "bytes" | "ms" | "pct" | "raw";
  investigation_actions?: InvestigationAction[];
};

type TableResult = {
  status: "TABLE";
  description: string;
  columns: { name: string; type: string }[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  row_cap?: number;
  evaluated_at_ms: number;
  message: string;
  esql?: string;
  namespace?: string;
  investigation_actions?: InvestigationAction[];
};

type ErrorResult = {
  status: "ERROR";
  description?: string;
  message: string;
  evaluated_at_ms: number;
  esql?: string;
};

type AnomalyAlert = {
  status: "ALERT" | "QUIET" | "NO_ML_JOBS";
  headline?: string;
  detected_after_seconds?: number;
  anomaly_count?: number;
  top_anomalies?: any[];
  affected_entities?: string[];
  affected_services?: string[];
  jobs_summary?: Record<string, number>;
  investigation_hints?: { tool: string; reason: string; args: Record<string, unknown> }[];
  investigation_actions?: InvestigationAction[];
  message?: string;
  suggestion?: string;
};

type ObserveResult = MetricResult | AnomalyAlert | NowResult | TableResult | ErrorResult;

function isMetric(r: ObserveResult): r is MetricResult {
  return r.status === "CONDITION_MET" || r.status === "TIMEOUT" || r.status === "SAMPLED";
}

function isNow(r: ObserveResult): r is NowResult {
  return r.status === "NOW";
}

function isTable(r: ObserveResult): r is TableResult {
  return r.status === "TABLE";
}

function isError(r: ObserveResult): r is ErrorResult {
  return r.status === "ERROR";
}

const NUMERIC_ES_TYPES = new Set([
  "long", "integer", "double", "float",
  "unsigned_long", "half_float", "scaled_float",
  "short", "byte",
]);
const DATE_ES_TYPES = new Set(["date", "date_nanos"]);

// ── Formatting ─────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined, unit?: "bytes" | "ms" | "pct" | "raw"): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
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

function inferUnit(description: string, esql?: string): "bytes" | "ms" | "pct" | "raw" {
  const s = `${description} ${esql || ""}`.toLowerCase();
  if (s.includes("memory") || s.includes("bytes") || s.includes("working_set")) return "bytes";
  if (s.includes("latency") || s.includes("duration") || s.includes("ms")) return "ms";
  if (s.includes("cpu") || s.includes("utilization") || s.includes("pct")) return "pct";
  return "raw";
}

function parseThreshold(condition: string): { comparator: string; value: number } | null {
  const m = /^\s*(<=?|>=?|==)\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(condition);
  if (!m) return null;
  return { comparator: m[1], value: parseFloat(m[2]) };
}

// ── Trend line chart ───────────────────────────────────────────────────────

function TrendChart({
  trend,
  threshold,
  thresholdLabel,
  unit,
  conditionMet,
}: {
  trend: TrendPoint[];
  threshold?: number;
  thresholdLabel?: string;
  unit: "bytes" | "ms" | "pct" | "raw";
  conditionMet: boolean;
}) {
  if (trend.length === 0) return null;
  const w = 560;
  const h = 180;
  const padL = 50;
  const padR = 10;
  const padT = 14;
  const padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // Use a monotonic x axis — prefer timestamp_ms when available (accumulated samples
  // come from multiple tool calls and can share elapsed_seconds values).
  const hasTs = trend.every((p) => typeof p.timestamp_ms === "number");
  const xVals = hasTs
    ? trend.map((p) => p.timestamp_ms as number)
    : trend.map((p) => p.elapsed_seconds);
  const xMin = Math.min(...xVals);
  const xMax = Math.max(...xVals);
  const xRange = xMax - xMin || 1;

  const allY = [...trend.map((p) => p.value), threshold ?? 0].filter((v) => Number.isFinite(v));
  const yMax = Math.max(...allY) * 1.15;
  const yMin = Math.min(0, Math.min(...allY) * 0.9);
  const yRange = yMax - yMin || 1;

  const xOf = (i: number) => padL + ((xVals[i] - xMin) / xRange) * plotW;
  const yOf = (v: number) => padT + plotH - ((v - yMin) / yRange) * plotH;

  const yTicks = [yMin, yMin + yRange / 2, yMax];

  const breached = (v: number) => (threshold !== undefined ? v >= threshold : false);
  const lineColor = conditionMet ? theme.redSoft : threshold === undefined ? theme.blue : theme.amber;

  const points = trend.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(" ");
  const areaPath =
    `M ${xOf(0).toFixed(1)},${yOf(yMin).toFixed(1)} ` +
    trend.map((p, i) => `L ${xOf(i).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(" ") +
    ` L ${xOf(trend.length - 1).toFixed(1)},${yOf(yMin).toFixed(1)} Z`;

  // Decide how many x-axis labels to show — aim for ~4 across the range.
  const tickCount = Math.min(4, trend.length);
  const tickIndexes = Array.from({ length: tickCount }, (_, k) =>
    Math.round((k * (trend.length - 1)) / Math.max(1, tickCount - 1))
  );
  const lastElapsed = trend[trend.length - 1].elapsed_seconds;

  // Only draw dots when points are sparse enough to not turn the line into a blob.
  const showDots = trend.length <= 40;

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={padL}
            x2={w - padR}
            y1={yOf(t)}
            y2={yOf(t)}
            stroke={theme.border}
            strokeWidth={0.5}
            strokeDasharray="3 3"
          />
          <text
            x={padL - 4}
            y={yOf(t) + 3}
            textAnchor="end"
            fill={theme.textDim}
            fontSize={9}
            fontFamily="'JetBrains Mono', monospace"
          >
            {fmt(t, unit)}
          </text>
        </g>
      ))}

      <path d={areaPath} fill={`${lineColor}1a`} stroke="none" />
      <polyline
        points={points}
        fill="none"
        stroke={lineColor}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {showDots &&
        trend.map((p, i) => {
          const isLast = i === trend.length - 1;
          const color = breached(p.value) ? theme.redSoft : lineColor;
          return (
            <circle
              key={i}
              cx={xOf(i)}
              cy={yOf(p.value)}
              r={isLast ? 3 : 2}
              fill={isLast ? color : `${color}aa`}
              stroke={isLast ? theme.text : "none"}
              strokeWidth={isLast ? 0.5 : 0}
            />
          );
        })}

      {tickIndexes.map((i, k) => {
        const elapsed = lastElapsed - trend[i].elapsed_seconds;
        const label = elapsed === 0 ? "now" : `-${elapsed}s`;
        return (
          <text
            key={`x-${k}`}
            x={xOf(i)}
            y={h - 8}
            textAnchor="middle"
            fill={theme.textDim}
            fontSize={9}
            fontFamily="'JetBrains Mono', monospace"
          >
            {label}
          </text>
        );
      })}

      {threshold !== undefined && (
        <>
          <line
            x1={padL}
            x2={w - padR}
            y1={yOf(threshold)}
            y2={yOf(threshold)}
            stroke={theme.textDim}
            strokeWidth={1.5}
            strokeDasharray="6 4"
          />
          <text
            x={w - padR}
            y={yOf(threshold) - 4}
            textAnchor="end"
            fill={theme.textDim}
            fontSize={9}
            fontFamily="'JetBrains Mono', monospace"
          >
            {thresholdLabel || fmt(threshold, unit)}
          </text>
        </>
      )}
    </svg>
  );
}

// ── Metric mode ────────────────────────────────────────────────────────────

// ── Now mode (single-instance read) ────────────────────────────────────────

function NowView({ data, onSend }: { data: NowResult; onSend: (p: string) => void }) {
  const unit = data.unit || inferUnit(data.description, data.esql);
  const hasValue = data.value !== null && data.value !== undefined;
  const ageSec = Math.max(0, Math.round((Date.now() - data.evaluated_at_ms) / 1000));

  return (
    <>
      <SectionCard>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            marginBottom: 14,
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: theme.text, marginBottom: 2 }}>
              {data.description || "Metric"}
            </div>
            <div className="mono" style={{ fontSize: 11, color: theme.textMuted }}>
              {data.esql ? data.esql.split("|")[0]?.trim() : "ES|QL metric"}
              {data.namespace ? ` · ${data.namespace}` : ""}
            </div>
          </div>
          <StatusBadge tone="ok">now</StatusBadge>
        </div>

        <div
          style={{
            fontSize: 40,
            fontWeight: 700,
            color: hasValue ? theme.text : theme.textMuted,
            fontFamily: "'JetBrains Mono', monospace",
            lineHeight: 1.1,
            marginBottom: 4,
          }}
        >
          {hasValue ? fmt(data.value as number, unit) : "—"}
        </div>
        <div style={{ fontSize: 11, color: theme.textDim }}>
          {hasValue
            ? `evaluated ${ageSec === 0 ? "just now" : `${ageSec}s ago`}`
            : "query returned no numeric value"}
        </div>
      </SectionCard>

      <InvestigationActions
        title="Next"
        actions={data.investigation_actions}
        onSend={onSend}
      />
    </>
  );
}

// ── Table mode (full tabular ES|QL result) ────────────────────────────────

function formatCell(value: unknown, type: string): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map((v) => formatCell(v, type)).join(", ");
  if (DATE_ES_TYPES.has(type)) {
    if (typeof value === "string") return value;
    if (typeof value === "number") return new Date(value).toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value)) return value.toLocaleString();
    if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return value.toPrecision(4).replace(/\.?0+$/, "");
  }
  return String(value);
}

function TableView({ data, onSend }: { data: TableResult; onSend: (p: string) => void }) {
  const { columns, rows } = data;
  const ageSec = Math.max(0, Math.round((Date.now() - data.evaluated_at_ms) / 1000));

  const alignments = columns.map((c) =>
    NUMERIC_ES_TYPES.has(c.type) ? "right" : ("left" as const)
  );

  return (
    <>
      <SectionCard>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            marginBottom: 14,
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: theme.text, marginBottom: 2 }}>
              {data.description || "ES|QL table"}
            </div>
            <div className="mono" style={{ fontSize: 11, color: theme.textMuted }}>
              {data.esql ? data.esql.split("|")[0]?.trim() : "ES|QL table"}
              {data.namespace ? ` · ${data.namespace}` : ""}
            </div>
          </div>
          <StatusBadge tone="ok">table</StatusBadge>
        </div>

        <div style={{ fontSize: 11, color: theme.textDim, marginBottom: 10 }}>
          {data.row_count} row{data.row_count === 1 ? "" : "s"}
          {data.truncated ? ` (showing first ${rows.length})` : ""}
          {" · "}
          {ageSec === 0 ? "evaluated just now" : `evaluated ${ageSec}s ago`}
        </div>

        {columns.length === 0 || rows.length === 0 ? (
          <div
            style={{
              fontSize: 12,
              color: theme.textMuted,
              padding: "14px 0",
              textAlign: "center",
            }}
          >
            Query returned no rows.
          </div>
        ) : (
          <div style={{ overflowX: "auto", border: `1px solid ${theme.border}`, borderRadius: 6 }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              <thead>
                <tr style={{ background: theme.bgTertiary }}>
                  {columns.map((c, i) => (
                    <th
                      key={c.name + i}
                      title={c.type}
                      style={{
                        textAlign: alignments[i],
                        padding: "7px 10px",
                        borderBottom: `1px solid ${theme.borderStrong}`,
                        color: theme.textMuted,
                        fontWeight: 600,
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr
                    key={ri}
                    style={{ background: ri % 2 === 0 ? "transparent" : theme.bgSecondary }}
                  >
                    {columns.map((c, ci) => (
                      <td
                        key={c.name + ci}
                        style={{
                          textAlign: alignments[ci],
                          padding: "6px 10px",
                          borderBottom:
                            ri === rows.length - 1 ? "none" : `1px solid ${theme.border}`,
                          color: theme.text,
                          verticalAlign: "top",
                          whiteSpace: "nowrap",
                          maxWidth: 320,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {formatCell(row[ci], c.type)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <InvestigationActions
        title="Next"
        actions={data.investigation_actions}
        onSend={onSend}
      />
    </>
  );
}

function ErrorView({ data }: { data: ErrorResult }) {
  return (
    <SectionCard>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: theme.text, marginBottom: 2 }}>
            {data.description || "Query failed"}
          </div>
          {data.esql && (
            <div className="mono" style={{ fontSize: 11, color: theme.textMuted }}>
              {data.esql.split("|")[0]?.trim()}
            </div>
          )}
        </div>
        <StatusBadge tone="critical">error</StatusBadge>
      </div>
      <div
        className="mono"
        style={{
          fontSize: 11,
          color: theme.redSoft,
          background: `${theme.red}12`,
          border: `1px solid ${theme.red}33`,
          borderRadius: 4,
          padding: "8px 10px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {data.message}
      </div>
    </SectionCard>
  );
}

function MetricView({
  data,
  trend,
  onSend,
}: {
  data: MetricResult;
  trend: TrendPoint[];
  onSend: (p: string) => void;
}) {
  const unit = data.unit || inferUnit(data.description, data.esql);
  const currentValue = data.final_value ?? data.last_value ?? undefined;
  const thresholdInfo = data.condition ? parseThreshold(data.condition) : null;
  const threshold = thresholdInfo?.value;
  const conditionMet = data.status === "CONDITION_MET";
  const sampling = data.status === "SAMPLED";

  const tone: BadgeTone = conditionMet ? "ok" : sampling ? "ok" : "major";
  const badgeText = conditionMet ? "condition met" : sampling ? "sampling" : "timeout";

  const elapsed = data.detected_after_seconds ?? data.elapsed_seconds ?? 0;
  const pollCount = trend.length || data.polls;

  const subtitle = data.esql
    ? `${data.esql.split("|")[0]?.trim()}${data.condition ? ` · ${data.condition}` : ""}`
    : data.condition
    ? `condition ${data.condition}`
    : "live sample";

  // Derive peak from accumulated trend when server didn't send one (live mode).
  const computedPeak =
    data.peak_value !== undefined
      ? data.peak_value
      : trend.length > 1
      ? Math.max(...trend.map((p) => p.value))
      : undefined;

  return (
    <>
      <SectionCard>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            marginBottom: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: theme.text, marginBottom: 2 }}>
              {data.description || "Observed metric"}
            </div>
            <div className="mono" style={{ fontSize: 11, color: theme.textMuted }}>
              {subtitle}
              {data.namespace ? ` · ${data.namespace}` : ""}
            </div>
          </div>
          <StatusBadge tone={tone}>{badgeText}</StatusBadge>
        </div>

        <StatGrid>
          <StatCard
            label="Current"
            value={fmt(currentValue, unit)}
            tone={conditionMet ? "ok" : sampling ? undefined : "major"}
          />
          {threshold !== undefined && (
            <StatCard
              label="Threshold"
              value={`${thresholdInfo!.comparator} ${fmt(threshold, unit)}`}
            />
          )}
          {computedPeak !== undefined && (
            <StatCard
              label={data.peak_label || "Peak"}
              value={fmt(computedPeak, unit)}
              tone={conditionMet ? "critical" : undefined}
            />
          )}
          {data.baseline_value !== undefined && (
            <StatCard label="Typical baseline" value={fmt(data.baseline_value, unit)} />
          )}
          <StatCard
            label="Elapsed"
            value={`${elapsed}s`}
            sub={`${pollCount} sample${pollCount === 1 ? "" : "s"}`}
          />
        </StatGrid>

        <TrendChart
          trend={trend}
          threshold={threshold}
          thresholdLabel={threshold !== undefined ? `${fmt(threshold, unit)} threshold` : undefined}
          unit={unit}
          conditionMet={conditionMet}
        />
      </SectionCard>

      <InvestigationActions
        title={sampling ? "Keep observing" : "Recommended next steps"}
        actions={data.investigation_actions}
        onSend={onSend}
      />
    </>
  );
}

// ── Anomaly mode ───────────────────────────────────────────────────────────

function AnomalyAlertView({ data, onSend }: { data: AnomalyAlert; onSend: (p: string) => void }) {
  if (data.status !== "ALERT") {
    return (
      <SectionCard>
        <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 4 }}>
          {data.status === "QUIET" ? "No anomalies fired" : "Observation could not run"}
        </div>
        <div style={{ fontSize: 12, color: theme.textDim, marginBottom: 8 }}>{data.message}</div>
        {data.suggestion && (
          <div style={{ fontSize: 11, color: theme.amber }}>{data.suggestion}</div>
        )}
      </SectionCard>
    );
  }

  const top = (data.top_anomalies || [])[0] as any;
  const topScore = top?.recordScore ?? 0;
  const tone: BadgeTone =
    topScore >= 90 ? "critical" : topScore >= 75 ? "major" : "minor";

  const actions: InvestigationAction[] =
    data.investigation_actions ||
    (data.investigation_hints || []).map((h) => {
      const args = Object.entries(h.args || {})
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      return {
        label: h.tool,
        prompt: `Use ${h.tool}${args ? ` with ${args}` : ""}. ${h.reason}`,
      };
    });

  return (
    <>
      <SectionCard>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            marginBottom: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: theme.text, marginBottom: 4 }}>
              {data.headline}
            </div>
            <div className="mono" style={{ fontSize: 11, color: theme.textMuted }}>
              fired after {data.detected_after_seconds}s · {data.anomaly_count} anomalies
            </div>
          </div>
          <StatusBadge tone={tone}>alert</StatusBadge>
        </div>

        <StatGrid>
          <StatCard
            label="Top score"
            value={topScore ? topScore.toFixed(1) : "—"}
            tone={tone === "critical" ? "critical" : tone === "major" ? "major" : undefined}
          />
          <StatCard label="Anomalies" value={data.anomaly_count ?? 0} />
          <StatCard label="Affected entities" value={data.affected_entities?.length ?? 0} />
          <StatCard label="Jobs firing" value={Object.keys(data.jobs_summary || {}).length} />
        </StatGrid>

        {data.affected_entities?.length ? (
          <div style={{ marginTop: 10 }}>
            <div
              style={{
                fontSize: 11,
                color: theme.textMuted,
                marginBottom: 4,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              Affected entities
            </div>
            {data.affected_entities.slice(0, 6).map((e, i) => (
              <div
                key={i}
                className="mono"
                style={{ fontSize: 11, color: theme.text, padding: "3px 0" }}
              >
                {e}
              </div>
            ))}
          </div>
        ) : null}
      </SectionCard>

      {data.jobs_summary && Object.keys(data.jobs_summary).length > 1 && (
        <SectionCard title="By ML job">
          {Object.entries(data.jobs_summary)
            .sort((a, b) => b[1] - a[1])
            .map(([job, count]) => (
              <HBarRow
                key={job}
                label={job}
                value={count}
                valueLabel={`${count}`}
                max={Math.max(...Object.values(data.jobs_summary!))}
                color={theme.blue}
              />
            ))}
        </SectionCard>
      )}

      <InvestigationActions
        title="Recommended next steps"
        actions={actions}
        onSend={onSend}
      />
    </>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────

export function App() {
  const [data, setData] = useState<ObserveResult | null>(null);
  const [accumulated, setAccumulated] = useState<TrendPoint[]>([]);
  const [lastKey, setLastKey] = useState<string | undefined>();
  const [app, setApp] = useState<AppLike | null>(null);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = baseStyles;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const handleToolResult = useCallback(
    (params: ToolResultParams) => {
      const d = parseToolResult<ObserveResult>(params);
      if (!d?.status) return;

      if (isMetric(d)) {
        const incoming = d.trend || [];
        // Merge when the observe_key matches a prior run — same ES|QL + condition —
        // so "Extend observation" invocations build a continuous timeline instead of
        // resetting. Otherwise treat as a fresh series.
        if (d.observe_key && d.observe_key === lastKey && accumulated.length > 0) {
          const seen = new Set(
            accumulated.map((p) => p.timestamp_ms).filter((t) => t !== undefined) as number[]
          );
          const fresh = incoming.filter(
            (p) => p.timestamp_ms === undefined || !seen.has(p.timestamp_ms)
          );
          const merged = [...accumulated, ...fresh].sort((a, b) => {
            const at = a.timestamp_ms ?? a.elapsed_seconds;
            const bt = b.timestamp_ms ?? b.elapsed_seconds;
            return at - bt;
          });
          // Cap at 240 points so a long-running observation doesn't overflow the SVG.
          setAccumulated(merged.slice(-240));
        } else {
          setAccumulated(incoming);
          setLastKey(d.observe_key);
        }
      } else {
        setAccumulated([]);
        setLastKey(undefined);
      }

      setData(d);
    },
    [accumulated, lastKey]
  );

  useApp({
    appInfo: { name: "Observe", version: "1.0.0" },
    onAppCreated: (a) => {
      a.ontoolresult = handleToolResult;
      setApp(a);
    },
  });

  const onSend = useCallback((p: string) => app?.sendMessage(p), [app]);

  if (!data) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: theme.textMuted }}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>Waiting for observe result…</div>
        <div style={{ fontSize: 11 }}>Call the observe tool to populate this view.</div>
      </div>
    );
  }

  return (
    <div style={{ padding: "14px 16px", maxWidth: 620 }}>
      {isError(data) ? (
        <ErrorView data={data} />
      ) : isTable(data) ? (
        <TableView data={data} onSend={onSend} />
      ) : isNow(data) ? (
        <NowView data={data} onSend={onSend} />
      ) : isMetric(data) ? (
        <MetricView data={data} trend={accumulated} onSend={onSend} />
      ) : (
        <AnomalyAlertView data={data} onSend={onSend} />
      )}
    </div>
  );
}

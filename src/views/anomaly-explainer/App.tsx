/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Anomaly Explainer — dual-mode view:
 *
 *   DETAIL    One anomaly in focus (user filtered by entity/job, or a single result).
 *             Header with job + entity, 4 stat cards (score / actual / typical / deviation),
 *             an actual-vs-typical ComparisonBar, an optional time-series chart, and a
 *             row of investigation-action buttons.
 *
 *   OVERVIEW  Many anomalies across many entities/jobs. Severity breakdown, affected-entity
 *             list grouped by job, and investigation-action buttons.
 *
 * Mode is chosen from the payload itself — no input knob. `filters.entity` / `filters.jobId`
 * being set is a strong "detail" signal; otherwise we fall back to cardinality.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useApp, AppLike, ToolResultParams } from "@shared/use-app";
import { parseToolResult } from "@shared/parse-tool-result";
import { theme, baseStyles } from "@shared/theme";
import {
  StatCard,
  StatGrid,
  SectionCard,
  BadgeTone,
  ComparisonBar,
  HBarRow,
  InvestigationActions,
  InvestigationAction,
  TimeRangeHeader,
  RerunContext,
  SectionTitleWithToggle,
  CondensedChips,
} from "@shared/components";

interface Anomaly {
  jobId: string;
  recordScore: number;
  severity: "critical" | "major" | "minor";
  timestamp: string | number;
  functionName?: string;
  fieldName?: string;
  entity?: string;
  actual?: number | number[];
  typical?: number | number[];
  deviationPercent?: number;
  influencers?: Record<string, string[]>;
}

interface TimePoint {
  timestamp: string | number;
  value: number;
  typical?: number;
}

interface AnomalyData {
  anomalies?: Anomaly[];
  top_anomalies?: Anomaly[];
  total?: number;
  returned?: number;
  jobsSummary?: Record<string, number>;
  filters?: { entity?: string; jobId?: string; minScore?: number; lookback?: string };
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

// ── Helpers ────────────────────────────────────────────────────────────────

function firstNum(v: number | number[] | undefined): number | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function severityTone(score: number): BadgeTone {
  if (score >= 90) return "critical";
  if (score >= 75) return "major";
  if (score >= 50) return "minor";
  return "ok";
}

// Okabe-Ito severity palette: vermillion → orange → sky-blue. Strong hue
// separation under all common color-vision deficiencies. Mirrors the shared
// StatusBadge / StatCard tones so the whole view reads as a single scale.
function sevColor(score: number): string {
  if (score >= 90) return "#D55E00";
  if (score >= 75) return "#E69F00";
  return "#56B4E9";
}

function entityLabel(a: Anomaly): string {
  if (a.entity) return a.entity.split("=").pop() || a.entity;
  const infl = Object.values(a.influencers || {}).flat()[0];
  return infl ?? "unknown";
}

function fmtValue(
  v: number | undefined,
  hint: { jobId?: string; fieldName?: string; unit?: "bytes" | "ms" | "pct" | "raw" }
): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  const u = hint.unit
    ?? (hint.fieldName?.includes("memory") || hint.fieldName?.includes("bytes") || hint.jobId?.includes("memory")
      ? "bytes"
      : hint.fieldName?.includes("latency") || hint.fieldName?.includes("duration") || hint.jobId?.includes("latency")
      ? "ms"
      : hint.jobId?.includes("cpu") || hint.fieldName?.includes("pct") || hint.fieldName?.includes("utilization")
      ? "pct"
      : "raw");
  if (u === "bytes") {
    if (Math.abs(v) >= 1024 * 1024 * 1024) return `${(v / (1024 ** 3)).toFixed(1)} GB`;
    if (Math.abs(v) >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
    if (Math.abs(v) >= 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${v.toFixed(0)} B`;
  }
  if (u === "ms") return `${v.toFixed(v < 10 ? 2 : 0)} ms`;
  if (u === "pct") return `${(v * (v <= 1 ? 100 : 1)).toFixed(1)}%`;
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function fmtTime(t: string | number): string {
  const d = new Date(typeof t === "number" ? t : t);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Time-series chart (for detail mode) ────────────────────────────────────

function TimeSeriesChart({
  points,
  actualLabel = "actual",
  typicalLabel = "typical",
  yFormat,
}: {
  points: TimePoint[];
  actualLabel?: string;
  typicalLabel?: string;
  yFormat?: (v: number) => string;
}) {
  const fmtY = yFormat ?? ((v: number) => fmtValue(v, { unit: "raw" }));
  if (points.length < 2) return null;
  const w = 560;
  const h = 160;
  const padL = 40;
  const padR = 10;
  const padT = 14;
  const padB = 20;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const toMs = (t: string | number) => (typeof t === "number" ? t : new Date(t).getTime());
  const sorted = [...points].sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));
  const tMin = toMs(sorted[0].timestamp);
  const tMax = toMs(sorted[sorted.length - 1].timestamp);
  const tRange = tMax - tMin || 1;

  const allY = sorted.flatMap((p) => [p.value, p.typical ?? p.value]);
  const yMax = Math.max(...allY) * 1.1;
  const yMin = Math.min(0, Math.min(...allY) * 0.95);
  const yRange = yMax - yMin || 1;

  const xOf = (t: string | number) => padL + ((toMs(t) - tMin) / tRange) * plotW;
  const yOf = (v: number) => padT + plotH - ((v - yMin) / yRange) * plotH;

  const actualPath = sorted
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.timestamp).toFixed(1)} ${yOf(p.value).toFixed(1)}`)
    .join(" ");
  const typicalPath = sorted.every((p) => p.typical !== undefined)
    ? sorted
        .map((p, i) =>
          `${i === 0 ? "M" : "L"} ${xOf(p.timestamp).toFixed(1)} ${yOf(p.typical!).toFixed(1)}`
        )
        .join(" ")
    : null;

  const yTicks = [yMin, yMin + yRange / 2, yMax];

  return (
    <div>
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
              {fmtY(t)}
            </text>
          </g>
        ))}
        <text
          x={padL}
          y={h - 4}
          fill={theme.textDim}
          fontSize={9}
          fontFamily="'JetBrains Mono', monospace"
        >
          {fmtTime(sorted[0].timestamp)}
        </text>
        <text
          x={w - padR}
          y={h - 4}
          textAnchor="end"
          fill={theme.textDim}
          fontSize={9}
          fontFamily="'JetBrains Mono', monospace"
        >
          {fmtTime(sorted[sorted.length - 1].timestamp)}
        </text>
        {typicalPath && (
          <path
            d={typicalPath}
            fill="none"
            stroke={theme.textDim}
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
        )}
        <path d={actualPath} fill="none" stroke={theme.redSoft} strokeWidth={2} />
        {sorted.map((p, i) => (
          <circle
            key={i}
            cx={xOf(p.timestamp)}
            cy={yOf(p.value)}
            r={2.5}
            fill={theme.redSoft}
          />
        ))}
      </svg>
      <div
        style={{
          display: "flex",
          gap: 14,
          marginTop: 4,
          fontSize: 11,
          color: theme.textMuted,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 14, height: 2, background: theme.redSoft }} />
          {actualLabel}
        </span>
        {typicalPath && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span
              style={{
                width: 14,
                height: 0,
                borderTop: `2px dashed ${theme.textDim}`,
              }}
            />
            {typicalLabel}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Detail mode ────────────────────────────────────────────────────────────

function DetailMode({
  top,
  data,
  onSend,
  detailCount,
}: {
  top: Anomaly;
  data: AnomalyData;
  onSend: (p: string) => void;
  detailCount: number;
}) {
  // "Related anomalies" can balloon with noisy jobs — default condensed, let the
  // user pop the full HBarRow list if they want it. Local state only; toggling
  // does not re-invoke the tool.
  const [relatedDetailed, setRelatedDetailed] = useState(false);
  const tone = severityTone(top.recordScore);
  const actual = firstNum(top.actual);
  const typical = firstNum(top.typical);
  const dev = top.deviationPercent;
  const direction = (dev ?? 0) >= 0 ? "+" : "";
  const label = data.detail?.entity_label || entityLabel(top);
  const namespace = data.detail?.namespace;
  const actualLabel = data.detail?.actual_label || "Actual";
  const typicalLabel = data.detail?.typical_label || "Typical";
  const actualSub = data.detail?.actual_sub;
  const typicalSub = data.detail?.typical_sub || "learned baseline";
  const valueHint = { jobId: top.jobId, fieldName: top.fieldName, unit: data.detail?.unit_format };

  // Header hierarchy from screenshot:
  //   job-id           (small, muted)
  //   entity-label     (big, bold)
  //   namespace · function(field)   (small, muted)
  const contextLine = [
    namespace,
    top.functionName && top.fieldName ? `${top.functionName}(${top.fieldName})` : top.fieldName,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <TimeRangeHeader
        title={<span className="mono">{label}</span>}
        subtitle={
          <>
            <span>{top.jobId}</span>
            {contextLine && <span> · {contextLine}</span>}
          </>
        }
        status={{ tone, label: top.severity }}
        rerunContext={data.rerun_context}
        onSend={onSend}
      />
      <SectionCard>
        <StatGrid>
          <StatCard
            label="Anomaly score"
            value={top.recordScore.toFixed(1)}
            tone={tone === "critical" ? "critical" : tone === "major" ? "major" : undefined}
            sub="out of 100"
          />
          <StatCard
            label={actualLabel}
            value={fmtValue(actual, valueHint)}
            tone={(dev ?? 0) >= 25 ? "critical" : undefined}
            sub={actualSub}
          />
          <StatCard label={typicalLabel} value={fmtValue(typical, valueHint)} sub={typicalSub} />
          <StatCard
            label="Deviation"
            value={dev !== undefined ? `${direction}${dev.toFixed(1)}%` : "—"}
            tone={(dev ?? 0) >= 50 ? "critical" : (dev ?? 0) >= 25 ? "major" : undefined}
            sub={(dev ?? 0) >= 0 ? "above baseline" : "below baseline"}
          />
        </StatGrid>

        {actual !== undefined && typical !== undefined && (
          <div style={{ marginTop: 10 }}>
            <ComparisonBar
              baselineLabel={`${typicalLabel} (${fmtValue(typical, valueHint)})`}
              actualLabel={`${actualLabel} (${fmtValue(actual, valueHint)})`}
              baselineValue={typical}
              actualValue={actual}
            />
          </div>
        )}
      </SectionCard>

      {data.time_series && data.time_series.length > 1 && (
        <SectionCard title={data.time_series_title || "Value over time"}>
          <TimeSeriesChart
            points={data.time_series}
            yFormat={(v) => fmtValue(v, valueHint)}
          />
          {(data.chart_window || data.time_series_note) && (
            <div style={{ marginTop: 6, fontSize: 11, color: theme.textMuted }}>
              {data.chart_window && <span>window: {data.chart_window}</span>}
              {data.chart_window && data.chart_points !== undefined && <span> · {data.chart_points} points</span>}
              {data.time_series_note && (
                <div style={{ marginTop: 4 }}>{data.time_series_note}</div>
              )}
            </div>
          )}
        </SectionCard>
      )}

      {(!data.time_series || data.time_series.length < 2) && data.time_series_note && (
        <SectionCard title="Baseline chart unavailable">
          <div style={{ fontSize: 12, color: theme.textMuted }}>{data.time_series_note}</div>
        </SectionCard>
      )}

      {detailCount > 1 && (
        <SectionCard
          title={
            <SectionTitleWithToggle
              label={`Related anomalies (${detailCount - 1})`}
              detailed={relatedDetailed}
              onToggle={() => setRelatedDetailed((v) => !v)}
            />
          }
        >
          {relatedDetailed ? (
            (data.anomalies || []).slice(1, 6).map((a, i) => (
              <HBarRow
                key={i}
                label={`${entityLabel(a)} · ${a.jobId}`}
                value={a.recordScore}
                valueLabel={`${Math.round(a.recordScore)}`}
                max={100}
                color={sevColor(a.recordScore)}
              />
            ))
          ) : (
            <CondensedChips
              items={(data.anomalies || []).slice(1, 6).map((a, i) => ({
                key: `${a.jobId}-${i}`,
                label: entityLabel(a),
                value: `${Math.round(a.recordScore)}`,
                color: sevColor(a.recordScore),
              }))}
            />
          )}
        </SectionCard>
      )}

      <InvestigationActions actions={data.investigation_actions} onSend={onSend} />
    </>
  );
}

// ── Overview mode ──────────────────────────────────────────────────────────

function OverviewMode({ data, onSend }: { data: AnomalyData; onSend: (p: string) => void }) {
  const anomalies = data.anomalies ?? [];
  const lookback = data.filters?.lookback || "1h";

  // Summary-by-default matches apm-health-summary / cluster-overview. Local state
  // only — toggling does not re-invoke the tool.
  const [entityDetailed, setEntityDetailed] = useState(false);
  const [jobDetailed, setJobDetailed] = useState(false);

  // Bucket by severity
  const bySev = { critical: 0, major: 0, minor: 0 };
  for (const a of anomalies) bySev[a.severity] = (bySev[a.severity] || 0) + 1;

  // Unique entities, highest-score wins
  const byEntity = new Map<string, Anomaly>();
  for (const a of anomalies) {
    const key = a.entity || entityLabel(a);
    const prev = byEntity.get(key);
    if (!prev || a.recordScore > prev.recordScore) byEntity.set(key, a);
  }
  const entities = [...byEntity.values()].sort((a, b) => b.recordScore - a.recordScore);
  const topEntities = entities.slice(0, 10);

  const jobs = data.jobsSummary || {};
  const jobEntries = Object.entries(jobs).sort((a, b) => b[1] - a[1]);
  const jobCount = jobEntries.length;
  const jobMax = jobCount ? Math.max(...Object.values(jobs)) : 1;

  // Drill-down prompts target a single entity / job with the current lookback.
  // We quote the value in single quotes inside the prompt so the LLM passes it
  // through as-is; entity values may contain dots or slashes.
  const entityDrill = (a: Anomaly) => {
    const ent = a.entity || entityLabel(a);
    return `Use ml-anomalies to show details for entity "${ent}" with lookback "${lookback}"`;
  };
  const jobDrill = (jobId: string) =>
    `Use ml-anomalies to show details for job_id "${jobId}" with lookback "${lookback}"`;

  return (
    <>
      <TimeRangeHeader
        title="Anomaly overview"
        subtitle={
          data.filters?.minScore !== undefined
            ? `score ≥ ${data.filters.minScore}`
            : undefined
        }
        status={{
          tone: bySev.critical > 0 ? "critical" : bySev.major > 0 ? "major" : "minor",
          label: `${anomalies.length} firing`,
        }}
        rerunContext={data.rerun_context}
        onSend={onSend}
      />

      <StatGrid>
        <StatCard label="Critical" value={bySev.critical} tone={bySev.critical > 0 ? "critical" : undefined} sub="score ≥ 90" />
        <StatCard label="Major" value={bySev.major} tone={bySev.major > 0 ? "major" : undefined} sub="75–89" />
        <StatCard label="Minor" value={bySev.minor} sub="50–74" />
        <StatCard label="Entities" value={byEntity.size} sub={`${jobCount} job${jobCount === 1 ? "" : "s"}`} />
      </StatGrid>

      <SectionCard
        title={
          <SectionTitleWithToggle
            label={`Affected entities (${entities.length})`}
            detailed={entityDetailed}
            onToggle={() => setEntityDetailed((v) => !v)}
          />
        }
      >
        {entityDetailed ? (
          topEntities.map((a, i) => (
            <HBarRow
              key={i}
              label={`${entityLabel(a)} · ${a.jobId}`}
              value={a.recordScore}
              valueLabel={`${Math.round(a.recordScore)}`}
              max={100}
              color={sevColor(a.recordScore)}
              inspect={{
                onClick: () => onSend(entityDrill(a)),
                title: `Inspect ${entityLabel(a)}`,
              }}
            />
          ))
        ) : (
          <CondensedChips
            items={topEntities.map((a, i) => ({
              key: `${a.jobId}-${i}`,
              label: entityLabel(a),
              value: `${Math.round(a.recordScore)}`,
              color: sevColor(a.recordScore),
            }))}
          />
        )}
      </SectionCard>

      {jobCount >= 1 && (
        <SectionCard
          title={
            <SectionTitleWithToggle
              label={`By ML job (${jobCount})`}
              detailed={jobDetailed}
              onToggle={() => setJobDetailed((v) => !v)}
            />
          }
        >
          {jobDetailed ? (
            jobEntries.map(([job, count]) => (
              <HBarRow
                key={job}
                label={job}
                value={count}
                valueLabel={`${count}`}
                max={jobMax}
                color={theme.blue}
                inspect={{
                  onClick: () => onSend(jobDrill(job)),
                  title: `Inspect ${job}`,
                }}
              />
            ))
          ) : (
            <CondensedChips
              items={jobEntries.map(([job, count]) => ({
                key: job,
                label: job,
                value: `${count}`,
                color: theme.blue,
              }))}
            />
          )}
        </SectionCard>
      )}

      <InvestigationActions actions={data.investigation_actions} onSend={onSend} />
    </>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────

export function App() {
  const [data, setData] = useState<AnomalyData | null>(null);
  const [app, setApp] = useState<AppLike | null>(null);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = baseStyles;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const handleToolResult = useCallback((params: ToolResultParams) => {
    const d = parseToolResult<AnomalyData>(params);
    if (!d) return;
    if (d.top_anomalies && !d.anomalies) d.anomalies = d.top_anomalies;
    if (d.anomalies?.length) setData(d);
  }, []);

  useApp({
    appInfo: { name: "Anomaly Explainer", version: "1.0.0" },
    onAppCreated: (a) => {
      a.ontoolresult = handleToolResult;
      setApp(a);
    },
  });

  const mode = useMemo<"detail" | "overview" | null>(() => {
    if (!data?.anomalies?.length) return null;
    const anomalies = data.anomalies;
    if (anomalies.length === 1) return "detail";
    if (data.filters?.entity || data.filters?.jobId) return "detail";
    // Single-entity result even without a filter
    const entities = new Set(anomalies.map((a) => a.entity || entityLabel(a)));
    if (entities.size === 1) return "detail";
    return "overview";
  }, [data]);

  const onSend = useCallback(
    (prompt: string) => {
      app?.sendMessage(prompt);
    },
    [app]
  );

  if (!data || !mode) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: theme.textMuted }}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>Waiting for anomaly data…</div>
        <div style={{ fontSize: 11 }}>Call ml-anomalies or observe to populate this view.</div>
      </div>
    );
  }

  const top = data.anomalies![0];

  return (
    <div style={{ padding: "14px 16px", maxWidth: 620 }}>
      {data.headline && (
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: theme.redSoft,
            marginBottom: 12,
            padding: "8px 10px",
            background: `${theme.red}15`,
            borderRadius: 6,
            border: `1px solid ${theme.red}30`,
          }}
        >
          {data.headline}
        </div>
      )}

      {mode === "detail" ? (
        <DetailMode
          top={top}
          data={data}
          onSend={onSend}
          detailCount={data.anomalies!.length}
        />
      ) : (
        <OverviewMode data={data} onSend={onSend} />
      )}
    </div>
  );
}

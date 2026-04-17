/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Watch view — renders results from the `watch` tool.
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

type MetricResult = {
  status: "CONDITION_MET" | "TIMEOUT";
  description: string;
  final_value?: number;
  last_value?: number | null;
  condition: string;
  detected_after_seconds?: number;
  elapsed_seconds?: number;
  polls: number;
  trend: { elapsed_seconds: number; value: number }[];
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

type WatchResult = MetricResult | AnomalyAlert;

function isMetric(r: WatchResult): r is MetricResult {
  return r.status === "CONDITION_MET" || r.status === "TIMEOUT";
}

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

// ── Trend bar chart ────────────────────────────────────────────────────────

function TrendChart({
  trend,
  threshold,
  thresholdLabel,
  unit,
  conditionMet,
}: {
  trend: { elapsed_seconds: number; value: number }[];
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

  const lastT = trend[trend.length - 1].elapsed_seconds;
  const allY = [...trend.map((p) => p.value), threshold ?? 0].filter((v) => Number.isFinite(v));
  const yMax = Math.max(...allY) * 1.15;
  const yMin = Math.min(0, Math.min(...allY) * 0.9);
  const yRange = yMax - yMin || 1;

  const barCount = trend.length;
  const barGap = 6;
  const barW = Math.max(8, (plotW - barGap * (barCount - 1)) / Math.max(barCount, 1));

  const yOf = (v: number) => padT + plotH - ((v - yMin) / yRange) * plotH;

  const yTicks = [yMin, yMin + yRange / 2, yMax];

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
      {trend.map((p, i) => {
        const isLast = i === trend.length - 1;
        const belowThreshold =
          threshold !== undefined ? p.value < threshold : true;
        const isGreen = conditionMet && isLast && belowThreshold;
        const color = isGreen
          ? theme.greenSoft
          : belowThreshold && conditionMet
          ? theme.amber
          : theme.redSoft;
        const x = padL + i * (barW + barGap);
        const y = yOf(p.value);
        const barH = padT + plotH - y;
        const elapsed = lastT - p.elapsed_seconds;
        return (
          <g key={i}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(1, barH)}
              fill={`${color}55`}
              stroke={color}
              strokeWidth={1}
              rx={2}
            />
            <text
              x={x + barW / 2}
              y={h - 8}
              textAnchor="middle"
              fill={theme.textDim}
              fontSize={9}
              fontFamily="'JetBrains Mono', monospace"
            >
              {elapsed === 0 ? "now" : `-${elapsed}s`}
            </text>
          </g>
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

function MetricView({ data, onSend }: { data: MetricResult; onSend: (p: string) => void }) {
  const unit = data.unit || inferUnit(data.description, data.esql);
  const currentValue = data.final_value ?? data.last_value ?? undefined;
  const thresholdInfo = parseThreshold(data.condition);
  const threshold = thresholdInfo?.value;
  const conditionMet = data.status === "CONDITION_MET";
  const tone: BadgeTone = conditionMet ? "ok" : "major";
  const badgeText = conditionMet ? "condition met" : "timeout";

  const elapsed = data.detected_after_seconds ?? data.elapsed_seconds ?? 0;

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
              {data.description || "Watched metric"}
            </div>
            <div className="mono" style={{ fontSize: 11, color: theme.textMuted }}>
              {data.esql
                ? `${data.esql.split("|")[0]?.trim()} · ${data.condition}`
                : `condition ${data.condition}`}
              {data.namespace ? ` · ${data.namespace}` : ""}
            </div>
          </div>
          <StatusBadge tone={tone}>{badgeText}</StatusBadge>
        </div>

        <StatGrid>
          <StatCard
            label="Current avg"
            value={fmt(currentValue, unit)}
            tone={conditionMet ? "ok" : "major"}
          />
          {threshold !== undefined && (
            <StatCard
              label="Threshold"
              value={`${thresholdInfo!.comparator} ${fmt(threshold, unit)}`}
            />
          )}
          {data.peak_value !== undefined && (
            <StatCard
              label={data.peak_label || "Peak (earlier)"}
              value={fmt(data.peak_value, unit)}
              tone="critical"
            />
          )}
          {data.baseline_value !== undefined && (
            <StatCard label="Typical baseline" value={fmt(data.baseline_value, unit)} />
          )}
          <StatCard
            label="Elapsed"
            value={`${elapsed}s`}
            sub={`${data.polls} poll${data.polls === 1 ? "" : "s"}`}
          />
        </StatGrid>

        <TrendChart
          trend={data.trend}
          threshold={threshold}
          thresholdLabel={threshold !== undefined ? `${fmt(threshold, unit)} threshold` : undefined}
          unit={unit}
          conditionMet={conditionMet}
        />
      </SectionCard>

      <InvestigationActions
        title="Recommended next steps"
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
          {data.status === "QUIET" ? "No anomalies fired" : "Watch could not run"}
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
  const [data, setData] = useState<WatchResult | null>(null);
  const [app, setApp] = useState<AppLike | null>(null);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = baseStyles;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const handleToolResult = useCallback((params: ToolResultParams) => {
    const d = parseToolResult<WatchResult>(params);
    if (d?.status) setData(d);
  }, []);

  useApp({
    appInfo: { name: "Watch", version: "1.0.0" },
    onAppCreated: (a) => {
      a.ontoolresult = handleToolResult;
      setApp(a);
    },
  });

  const onSend = useCallback((p: string) => app?.sendMessage(p), [app]);

  if (!data) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: theme.textMuted }}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>Waiting for watch result…</div>
        <div style={{ fontSize: 11 }}>Call the watch tool to populate this view.</div>
      </div>
    );
  }

  return (
    <div style={{ padding: "14px 16px", maxWidth: 620 }}>
      {isMetric(data) ? (
        <MetricView data={data} onSend={onSend} />
      ) : (
        <AnomalyAlertView data={data} onSend={onSend} />
      )}
    </div>
  );
}

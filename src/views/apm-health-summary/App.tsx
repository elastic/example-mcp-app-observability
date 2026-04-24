/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Health Summary — cluster rollup view.
 *
 * Layout:
 *   Header:      namespace · lookback · filter   [status badge]
 *   Stat grid:   total pods · services · degraded services · active anomalies
 *   Section:     anomaly breakdown (per-severity count tiles + donut)
 *   Section:     top pods by memory (condensed chip strip; "Show details" → HBarRow list)
 *   Section:     service throughput (condensed chip strip; "Show details" → HBarRow list)
 *   Footer:      investigation-action buttons
 *
 * All sections render conditionally — graceful degradation when backends are missing.
 *
 * Density toggles on the two row-list sections are pure local React state — no
 * tool re-invocation on toggle. State resets when the tool is re-run (e.g. the
 * user clicks a time-range chip); that reset is intentional and acceptable.
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
  HBarRow,
  InvestigationActions,
  InvestigationAction,
  TimeRangeHeader,
  RerunContext,
} from "@shared/components";

interface MetricTimelineBucket {
  ts: number;
  value: number;
}

interface ServiceDetail {
  service: string;
  throughput: number;
  avg_latency_ms?: number;
  error_rate_pct?: number;
  timeline?: MetricTimelineBucket[];
  peak_throughput?: number;
}

interface DegradedService {
  service: string;
  reasons: string[];
}

interface PodDetail {
  pod: string;
  avg_memory_mb: number;
  avg_cpu_cores?: number;
  timeline?: MetricTimelineBucket[];
  peak_memory_mb?: number;
}

interface TimelineBucket {
  ts: number;
  max_score: number;
}

interface TimelineWindow {
  start_ms: number;
  end_ms: number;
  bucket_span_ms: number;
}

interface TopAnomalyEntity {
  entity: string;
  max_score: number;
  timeline?: TimelineBucket[];
}

interface AnomalyInfo {
  total: number;
  by_severity?: Record<string, number>;
  top_entities?: TopAnomalyEntity[];
  timeline_window?: TimelineWindow;
}

interface DataCoverage {
  apm: boolean;
  kubernetes: boolean;
  ml_anomalies: boolean;
}

interface HealthData {
  overall_health: string;
  namespace: string;
  lookback: string;
  data_coverage?: DataCoverage;
  services: {
    total: number;
    degraded_count: number;
    details: ServiceDetail[];
    timeline_window?: TimelineWindow;
  };
  degraded_services: DegradedService[];
  pods?: { total: number; top_memory: PodDetail[]; timeline_window?: TimelineWindow };
  pods_note?: string;
  anomalies?: AnomalyInfo;
  anomalies_note?: string;
  recommendation?: string;
  warning?: string;
  exclude_filter?: string;
  namespace_requested?: string;
  namespace_note?: string;
  namespace_candidates?: string[];
  investigation_actions?: InvestigationAction[];
  rerun_context?: RerunContext;
}

// Okabe-Ito-derived palette: vermillion / orange / sky-blue. Strong hue separation
// and a hot-to-cool severity ramp that remains distinguishable under all common
// color-vision deficiencies (protanopia, deuteranopia, tritanopia).
// Critical text uses #F07840 rather than canonical Okabe-Ito #D55E00 because
// the latter fails WCAG 2 AA as TEXT on bg-secondary / bg-elevated (~4.4:1).
// #F07840 is the same hue family and clears ~4.8:1. Chart/donut stroke uses
// the same value for consistency — visually nearly identical to the canonical.
const SEV_COLORS: Record<string, string> = {
  critical: "#F07840",
  major: "#E69F00",
  minor: "#56B4E9",
};
const SEV_ORDER = ["critical", "major", "minor"];
const HEALTH_TONE: Record<string, BadgeTone> = {
  critical: "critical",
  degraded: "major",
  healthy: "ok",
};

// ── Donut chart ────────────────────────────────────────────────────────────

// Geometry:
//   size=120, centerline r=38, strokeWidth=16
//   → outer edge = 46 (2px margin inside the 120 viewBox), inner hole radius = 30
//   The previous donut (r=38, strokeWidth=56) had its outer edge at 66, which
//   exceeded the viewBox on both sides and made the donut look square / clipped.
function Donut({ segments, size = 120 }: { segments: Array<{ label: string; value: number; color: string }>; size?: number }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total === 0) return null;
  const cx = size / 2;
  const cy = size / 2;
  const strokeWidth = Math.round(size * 0.13);
  const r = size / 2 - strokeWidth / 2 - 2;
  const circ = 2 * Math.PI * r;

  let offset = 0;
  const arcs = segments.map((s) => {
    const frac = s.value / total;
    const length = frac * circ;
    const arc = (
      <circle
        key={s.label}
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={s.color}
        strokeWidth={strokeWidth}
        strokeDasharray={`${length} ${circ}`}
        strokeDashoffset={-offset}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
    );
    offset += length;
    return arc;
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={theme.border} strokeWidth={strokeWidth} />
      {arcs}
      <text
        x={cx}
        y={cy - 2}
        textAnchor="middle"
        dominantBaseline="middle"
        className="mono"
        style={{ fontSize: size * 0.22, fontWeight: 700, fill: theme.text }}
      >
        {total}
      </text>
      <text
        x={cx}
        y={cy + size * 0.14}
        textAnchor="middle"
        dominantBaseline="middle"
        style={{ fontSize: size * 0.08, fill: theme.textMuted, textTransform: "lowercase", letterSpacing: 0.3 }}
      >
        total
      </text>
    </svg>
  );
}

function severityFromScore(score: number): "critical" | "major" | "minor" | "none" {
  if (score >= 90) return "critical";
  if (score >= 75) return "major";
  if (score >= 50) return "minor";
  return "none";
}

function shortenEntity(label: string): string {
  // "service.name=checkout" -> "checkout" ; "host.name=node-us-east-4" -> "node-us-east-4"
  const eq = label.indexOf("=");
  return eq >= 0 ? label.slice(eq + 1) : label;
}

function fmtAxisTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Entity × time heatmap, one row per top anomaly entity. Each cell's color
 * is driven by the max anomaly score that fell into that bucket (Okabe-Ito
 * ramp matching the rest of the view); empty buckets render as a subtle
 * inset. Mirrors the Kibana Anomaly Explorer heatmap at this zoom.
 */
function AnomalyHeatmap({
  entities,
  window,
}: {
  entities: TopAnomalyEntity[];
  window: TimelineWindow;
}) {
  const rows = entities.filter((e) => (e.timeline?.length ?? 0) > 0);
  if (rows.length === 0) return null;

  const bucketCount = rows[0].timeline!.length;

  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: theme.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          marginBottom: 8,
          fontWeight: 600,
        }}
      >
        Top entities · last {Math.round((window.end_ms - window.start_ms) / 60000)}m
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(120px, 22%) 1fr",
          rowGap: 4,
          alignItems: "center",
        }}
      >
        {rows.map((row) => (
          <React.Fragment key={row.entity}>
            <div
              style={{
                fontSize: 11,
                color: theme.text,
                fontFamily: "'JetBrains Mono', monospace",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                paddingRight: 10,
              }}
              title={row.entity}
            >
              {shortenEntity(row.entity)}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${bucketCount}, 1fr)`,
                gap: 2,
              }}
            >
              {row.timeline!.map((b, i) => {
                const sev = severityFromScore(b.max_score);
                const color = sev === "none" ? undefined : SEV_COLORS[sev];
                return (
                  <div
                    key={i}
                    title={
                      sev === "none"
                        ? `${fmtAxisTime(b.ts)} · no anomaly`
                        : `${fmtAxisTime(b.ts)} · max score ${b.max_score}`
                    }
                    style={{
                      height: 20,
                      borderRadius: 3,
                      background: color ?? "var(--bg-tertiary)",
                      border: color ? `1px solid ${color}88` : "1px solid var(--border-subtle)",
                    }}
                  />
                );
              })}
            </div>
          </React.Fragment>
        ))}

        <div />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 4,
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
            color: theme.textMuted,
          }}
        >
          <span>{fmtAxisTime(window.start_ms)}</span>
          <span>{fmtAxisTime(window.end_ms)}</span>
        </div>
      </div>
    </div>
  );
}

function AnomalyBreakdown({ anomalies }: { anomalies: AnomalyInfo }) {
  const sev = anomalies.by_severity || {};
  const segments = SEV_ORDER.filter((s) => (sev[s] ?? 0) > 0).map((s) => ({
    label: s,
    value: sev[s]!,
    color: SEV_COLORS[s],
  }));
  if (!segments.length) {
    return (
      <div style={{ fontSize: 12, color: theme.greenSoft }}>No anomalies in this window.</div>
    );
  }

  const hasHeatmap = !!(anomalies.top_entities?.length && anomalies.timeline_window);

  // Summary column: donut on the left, stacked severity pills on the right.
  // When a heatmap is present the whole block sits beside it on a single
  // row (flex-wrap makes it fall back to stacked on narrow viewports).
  const SummaryBlock = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "0 0 auto" }}>
      <Donut segments={segments} size={96} />
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {segments.map((s) => (
          <div
            key={s.label}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "2px 10px",
              background: `${s.color}18`,
              border: `1px solid ${s.color}40`,
              borderRadius: 999,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: s.color,
                display: "inline-block",
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: s.color,
                textTransform: "lowercase",
                fontWeight: 600,
                letterSpacing: 0.3,
              }}
            >
              {s.label}
            </span>
            <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: s.color, marginLeft: "auto" }}>
              {s.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  if (!hasHeatmap) return SummaryBlock;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
      {SummaryBlock}
      <div style={{ flex: "1 1 360px", minWidth: 280 }}>
        <AnomalyHeatmap
          entities={anomalies.top_entities!}
          window={anomalies.timeline_window!}
        />
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────

function shortenPod(name: string): string {
  return name.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "").replace(/-[a-z0-9]{8,10}$/, "");
}

function podMemColor(mb: number, max: number): string {
  const pct = mb / max;
  if (pct > 0.75) return theme.redSoft;
  if (pct > 0.5) return theme.amber;
  return theme.textDim;
}

/**
 * Small SVG sparkline. Fixed-height row artifact — width flexes via a parent
 * container. Renders a line with an optional filled area under it; peak
 * marker drops a small dot on the highest sample.
 */
function Sparkline({
  values,
  color,
  height = 22,
  showPeak = true,
}: {
  values: number[];
  color: string;
  height?: number;
  showPeak?: boolean;
}) {
  if (!values.length) return null;
  const W = 120;
  const H = height;
  const PAD_Y = 2;
  const plotH = H - PAD_Y * 2;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  // Anchor at the cell top (PAD_Y) so identical values map to the midline
  // when range is 0, avoiding a divide-by-zero flatline at the bottom.
  const y = (v: number) => PAD_Y + plotH - ((v - min) / range) * plotH;
  const x = (i: number) =>
    values.length === 1 ? W / 2 : (i / (values.length - 1)) * W;
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L ${W} ${H} L 0 ${H} Z`;
  const peakIdx = values.indexOf(max);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, display: "block" }}>
      <path d={area} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {showPeak && peakIdx >= 0 && (
        <circle cx={x(peakIdx)} cy={y(max)} r={1.8} fill={color} vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}

/**
 * Row for a metric list (top pods / services by throughput etc.) with a
 * sparkline occupying the middle flex slot. Right side shows the current
 * value + optional peak.
 */
function SparklineRow({
  label,
  values,
  color,
  currentLabel,
  peakLabel,
  inspect,
}: {
  label: React.ReactNode;
  values: number[];
  color: string;
  currentLabel: string;
  peakLabel?: string;
  inspect?: { onClick: () => void; title?: string };
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 0",
        borderBottom: `1px solid ${theme.border}`,
      }}
    >
      <div
        style={{
          flex: "0 0 32%",
          minWidth: 0,
          fontSize: 12,
          color: theme.text,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
      <div style={{ flex: "1 1 0", minWidth: 0 }}>
        <Sparkline values={values} color={color} />
      </div>
      <div
        className="mono"
        style={{
          flex: "0 0 auto",
          fontSize: 11,
          color: theme.text,
          textAlign: "right",
          whiteSpace: "nowrap",
          minWidth: 72,
        }}
      >
        {currentLabel}
        {peakLabel && (
          <div style={{ fontSize: 10, color: theme.textMuted }}>peak {peakLabel}</div>
        )}
      </div>
      {inspect && (
        <button
          onClick={inspect.onClick}
          title={inspect.title ?? "Inspect"}
          aria-label={inspect.title ?? "Inspect"}
          style={{
            flex: "0 0 auto",
            width: 22,
            height: 22,
            padding: 0,
            background: "transparent",
            border: "none",
            color: theme.textMuted,
            cursor: "pointer",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 L14 14" />
          </svg>
        </button>
      )}
    </div>
  );
}

function fmtThroughput(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

export function App() {
  const [data, setData] = useState<HealthData | null>(null);
  const [app, setApp] = useState<AppLike | null>(null);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = baseStyles;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const handleToolResult = useCallback((params: ToolResultParams) => {
    const d = parseToolResult<HealthData>(params);
    if (d?.overall_health) setData(d);
  }, []);

  useApp({
    appInfo: { name: "APM Health Summary", version: "1.0.0" },
    onAppCreated: (a) => {
      a.ontoolresult = handleToolResult;
      setApp(a);
    },
  });

  const onSend = useCallback((p: string) => app?.sendMessage(p), [app]);

  const pods = data?.pods?.top_memory ?? [];
  const maxMem = useMemo(
    () => Math.max(100, ...pods.map((p) => p.avg_memory_mb)),
    [pods]
  );
  const services = data?.services.details ?? [];
  const maxThroughput = useMemo(
    () => Math.max(1, ...services.map((s) => s.throughput)),
    [services]
  );
  const degradedSet = useMemo(
    () => new Set((data?.degraded_services ?? []).map((d) => d.service)),
    [data]
  );

  if (!data) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: theme.textMuted }}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>Waiting for health data…</div>
        <div style={{ fontSize: 11 }}>Call apm-health-summary to populate this view.</div>
      </div>
    );
  }

  const tone = HEALTH_TONE[data.overall_health] || "neutral";

  return (
    <div style={{ padding: "14px 16px" }}>
      {data.namespace_candidates?.length ? (
        <div
          style={{
            marginBottom: 10,
            padding: "8px 12px",
            background: `${theme.amber}18`,
            border: `1px solid ${theme.amber}55`,
            borderRadius: 6,
            fontSize: 11,
            color: theme.text,
          }}
        >
          <div style={{ fontWeight: 700, color: theme.amber, marginBottom: 4 }}>
            Namespace not found
          </div>
          <div>
            "{data.namespace_requested || data.namespace}" did not match. Did you mean:{" "}
            {data.namespace_candidates.slice(0, 5).map((c, i) => (
              <span key={c} className="mono">
                {i > 0 ? ", " : ""}
                {c}
              </span>
            ))}
            ?
          </div>
        </div>
      ) : null}

      {/* Header */}
      <TimeRangeHeader
        title={<span className="mono">{data.namespace}</span>}
        subtitle={
          <>
            {data.exclude_filter ? `${data.exclude_filter} excluded` : null}
            {data.namespace_requested && (
              <span
                style={{
                  marginLeft: data.exclude_filter ? 8 : 0,
                  color: theme.amber,
                  fontStyle: "italic",
                }}
              >
                resolved from "{data.namespace_requested}"
              </span>
            )}
          </>
        }
        status={{ tone, label: data.overall_health }}
        rerunContext={data.rerun_context}
        onSend={onSend}
      />

      {/* Stat grid */}
      <StatGrid>
        <StatCard label="Total pods" value={data.pods?.total ?? 0} />
        <StatCard label="Services" value={data.services.total} />
        <StatCard
          label="Degraded services"
          value={data.services.degraded_count}
          tone={data.services.degraded_count > 0 ? "critical" : "ok"}
        />
        <StatCard
          label="Active anomalies"
          value={data.anomalies?.total ?? 0}
          tone={
            (data.anomalies?.by_severity?.critical ?? 0) > 0
              ? "critical"
              : (data.anomalies?.total ?? 0) > 0
              ? "major"
              : "ok"
          }
        />
      </StatGrid>

      {/* Warning / recommendation */}
      {data.warning && (
        <SectionCard>
          <div style={{ fontSize: 12, color: theme.amber }}>{data.warning}</div>
        </SectionCard>
      )}
      {data.recommendation && (
        <SectionCard>
          <div style={{ fontSize: 12, color: theme.amber }}>{data.recommendation}</div>
        </SectionCard>
      )}

      {/* Anomaly breakdown */}
      {data.anomalies ? (
        <SectionCard title="Anomaly breakdown">
          <AnomalyBreakdown anomalies={data.anomalies} />
        </SectionCard>
      ) : data.anomalies_note ? (
        <SectionCard title="ML anomalies">
          <div style={{ fontSize: 11, color: theme.textMuted }}>{data.anomalies_note}</div>
        </SectionCard>
      ) : null}

      {/* Top pods by memory — sparkline per row when the tool returned
       * per-pod timelines, plain HBarRow list as fallback otherwise. */}
      {pods.length ? (
        <SectionCard title="Top pods by memory">
          {pods.some((p) => p.timeline?.length) ? (
            pods.slice(0, 6).map((p) => {
              const vals = p.timeline?.map((b) => b.value) ?? [];
              const peak = p.peak_memory_mb ?? (vals.length ? Math.max(...vals) : p.avg_memory_mb);
              return (
                <SparklineRow
                  key={p.pod}
                  label={shortenPod(p.pod)}
                  values={vals.length ? vals : [p.avg_memory_mb]}
                  color={podMemColor(p.avg_memory_mb, maxMem)}
                  currentLabel={`${p.avg_memory_mb.toFixed(0)} MB`}
                  peakLabel={`${peak.toFixed(0)} MB`}
                />
              );
            })
          ) : (
            pods.slice(0, 6).map((p) => (
              <HBarRow
                key={p.pod}
                label={shortenPod(p.pod)}
                value={p.avg_memory_mb}
                valueLabel={`${p.avg_memory_mb.toFixed(1)} MB`}
                max={maxMem}
                color={podMemColor(p.avg_memory_mb, maxMem)}
              />
            ))
          )}
        </SectionCard>
      ) : data.pods_note ? (
        <SectionCard title="Pods">
          <div style={{ fontSize: 11, color: theme.textMuted }}>{data.pods_note}</div>
        </SectionCard>
      ) : null}

      {/* Service throughput — same pattern: sparkline per row when the tool
       * returned per-service timelines, HBarRow list fallback otherwise. */}
      {services.length > 0 && (
        <SectionCard title={`Service throughput · last ${data.lookback}`}>
          {services.some((s) => s.timeline?.length) ? (
            services.slice(0, 8).map((s) => {
              const vals = s.timeline?.map((b) => b.value) ?? [];
              const peak = s.peak_throughput ?? (vals.length ? Math.max(...vals) : s.throughput);
              return (
                <SparklineRow
                  key={s.service}
                  label={s.service}
                  values={vals.length ? vals : [s.throughput]}
                  color={degradedSet.has(s.service) ? theme.redSoft : theme.blue}
                  currentLabel={`${fmtThroughput(s.throughput)} rpm`}
                  peakLabel={`${fmtThroughput(peak)} rpm`}
                />
              );
            })
          ) : (
            services.slice(0, 8).map((s) => (
              <HBarRow
                key={s.service}
                label={s.service}
                value={s.throughput}
                valueLabel={`${s.throughput} rpm`}
                max={maxThroughput}
                color={degradedSet.has(s.service) ? theme.redSoft : theme.blue}
              />
            ))
          )}
        </SectionCard>
      )}

      <InvestigationActions actions={data.investigation_actions} onSend={onSend} />
    </div>
  );
}

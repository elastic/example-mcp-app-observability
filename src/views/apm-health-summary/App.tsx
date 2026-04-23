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
  SectionTitleWithToggle,
  CondensedChips,
} from "@shared/components";

interface ServiceDetail {
  service: string;
  throughput: number;
  avg_latency_ms?: number;
  error_rate_pct?: number;
}

interface DegradedService {
  service: string;
  reasons: string[];
}

interface PodDetail {
  pod: string;
  avg_memory_mb: number;
  avg_cpu_cores?: number;
}

interface AnomalyInfo {
  total: number;
  by_severity?: Record<string, number>;
  top_entities?: Array<{ entity: string; max_score: number }>;
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
  };
  degraded_services: DegradedService[];
  pods?: { total: number; top_memory: PodDetail[] };
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
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
        {segments.map((s) => (
          <div
            key={s.label}
            style={{
              background: `${s.color}18`,
              border: `1px solid ${s.color}40`,
              borderRadius: 6,
              padding: "10px 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: s.color,
                textTransform: "lowercase",
                letterSpacing: 0.3,
                fontWeight: 600,
              }}
            >
              {s.label}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: s.color,
                lineHeight: 1,
              }}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>
      <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center" }}>
        <Donut segments={segments} />
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

export function App() {
  const [data, setData] = useState<HealthData | null>(null);
  const [app, setApp] = useState<AppLike | null>(null);
  const [memDetailed, setMemDetailed] = useState(false);
  const [svcDetailed, setSvcDetailed] = useState(false);

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

      {/* Top pods by memory — condensed chip strip by default, toggle to HBarRow list */}
      {pods.length ? (
        <SectionCard
          title={
            <SectionTitleWithToggle
              label="Top pods by memory"
              detailed={memDetailed}
              onToggle={() => setMemDetailed((v) => !v)}
            />
          }
        >
          {memDetailed ? (
            <>
              <div
                style={{
                  display: "flex",
                  fontSize: 10,
                  color: theme.textDim,
                  textTransform: "uppercase",
                  letterSpacing: 0.3,
                  padding: "2px 0 4px",
                }}
              >
                <div style={{ flex: "0 0 35%" }}>pod</div>
                <div style={{ flex: "0 0 auto", minWidth: 70, textAlign: "right" }}>memory</div>
                <div style={{ flex: 1, paddingLeft: 10 }}>usage</div>
              </div>
              {pods.slice(0, 6).map((p) => (
                <HBarRow
                  key={p.pod}
                  label={shortenPod(p.pod)}
                  value={p.avg_memory_mb}
                  valueLabel={`${p.avg_memory_mb.toFixed(1)} MB`}
                  max={maxMem}
                  color={podMemColor(p.avg_memory_mb, maxMem)}
                />
              ))}
            </>
          ) : (
            <CondensedChips
              items={pods.slice(0, 6).map((p) => ({
                key: p.pod,
                label: shortenPod(p.pod),
                value: `${p.avg_memory_mb.toFixed(0)} MB`,
                color: podMemColor(p.avg_memory_mb, maxMem),
              }))}
            />
          )}
        </SectionCard>
      ) : data.pods_note ? (
        <SectionCard title="Pods">
          <div style={{ fontSize: 11, color: theme.textMuted }}>{data.pods_note}</div>
        </SectionCard>
      ) : null}

      {/* Service throughput — condensed chip strip by default, toggle to HBarRow list */}
      {services.length > 0 && (
        <SectionCard
          title={
            <SectionTitleWithToggle
              label={`Service throughput (rpm, last ${data.lookback})`}
              detailed={svcDetailed}
              onToggle={() => setSvcDetailed((v) => !v)}
            />
          }
        >
          {svcDetailed ? (
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
          ) : (
            <CondensedChips
              items={services.slice(0, 8).map((s) => ({
                key: s.service,
                label: s.service,
                value: `${s.throughput} rpm`,
                color: degradedSet.has(s.service) ? theme.redSoft : theme.textMuted,
              }))}
            />
          )}
        </SectionCard>
      )}

      <InvestigationActions actions={data.investigation_actions} onSend={onSend} />
    </div>
  );
}

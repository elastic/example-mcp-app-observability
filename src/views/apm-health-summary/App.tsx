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
 *   Section:     top pods by memory (HBarRow list, MB values)
 *   Section:     service throughput (HBarRow list, rpm values)
 *   Footer:      investigation-action buttons
 *
 * All sections render conditionally — graceful degradation when backends are missing.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
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
  investigation_actions?: InvestigationAction[];
}

const SEV_COLORS: Record<string, string> = {
  critical: theme.redSoft,
  major: theme.orange,
  minor: theme.amber,
};
const SEV_ORDER = ["critical", "major", "minor"];
const HEALTH_TONE: Record<string, BadgeTone> = {
  critical: "critical",
  degraded: "major",
  healthy: "ok",
};

// ── Donut chart ────────────────────────────────────────────────────────────

function Donut({ segments }: { segments: Array<{ label: string; value: number; color: string }> }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total === 0) return null;
  const size = 100;
  const cx = size / 2;
  const cy = size / 2;
  const r = 38;
  const inner = 22;
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
        strokeWidth={size - inner * 2}
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
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={theme.border} strokeWidth={size - inner * 2} />
      {arcs}
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
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        {segments.map((s) => (
          <div
            key={s.label}
            style={{
              flex: 1,
              background: `${s.color}18`,
              border: `1px solid ${s.color}40`,
              borderRadius: 6,
              padding: "14px 12px",
              textAlign: "center",
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 26,
                fontWeight: 700,
                color: s.color,
                lineHeight: 1,
              }}
            >
              {s.value}
            </div>
            <div
              style={{
                fontSize: 11,
                color: s.color,
                marginTop: 6,
                textTransform: "lowercase",
              }}
            >
              {s.label}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
        <Donut segments={segments} />
      </div>
      <div style={{ display: "flex", justifyContent: "center", gap: 14, fontSize: 11, color: theme.textMuted }}>
        {segments.map((s) => (
          <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 10, height: 10, background: s.color, borderRadius: 2 }} />
            {s.label.charAt(0).toUpperCase() + s.label.slice(1)} ({s.value})
          </span>
        ))}
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
    <div style={{ padding: "14px 16px", maxWidth: 620 }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            className="mono"
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: theme.text,
              marginBottom: 2,
              wordBreak: "break-all",
            }}
          >
            {data.namespace}
          </div>
          <div style={{ fontSize: 11, color: theme.textMuted }}>
            last {data.lookback}
            {data.exclude_filter ? ` · ${data.exclude_filter} excluded` : ""}
          </div>
        </div>
        <StatusBadge tone={tone}>{data.overall_health}</StatusBadge>
      </div>

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

      {/* Top pods by memory */}
      {pods.length ? (
        <SectionCard title="Top pods by memory">
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
        </SectionCard>
      ) : data.pods_note ? (
        <SectionCard title="Pods">
          <div style={{ fontSize: 11, color: theme.textMuted }}>{data.pods_note}</div>
        </SectionCard>
      ) : null}

      {/* Service throughput */}
      {services.length > 0 && (
        <SectionCard title={`Service throughput (rpm, last ${data.lookback})`}>
          {services.slice(0, 8).map((s) => (
            <HBarRow
              key={s.service}
              label={s.service}
              value={s.throughput}
              valueLabel={`${s.throughput} rpm`}
              max={maxThroughput}
              color={degradedSet.has(s.service) ? theme.redSoft : theme.blue}
            />
          ))}
        </SectionCard>
      )}

      <InvestigationActions actions={data.investigation_actions} onSend={onSend} />
    </div>
  );
}

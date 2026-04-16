/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useState, useCallback } from "react";
import { useApp, ToolResultParams } from "./shared/use-app";
import { parseToolResult } from "./shared/parse-tool-result";
import { theme } from "./shared/theme";

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
}

const HEALTH_CONFIG: Record<string, { color: string; label: string; bg: string }> = {
  healthy: { color: theme.green, label: "Healthy", bg: `${theme.green}15` },
  degraded: { color: theme.amber, label: "Degraded", bg: `${theme.amber}15` },
  critical: { color: theme.red, label: "Critical", bg: `${theme.red}15` },
};

function HealthBadge({ health }: { health: string }) {
  const config = HEALTH_CONFIG[health] || HEALTH_CONFIG.healthy;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 16px",
        background: config.bg,
        border: `1px solid ${config.color}30`,
        borderRadius: 8,
      }}
    >
      <div
        style={{
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: config.color,
          boxShadow: `0 0 8px ${config.color}60`,
        }}
      />
      <span style={{ fontSize: 16, fontWeight: 700, color: config.color }}>
        {config.label}
      </span>
    </div>
  );
}

function CoverageBadges({ coverage }: { coverage?: DataCoverage }) {
  if (!coverage) return null;
  const items: Array<{ key: keyof DataCoverage; label: string }> = [
    { key: "apm", label: "APM" },
    { key: "kubernetes", label: "K8s" },
    { key: "ml_anomalies", label: "ML" },
  ];
  return (
    <div style={{ display: "flex", gap: 4, marginTop: 4, justifyContent: "flex-end" }}>
      {items.map(({ key, label }) => {
        const on = coverage[key];
        return (
          <span
            key={key}
            title={`${label}: ${on ? "present" : "not detected"}`}
            className="mono"
            style={{
              fontSize: 9,
              padding: "2px 5px",
              borderRadius: 3,
              color: on ? theme.green : theme.textDim,
              background: on ? `${theme.green}10` : "transparent",
              border: `1px solid ${on ? `${theme.green}30` : theme.border}`,
              fontWeight: 600,
            }}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: theme.textMuted,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        marginBottom: 6,
        marginTop: 16,
        display: "flex",
        justifyContent: "space-between",
      }}
    >
      <span>{title}</span>
      {count !== undefined && <span style={{ color: theme.textDim }}>{count}</span>}
    </div>
  );
}

function InfoNote({ text, tone = "muted" }: { text: string; tone?: "muted" | "warn" }) {
  const color = tone === "warn" ? theme.amber : theme.textMuted;
  const bg = tone === "warn" ? `${theme.amber}10` : theme.bgSecondary;
  const border = tone === "warn" ? `${theme.amber}25` : theme.border;
  return (
    <div
      style={{
        padding: "8px 12px",
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 6,
        fontSize: 11,
        color,
        lineHeight: 1.5,
      }}
    >
      {text}
    </div>
  );
}

function ResourceBar({
  value,
  max,
  color,
  label,
}: {
  value: number;
  max: number;
  color: string;
  label: string;
}) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
      <span
        className="mono"
        style={{ fontSize: 10, color: theme.textMuted, minWidth: 32, textAlign: "right" }}
      >
        {label}
      </span>
      <div style={{ flex: 1, height: 6, background: theme.border, borderRadius: 3, overflow: "hidden" }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: pct > 80 ? theme.red : pct > 60 ? theme.amber : color,
            borderRadius: 3,
            transition: "width 0.3s ease",
          }}
        />
      </div>
      <span
        className="mono"
        style={{ fontSize: 10, color: theme.textDim, minWidth: 45, textAlign: "right" }}
      >
        {value.toFixed(1)}
      </span>
    </div>
  );
}

function PodCard({ pod, maxMem }: { pod: PodDetail; maxMem: number }) {
  const shortName = pod.pod.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "");
  return (
    <div
      style={{
        background: theme.bgSecondary,
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        padding: "8px 12px",
        marginBottom: 4,
      }}
    >
      <div
        className="mono"
        style={{ fontSize: 11, fontWeight: 600, color: theme.text, marginBottom: 4 }}
      >
        {shortName}
      </div>
      <ResourceBar value={pod.avg_memory_mb} max={maxMem} color={theme.blue} label="MEM" />
      {pod.avg_cpu_cores !== undefined && (
        <ResourceBar value={pod.avg_cpu_cores * 1000} max={2000} color={theme.cyan} label="CPU" />
      )}
    </div>
  );
}

function ServiceRow({
  svc,
  isDegraded,
  reasons,
}: {
  svc: ServiceDetail;
  isDegraded: boolean;
  reasons?: string[];
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "5px 10px",
        background: isDegraded ? `${theme.red}10` : "transparent",
        borderLeft: isDegraded ? `3px solid ${theme.red}` : "3px solid transparent",
        borderRadius: 4,
        marginBottom: 2,
      }}
    >
      <div>
        <span className="mono" style={{ fontSize: 12, color: isDegraded ? theme.red : theme.text }}>
          {svc.service}
        </span>
        {reasons && (
          <span style={{ fontSize: 10, color: theme.red, marginLeft: 8 }}>
            {reasons.join(", ")}
          </span>
        )}
      </div>
      <span className="mono" style={{ fontSize: 11, color: theme.textDim }}>
        {svc.throughput} req
      </span>
    </div>
  );
}

function AnomalySummary({ anomalies }: { anomalies: AnomalyInfo }) {
  if (!anomalies.total) {
    return (
      <div
        style={{
          padding: "8px 12px",
          background: `${theme.green}10`,
          border: `1px solid ${theme.green}20`,
          borderRadius: 6,
          fontSize: 12,
          color: theme.green,
        }}
      >
        No active anomalies
      </div>
    );
  }

  const severities = anomalies.by_severity || {};
  const colors: Record<string, string> = {
    critical: theme.red,
    major: theme.orange,
    minor: theme.amber,
  };

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {Object.entries(severities).map(([sev, count]) => (
        <div
          key={sev}
          style={{
            padding: "4px 10px",
            background: `${colors[sev] || theme.textDim}15`,
            border: `1px solid ${colors[sev] || theme.textDim}30`,
            borderRadius: 4,
            fontSize: 11,
            color: colors[sev] || theme.textDim,
            fontWeight: 600,
          }}
        >
          {count} {sev}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const [data, setData] = useState<HealthData | null>(null);

  const handleToolResult = useCallback((params: ToolResultParams) => {
    const d = parseToolResult<HealthData>(params);
    if (d?.overall_health) setData(d);
  }, []);

  useApp({
    appInfo: { name: "APM Health Summary", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolresult = handleToolResult;
    },
  });

  if (!data) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: theme.textMuted }}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>Waiting for health data…</div>
        <div style={{ fontSize: 11 }}>Call apm-health-summary to populate this view.</div>
      </div>
    );
  }

  const degradedNames = new Set(data.degraded_services.map((d) => d.service));
  const degradedMap = new Map(data.degraded_services.map((d) => [d.service, d.reasons]));
  const pods = data.pods?.top_memory ?? [];
  const maxMem = Math.max(...pods.map((p) => p.avg_memory_mb), 100);

  return (
    <div style={{ padding: "12px 16px", maxWidth: 460 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 12,
        }}
      >
        <HealthBadge health={data.overall_health} />
        <div style={{ textAlign: "right" }}>
          <div className="mono" style={{ fontSize: 11, color: theme.textMuted }}>
            {data.namespace}
          </div>
          <div className="mono" style={{ fontSize: 10, color: theme.textDim }}>
            last {data.lookback}
          </div>
          <CoverageBadges coverage={data.data_coverage} />
        </div>
      </div>

      {data.warning && (
        <div style={{ marginBottom: 12 }}>
          <InfoNote text={data.warning} tone="warn" />
        </div>
      )}

      {data.recommendation && (
        <div
          style={{
            padding: "8px 12px",
            background: `${theme.amber}10`,
            border: `1px solid ${theme.amber}25`,
            borderRadius: 6,
            fontSize: 12,
            color: theme.amber,
            marginBottom: 12,
            lineHeight: 1.5,
          }}
        >
          {data.recommendation}
        </div>
      )}

      <SectionHeader title="ML Anomalies" count={data.anomalies?.total} />
      {data.anomalies ? (
        <AnomalySummary anomalies={data.anomalies} />
      ) : (
        <InfoNote text={data.anomalies_note || "No ML anomaly data available."} />
      )}

      <SectionHeader title="Services" count={data.services.total} />
      {data.services.details.length ? (
        <div
          style={{
            background: theme.bgSecondary,
            border: `1px solid ${theme.border}`,
            borderRadius: 6,
            padding: "4px 0",
            maxHeight: 180,
            overflowY: "auto",
          }}
        >
          {data.services.details.map((svc) => (
            <ServiceRow
              key={svc.service}
              svc={svc}
              isDegraded={degradedNames.has(svc.service)}
              reasons={degradedMap.get(svc.service)}
            />
          ))}
        </div>
      ) : (
        <InfoNote text="No APM services reporting in this window." />
      )}

      <SectionHeader title="Top Pods by Memory" count={data.pods?.total} />
      {pods.length ? (
        pods.slice(0, 6).map((pod) => <PodCard key={pod.pod} pod={pod} maxMem={maxMem} />)
      ) : (
        <InfoNote text={data.pods_note || "No Kubernetes pod metrics available."} />
      )}

      <div
        style={{
          marginTop: 12,
          fontSize: 10,
          color: theme.textDim,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{data.pods?.total ?? 0} pods total</span>
        <span>{data.services.degraded_count} degraded</span>
      </div>
    </div>
  );
}

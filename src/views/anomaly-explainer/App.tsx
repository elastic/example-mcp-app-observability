/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useState, useRef, useCallback, useEffect } from "react";
import { useApp, AppLike, ToolResultParams } from "./shared/use-app";
import { parseToolResult } from "./shared/parse-tool-result";
import { theme, baseStyles } from "./shared/theme";

interface Anomaly {
  jobId: string;
  recordScore: number;
  severity: string;
  timestamp: string | number;
  functionName?: string;
  fieldName?: string;
  entity?: string;
  actual?: number | number[];
  typical?: number | number[];
  deviationPercent?: number;
  influencers?: Record<string, string[]>;
}

interface AnomalyData {
  anomalies?: Anomaly[];
  total?: number;
  returned?: number;
  jobsSummary?: Record<string, number>;
  status?: string;
  top_anomalies?: Anomaly[];
  headline?: string;
  affected_services?: string[];
}

const SEVERITY_COLORS = [
  { min: 0, max: 50, color: theme.green, label: "Normal" },
  { min: 50, max: 75, color: theme.amber, label: "Minor" },
  { min: 75, max: 90, color: theme.orange, label: "Major" },
  { min: 90, max: 101, color: theme.red, label: "Critical" },
];

function firstNum(v: number | number[] | undefined): number | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function SeverityGauge({ score }: { score: number }) {
  const band = SEVERITY_COLORS.find((b) => score >= b.min && score < b.max) || SEVERITY_COLORS[3];
  const pct = Math.min(100, Math.max(0, score));

  const radius = 70;
  const cx = 90;
  const cy = 85;
  const startAngle = -180;
  const endAngle = 0;
  const range = endAngle - startAngle;
  const angle = startAngle + (pct / 100) * range;

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const arcPath = (start: number, end: number, r: number) => {
    const x1 = cx + r * Math.cos(toRad(start));
    const y1 = cy + r * Math.sin(toRad(start));
    const x2 = cx + r * Math.cos(toRad(end));
    const y2 = cy + r * Math.sin(toRad(end));
    const large = end - start > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  const needleX = cx + (radius - 10) * Math.cos(toRad(angle));
  const needleY = cy + (radius - 10) * Math.sin(toRad(angle));

  return (
    <div style={{ textAlign: "center", padding: "16px 0" }}>
      <svg width="180" height="110" viewBox="0 0 180 110">
        <path d={arcPath(-180, 0, radius)} fill="none" stroke={theme.border} strokeWidth="12" strokeLinecap="round" />
        {SEVERITY_COLORS.map((b) => (
          <path
            key={b.label}
            d={arcPath(startAngle + (b.min / 100) * range, startAngle + (b.max / 100) * range, radius)}
            fill="none"
            stroke={b.color}
            strokeWidth="12"
            strokeLinecap="round"
            opacity={0.25}
          />
        ))}
        <path d={arcPath(-180, angle, radius)} fill="none" stroke={band.color} strokeWidth="12" strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={needleX} y2={needleY} stroke={theme.text} strokeWidth="2" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="4" fill={theme.text} />
        <text x={cx} y={cy + 28} textAnchor="middle" fill={band.color} fontSize="24" fontWeight="700" fontFamily="'JetBrains Mono', monospace">
          {Math.round(score)}
        </text>
      </svg>
      <div style={{ color: band.color, fontWeight: 600, fontSize: 14, marginTop: -4 }}>{band.label}</div>
    </div>
  );
}

function explainAnomaly(a: Anomaly): string {
  const field = a.fieldName || "a metric";
  const entity = a.entity?.split("=").pop() || "unknown entity";
  const actual = firstNum(a.actual);
  const typical = firstNum(a.typical);
  const dev = a.deviationPercent ?? 0;
  const direction = dev > 0 ? "higher" : "lower";
  const absDev = Math.abs(dev);

  if (a.jobId?.includes("memory")) {
    const actualMB = typeof actual === "number" ? Math.round(actual / (1024 * 1024)) : "?";
    const typicalMB = typeof typical === "number" ? Math.round(typical / (1024 * 1024)) : "?";
    return (
      `Memory usage on ${entity} is ${absDev.toFixed(0)}% ${direction} than normal. ` +
      `Currently at ${actualMB}MB (typical: ${typicalMB}MB). ` +
      (direction === "higher"
        ? "This could indicate a memory leak, increased load, or resource contention."
        : "This could indicate reduced traffic or a recent restart clearing cached data.")
    );
  }

  if (a.jobId?.includes("cpu")) {
    return (
      `CPU usage on ${entity} is ${absDev.toFixed(0)}% ${direction} than normal. ` +
      (direction === "higher"
        ? "This may cause increased latency and could lead to throttling if sustained."
        : "Lower-than-expected CPU may indicate reduced traffic or a stalled process.")
    );
  }

  if (a.jobId?.includes("network")) {
    return (
      `Network I/O on ${entity} is ${absDev.toFixed(0)}% ${direction} than normal. ` +
      (direction === "higher"
        ? "Elevated network traffic may indicate increased client load, retry storms, or data replication issues."
        : "Reduced network traffic may indicate upstream failures blocking requests from reaching this service.")
    );
  }

  if (a.jobId?.includes("restart")) {
    return `Pod restart rate for ${entity} is anomalous. Frequent restarts typically indicate OOMKills, liveness probe failures, or application crashes.`;
  }

  return (
    `${field} on ${entity} is ${absDev.toFixed(0)}% ${direction} than the ML baseline. ` +
    `Actual: ${actual?.toFixed(1) ?? "?"}, Typical: ${typical?.toFixed(1) ?? "?"}.`
  );
}

function EntityCard({ anomaly }: { anomaly: Anomaly }) {
  const band = SEVERITY_COLORS.find((b) => anomaly.recordScore >= b.min && anomaly.recordScore < b.max) || SEVERITY_COLORS[3];
  const entityLabel = anomaly.entity?.split("=").pop()
    ?? Object.values(anomaly.influencers || {}).flat()[0]
    ?? "unknown";

  return (
    <div
      style={{
        background: theme.bgSecondary,
        border: `1px solid ${theme.border}`,
        borderLeft: `3px solid ${band.color}`,
        borderRadius: 6,
        padding: "10px 14px",
        marginBottom: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: theme.text }}>{entityLabel}</span>
        <span className="mono" style={{ fontSize: 11, color: band.color, fontWeight: 700 }}>
          {anomaly.recordScore.toFixed(0)}
        </span>
      </div>
      <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 6 }}>
        {anomaly.jobId} &middot; {anomaly.functionName || anomaly.fieldName}
      </div>
      {anomaly.deviationPercent !== undefined && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, height: 6, background: theme.border, borderRadius: 3, overflow: "hidden" }}>
            <div
              style={{
                width: `${Math.min(100, Math.abs(anomaly.deviationPercent))}%`,
                height: "100%",
                background: band.color,
                borderRadius: 3,
              }}
            />
          </div>
          <span className="mono" style={{ fontSize: 11, color: band.color, minWidth: 50, textAlign: "right" }}>
            {anomaly.deviationPercent > 0 ? "+" : ""}
            {anomaly.deviationPercent.toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  );
}

function Timeline({ anomalies }: { anomalies: Anomaly[] }) {
  if (anomalies.length < 2) return null;
  const toMs = (t: string | number) => (typeof t === "number" ? t : new Date(t).getTime());
  const sorted = [...anomalies].sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));
  const minT = toMs(sorted[0].timestamp);
  const maxT = toMs(sorted[sorted.length - 1].timestamp);
  const range = maxT - minT || 1;
  const width = 320;
  const height = 60;
  const padX = 10;
  const padY = 8;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const points = sorted.map((a) => ({
    x: padX + ((toMs(a.timestamp) - minT) / range) * plotW,
    y: padY + plotH - (a.recordScore / 100) * plotH,
    score: a.recordScore,
    color: (SEVERITY_COLORS.find((b) => a.recordScore >= b.min && a.recordScore < b.max) || SEVERITY_COLORS[3]).color,
  }));

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 4 }}>Anomaly score over time</div>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto" }}>
        {[50, 75, 90].map((t) => (
          <line
            key={t}
            x1={padX}
            x2={width - padX}
            y1={padY + plotH - (t / 100) * plotH}
            y2={padY + plotH - (t / 100) * plotH}
            stroke={theme.border}
            strokeWidth={0.5}
            strokeDasharray="3 3"
          />
        ))}
        <path d={pathD} fill="none" stroke={theme.blue} strokeWidth="1.5" />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="3" fill={p.color} />
        ))}
      </svg>
    </div>
  );
}

export function App() {
  const [data, setData] = useState<AnomalyData | null>(null);
  const appRef = useRef<AppLike | null>(null);

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
    capabilities: {},
    onAppCreated: (app) => {
      appRef.current = app;
      app.ontoolresult = handleToolResult;
    },
  });

  if (!data || !data.anomalies?.length) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: theme.textMuted }}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>Waiting for anomaly data...</div>
        <div style={{ fontSize: 11 }}>Call ml-anomalies or watch to populate this view.</div>
      </div>
    );
  }

  const anomalies = data.anomalies;
  const top = anomalies[0];
  const explanation = explainAnomaly(top);

  const uniqueEntities = new Map<string, Anomaly>();
  for (const a of anomalies) {
    const key = a.entity || a.jobId + (a.fieldName || "");
    if (!uniqueEntities.has(key) || a.recordScore > uniqueEntities.get(key)!.recordScore) {
      uniqueEntities.set(key, a);
    }
  }

  return (
    <div style={{ padding: "12px 16px", maxWidth: 400 }}>
      {data.headline && (
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: theme.red,
            marginBottom: 12,
            padding: "6px 10px",
            background: `${theme.red}15`,
            borderRadius: 4,
            border: `1px solid ${theme.red}30`,
          }}
        >
          {data.headline}
        </div>
      )}

      <SeverityGauge score={top.recordScore} />

      <div
        style={{
          background: theme.bgSecondary,
          border: `1px solid ${theme.border}`,
          borderRadius: 6,
          padding: "10px 14px",
          marginBottom: 16,
          fontSize: 12,
          lineHeight: 1.6,
          color: theme.text,
        }}
      >
        <div
          style={{
            fontWeight: 600,
            marginBottom: 4,
            color: theme.amber,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          What this means
        </div>
        {explanation}
      </div>

      <div
        style={{
          fontSize: 11,
          color: theme.textMuted,
          marginBottom: 6,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        Affected entities ({uniqueEntities.size})
      </div>
      {[...uniqueEntities.values()].slice(0, 8).map((a, i) => (
        <EntityCard key={i} anomaly={a} />
      ))}

      <Timeline anomalies={anomalies} />

      <div
        style={{
          marginTop: 12,
          fontSize: 11,
          color: theme.textDim,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{data.total ?? anomalies.length} total anomalies</span>
        {data.jobsSummary && <span>{Object.keys(data.jobsSummary).length} ML jobs reporting</span>}
      </div>
    </div>
  );
}

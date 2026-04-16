/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * K8s Blast Radius — radial SVG visualization of deployment impact
 * when a Kubernetes node goes offline.
 *
 * Layout:
 *   Center  — the node under analysis
 *   Ring 1  — full_outage + degraded deployments (direct impact)
 *   Ring 2  — downstream APM services in affected namespaces
 *
 * Consumes the JSON payload returned by the `k8s-blast-radius` tool.
 */

import React, { useCallback, useMemo, useState } from "react";
import { useApp } from "./shared/use-app";
import { parseToolResult } from "./shared/parse-tool-result";
import { theme } from "./shared/theme";

// ── Data shape returned by k8s-blast-radius tool ───────────────────────────

interface Deployment {
  deployment: string;
  namespace: string;
  pods_on_node: number;
  pods_total: number;
  surviving: number;
  memory: string;
  memory_bytes: number;
}

interface DownstreamService {
  service: string;
  namespace: string;
}

interface Rescheduling {
  memory_required: string;
  memory_available: string;
  remaining_nodes: number;
  feasible: boolean | null;
}

interface BlastRadiusData {
  node: string;
  status: "AT RISK" | "PARTIAL RISK" | "SAFE" | string;
  data_coverage: { kubernetes: boolean; apm: boolean };
  pods_at_risk: number;
  full_outage: Deployment[];
  degraded: Deployment[];
  unaffected_count: number;
  unaffected: Array<{ deployment: string; namespace: string; pods_total: number }>;
  rescheduling: Rescheduling;
  downstream_services?: DownstreamService[];
  downstream_services_note?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function polarToXY(cx: number, cy: number, radius: number, angle: number) {
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 1) / 2);
  return text.slice(0, keep) + "\u2026" + text.slice(-keep);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "\u2026" : text;
}

function statusRisk(status: string): { pct: number; color: string; label: string } {
  if (status === "AT RISK") return { pct: 80, color: theme.red, label: "AT RISK" };
  if (status === "PARTIAL RISK") return { pct: 50, color: theme.amber, label: "PARTIAL" };
  if (status === "SAFE") return { pct: 10, color: theme.green, label: "SAFE" };
  return { pct: 50, color: theme.textMuted, label: status };
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

// ── Tooltip ────────────────────────────────────────────────────────────────

interface TooltipInfo {
  x: number;
  y: number;
  name: string;
  details: string[];
}

function Tooltip({ info }: { info: TooltipInfo }) {
  return (
    <div
      style={{
        position: "absolute",
        left: info.x + 12,
        top: info.y - 8,
        background: "#1a1d2a",
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        pointerEvents: "none",
        zIndex: 100,
        maxWidth: 240,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: "#fff", marginBottom: 2 }}>
        {info.name}
      </div>
      {info.details.map((d, i) => (
        <div key={i} style={{ fontSize: 10, color: theme.textMuted, lineHeight: 1.4 }}>
          {d}
        </div>
      ))}
    </div>
  );
}

// ── Legend dot ─────────────────────────────────────────────────────────────

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: `${color}40`,
          border: `1.5px solid ${color}`,
        }}
      />
      <span style={{ fontSize: 9, color: theme.textMuted }}>{label}</span>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────

export function App() {
  const [data, setData] = useState<BlastRadiusData | null>(null);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);

  const { isConnected, error } = useApp({
    onAppCreated: (app) => {
      app.ontoolresult = (params) => {
        const parsed = parseToolResult<BlastRadiusData>(params);
        if (parsed?.node && parsed?.status) {
          setData(parsed);
        }
      };
    },
  });

  const layout = useMemo(() => {
    if (!data) return null;

    const svgW = 620;
    const svgH = 480;
    const cx = svgW / 2;
    const cy = svgH / 2;
    const ring1Radius = 135;
    const ring2Radius = 215;

    const center = { x: cx, y: cy, r: 32 };

    interface RingItem {
      x: number;
      y: number;
      r: number;
      color: string;
      label: string;
      isSpof: boolean;
      outage: boolean;
      details: string[];
    }

    const fullOutage = data.full_outage || [];
    const degraded = data.degraded || [];
    const ring1Total = fullOutage.length + degraded.length;

    const ring1: RingItem[] = [];

    fullOutage.forEach((dep, i) => {
      const angle = (2 * Math.PI * i) / Math.max(ring1Total, 1) - Math.PI / 2;
      const pos = polarToXY(cx, cy, ring1Radius, angle);
      const r = clamp(11 + dep.pods_on_node * 2, 11, 22);
      ring1.push({
        ...pos,
        r,
        color: theme.red,
        label: dep.deployment,
        isSpof: dep.pods_total === 1,
        outage: true,
        details: [
          `Namespace: ${dep.namespace}`,
          `Pods lost: ${dep.pods_on_node} of ${dep.pods_total}`,
          `Surviving: ${dep.surviving}`,
          `Memory: ${dep.memory}`,
          dep.pods_total === 1 ? "Single replica — SPOF" : "",
        ].filter(Boolean),
      });
    });

    degraded.forEach((dep, i) => {
      const angle =
        (2 * Math.PI * (fullOutage.length + i)) / Math.max(ring1Total, 1) - Math.PI / 2;
      const pos = polarToXY(cx, cy, ring1Radius, angle);
      const r = clamp(10 + dep.pods_on_node * 2, 10, 20);
      ring1.push({
        ...pos,
        r,
        color: theme.amber,
        label: dep.deployment,
        isSpof: false,
        outage: false,
        details: [
          `Namespace: ${dep.namespace}`,
          `Pods lost: ${dep.pods_on_node} of ${dep.pods_total}`,
          `Surviving: ${dep.surviving}`,
          `Memory: ${dep.memory}`,
        ],
      });
    });

    // Group downstream services by namespace so we don't overflow ring 2
    const downstream = data.downstream_services || [];
    const byNamespace = new Map<string, string[]>();
    for (const svc of downstream) {
      const list = byNamespace.get(svc.namespace) || [];
      list.push(svc.service);
      byNamespace.set(svc.namespace, list);
    }
    const downstreamEntries = Array.from(byNamespace.entries());

    const ring2: RingItem[] = downstreamEntries.map(([namespace, services], i) => {
      const angle =
        (2 * Math.PI * i) / Math.max(downstreamEntries.length, 1) - Math.PI / 2;
      const pos = polarToXY(cx, cy, ring2Radius, angle);
      return {
        ...pos,
        r: clamp(8 + services.length, 8, 14),
        color: theme.blue,
        label: namespace,
        isSpof: false,
        outage: false,
        details: [
          `Namespace: ${namespace}`,
          `Services: ${services.length}`,
          ...services.slice(0, 6).map((s) => `  • ${s}`),
          services.length > 6 ? `  …and ${services.length - 6} more` : "",
        ].filter(Boolean),
      };
    });

    // Edges from center to ring1
    const edgesR1 = ring1.map((item) => ({
      x1: cx,
      y1: cy,
      x2: item.x,
      y2: item.y,
      outage: item.outage,
    }));

    // Edges from each ring2 item to the ring1 item in the same namespace (if any)
    const edgesR2: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const r2 of ring2) {
      // r2.label is a namespace; find ring1 items in that namespace via details
      const match = ring1.find((r1) => r1.details[0] === `Namespace: ${r2.label}`);
      if (match) {
        edgesR2.push({ x1: match.x, y1: match.y, x2: r2.x, y2: r2.y });
      } else {
        edgesR2.push({ x1: cx, y1: cy, x2: r2.x, y2: r2.y });
      }
    }

    return { svgW, svgH, cx, cy, center, ring1, ring2, edgesR1, edgesR2, ring1Radius, ring2Radius };
  }, [data]);

  const handleHover = useCallback(
    (e: React.MouseEvent, name: string, details: string[]) => {
      const rect = (e.currentTarget as SVGElement).closest("svg")?.getBoundingClientRect();
      if (!rect) return;
      setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, name, details });
    },
    []
  );
  const clearHover = useCallback(() => setTooltip(null), []);

  if (error) {
    return <div style={{ padding: 16, color: theme.red, fontSize: 12 }}>Error: {error.message}</div>;
  }
  if (!isConnected || !data) {
    return (
      <div
        style={{
          padding: 20,
          color: theme.textMuted,
          fontSize: 12,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 22, marginBottom: 8 }}>◎</div>
        <div>Waiting for blast-radius data…</div>
        <div style={{ marginTop: 8, fontSize: 10, color: theme.textDim }}>
          Call the k8s-blast-radius tool with a node name
        </div>
      </div>
    );
  }

  if (!layout) return null;

  const { svgW, svgH, cx, cy, center, ring1, ring2, edgesR1, edgesR2, ring1Radius, ring2Radius } =
    layout;
  const risk = statusRisk(data.status);
  const resched = data.rescheduling;
  const reschedFeasible = resched.feasible;
  const reschedColor =
    reschedFeasible === true ? theme.green : reschedFeasible === false ? theme.red : theme.textMuted;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: theme.bg }}>
      {/* Header */}
      <div
        style={{
          padding: "10px 14px",
          borderBottom: `1px solid ${theme.border}`,
          background: "#0d0f14",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 14 }}>◎</span>
          <span style={{ fontWeight: 700, fontSize: 13, color: "#fff" }}>Blast Radius</span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: theme.cyan,
              padding: "2px 8px",
              borderRadius: 10,
              background: `${theme.cyan}18`,
              fontFamily: "'JetBrains Mono', monospace",
              maxWidth: 320,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={data.node}
          >
            node: {truncateMiddle(data.node, 34)}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 8,
            background: `${risk.color}15`,
            border: `1px solid ${risk.color}40`,
          }}
        >
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: theme.textMuted,
              letterSpacing: "0.05em",
            }}
          >
            STATUS
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 800,
              color: risk.color,
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: "0.04em",
            }}
          >
            {risk.label}
          </span>
        </div>
      </div>

      {/* KPI row */}
      <div
        style={{
          display: "flex",
          gap: 0,
          borderBottom: `1px solid ${theme.border}`,
          background: "#0a0c10",
        }}
      >
        <Kpi label="Pods at risk" value={String(data.pods_at_risk)} color={theme.red} />
        <Kpi label="Full outage" value={String(data.full_outage.length)} color={theme.red} />
        <Kpi label="Degraded" value={String(data.degraded.length)} color={theme.amber} />
        <Kpi label="Unaffected" value={String(data.unaffected_count)} color={theme.green} />
      </div>

      {/* SVG diagram */}
      <div style={{ flex: 1, overflow: "auto", padding: "8px 14px", position: "relative" }}>
        <svg
          width="100%"
          height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          style={{ display: "block", margin: "0 auto", maxWidth: svgW }}
        >
          <defs>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="centerGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Ring guides */}
          <circle
            cx={cx}
            cy={cy}
            r={ring1Radius}
            fill="none"
            stroke={theme.border}
            strokeWidth={1}
            strokeDasharray="4 6"
            opacity={0.4}
          />
          {ring2.length > 0 && (
            <circle
              cx={cx}
              cy={cy}
              r={ring2Radius}
              fill="none"
              stroke={theme.border}
              strokeWidth={1}
              strokeDasharray="4 6"
              opacity={0.3}
            />
          )}

          {/* Edges center -> ring1 */}
          {edgesR1.map((edge, i) => (
            <line
              key={`e1-${i}`}
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              stroke={edge.outage ? theme.red : theme.amber}
              strokeWidth={1.5}
              strokeDasharray="4 4"
              opacity={0.5}
              filter="url(#glow)"
            />
          ))}

          {/* Edges ring1 -> ring2 */}
          {edgesR2.map((edge, i) => (
            <line
              key={`e2-${i}`}
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              stroke={theme.blue}
              strokeWidth={1}
              strokeDasharray="3 5"
              opacity={0.3}
            />
          ))}

          {/* Ring 2 nodes (downstream namespaces) */}
          {ring2.map((item, i) => (
            <g
              key={`r2-${i}`}
              onMouseMove={(e) => handleHover(e, item.label, item.details)}
              onMouseLeave={clearHover}
              style={{ cursor: "pointer" }}
            >
              <circle
                cx={item.x}
                cy={item.y}
                r={item.r + 2}
                fill="none"
                stroke={item.color}
                strokeWidth={1}
                opacity={0.3}
              />
              <circle
                cx={item.x}
                cy={item.y}
                r={item.r}
                fill={`${item.color}20`}
                stroke={item.color}
                strokeWidth={1.5}
              />
              <text
                x={item.x}
                y={item.y + item.r + 12}
                textAnchor="middle"
                fill={theme.textMuted}
                fontSize={8}
                fontFamily="'JetBrains Mono', monospace"
              >
                {truncate(item.label, 16)}
              </text>
            </g>
          ))}

          {/* Ring 1 nodes (affected deployments) */}
          {ring1.map((item, i) => (
            <g
              key={`r1-${i}`}
              onMouseMove={(e) => handleHover(e, item.label, item.details)}
              onMouseLeave={clearHover}
              style={{ cursor: "pointer" }}
            >
              {item.isSpof && (
                <circle
                  cx={item.x}
                  cy={item.y}
                  r={item.r + 5}
                  fill="none"
                  stroke={theme.red}
                  strokeWidth={2}
                  opacity={0.9}
                />
              )}
              <circle
                cx={item.x}
                cy={item.y}
                r={item.r}
                fill={`${item.color}25`}
                stroke={item.color}
                strokeWidth={2}
              />
              <text
                x={item.x}
                y={item.y + item.r + 12}
                textAnchor="middle"
                fill={theme.text}
                fontSize={9}
                fontWeight={600}
                fontFamily="'JetBrains Mono', monospace"
              >
                {truncate(item.label, 16)}
              </text>
            </g>
          ))}

          {/* Center node */}
          <circle
            cx={cx}
            cy={cy}
            r={center.r + 5}
            fill="none"
            stroke={risk.color}
            strokeWidth={1}
            opacity={0.4}
            filter="url(#centerGlow)"
          />
          <circle
            cx={cx}
            cy={cy}
            r={center.r}
            fill={`${risk.color}25`}
            stroke={risk.color}
            strokeWidth={2.5}
          />
          <text
            x={cx}
            y={cy - 4}
            textAnchor="middle"
            fill="#fff"
            fontSize={10}
            fontWeight={700}
            fontFamily="'JetBrains Mono', monospace"
          >
            {truncateMiddle(data.node, 14)}
          </text>
          <text
            x={cx}
            y={cy + 10}
            textAnchor="middle"
            fill={risk.color}
            fontSize={8}
            fontFamily="'JetBrains Mono', monospace"
          >
            node
          </text>
        </svg>
        {tooltip && <Tooltip info={tooltip} />}
      </div>

      {/* Legend */}
      <div
        style={{
          padding: "8px 14px",
          borderTop: `1px solid ${theme.border}`,
          display: "flex",
          gap: 14,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <LegendDot color={theme.red} label="Full outage" />
        <LegendDot color={theme.amber} label="Degraded" />
        {ring2.length > 0 && <LegendDot color={theme.blue} label="Downstream ns" />}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: `2px solid ${theme.red}`,
              background: "transparent",
            }}
          />
          <span style={{ fontSize: 9, color: theme.textMuted }}>SPOF (single replica)</span>
        </div>
      </div>

      {/* Rescheduling footer */}
      <div
        style={{
          padding: "10px 14px",
          borderTop: `1px solid ${theme.border}`,
          background: "#0a0c10",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: theme.textMuted,
              marginBottom: 2,
              letterSpacing: "0.08em",
            }}
          >
            RESCHEDULING
          </div>
          <div style={{ fontSize: 11, color: theme.text, fontFamily: "'JetBrains Mono', monospace" }}>
            {resched.memory_required} required / {resched.memory_available} available across{" "}
            {resched.remaining_nodes} node{resched.remaining_nodes === 1 ? "" : "s"}
          </div>
        </div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: reschedColor,
            padding: "4px 10px",
            borderRadius: 6,
            background: `${reschedColor}18`,
            border: `1px solid ${reschedColor}40`,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {reschedFeasible === true
            ? "✓ FEASIBLE"
            : reschedFeasible === false
            ? "✗ INFEASIBLE"
            : "— unknown"}
        </div>
      </div>

      {data.downstream_services_note && (
        <div
          style={{
            padding: "8px 14px",
            borderTop: `1px solid ${theme.border}`,
            background: "#0a0c10",
            fontSize: 10,
            color: theme.textMuted,
            lineHeight: 1.5,
          }}
        >
          {data.downstream_services_note}
        </div>
      )}

      <style>{`
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a2d3a; border-radius: 2px; }
      `}</style>
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      style={{
        flex: 1,
        padding: "10px 14px",
        borderRight: `1px solid ${theme.border}`,
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          color: theme.textMuted,
          letterSpacing: "0.08em",
          marginBottom: 2,
        }}
      >
        {label.toUpperCase()}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 800,
          color,
          fontFamily: "'JetBrains Mono', monospace",
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
    </div>
  );
}

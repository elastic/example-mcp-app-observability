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
 *   Floating summary card (top-left): counts + rescheduling feasibility
 *   Center:   the node under analysis
 *   Ring 1:   full_outage + degraded deployments (direct impact)
 *   Safe arc: green arc on the right representing unaffected capacity
 *   Hover:    tooltip with deployment / namespace detail
 *
 * Pan / zoom: the diagram supports wheel-zoom (centered on cursor) and
 * click-drag-pan (from empty SVG space — node hover still works). Floating
 * zoom controls sit at the bottom-right. Pan/zoom state is local React state
 * and resets on tool re-invocation (e.g. re-running for a different node).
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useApp, AppLike } from "@shared/use-app";
import { parseToolResult } from "@shared/parse-tool-result";
import { theme, baseStyles } from "@shared/theme";
import {
  InvestigationActions,
  InvestigationAction,
  TimeRangeHeader,
  BadgeTone,
  ZoomControls,
} from "@shared/components";
import { usePanZoom } from "@shared/use-pan-zoom";

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
  investigation_actions?: InvestigationAction[];
}

function polarToXY(cx: number, cy: number, r: number, angle: number) {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "\u2026" : text;
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 1) / 2);
  return text.slice(0, keep) + "\u2026" + text.slice(-keep);
}

function statusStyle(status: string): { color: string; label: string } {
  if (status === "AT RISK") return { color: theme.red, label: "AT RISK" };
  if (status === "PARTIAL RISK") return { color: theme.amber, label: "PARTIAL" };
  if (status === "SAFE") return { color: theme.green, label: "SAFE" };
  return { color: theme.textMuted, label: status };
}

function statusTone(status: string): BadgeTone {
  if (status === "AT RISK") return "critical";
  if (status === "PARTIAL RISK") return "major";
  if (status === "SAFE") return "ok";
  return "neutral";
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

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
        left: info.x + 14,
        top: info.y - 8,
        background: theme.bgTertiary,
        border: `1px solid ${theme.borderStrong}`,
        borderRadius: 6,
        padding: "8px 12px",
        pointerEvents: "none",
        zIndex: 100,
        maxWidth: 260,
        boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: theme.text, marginBottom: 4 }}>
        {info.name}
      </div>
      {info.details.map((d, i) => (
        <div key={i} style={{ fontSize: 11, color: theme.textMuted, lineHeight: 1.5 }}>
          {d}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const [data, setData] = useState<BlastRadiusData | null>(null);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const [app, setApp] = useState<AppLike | null>(null);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = baseStyles;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const { isConnected, error } = useApp({
    appInfo: { name: "K8s Blast Radius", version: "1.0.0" },
    onAppCreated: (a) => {
      a.ontoolresult = (params) => {
        const parsed = parseToolResult<BlastRadiusData>(params);
        if (parsed?.node && parsed?.status) setData(parsed);
      };
      setApp(a);
    },
  });

  const onSend = useCallback((p: string) => app?.sendMessage(p), [app]);

  const layout = useMemo(() => {
    if (!data) return null;

    const fullOutage = data.full_outage || [];
    const degraded = data.degraded || [];
    const ring1Total = fullOutage.length + degraded.length;

    // Scale radius + canvas when the ring gets crowded. Labels like
    // "chaos-dashboard" are ~110px wide at this font; allow ~60px of angular
    // slot per item along the 270° sweep to keep most labels legible. The user
    // can still pan/zoom for dense or long-labeled clusters. Below ~15 items
    // this stays at the base 180.
    const ring1Radius = Math.max(180, Math.ceil((ring1Total * 60) / ((3 * Math.PI) / 2)));
    const svgW = Math.max(600, ring1Radius * 2 + 120);
    const svgH = Math.max(520, ring1Radius * 2 + 140);
    const cx = svgW / 2;
    const cy = svgH / 2 + 10;

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

    const ring1: RingItem[] = [];

    // Distribute affected deployments across 270° on the left & top, leaving
    // the right-side ~90° arc for the "safe zone" indicator.
    const startAngle = Math.PI / 4; // 45° (bottom-right start)
    const endAngle = 2 * Math.PI - Math.PI / 4; // 315° sweep, skipping right-side arc
    const sweep = endAngle - startAngle;

    fullOutage.forEach((dep, i) => {
      const t = ring1Total > 1 ? i / (ring1Total - 1) : 0.5;
      const angle = startAngle + t * sweep + Math.PI / 2; // rotate so top=0
      const pos = polarToXY(cx, cy, ring1Radius, angle);
      const r = clamp(10 + dep.pods_on_node * 1.5, 10, 18);
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
      const idx = fullOutage.length + i;
      const t = ring1Total > 1 ? idx / (ring1Total - 1) : 0.5;
      const angle = startAngle + t * sweep + Math.PI / 2;
      const pos = polarToXY(cx, cy, ring1Radius, angle);
      const r = clamp(9 + dep.pods_on_node * 1.5, 9, 16);
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

    const edgesR1 = ring1.map((item) => ({
      x1: cx,
      y1: cy,
      x2: item.x,
      y2: item.y,
      outage: item.outage,
    }));

    // Safe-zone arc — a filled green arc on the right side indicating the
    // portion of the cluster that survives this node failure. Width is
    // proportional to unaffected_count / (unaffected_count + affected).
    const affected = ring1Total;
    const safe = data.unaffected_count || 0;
    const total = affected + safe;
    const safeFrac = total > 0 ? safe / total : 0;
    const arcSweepDeg = Math.min(100, Math.max(40, safeFrac * 180));
    const arcStartAngle = -arcSweepDeg / 2; // right side
    const arcEndAngle = arcSweepDeg / 2;
    const arcR = ring1Radius + 20;

    const arcStart = polarToXY(cx, cy, arcR, (arcStartAngle * Math.PI) / 180);
    const arcEnd = polarToXY(cx, cy, arcR, (arcEndAngle * Math.PI) / 180);
    const large = arcSweepDeg > 180 ? 1 : 0;
    const safeArcPath = `M ${arcStart.x.toFixed(1)} ${arcStart.y.toFixed(1)} A ${arcR} ${arcR} 0 ${large} 1 ${arcEnd.x.toFixed(1)} ${arcEnd.y.toFixed(1)}`;

    return { svgW, svgH, cx, cy, ring1Radius, ring1, edgesR1, safeArcPath, safeFrac };
  }, [data]);

  const panZoom = usePanZoom({
    baseW: layout?.svgW,
    baseH: layout?.svgH,
  });
  const { viewBox, currentZoom, isDragging, svgRef, minZoom, maxZoom } = panZoom;

  const handleHover = useCallback((e: React.MouseEvent, name: string, details: string[]) => {
    if (isDragging) return; // don't pop a tooltip while the user is panning
    const svg = (e.currentTarget as SVGElement).closest("svg");
    const rect = svg?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, name, details });
  }, [isDragging]);
  const clearHover = useCallback(() => setTooltip(null), []);

  if (error) {
    return <div style={{ padding: 16, color: theme.red, fontSize: 12 }}>Error: {error.message}</div>;
  }
  if (!isConnected || !data) {
    return (
      <div style={{ padding: 24, color: theme.textMuted, fontSize: 12, textAlign: "center" }}>
        <div style={{ fontSize: 22, marginBottom: 8 }}>◎</div>
        <div>Waiting for blast-radius data…</div>
        <div style={{ marginTop: 8, fontSize: 10, color: theme.textDim }}>
          Call the k8s-blast-radius tool with a node name
        </div>
      </div>
    );
  }

  if (!layout) return null;

  const { svgW, svgH, cx, cy, ring1, edgesR1, safeArcPath } = layout;
  const status = statusStyle(data.status);
  const resched = data.rescheduling;
  const reschedFeasible = resched.feasible;
  const reschedColor =
    reschedFeasible === true ? theme.greenSoft : reschedFeasible === false ? theme.redSoft : theme.textMuted;

  return (
    <div style={{ padding: "12px 14px", background: theme.bg, position: "relative", maxWidth: svgW + 20 }}>
      <TimeRangeHeader
        title={<span className="mono">{data.node}</span>}
        subtitle="K8s blast-radius analysis"
        status={{ tone: statusTone(data.status), label: status.label }}
      />
      {/* SVG diagram */}
      <div style={{ position: "relative" }}>
        <svg
          ref={svgRef}
          width="100%"
          height={svgH}
          viewBox={
            viewBox
              ? `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`
              : `0 0 ${svgW} ${svgH}`
          }
          style={{
            display: "block",
            maxWidth: svgW,
            cursor: isDragging ? "grabbing" : "grab",
            userSelect: "none",
            touchAction: "none",
          }}
          {...panZoom.svgHandlers}
        >
          {/* Transparent background captures pan-drag. Sits behind everything
              but above the viewBox origin — so click on empty space pans, but
              node circles receive their own mouse events first. */}
          <rect
            x={viewBox?.x ?? 0}
            y={viewBox?.y ?? 0}
            width={viewBox?.w ?? svgW}
            height={viewBox?.h ?? svgH}
            fill="transparent"
            onMouseDown={(e) => {
              setTooltip(null);
              panZoom.bgHandlers.onMouseDown(e);
            }}
          />
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

          {/* Ring guide */}
          <circle
            cx={cx}
            cy={cy}
            r={layout.ring1Radius}
            fill="none"
            stroke={theme.border}
            strokeWidth={1}
            strokeDasharray="4 6"
            opacity={0.4}
          />

          {/* Safe-zone arc (green, right-side) */}
          <path
            d={safeArcPath}
            fill="none"
            stroke={theme.greenSoft}
            strokeWidth={6}
            strokeLinecap="round"
            opacity={0.8}
          />
          <text
            x={cx + layout.ring1Radius + 40}
            y={cy - 4}
            textAnchor="middle"
            fill={theme.greenSoft}
            fontSize={11}
            fontWeight={600}
            fontFamily="'JetBrains Mono', monospace"
          >
            safe
          </text>
          <text
            x={cx + layout.ring1Radius + 40}
            y={cy + 10}
            textAnchor="middle"
            fill={theme.greenSoft}
            fontSize={10}
            fontFamily="'JetBrains Mono', monospace"
          >
            {data.unaffected_count} unaffected
          </text>

          {/* Edges */}
          {edgesR1.map((edge, i) => (
            <line
              key={i}
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              stroke={edge.outage ? theme.red : theme.amber}
              strokeWidth={1.2}
              strokeDasharray="4 4"
              opacity={0.45}
            />
          ))}

          {/* Ring 1 nodes */}
          {ring1.map((item, i) => (
            <g
              key={i}
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
                  opacity={0.85}
                />
              )}
              <circle
                cx={item.x}
                cy={item.y}
                r={item.r}
                fill={`${item.color}25`}
                stroke={item.color}
                strokeWidth={2}
                filter="url(#glow)"
              />
              <text
                x={item.x}
                y={item.y + item.r + 12}
                textAnchor="middle"
                fill={item.outage ? theme.redSoft : theme.amber}
                fontSize={9}
                fontWeight={600}
                fontFamily="'JetBrains Mono', monospace"
              >
                {truncate(item.label, 18)}
              </text>
              <text
                x={item.x}
                y={item.y + item.r + 22}
                textAnchor="middle"
                fill={theme.textDim}
                fontSize={8}
                fontFamily="'JetBrains Mono', monospace"
              >
                {item.outage ? "full outage" : "degraded"}
              </text>
            </g>
          ))}

          {/* Center node */}
          <circle
            cx={cx}
            cy={cy}
            r={42}
            fill={`${status.color}20`}
            stroke={status.color}
            strokeWidth={2.5}
            filter="url(#centerGlow)"
          />
          <text
            x={cx}
            y={cy - 6}
            textAnchor="middle"
            fill={theme.text}
            fontSize={12}
            fontWeight={700}
            fontFamily="'JetBrains Mono', monospace"
          >
            {truncateMiddle(data.node, 12)}
          </text>
          <text
            x={cx}
            y={cy + 8}
            textAnchor="middle"
            fill={theme.textMuted}
            fontSize={9}
            fontFamily="'JetBrains Mono', monospace"
          >
            node
          </text>
          <text
            x={cx}
            y={cy + 24}
            textAnchor="middle"
            fill={status.color}
            fontSize={11}
            fontWeight={700}
            fontFamily="'JetBrains Mono', monospace"
            letterSpacing={0.5}
          >
            {status.label}
          </text>
        </svg>

        {/* Floating summary card — top-left */}
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            background: `${theme.bgSecondary}ee`,
            border: `1px solid ${theme.borderStrong}`,
            borderRadius: 6,
            padding: "10px 12px",
            minWidth: 220,
            backdropFilter: "blur(4px)",
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: theme.textMuted,
              textTransform: "uppercase",
              letterSpacing: 0.8,
              marginBottom: 8,
            }}
          >
            blast radius summary
          </div>
          <SummaryRow color={theme.redSoft} value={data.full_outage.length} label="deployments" sub="full outage" />
          <SummaryRow color={theme.amber} value={data.degraded.length} label="deployments" sub="degraded" />
          <SummaryRow color={theme.greenSoft} value={data.unaffected_count} label="deployments" sub="unaffected" />
          <div style={{ height: 1, background: theme.border, margin: "8px 0" }} />
          <SummaryRow color={theme.redSoft} value={data.pods_at_risk} label="pods at risk" />
          <div style={{ marginTop: 8, fontSize: 11, color: theme.textMuted, display: "flex", gap: 6, alignItems: "center" }}>
            <span>rescheduling:</span>
            <span style={{ color: reschedColor, fontWeight: 600 }}>
              {reschedFeasible === true ? "feasible" : reschedFeasible === false ? "infeasible" : "unknown"}
            </span>
          </div>
        </div>

        {tooltip && <Tooltip info={tooltip} />}

        <ZoomControls
          currentZoom={currentZoom}
          minZoom={minZoom}
          maxZoom={maxZoom}
          onZoomIn={() => panZoom.applyZoom(1.25)}
          onZoomOut={() => panZoom.applyZoom(1 / 1.25)}
          onReset={panZoom.resetView}
          isDragging={isDragging}
        />
      </div>

      {/* Rescheduling detail + actions */}
      <div style={{ marginTop: 12, fontSize: 11, color: theme.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
        {resched.memory_required} required / {resched.memory_available} available across{" "}
        {resched.remaining_nodes} node{resched.remaining_nodes === 1 ? "" : "s"}
      </div>

      {data.downstream_services_note && (
        <div style={{ marginTop: 10, fontSize: 11, color: theme.textMuted, lineHeight: 1.5 }}>
          {data.downstream_services_note}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <InvestigationActions actions={data.investigation_actions} onSend={onSend} />
      </div>
    </div>
  );
}

function SummaryRow({
  color,
  value,
  label,
  sub,
}: {
  color: string;
  value: number;
  label: string;
  sub?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        marginBottom: 4,
      }}
    >
      <span
        className="mono"
        style={{ color, fontWeight: 700, minWidth: 28, textAlign: "right" }}
      >
        {value}
      </span>
      <span style={{ color: theme.text }}>{label}</span>
      {sub && (
        <>
          <span style={{ color: theme.textDim }}>—</span>
          <span style={{ color }}>{sub}</span>
        </>
      )}
    </div>
  );
}

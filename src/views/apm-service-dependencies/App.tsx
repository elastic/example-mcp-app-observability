/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Directed acyclic graph showing service-to-service call edges derived from
 * APM telemetry. Layered top-to-bottom layout: roots at the top, leaves at
 * the bottom. Curved edges with protocol/port labels and call-count width;
 * hover to highlight full upstream/downstream path.
 */

import React, { useState, useMemo, useCallback } from "react";
import { useApp } from "./shared/use-app";
import { parseToolResult } from "./shared/parse-tool-result";
import { theme } from "./shared/theme";

interface ServiceHealth {
  span_count: number;
  avg_duration_us: number;
  p99_duration_us?: number;
  error_count?: number;
}

interface ServiceNode {
  name: string;
  role: "root" | "internal" | "leaf";
  language?: string;
  deployment?: string;
  namespace?: string;
  health?: ServiceHealth;
}

interface Edge {
  source: string;
  target: string;
  call_count: number;
  protocol?: string;
  port?: string;
  avg_latency_us?: number;
}

interface DepData {
  services: ServiceNode[];
  edges: Edge[];
  service_count: number;
  edge_count: number;
  focal_service?: string;
  upstream?: string[];
  downstream?: string[];
  filters?: { lookback?: string; namespace?: string };
  data_coverage?: { apm: boolean };
  hint?: string;
}

const NODE_W = 180;
const NODE_H = 56;
const LAYER_GAP_Y = 90;
const NODE_GAP_X = 24;
const PAD_X = 30;
const PAD_TOP = 20;

function roleColor(role: string): string {
  switch (role) {
    case "root":
      return theme.green;
    case "leaf":
      return theme.amber;
    default:
      return theme.blue;
  }
}

function formatDuration(us: number): string {
  if (us >= 1_000_000) return `${(us / 1_000_000).toFixed(1)}s`;
  if (us >= 1_000) return `${(us / 1_000).toFixed(0)}ms`;
  return `${us.toFixed(0)}\u00b5s`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function healthIndicator(svc: ServiceNode): { color: string; label: string } {
  if (!svc.health) return { color: theme.textDim, label: "no traces" };
  const err = svc.health.error_count ?? 0;
  const total = svc.health.span_count;
  const rate = total > 0 ? err / total : 0;
  if (rate > 0.1) return { color: theme.red, label: `${(rate * 100).toFixed(1)}% err` };
  if (rate > 0.02) return { color: theme.amber, label: `${(rate * 100).toFixed(1)}% err` };
  return { color: theme.green, label: "healthy" };
}

function edgeWidth(callCount: number, maxCalls: number): number {
  if (maxCalls <= 0) return 1.5;
  const ratio = callCount / maxCalls;
  return 1 + ratio * 4;
}

function edgeLabel(e: Edge): string {
  const parts: string[] = [];
  if (e.protocol) parts.push(e.protocol);
  if (e.port) parts.push(`:${e.port}`);
  return parts.join("");
}

interface LayoutNode {
  name: string;
  svc: ServiceNode;
  layer: number;
  col: number;
  x: number;
  y: number;
}

function computeLayout(services: ServiceNode[], edges: Edge[]) {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const svcMap = new Map<string, ServiceNode>();

  for (const s of services) {
    svcMap.set(s.name, s);
    outgoing.set(s.name, []);
    incoming.set(s.name, []);
  }
  for (const e of edges) {
    outgoing.get(e.source)?.push(e.target);
    incoming.get(e.target)?.push(e.source);
  }

  const layers = new Map<string, number>();
  const visited = new Set<string>();

  function assignLayer(name: string): number {
    if (layers.has(name)) return layers.get(name)!;
    if (visited.has(name)) return 0;
    visited.add(name);
    const parents = incoming.get(name) ?? [];
    const maxParent = parents.length === 0 ? -1 : Math.max(...parents.map(assignLayer));
    const layer = maxParent + 1;
    layers.set(name, layer);
    return layer;
  }

  for (const s of services) assignLayer(s.name);

  const byLayer = new Map<number, string[]>();
  for (const [name, layer] of layers) {
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer)!.push(name);
  }

  const numLayers = byLayer.size;
  const maxPerLayer = Math.max(...[...byLayer.values()].map((l) => l.length), 1);

  for (const [, names] of byLayer) {
    names.sort((a, b) => {
      const connA = (outgoing.get(a)?.length ?? 0) + (incoming.get(a)?.length ?? 0);
      const connB = (outgoing.get(b)?.length ?? 0) + (incoming.get(b)?.length ?? 0);
      return connB - connA;
    });
  }

  const svgW = Math.max(maxPerLayer * (NODE_W + NODE_GAP_X) + PAD_X * 2, 500);
  const svgH = numLayers * (NODE_H + LAYER_GAP_Y) + PAD_TOP * 2;

  const nodes: LayoutNode[] = [];
  for (const [layer, names] of byLayer) {
    const totalW = names.length * NODE_W + (names.length - 1) * NODE_GAP_X;
    const startX = (svgW - totalW) / 2;
    names.forEach((name, col) => {
      const svc = svcMap.get(name);
      if (!svc) return;
      nodes.push({
        name,
        svc,
        layer,
        col,
        x: startX + col * (NODE_W + NODE_GAP_X),
        y: PAD_TOP + layer * (NODE_H + LAYER_GAP_Y),
      });
    });
  }

  return { nodes, svgW, svgH };
}

function connectedSet(name: string, edges: Edge[]): Set<string> {
  const result = new Set<string>([name]);
  const upQ = [name];
  while (upQ.length) {
    const cur = upQ.pop()!;
    for (const e of edges) {
      if (e.target === cur && !result.has(e.source)) {
        result.add(e.source);
        upQ.push(e.source);
      }
    }
  }
  const downQ = [name];
  while (downQ.length) {
    const cur = downQ.pop()!;
    for (const e of edges) {
      if (e.source === cur && !result.has(e.target)) {
        result.add(e.target);
        downQ.push(e.target);
      }
    }
  }
  return result;
}

function isEdgeConnected(e: Edge, connected: Set<string>): boolean {
  return connected.has(e.source) && connected.has(e.target);
}

interface TooltipInfo {
  x: number;
  y: number;
  lines: string[];
}

function Tooltip({ info }: { info: TooltipInfo }) {
  return (
    <div
      style={{
        position: "absolute",
        left: info.x + 14,
        top: info.y - 8,
        background: "#1a1d2a",
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        pointerEvents: "none",
        zIndex: 100,
        maxWidth: 260,
      }}
    >
      {info.lines.map((line, i) => (
        <div
          key={i}
          style={{
            fontSize: i === 0 ? 11 : 10,
            fontWeight: i === 0 ? 700 : 400,
            color: i === 0 ? "#fff" : theme.textMuted,
            lineHeight: 1.5,
            fontFamily: i === 0 ? "'JetBrains Mono', monospace" : undefined,
          }}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

function EdgePath({
  edge,
  srcNode,
  dstNode,
  maxCalls,
  dimmed,
  onHover,
  onLeave,
}: {
  edge: Edge;
  srcNode: LayoutNode;
  dstNode: LayoutNode;
  maxCalls: number;
  dimmed: boolean;
  onHover: (e: React.MouseEvent) => void;
  onLeave: () => void;
}) {
  const x1 = srcNode.x + NODE_W / 2;
  const y1 = srcNode.y + NODE_H;
  const x2 = dstNode.x + NODE_W / 2;
  const y2 = dstNode.y;

  const dy = Math.abs(y2 - y1);
  const cpOff = Math.max(dy * 0.4, 30);

  const d = `M ${x1} ${y1} C ${x1} ${y1 + cpOff}, ${x2} ${y2 - cpOff}, ${x2} ${y2}`;
  const w = edgeWidth(edge.call_count, maxCalls);
  const label = edgeLabel(edge);

  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;

  const latencyStr = edge.avg_latency_us ? formatDuration(edge.avg_latency_us) : "";

  const opacity = dimmed ? 0.12 : 0.65;
  const strokeColor = dimmed ? theme.border : theme.blue;

  return (
    <g onMouseEnter={onHover} onMouseLeave={onLeave} style={{ cursor: "pointer" }}>
      <path d={d} fill="none" stroke="transparent" strokeWidth={w + 10} />
      <path
        d={d}
        fill="none"
        stroke={strokeColor}
        strokeWidth={dimmed ? Math.max(w * 0.5, 0.5) : w}
        opacity={opacity}
        strokeLinecap="round"
      />
      {!dimmed && (
        <polygon
          points={`${x2},${y2} ${x2 - 4},${y2 - 8} ${x2 + 4},${y2 - 8}`}
          fill={theme.blue}
          opacity={0.6}
        />
      )}
      {!dimmed && label && (
        <text
          x={mx + (x2 > x1 ? 6 : -6)}
          y={my - 4}
          fill={theme.textMuted}
          fontSize={8}
          fontFamily="'JetBrains Mono', monospace"
          textAnchor={x2 > x1 ? "start" : "end"}
        >
          {label}
        </text>
      )}
      {!dimmed && (latencyStr || edge.call_count > 0) && (
        <text
          x={mx + (x2 > x1 ? 6 : -6)}
          y={my + 8}
          fill={theme.textDim}
          fontSize={7}
          fontFamily="'JetBrains Mono', monospace"
          textAnchor={x2 > x1 ? "start" : "end"}
        >
          {[latencyStr, edge.call_count > 0 ? `${formatCount(edge.call_count)} calls` : ""]
            .filter(Boolean)
            .join(" \u00b7 ")}
        </text>
      )}
    </g>
  );
}

function NodeCard({
  node,
  dimmed,
  isHovered,
  onHover,
  onLeave,
}: {
  node: LayoutNode;
  dimmed: boolean;
  isHovered: boolean;
  onHover: () => void;
  onLeave: () => void;
}) {
  const color = roleColor(node.svc.role);
  const hi = healthIndicator(node.svc);

  return (
    <foreignObject x={node.x} y={node.y} width={NODE_W} height={NODE_H}>
      <div
        // @ts-expect-error xmlns needed for foreignObject
        xmlns="http://www.w3.org/1999/xhtml"
        onMouseEnter={onHover}
        onMouseLeave={onLeave}
        style={{
          width: NODE_W,
          height: NODE_H,
          background: isHovered ? "#1a1d28" : theme.bgSecondary,
          borderRadius: 8,
          border: `1px solid ${isHovered ? color : dimmed ? `${theme.border}60` : theme.border}`,
          padding: "6px 10px",
          cursor: "pointer",
          transition: "all 0.15s",
          opacity: dimmed ? 0.35 : 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: hi.color,
              boxShadow: hi.color !== theme.textDim ? `0 0 4px ${hi.color}60` : "none",
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "#fff",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            {node.name}
          </span>
          <span
            style={{
              fontSize: 8,
              fontWeight: 700,
              padding: "1px 5px",
              borderRadius: 6,
              background: `${color}18`,
              color,
              letterSpacing: "0.04em",
            }}
          >
            {node.svc.role}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
          {node.svc.language && (
            <span
              style={{
                fontSize: 9,
                color: theme.textMuted,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {node.svc.language}
            </span>
          )}
          <span style={{ fontSize: 9, color: hi.color }}>{hi.label}</span>
          {node.svc.health?.avg_duration_us != null && (
            <span
              style={{
                fontSize: 9,
                color: theme.textDim,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {formatDuration(node.svc.health.avg_duration_us)} avg
            </span>
          )}
        </div>
      </div>
    </foreignObject>
  );
}

function StatChip({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          color,
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: 9, color: theme.textMuted }}>{label}</span>
    </div>
  );
}

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

export function App() {
  const [data, setData] = useState<DepData | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [edgeTooltip, setEdgeTooltip] = useState<TooltipInfo | null>(null);

  const { isConnected, error } = useApp({
    appInfo: { name: "APM Service Dependencies", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolresult = (params) => {
        const parsed = parseToolResult<DepData>(params);
        if (parsed?.services && parsed?.edges) setData(parsed);
      };
    },
  });

  const layout = useMemo(() => {
    if (!data) return null;
    return computeLayout(data.services, data.edges);
  }, [data]);

  const connected = useMemo(() => {
    if (!hovered || !data) return null;
    return connectedSet(hovered, data.edges);
  }, [hovered, data]);

  const maxCalls = useMemo(() => {
    if (!data) return 0;
    return Math.max(...data.edges.map((e) => e.call_count), 1);
  }, [data]);

  const stats = useMemo(() => {
    if (!data) return null;
    const roots = data.services.filter((s) => s.role === "root").length;
    const leaves = data.services.filter((s) => s.role === "leaf").length;
    const withHealth = data.services.filter((s) => s.health).length;
    const unhealthy = data.services.filter((s) => {
      if (!s.health) return false;
      const total = s.health.span_count;
      const err = s.health.error_count ?? 0;
      return total > 0 && err / total > 0.02;
    }).length;
    return { roots, leaves, withHealth, unhealthy };
  }, [data]);

  const handleEdgeHover = useCallback((e: React.MouseEvent, edge: Edge) => {
    const rect = (e.currentTarget as SVGElement).closest("svg")?.getBoundingClientRect();
    if (!rect) return;
    const lines = [
      `${edge.source} \u2192 ${edge.target}`,
      `${formatCount(edge.call_count)} calls`,
    ];
    if (edge.avg_latency_us) lines.push(`Avg latency: ${formatDuration(edge.avg_latency_us)}`);
    if (edge.protocol) lines.push(`Protocol: ${edge.protocol}`);
    if (edge.port) lines.push(`Port: ${edge.port}`);
    setEdgeTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, lines });
  }, []);

  const clearEdgeTooltip = useCallback(() => setEdgeTooltip(null), []);

  if (error) {
    return <div style={{ padding: 16, color: theme.red, fontSize: 12 }}>Error: {error.message}</div>;
  }
  if (!isConnected || !data) {
    return (
      <div style={{ padding: 20, color: theme.textMuted, fontSize: 12, textAlign: "center" }}>
        <div>Waiting for service dependency data…</div>
        <div style={{ marginTop: 8, fontSize: 10, color: theme.textDim }}>
          Call apm-service-dependencies to map the topology.
        </div>
      </div>
    );
  }

  if (!data.services.length || !data.edges.length) {
    return (
      <div style={{ padding: 20, color: theme.textMuted, fontSize: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6, color: theme.amber }}>
          No service dependency data
        </div>
        <div style={{ fontSize: 11, lineHeight: 1.6, color: theme.textMuted }}>
          {data.hint ||
            "No APM spans with destination service resources found in the selected window."}
        </div>
      </div>
    );
  }

  if (!layout || !stats) return null;
  const { nodes, svgW, svgH } = layout;

  const nodeMap = new Map<string, LayoutNode>();
  for (const n of nodes) nodeMap.set(n.name, n);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          padding: "10px 14px",
          borderBottom: `1px solid ${theme.border}`,
          background: "#0d0f14",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: "#fff" }}>
            Service Dependencies
          </span>
          {data.focal_service && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: theme.cyan,
                padding: "2px 8px",
                borderRadius: 10,
                background: `${theme.cyan}18`,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              focal: {data.focal_service}
            </span>
          )}
          {data.filters?.lookback && (
            <span
              style={{
                fontSize: 10,
                color: theme.textMuted,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {data.filters.lookback} window
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <StatChip label="services" value={data.service_count} color={theme.blue} />
          <StatChip label="edges" value={data.edge_count} color={theme.cyan} />
          <StatChip label="roots" value={stats.roots} color={theme.green} />
          <StatChip label="leaves" value={stats.leaves} color={theme.amber} />
          {stats.unhealthy > 0 && (
            <StatChip label="unhealthy" value={stats.unhealthy} color={theme.red} />
          )}
        </div>
      </div>

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
          </defs>

          {data.edges.map((edge, i) => {
            const src = nodeMap.get(edge.source);
            const dst = nodeMap.get(edge.target);
            if (!src || !dst) return null;
            const dim = hovered !== null && (!connected || !isEdgeConnected(edge, connected));
            return (
              <EdgePath
                key={`e-${i}`}
                edge={edge}
                srcNode={src}
                dstNode={dst}
                maxCalls={maxCalls}
                dimmed={dim}
                onHover={(e) => handleEdgeHover(e, edge)}
                onLeave={clearEdgeTooltip}
              />
            );
          })}

          {nodes.map((node) => {
            const dim = hovered !== null && (!connected || !connected.has(node.name));
            const isHov = hovered === node.name;
            return (
              <NodeCard
                key={node.name}
                node={node}
                dimmed={dim}
                isHovered={isHov}
                onHover={() => setHovered(node.name)}
                onLeave={() => setHovered(null)}
              />
            );
          })}
        </svg>

        {edgeTooltip && <Tooltip info={edgeTooltip} />}
      </div>

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
        <LegendDot color={theme.green} label="Root (no upstream)" />
        <LegendDot color={theme.blue} label="Internal" />
        <LegendDot color={theme.amber} label="Leaf (no downstream)" />
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div
            style={{
              width: 20,
              height: 2,
              background: theme.blue,
              borderRadius: 1,
              opacity: 0.6,
            }}
          />
          <span style={{ fontSize: 9, color: theme.textMuted }}>Call edge</span>
        </div>
      </div>

      <style>{`
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a2d3a; border-radius: 2px; }
      `}</style>
    </div>
  );
}

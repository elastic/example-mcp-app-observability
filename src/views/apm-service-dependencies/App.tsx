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

import React, { useEffect, useState, useMemo, useCallback } from "react";
import { useApp, AppLike } from "@shared/use-app";
import { parseToolResult } from "@shared/parse-tool-result";
import { applyTheme, theme } from "@shared/theme";
import { useDisplayMode } from "@shared/use-display-mode";
import {
  Dropdown,
  InvestigationActions,
  InvestigationAction,
  QueryPill,
  RerunContext,
  ZoomControls,
  SetupNoticeBanner,
  SetupNotice,
  type DropdownOption,
} from "@shared/components";
import { AppGlyph, ExitFullscreenIcon, FullscreenIcon } from "@shared/icons";
import { usePanZoom } from "@shared/use-pan-zoom";
import { viewStyles } from "./styles";

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
  data_coverage_note?: string;
  hint?: string;
  investigation_actions?: InvestigationAction[];
  rerun_context?: RerunContext;
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

function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h * 31) ^ s.charCodeAt(i)) & 0x7fffffff;
  return h;
}

interface LayoutNode {
  name: string;
  svc: ServiceNode;
  layer: number;
  col: number;
  x: number;
  y: number;
}

export type GraphDirection = "vertical" | "horizontal";

function computeLayout(
  services: ServiceNode[],
  edges: Edge[],
  direction: GraphDirection = "vertical",
) {
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

  const nodes: LayoutNode[] = [];
  let svgW: number, svgH: number;

  if (direction === "horizontal") {
    // Layers flow L -> R; nodes within a layer stack vertically.
    // Vertical inter-node spacing mirrors NODE_GAP_X from vertical mode;
    // inter-layer horizontal spacing mirrors LAYER_GAP_Y.
    const INTER_NODE = NODE_GAP_X;
    const INTER_LAYER_X = LAYER_GAP_Y + NODE_W; // column-to-column distance
    svgH = Math.max(maxPerLayer * (NODE_H + INTER_NODE) + PAD_TOP * 2, 360);
    svgW = numLayers * INTER_LAYER_X + PAD_X * 2;

    for (const [layer, names] of byLayer) {
      const totalH = names.length * NODE_H + (names.length - 1) * INTER_NODE;
      const startY = (svgH - totalH) / 2;
      names.forEach((name, col) => {
        const svc = svcMap.get(name);
        if (!svc) return;
        nodes.push({
          name,
          svc,
          layer,
          col,
          x: PAD_X + layer * INTER_LAYER_X,
          y: startY + col * (NODE_H + INTER_NODE),
        });
      });
    }
  } else {
    svgW = Math.max(maxPerLayer * (NODE_W + NODE_GAP_X) + PAD_X * 2, 500);
    svgH = numLayers * (NODE_H + LAYER_GAP_Y) + PAD_TOP * 2;

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
  }

  return { nodes, svgW, svgH, direction };
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
  direction,
  onHover,
  onLeave,
}: {
  edge: Edge;
  srcNode: LayoutNode;
  dstNode: LayoutNode;
  maxCalls: number;
  dimmed: boolean;
  direction: GraphDirection;
  onHover: (e: React.MouseEvent) => void;
  onLeave: () => void;
}) {
  const horizontal = direction === "horizontal";
  const x1 = horizontal ? srcNode.x + NODE_W        : srcNode.x + NODE_W / 2;
  const y1 = horizontal ? srcNode.y + NODE_H / 2    : srcNode.y + NODE_H;
  const x2 = horizontal ? dstNode.x                 : dstNode.x + NODE_W / 2;
  const y2 = horizontal ? dstNode.y + NODE_H / 2    : dstNode.y;

  const primaryDelta = horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1);
  const cpOff = Math.max(primaryDelta * 0.4, 30);

  const d = horizontal
    ? `M ${x1} ${y1} C ${x1 + cpOff} ${y1}, ${x2 - cpOff} ${y2}, ${x2} ${y2}`
    : `M ${x1} ${y1} C ${x1} ${y1 + cpOff}, ${x2} ${y2 - cpOff}, ${x2} ${y2}`;
  const w = edgeWidth(edge.call_count, maxCalls);
  const label = edgeLabel(edge);

  // Labels used to pile up at the chord midpoint when multiple edges crossed similar
  // screen coordinates (common when several services call the same backend leaf). Stagger
  // labels along the edge via a stable per-edge hash so each label lands at a distinct
  // position. Three lanes of horizontal offset + vertical offset spread most collisions.
  const laneBucket = stableHash(edge.source + "|" + edge.target) % 3;
  const labelT = 0.42 + laneBucket * 0.08; // 0.42 | 0.50 | 0.58 along the edge
  const laneYOffset = (laneBucket - 1) * 12; // -12 | 0 | +12 px

  const mx = Math.round((1 - labelT) * x1 + labelT * x2);
  const my = Math.round((1 - labelT) * y1 + labelT * y2 + laneYOffset);

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
          points={
            horizontal
              ? `${x2},${y2} ${x2 - 8},${y2 - 4} ${x2 - 8},${y2 + 4}`
              : `${x2},${y2} ${x2 - 4},${y2 - 8} ${x2 + 4},${y2 - 8}`
          }
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
  isPinned,
  isInspected,
  canInspect,
  fanIn,
  fanOut,
  onHover,
  onMove,
  onLeave,
  onClick,
  onToggleInspect,
}: {
  node: LayoutNode;
  dimmed: boolean;
  isHovered: boolean;
  isPinned: boolean;
  isInspected: boolean;
  canInspect: boolean;
  fanIn: number;
  fanOut: number;
  onHover: (e: React.MouseEvent) => void;
  onMove: (e: React.MouseEvent) => void;
  onLeave: () => void;
  onClick: (e: React.MouseEvent) => void;
  onToggleInspect: () => void;
}) {
  const color = roleColor(node.svc.role);
  const hi = healthIndicator(node.svc);
  const focused = isHovered || isPinned;
  const showBadge = isHovered || isInspected;
  const badgeDisabled = !isInspected && !canInspect;
  const badgeTitle = isInspected
    ? "Remove from compare"
    : canInspect
      ? "Add to compare"
      : "Compare panel is full (max 4)";

  return (
    <foreignObject x={node.x} y={node.y} width={NODE_W} height={NODE_H}>
      <div
        // @ts-expect-error xmlns needed for foreignObject
        xmlns="http://www.w3.org/1999/xhtml"
        onMouseEnter={onHover}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        onClick={onClick}
        role="button"
        aria-pressed={isPinned}
        className={isInspected ? "dep-node-inspected" : undefined}
        style={{
          position: "relative",
          width: NODE_W,
          height: NODE_H,
          background: focused ? "#1a1d28" : theme.bgSecondary,
          borderRadius: 8,
          border: `1px solid ${isPinned ? "var(--accent)" : focused ? color : dimmed ? `${theme.border}60` : theme.border}`,
          boxShadow: isPinned ? "0 0 0 1px var(--accent-dim) inset" : undefined,
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
        {showBadge && (
          <button
            className={`dep-inspect-badge${isInspected ? " on" : ""}`}
            aria-label={badgeTitle}
            title={badgeTitle}
            disabled={badgeDisabled}
            onClick={(e) => {
              e.stopPropagation();
              onToggleInspect();
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {isInspected ? "✓" : "+"}
          </button>
        )}
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
            title={`${fanIn} upstream \u00b7 ${fanOut} downstream`}
            style={{
              fontSize: 9,
              fontWeight: 700,
              padding: "1px 5px",
              borderRadius: 6,
              background: `${color}18`,
              color,
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: "0.02em",
              whiteSpace: "nowrap",
            }}
          >
            {`${fanIn}\u2194${fanOut}`}
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

const DIRECTION_OPTIONS: DropdownOption<GraphDirection>[] = [
  { value: "vertical", label: "Vertical (top → bottom)" },
  { value: "horizontal", label: "Horizontal (left → right)" },
];

export function App() {
  const [data, setData] = useState<DepData | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [inspected, setInspected] = useState<string[]>([]);
  const [direction, setDirection] = useState<GraphDirection>("vertical");
  const [edgeTooltip, setEdgeTooltip] = useState<TooltipInfo | null>(null);
  const [nodeTooltip, setNodeTooltip] = useState<TooltipInfo | null>(null);
  const [app, setApp] = useState<AppLike | null>(null);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const { isFullscreen, toggle: toggleFullscreen } = useDisplayMode(app);

  // Hover wins for in-motion feedback; pinned takes over once the cursor
  // leaves so the dim/focus state persists for comparison work.
  const focusTarget = hovered ?? pinned;

  const inspectedSet = useMemo(() => new Set(inspected), [inspected]);
  const MAX_INSPECT = 4;
  const canInspectMore = inspected.length < MAX_INSPECT;

  const toggleInspect = useCallback((name: string) => {
    setInspected((prev) => {
      if (prev.includes(name)) return prev.filter((n) => n !== name);
      if (prev.length >= MAX_INSPECT) return prev;
      return [...prev, name];
    });
  }, []);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = viewStyles;
    document.head.appendChild(style);
    applyTheme();
    return () => style.remove();
  }, []);

  const { isConnected, error } = useApp({
    appInfo: { name: "APM Service Dependencies", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (a) => {
      a.ontoolresult = (params) => {
        const parsed = parseToolResult<DepData>(params);
        if (parsed?.services && parsed?.edges) setData(parsed);
      };
      setApp(a);
    },
  });

  const onSend = useCallback((p: string) => app?.sendMessage(p), [app]);

  const layout = useMemo(() => {
    if (!data) return null;
    return computeLayout(data.services, data.edges, direction);
  }, [data, direction]);

  const panZoom = usePanZoom({
    baseW: layout?.svgW,
    baseH: layout?.svgH,
  });

  const connected = useMemo(() => {
    if (!focusTarget || !data) return null;
    return connectedSet(focusTarget, data.edges);
  }, [focusTarget, data]);

  const maxCalls = useMemo(() => {
    if (!data) return 0;
    return Math.max(...data.edges.map((e) => e.call_count), 1);
  }, [data]);

  const fanMap = useMemo(() => {
    const m = new Map<string, { in: number; out: number }>();
    if (!data) return m;
    for (const s of data.services) m.set(s.name, { in: 0, out: 0 });
    for (const e of data.edges) {
      const s = m.get(e.source);
      if (s) s.out += 1;
      const t = m.get(e.target);
      if (t) t.in += 1;
    }
    return m;
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

  const isDragging = panZoom.isDragging;

  const handleEdgeHover = useCallback(
    (e: React.MouseEvent, edge: Edge) => {
      if (isDragging) return;
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
    },
    [isDragging]
  );

  const clearEdgeTooltip = useCallback(() => setEdgeTooltip(null), []);

  const handleNodeHover = useCallback(
    (e: React.MouseEvent, node: LayoutNode) => {
      if (isDragging) return;
      const svg = (e.currentTarget as HTMLElement).closest("svg");
      const rect = svg?.getBoundingClientRect();
      if (!rect) return;

      const svc = node.svc;
      const lines: string[] = [svc.name];

      const roleParts: string[] = [svc.role];
      if (svc.language) roleParts.push(svc.language);
      lines.push(roleParts.join(" · "));

      if (svc.deployment || svc.namespace) {
        const k8s: string[] = [];
        if (svc.deployment) k8s.push(`deploy: ${svc.deployment}`);
        if (svc.namespace) k8s.push(`ns: ${svc.namespace}`);
        lines.push(k8s.join(" · "));
      }

      if (svc.health) {
        const h = svc.health;
        const total = h.span_count;
        const err = h.error_count ?? 0;
        const rate = total > 0 ? (err / total) * 100 : 0;
        lines.push(`spans: ${formatCount(total)}`);
        if (total > 0) {
          lines.push(`errors: ${formatCount(err)} (${rate.toFixed(2)}%)`);
        }
        if (h.avg_duration_us != null) {
          const durParts = [`avg: ${formatDuration(h.avg_duration_us)}`];
          if (h.p99_duration_us != null) durParts.push(`p99: ${formatDuration(h.p99_duration_us)}`);
          lines.push(durParts.join(" · "));
        }
      } else {
        lines.push("no trace data");
      }

      if (data) {
        const upstream = data.edges.filter((edg) => edg.target === svc.name);
        const downstream = data.edges.filter((edg) => edg.source === svc.name);
        lines.push(`upstream: ${upstream.length} · downstream: ${downstream.length}`);
      }

      setNodeTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, lines });
    },
    [isDragging, data]
  );

  const clearNodeTooltip = useCallback(() => setNodeTooltip(null), []);

  const headerPills = (
    <>
      {pinned && (
        <QueryPill onClear={() => setPinned(null)} label="Clear pin">
          focus: {pinned}
        </QueryPill>
      )}
      {data?.focal_service && <QueryPill>focal: {data.focal_service}</QueryPill>}
      {data?.filters?.namespace && <QueryPill>namespace: {data.filters.namespace}</QueryPill>}
      {data?.filters?.lookback && <QueryPill>lookback: {data.filters.lookback}</QueryPill>}
    </>
  );

  const Header = (
    <header className="ds-header">
      <AppGlyph size={20} />
      <h1 className="ds-header-title">Service dependencies</h1>
      <div className="ds-header-actions">
        {headerPills}
        <Dropdown<GraphDirection>
          value={direction}
          onChange={setDirection}
          options={DIRECTION_OPTIONS}
          label="Graph layout"
          triggerPrefix="Layout:"
        />
        <button
          type="button"
          className="ds-btn-icon"
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          onClick={toggleFullscreen}
        >
          {isFullscreen ? <ExitFullscreenIcon size={14} /> : <FullscreenIcon size={14} />}
        </button>
      </div>
    </header>
  );

  if (error) {
    return (
      <div className="ds-view">
        {Header}
        <div className="dep-empty">
          <div className="dep-empty-title">Error</div>
          <div className="dep-empty-sub">{error.message}</div>
        </div>
      </div>
    );
  }
  if (!isConnected || !data) {
    return (
      <div className="ds-view">
        {Header}
        <div className="dep-empty">
          <div className="dep-empty-title">Waiting for service dependency data…</div>
          <div className="dep-empty-sub">
            Call apm-service-dependencies to map the topology.
          </div>
        </div>
      </div>
    );
  }

  if (!data.services.length || !data.edges.length) {
    return (
      <div className="ds-view">
        {Header}
        <div className="dep-empty">
          <div className="dep-empty-title">No service dependency data</div>
          <div className="dep-empty-sub">
            {data.hint ||
              "No APM spans with destination service resources found in the selected window."}
          </div>
        </div>
      </div>
    );
  }

  if (!layout || !stats) return null;
  const { nodes, svgW, svgH } = layout;

  const nodeMap = new Map<string, LayoutNode>();
  for (const n of nodes) nodeMap.set(n.name, n);

  const setupNotice = (data as { _setup_notice?: SetupNotice })._setup_notice;
  const onDismissNotice =
    setupNotice?.type === "welcome" && app
      ? () => {
          setNoticeDismissed(true);
          app.callServerTool({ name: "_setup-dismiss-welcome", arguments: {} }).catch(() => {});
        }
      : undefined;

  return (
    <div className="ds-view">
      {Header}

      {setupNotice && !noticeDismissed && (
        <SetupNoticeBanner
          notice={setupNotice}
          onDismiss={onDismissNotice}
          onOpenLink={app ? (url) => { app.openLink({ url }).catch(() => {}); } : undefined}
        />
      )}

      <div className="dep-stats">
        <StatChip label="services" value={data.service_count} color={theme.blue} />
        <StatChip label="edges" value={data.edge_count} color={theme.cyan} />
        <StatChip label="roots" value={stats.roots} color={theme.green} />
        <StatChip label="leaves" value={stats.leaves} color={theme.amber} />
        {stats.unhealthy > 0 && (
          <StatChip label="unhealthy" value={stats.unhealthy} color={theme.red} />
        )}
      </div>

      {data.data_coverage_note && (
        <div className="dep-coverage"><strong>Data coverage</strong>{data.data_coverage_note}</div>
      )}

      <div className="dep-graph">
        <svg
          ref={panZoom.svgRef}
          viewBox={
            panZoom.viewBox
              ? `${panZoom.viewBox.x} ${panZoom.viewBox.y} ${panZoom.viewBox.w} ${panZoom.viewBox.h}`
              : `0 0 ${svgW} ${svgH}`
          }
          preserveAspectRatio="xMidYMid meet"
          {...panZoom.svgHandlers}
          style={{
            display: "block",
            // SVG fills the graph container both ways. viewBox content stays
            // at its natural aspect and is centered via preserveAspectRatio;
            // any whitespace lives inside the SVG and blends with the
            // container background, so the graph canvas fills the available
            // vertical space cleanly even when the compare strip is empty.
            width: "100%",
            height: "100%",
            cursor: isDragging ? "grabbing" : "grab",
            userSelect: "none",
            touchAction: "none",
          }}
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

          <rect
            x={0}
            y={0}
            width={svgW}
            height={svgH}
            fill="transparent"
            onMouseDown={(e) => {
              setEdgeTooltip(null);
              setNodeTooltip(null);
              setHovered(null);
              panZoom.bgHandlers.onMouseDown(e);
            }}
            onClick={() => {
              // Click on empty space (no drag) clears the pin. If the user
              // panned, React doesn't fire onClick so the pin persists.
              setPinned(null);
            }}
          />

          {data.edges.map((edge, i) => {
            const src = nodeMap.get(edge.source);
            const dst = nodeMap.get(edge.target);
            if (!src || !dst) return null;
            const edgeTouchesInspected =
              inspectedSet.has(edge.source) || inspectedSet.has(edge.target);
            const dim =
              focusTarget !== null &&
              !edgeTouchesInspected &&
              (!connected || !isEdgeConnected(edge, connected));
            return (
              <EdgePath
                key={`e-${i}`}
                edge={edge}
                srcNode={src}
                dstNode={dst}
                maxCalls={maxCalls}
                dimmed={dim}
                direction={direction}
                onHover={(e) => handleEdgeHover(e, edge)}
                onLeave={clearEdgeTooltip}
              />
            );
          })}

          {nodes.map((node) => {
            const isIns = inspectedSet.has(node.name);
            const dim =
              focusTarget !== null &&
              !isIns &&
              (!connected || !connected.has(node.name));
            const isHov = hovered === node.name;
            const isPin = pinned === node.name;
            return (
              <NodeCard
                key={node.name}
                node={node}
                dimmed={dim}
                isHovered={isHov}
                isPinned={isPin}
                isInspected={isIns}
                canInspect={canInspectMore}
                fanIn={fanMap.get(node.name)?.in ?? 0}
                fanOut={fanMap.get(node.name)?.out ?? 0}
                onClick={(e) => {
                  e.stopPropagation();
                  setPinned((prev) => (prev === node.name ? null : node.name));
                }}
                onToggleInspect={() => toggleInspect(node.name)}
                onHover={(e) => {
                  if (isDragging) return;
                  setHovered(node.name);
                  handleNodeHover(e, node);
                }}
                onMove={(e) => {
                  if (!isDragging) handleNodeHover(e, node);
                }}
                onLeave={() => {
                  setHovered(null);
                  clearNodeTooltip();
                }}
              />
            );
          })}
        </svg>

        {edgeTooltip && <Tooltip info={edgeTooltip} />}
        {nodeTooltip && !edgeTooltip && <Tooltip info={nodeTooltip} />}

        <ZoomControls
          currentZoom={panZoom.currentZoom}
          minZoom={panZoom.minZoom}
          maxZoom={panZoom.maxZoom}
          onZoomIn={() => panZoom.applyZoom(1.25)}
          onZoomOut={() => panZoom.applyZoom(1 / 1.25)}
          onReset={panZoom.resetView}
          isDragging={isDragging}
        />
      </div>

      {inspected.length > 0 && (
        <div className="dep-inspect-strip" role="region" aria-label="Compare panel">
          {inspected.map((name) => {
            const svc = data.services.find((s) => s.name === name);
            if (!svc) return null;
            const isFocused = pinned === name;
            const fan = fanMap.get(name);
            const hi = healthIndicator(svc);
            return (
              <div
                key={name}
                className={`dep-inspect-card${isFocused ? " focused" : ""}`}
              >
                <div className="dep-inspect-card-head">
                  <span className="dep-inspect-card-name" title={name}>{name}</span>
                  {isFocused && <span className="dep-inspect-card-focused-badge">focus</span>}
                  <button
                    type="button"
                    className="dep-inspect-card-close"
                    aria-label={`Remove ${name} from compare`}
                    onClick={() => toggleInspect(name)}
                  >
                    ×
                  </button>
                </div>
                <div className="dep-inspect-card-meta">
                  <div className="dep-inspect-card-meta-row">
                    <strong>{svc.role}</strong>
                    {svc.language ? ` · ${svc.language}` : ""}
                    {svc.namespace ? ` · ns: ${svc.namespace}` : ""}
                  </div>
                  {svc.health && svc.health.span_count > 0 && (
                    <div className="dep-inspect-card-meta-row">
                      <strong>{formatCount(svc.health.span_count)}</strong> spans
                      {(svc.health.error_count ?? 0) > 0 && (
                        <>
                          {" · "}
                          <span style={{ color: hi.color }}>{hi.label}</span>
                        </>
                      )}
                    </div>
                  )}
                  {svc.health?.avg_duration_us != null && (
                    <div className="dep-inspect-card-meta-row">
                      avg <strong>{formatDuration(svc.health.avg_duration_us)}</strong>
                      {svc.health.p99_duration_us != null && (
                        <> · p99 <strong>{formatDuration(svc.health.p99_duration_us)}</strong></>
                      )}
                    </div>
                  )}
                  {fan && (
                    <div className="dep-inspect-card-meta-row">
                      <strong>{fan.in}</strong> upstream · <strong>{fan.out}</strong> downstream
                    </div>
                  )}
                </div>
                <div className="dep-inspect-card-foot">
                  <button
                    type="button"
                    className="dep-inspect-card-action"
                    onClick={() => setPinned(isFocused ? null : name)}
                    disabled={isFocused}
                  >
                    {isFocused ? "Focused" : "Make focus"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="dep-legend">
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
          <span style={{ fontSize: 9, color: "var(--text-muted)" }}>Call edge</span>
        </div>
      </div>

      {data.investigation_actions?.length ? (
        <div className="dep-actions">
          <InvestigationActions actions={data.investigation_actions} onSend={onSend} />
        </div>
      ) : null}
    </div>
  );
}

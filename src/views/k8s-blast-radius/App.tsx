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
 *   Ring 2:   APM-discovered user-facing services in affected namespaces
 *             (only rendered when APM telemetry is present)
 *   Safe arc: green arc on the right representing unaffected capacity
 *   Hover:    tooltip with deployment / namespace / service detail
 *
 * Pan / zoom: the diagram supports wheel-zoom (centered on cursor) and
 * click-drag-pan (from empty SVG space — node hover still works). Floating
 * zoom controls sit at the bottom-right. Pan/zoom state is local React state
 * and resets on tool re-invocation (e.g. re-running for a different node).
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useApp, AppLike } from "@shared/use-app";
import { parseToolResult } from "@shared/parse-tool-result";
import { applyTheme, theme } from "@shared/theme";
import { useDisplayMode } from "@shared/use-display-mode";
import {
  InvestigationAction,
  QueryPill,
  type Severity as DSSeverity,
  SeverityChip,
  SetupNoticeBanner,
  SetupNotice,
  ZoomControls,
} from "@shared/components";
import { AppGlyph, ExitFullscreenIcon, FullscreenIcon } from "@shared/icons";
import { usePanZoom } from "@shared/use-pan-zoom";
import { viewStyles } from "./styles";

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

function statusSeverity(status: string): DSSeverity {
  if (status === "AT RISK") return "critical";
  if (status === "PARTIAL RISK") return "major";
  if (status === "SAFE") return "ok";
  return "minor";
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
  const [inspected, setInspected] = useState<Array<{ name: string; details: string[] }>>([]);
  const MAX_INSPECT = 4;
  const inspectedNames = useMemo(() => new Set(inspected.map((i) => i.name)), [inspected]);
  const canInspectMore = inspected.length < MAX_INSPECT;

  // Click a node to pin its details into the bottom compare strip (up to 4).
  // Click the same node again to remove it from the strip.
  const toggleInspect = useCallback((name: string, details: string[]) => {
    setInspected((prev) => {
      if (prev.some((i) => i.name === name)) return prev.filter((i) => i.name !== name);
      if (prev.length >= MAX_INSPECT) return prev;
      return [...prev, { name, details }];
    });
  }, []);
  const [app, setApp] = useState<AppLike | null>(null);
  const [noticeDismissed, setNoticeDismissed] = useState(false);

  const { isFullscreen, toggle: toggleFullscreen } = useDisplayMode(app);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = viewStyles;
    document.head.appendChild(style);
    applyTheme();
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

    const downstream = data.downstream_services || [];
    const hasRing2 = downstream.length > 0;
    const ring2Gap = 85;
    const ring2Radius = hasRing2 ? ring1Radius + ring2Gap : ring1Radius;
    const outerRadius = ring2Radius;

    const svgW = Math.max(600, outerRadius * 2 + 140);
    const svgH = Math.max(520, outerRadius * 2 + 160);
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
      namespace?: string;
    }

    interface Ring2Item {
      x: number;
      y: number;
      r: number;
      label: string;
      namespace: string;
      angle: number;
      details: string[];
    }

    const ring1: RingItem[] = [];

    // Distribute affected deployments across 270° on the left & top, leaving
    // the right-side ~90° arc for the "safe zone" indicator.
    const startAngle = Math.PI / 4; // 45° (bottom-right start)
    const endAngle = 2 * Math.PI - Math.PI / 4; // 315° sweep, skipping right-side arc
    const sweep = endAngle - startAngle;

    const ring1Angles: Array<{ angle: number; namespace: string }> = [];

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
        namespace: dep.namespace,
        details: [
          `Namespace: ${dep.namespace}`,
          `Pods lost: ${dep.pods_on_node} of ${dep.pods_total}`,
          `Surviving: ${dep.surviving}`,
          `Memory: ${dep.memory}`,
          dep.pods_total === 1 ? "Single replica — SPOF" : "",
        ].filter(Boolean),
      });
      ring1Angles.push({ angle, namespace: dep.namespace });
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
        namespace: dep.namespace,
        details: [
          `Namespace: ${dep.namespace}`,
          `Pods lost: ${dep.pods_on_node} of ${dep.pods_total}`,
          `Surviving: ${dep.surviving}`,
          `Memory: ${dep.memory}`,
        ],
      });
      ring1Angles.push({ angle, namespace: dep.namespace });
    });

    const edgesR1 = ring1.map((item) => ({
      x1: cx,
      y1: cy,
      x2: item.x,
      y2: item.y,
      outage: item.outage,
    }));

    const ring2: Ring2Item[] = [];
    const edgesR2: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

    if (hasRing2) {
      // Group services by namespace; deduplicate (service, namespace) pairs.
      const svcByNs = new Map<string, Set<string>>();
      for (const svc of downstream) {
        if (!svc.service || !svc.namespace) continue;
        if (!svcByNs.has(svc.namespace)) svcByNs.set(svc.namespace, new Set());
        svcByNs.get(svc.namespace)!.add(svc.service);
      }

      // For each namespace, find centroid angle of its ring1 members and
      // distribute its services in a small arc on ring 2 around that centroid.
      // When a namespace has no ring1 member (shouldn't happen but defensive),
      // fall back to an evenly-distributed slot.
      const namespaces = Array.from(svcByNs.keys());
      namespaces.forEach((ns, nsIdx) => {
        const services = Array.from(svcByNs.get(ns)!);
        const anglesForNs = ring1Angles.filter((a) => a.namespace === ns).map((a) => a.angle);

        let centroidAngle: number;
        if (anglesForNs.length) {
          // Circular mean — avoids the wraparound bug when angles straddle 0/2π.
          const sinSum = anglesForNs.reduce((s, a) => s + Math.sin(a), 0);
          const cosSum = anglesForNs.reduce((s, a) => s + Math.cos(a), 0);
          centroidAngle = Math.atan2(sinSum, cosSum);
        } else {
          centroidAngle = startAngle + (nsIdx / Math.max(1, namespaces.length - 1)) * sweep + Math.PI / 2;
        }

        // Arc width scales with service count but caps at 40° so a service-heavy
        // namespace doesn't swallow the whole ring.
        const arcSpan = Math.min((Math.PI / 180) * 40, Math.max((Math.PI / 180) * 6, services.length * 0.06));
        const arcStart = centroidAngle - arcSpan / 2;
        const step = services.length > 1 ? arcSpan / (services.length - 1) : 0;

        services.forEach((svc, sIdx) => {
          const angle = services.length > 1 ? arcStart + sIdx * step : centroidAngle;
          const pos = polarToXY(cx, cy, ring2Radius, angle);
          ring2.push({
            ...pos,
            r: 5,
            label: svc,
            namespace: ns,
            angle,
            details: [`Namespace: ${ns}`, "User-facing service (APM)"],
          });
        });
      });

      // Faint connector: each ring1 deployment → its namespace's service cluster
      // centroid on ring 2. Keeps edge count low and visually ties the two rings
      // together without fan-out clutter.
      const ring2CentroidByNs = new Map<string, { x: number; y: number }>();
      for (const ns of namespaces) {
        const items = ring2.filter((r) => r.namespace === ns);
        if (!items.length) continue;
        const sumX = items.reduce((s, it) => s + it.x, 0);
        const sumY = items.reduce((s, it) => s + it.y, 0);
        ring2CentroidByNs.set(ns, { x: sumX / items.length, y: sumY / items.length });
      }
      for (const item of ring1) {
        const centroid = item.namespace ? ring2CentroidByNs.get(item.namespace) : undefined;
        if (!centroid) continue;
        edgesR2.push({ x1: item.x, y1: item.y, x2: centroid.x, y2: centroid.y });
      }
    }

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
    const arcR = outerRadius + 20;

    const arcStart = polarToXY(cx, cy, arcR, (arcStartAngle * Math.PI) / 180);
    const arcEnd = polarToXY(cx, cy, arcR, (arcEndAngle * Math.PI) / 180);
    const large = arcSweepDeg > 180 ? 1 : 0;
    const safeArcPath = `M ${arcStart.x.toFixed(1)} ${arcStart.y.toFixed(1)} A ${arcR} ${arcR} 0 ${large} 1 ${arcEnd.x.toFixed(1)} ${arcEnd.y.toFixed(1)}`;

    return {
      svgW,
      svgH,
      cx,
      cy,
      ring1Radius,
      ring2Radius,
      hasRing2,
      ring1,
      ring2,
      edgesR1,
      edgesR2,
      safeArcPath,
      safeFrac,
      arcR,
      downstreamCount: downstream.length,
    };
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

  const headerNode = (data?.node ?? "").trim();
  // Investigation actions move into the header as slim buttons so they
  // don't eat ~80px of vertical space on the body. Same pattern adopted
  // by apm-service-dependencies for the same graph-first layout reason.
  const headerActions = data?.investigation_actions?.length ? (
    <span className="blast-header-actions-inline">
      {data.investigation_actions.map((a, i) => (
        <button
          key={i}
          type="button"
          className="blast-header-action-btn"
          onClick={() => onSend(a.prompt)}
          title={a.prompt}
        >
          {a.label} <span aria-hidden="true">↗</span>
        </button>
      ))}
    </span>
  ) : null;
  const Header = (
    <header className="ds-header">
      <AppGlyph size={20} />
      <h1 className="ds-header-title">Blast radius</h1>
      <div className="ds-header-actions">
        {inspected.length > 0 && (
          <QueryPill onClear={() => setInspected([])} label="Clear all comparisons">
            comparing: {inspected.length}
          </QueryPill>
        )}
        {headerNode && <QueryPill>node: {headerNode}</QueryPill>}
        {data && (
          <SeverityChip
            severity={statusSeverity(data.status)}
            label={statusStyle(data.status).label}
          />
        )}
        {headerActions}
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
        <div className="blast-empty">
          <div className="blast-empty-title">Error</div>
          <div className="blast-empty-sub">{error.message}</div>
        </div>
      </div>
    );
  }
  if (!isConnected || !data) {
    return (
      <div className="ds-view">
        {Header}
        <div className="blast-empty">
          <div className="blast-empty-title">Waiting for blast-radius data…</div>
          <div className="blast-empty-sub">Call the k8s-blast-radius tool with a node name.</div>
        </div>
      </div>
    );
  }

  if (!layout) return null;

  const { svgW, svgH, cx, cy, ring1, ring2, edgesR1, edgesR2, safeArcPath, hasRing2, ring2Radius, arcR, downstreamCount } = layout;
  const status = statusStyle(data.status);
  const resched = data.rescheduling;
  const reschedFeasible = resched.feasible;
  const reschedColor =
    reschedFeasible === true ? theme.greenSoft : reschedFeasible === false ? theme.redSoft : theme.textMuted;

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
      <div className="blast-graph">
        <svg
          ref={svgRef}
          viewBox={
            viewBox
              ? `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`
              : `0 0 ${svgW} ${svgH}`
          }
          preserveAspectRatio="xMidYMid meet"
          style={{
            display: "block",
            width: "100%",
            height: "100%",
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
            /* Empty-space click was clearing the single pin in the previous
             * iteration. With the multi-select compare strip, clearing all
             * on an empty click would be surprising — the strip persists
             * until the user closes cards explicitly or uses the header
             * "comparing: N" pill. */
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

          {/* Ring 1 guide */}
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

          {/* Ring 2 guide (downstream services) */}
          {hasRing2 && (
            <circle
              cx={cx}
              cy={cy}
              r={ring2Radius}
              fill="none"
              stroke={theme.blue}
              strokeWidth={1}
              strokeDasharray="2 6"
              opacity={0.25}
            />
          )}

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
            x={cx + arcR + 20}
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
            x={cx + arcR + 20}
            y={cy + 10}
            textAnchor="middle"
            fill={theme.greenSoft}
            fontSize={10}
            fontFamily="'JetBrains Mono', monospace"
          >
            {data.unaffected_count} unaffected
          </text>

          {/* Ring 1 edges (center → affected deployment) */}
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

          {/* Ring 2 edges (affected deployment → namespace service cluster) */}
          {hasRing2 && edgesR2.map((edge, i) => (
            <line
              key={`r2-${i}`}
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              stroke={theme.blue}
              strokeWidth={1}
              strokeDasharray="2 4"
              opacity={0.3}
            />
          ))}

          {/* Ring 2 nodes (downstream services) */}
          {hasRing2 && ring2.map((item, i) => {
            // Label angle: rotate so labels read outward-radially around the
            // circle. Keep labels upright on the bottom half by flipping >90°.
            const deg = (item.angle * 180) / Math.PI;
            const normDeg = ((deg % 360) + 360) % 360;
            const labelOffset = 10;
            const labelPos = polarToXY(cx, cy, ring2Radius + labelOffset, item.angle);
            const textAnchor = normDeg > 90 && normDeg < 270 ? "end" : "start";
            return (
              <g
                key={`r2n-${i}`}
                onMouseMove={(e) => handleHover(e, item.label, item.details)}
                onMouseLeave={clearHover}
                onClick={(e) => {
                  e.stopPropagation();
                  if (inspectedNames.has(item.label) || canInspectMore) {
                    toggleInspect(item.label, item.details);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <circle
                  cx={item.x}
                  cy={item.y}
                  r={item.r}
                  fill={`${theme.blue}30`}
                  stroke={theme.blue}
                  strokeWidth={1.5}
                />
                <text
                  x={labelPos.x}
                  y={labelPos.y + 3}
                  textAnchor={textAnchor}
                  fill={theme.blue}
                  fontSize={8}
                  fontFamily="'JetBrains Mono', monospace"
                  opacity={0.9}
                >
                  {truncate(item.label, 14)}
                </text>
              </g>
            );
          })}

          {/* Ring 1 nodes */}
          {ring1.map((item, i) => (
            <g
              key={i}
              onMouseMove={(e) => handleHover(e, item.label, item.details)}
              onMouseLeave={clearHover}
              onClick={(e) => {
                e.stopPropagation();
                if (inspectedNames.has(item.label) || canInspectMore) {
                  toggleInspect(item.label, item.details);
                }
              }}
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

        {/* Floating summary card — top-left of the radial graph */}
        <div className="blast-summary-card">
          <div className="blast-summary-card-title">Blast radius summary</div>
          <SummaryRow color={theme.redSoft}   value={data.full_outage.length}   label="deployments" sub="full outage" />
          <SummaryRow color={theme.amber}     value={data.degraded.length}      label="deployments" sub="degraded" />
          <SummaryRow color={theme.greenSoft} value={data.unaffected_count}     label="deployments" sub="unaffected" />
          <div className="blast-summary-card-divider" />
          <SummaryRow color={theme.redSoft}   value={data.pods_at_risk}         label="pods at risk" />
          {hasRing2 && (
            <SummaryRow color={theme.blue}    value={downstreamCount}           label="downstream services" sub="user-facing" />
          )}
          <div className="blast-summary-card-foot">
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

        {/* Inspect strip overlays the bottom of the graph instead of
         *  pushing the layout. Same pattern as apm-service-dependencies. */}
        {inspected.length > 0 && (
          <div className="blast-inspect-strip" role="region" aria-label="Compare panel">
            {inspected.map((item) => (
              <div key={item.name} className="blast-inspect-card">
                <div className="blast-inspect-card-head">
                  <span className="blast-inspect-card-name" title={item.name}>{item.name}</span>
                  <button
                    type="button"
                    className="blast-inspect-card-close"
                    aria-label={`Remove ${item.name} from compare`}
                    onClick={() => toggleInspect(item.name, item.details)}
                  >
                    ×
                  </button>
                </div>
                <div className="blast-inspect-card-body">
                  {item.details.map((d, i) => (
                    <div key={i}>{d}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Rescheduling capacity line as an unobtrusive overlay along
         *  the bottom — was a separate row eating ~40px below. */}
        <div className="blast-meta-overlay">
          <span className="mono">
            {resched.memory_required} required / {resched.memory_available} available across{" "}
            {resched.remaining_nodes} node{resched.remaining_nodes === 1 ? "" : "s"}
          </span>
          {data.downstream_services_note && (
            <span className="blast-meta-note">{data.downstream_services_note}</span>
          )}
        </div>
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

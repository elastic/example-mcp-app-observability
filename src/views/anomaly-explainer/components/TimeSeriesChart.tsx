/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * SVG line chart for the detail-mode anomaly. Plots an actual series and an
 * optional typical baseline. Restyled with design tokens so light/dark inherit
 * automatically.
 */

import React from "react";
import type { TimePoint } from "../types";

const W = 560;
const H = 160;
const PAD_L = 40;
const PAD_R = 10;
const PAD_T = 14;
const PAD_B = 20;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

function toMs(t: string | number): number {
  return typeof t === "number" ? t : new Date(t).getTime();
}

function fmtTime(t: string | number): string {
  const d = new Date(typeof t === "number" ? t : t);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function TimeSeriesChart({
  points,
  actualLabel = "actual",
  typicalLabel = "typical",
  yFormat,
}: {
  points: TimePoint[];
  actualLabel?: string;
  typicalLabel?: string;
  yFormat?: (v: number) => string;
}) {
  const fmtY = yFormat ?? ((v: number) => v.toFixed(1));
  if (points.length < 2) return null;

  const sorted = [...points].sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));
  const tMin = toMs(sorted[0].timestamp);
  const tMax = toMs(sorted[sorted.length - 1].timestamp);
  const tRange = tMax - tMin || 1;

  const allY = sorted.flatMap((p) => [p.value, p.typical ?? p.value]);
  const yMax = Math.max(...allY) * 1.1;
  const yMin = Math.min(0, Math.min(...allY) * 0.95);
  const yRange = yMax - yMin || 1;

  const xOf = (t: string | number) => PAD_L + ((toMs(t) - tMin) / tRange) * PLOT_W;
  const yOf = (v: number) => PAD_T + PLOT_H - ((v - yMin) / yRange) * PLOT_H;

  const actualPath = sorted
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.timestamp)} ${yOf(p.value)}`)
    .join(" ");
  const hasTypical = sorted.every((p) => p.typical !== undefined);
  const typicalPath = hasTypical
    ? sorted
        .map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.timestamp)} ${yOf(p.typical!)}`)
        .join(" ")
    : null;

  // Y axis ticks: 4 evenly spaced values
  const yTicks = Array.from({ length: 4 }, (_, i) => yMin + ((yMax - yMin) * i) / 3);

  return (
    <div className="anom-chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet">
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yOf(t)}
              y2={yOf(t)}
              stroke="var(--border-subtle)"
              strokeWidth={1}
              strokeDasharray="2 4"
            />
            <text
              x={PAD_L - 6}
              y={yOf(t) + 3}
              textAnchor="end"
              fontSize={9}
              fontFamily="var(--font-mono)"
              fill="var(--text-muted)"
            >
              {fmtY(t)}
            </text>
          </g>
        ))}
        <text
          x={PAD_L}
          y={H - 4}
          fontSize={9}
          fontFamily="var(--font-mono)"
          fill="var(--text-muted)"
        >
          {fmtTime(sorted[0].timestamp)}
        </text>
        <text
          x={W - PAD_R}
          y={H - 4}
          textAnchor="end"
          fontSize={9}
          fontFamily="var(--font-mono)"
          fill="var(--text-muted)"
        >
          {fmtTime(sorted[sorted.length - 1].timestamp)}
        </text>
        {typicalPath && (
          <path
            d={typicalPath}
            fill="none"
            stroke="var(--text-muted)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
        )}
        <path d={actualPath} fill="none" stroke="var(--severity-critical)" strokeWidth={2} />
        {sorted.map((p, i) => (
          <circle
            key={i}
            cx={xOf(p.timestamp)}
            cy={yOf(p.value)}
            r={2.5}
            fill="var(--severity-critical)"
          />
        ))}
      </svg>
      <div className="anom-chart-legend">
        <span>
          <span
            className="anom-chart-legend-swatch"
            style={{ background: "var(--severity-critical)" }}
          />
          {actualLabel}
        </span>
        {typicalPath && (
          <span>
            <span className="anom-chart-legend-swatch anom-chart-legend-swatch-dashed" />
            {typicalLabel}
          </span>
        )}
      </div>
    </div>
  );
}

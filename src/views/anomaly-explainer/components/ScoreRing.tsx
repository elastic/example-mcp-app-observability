/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * 0-100 score gauge for a single anomaly. The arc length encodes the score and
 * the stroke color encodes the severity bucket. Renders the numeric score in
 * the center.
 */

import React from "react";
import type { AnomalySeverity } from "../types";

export function ScoreRing({
  score,
  severity,
  size = 96,
  thickness = 8,
}: {
  score: number;
  severity: AnomalySeverity;
  size?: number;
  thickness?: number;
}) {
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, score));
  const arcLen = (clamped / 100) * circumference;

  // Use the canonical severity stroke color (chart marks, not text). Chip
  // text elsewhere uses --severity-*-text for AA contrast; the ring stroke
  // is a graphical mark so the canonical color is correct.
  const stroke = `var(--severity-${severity})`;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Anomaly score ${score.toFixed(1)} of 100, severity ${severity}`}
    >
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="var(--border-subtle)"
        strokeWidth={thickness}
      />
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={stroke}
        strokeWidth={thickness}
        strokeDasharray={`${arcLen} ${circumference}`}
        strokeDashoffset={0}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
      />
      <text
        x={cx}
        y={cy + size * 0.08}
        textAnchor="middle"
        className="anom-score-value"
        fontSize={size * 0.32}
      >
        {Math.round(score)}
      </text>
      <text
        x={cx}
        y={cy + size * 0.30}
        textAnchor="middle"
        className="anom-score-suffix"
        fontSize={size * 0.10}
      >
        / 100
      </text>
    </svg>
  );
}

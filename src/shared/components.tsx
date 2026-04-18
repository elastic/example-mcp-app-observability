/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Shared UI primitives used across all MCP App views. Keeps the four+ views
 * visually consistent so the whole server feels like one product.
 */

import React from "react";
import { theme } from "./theme.js";

// ── Status badge (top-right pill: "critical", "condition met", "live", etc.)

export type BadgeTone = "critical" | "major" | "minor" | "ok" | "info" | "neutral";

// Severity palette is Okabe-Ito-derived: vermillion / orange / sky-blue. Strong hue
// separation and a hot-to-cool ramp that stays distinguishable under all common
// color-vision deficiencies.
const SEV_CRIT = "#D55E00";
const SEV_MAJOR = "#E69F00";
const SEV_MINOR = "#56B4E9";

const badgeColors: Record<BadgeTone, { bg: string; fg: string; border: string }> = {
  critical: { bg: `${SEV_CRIT}20`, fg: SEV_CRIT, border: `${SEV_CRIT}66` },
  major: { bg: `${SEV_MAJOR}20`, fg: SEV_MAJOR, border: `${SEV_MAJOR}66` },
  minor: { bg: `${SEV_MINOR}20`, fg: SEV_MINOR, border: `${SEV_MINOR}66` },
  ok: { bg: `${theme.green}18`, fg: theme.greenSoft, border: `${theme.green}55` },
  info: { bg: `${theme.blue}18`, fg: theme.blue, border: `${theme.blue}55` },
  neutral: { bg: `${theme.borderStrong}`, fg: theme.textMuted, border: theme.border },
};

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  const c = badgeColors[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "3px 9px",
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.border}`,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.2,
        textTransform: "lowercase",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

// ── Stat card: label + big value + sublabel; grid of them in a row

export function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: "critical" | "major" | "ok" | "neutral";
}) {
  const valueColor =
    tone === "critical"
      ? SEV_CRIT
      : tone === "major"
      ? SEV_MAJOR
      : tone === "ok"
      ? theme.greenSoft
      : theme.text;
  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 0,
        background: theme.bgSecondary,
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: theme.textMuted,
          fontWeight: 500,
          marginBottom: 6,
          letterSpacing: 0.2,
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: valueColor,
          lineHeight: 1.15,
          marginBottom: sub ? 2 : 0,
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: theme.textDim }}>{sub}</div>
      )}
    </div>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
      {children}
    </div>
  );
}

// ── Section card: titled panel

export function SectionCard({
  title,
  tone,
  children,
}: {
  title?: React.ReactNode;
  tone?: BadgeTone;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: theme.bgSecondary,
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        padding: 14,
        marginBottom: 12,
      }}
    >
      {title && (
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: tone ? badgeColors[tone].fg : theme.text,
            marginBottom: 10,
            letterSpacing: 0.2,
          }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Investigation actions: click-to-send-prompt button row

export interface InvestigationAction {
  label: string;
  prompt: string;
}

export function InvestigationActions({
  actions,
  onSend,
  title = "Investigation actions",
}: {
  actions?: InvestigationAction[];
  onSend: (prompt: string) => void;
  title?: string;
}) {
  if (!actions?.length) return null;
  return (
    <SectionCard title={title}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {actions.map((a, i) => (
          <button
            key={i}
            onClick={() => onSend(a.prompt)}
            style={{
              background: theme.bgTertiary,
              color: theme.text,
              border: `1px solid ${theme.border}`,
              borderRadius: 6,
              padding: "7px 12px",
              fontSize: 12,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = theme.border;
              e.currentTarget.style.borderColor = theme.borderStrong;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = theme.bgTertiary;
              e.currentTarget.style.borderColor = theme.border;
            }}
          >
            <span>{a.label}</span>
            <span style={{ color: theme.textDim, fontSize: 10 }}>↗</span>
          </button>
        ))}
      </div>
    </SectionCard>
  );
}

// ── Time-range / context header (shared top-of-view block).
//
// Consistent across all tool views so users always know where to look for
// "when am I looking at?" and "how do I change that window?". Structure:
//
//   Title                                                [status badge]
//   subtitle (scope: namespace, focal service, node, …)
//   ───────────────────────────────────────────────────────────────
//   Time range  [15m] [1h●] [6h] [24h]
//
// Chip row only renders when `rerunContext` is supplied — tools without a
// user-configurable lookback (k8s-blast-radius, create-alert-rule) still
// use this component so the title/subtitle/status layout stays consistent.
//
// Rerun works by substituting `{lookback}` in the caller-provided
// `prompt_template` and calling `onSend`, which wires into `app.sendMessage`
// so Claude re-invokes the tool with the new window.

export interface RerunContext {
  tool: string;
  current_lookback: string;
  prompt_template: string;
  presets?: string[];
}

const DEFAULT_PRESETS = ["15m", "1h", "6h", "24h"];

export function TimeRangeHeader({
  title,
  subtitle,
  status,
  rerunContext,
  onSend,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  status?: { tone: BadgeTone; label: React.ReactNode };
  rerunContext?: RerunContext;
  onSend?: (prompt: string) => void;
}) {
  const presets = rerunContext?.presets ?? DEFAULT_PRESETS;
  const current = rerunContext?.current_lookback;
  const canRerun = !!(rerunContext && onSend);

  return (
    <div
      style={{
        padding: "12px 16px",
        background: theme.bgSecondary,
        border: `1px solid ${theme.border}`,
        borderRadius: 8,
        marginBottom: 14,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: theme.text,
              marginBottom: subtitle ? 3 : 0,
              wordBreak: "break-word",
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: theme.textMuted,
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
        {status && <StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
      </div>

      {rerunContext && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 12,
            paddingTop: 10,
            borderTop: `1px solid ${theme.border}`,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontSize: 10,
              color: theme.textDim,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontWeight: 600,
            }}
          >
            Time range
          </span>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {presets.map((p) => {
              const active = p === current;
              return (
                <button
                  key={p}
                  disabled={!canRerun || active}
                  onClick={() => {
                    if (!canRerun || active) return;
                    const prompt = rerunContext!.prompt_template.replace(
                      /\{lookback\}/g,
                      p
                    );
                    onSend!(prompt);
                  }}
                  className="mono"
                  style={{
                    background: active ? `${theme.blue}22` : theme.bgTertiary,
                    color: active ? theme.blue : theme.text,
                    border: `1px solid ${active ? `${theme.blue}88` : theme.border}`,
                    borderRadius: 5,
                    padding: "4px 10px",
                    fontSize: 11,
                    fontWeight: active ? 700 : 500,
                    cursor: active || !canRerun ? "default" : "pointer",
                    transition: "all 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (active || !canRerun) return;
                    e.currentTarget.style.background = theme.border;
                    e.currentTarget.style.borderColor = theme.borderStrong;
                  }}
                  onMouseLeave={(e) => {
                    if (active || !canRerun) return;
                    e.currentTarget.style.background = theme.bgTertiary;
                    e.currentTarget.style.borderColor = theme.border;
                  }}
                >
                  {p}
                </button>
              );
            })}
          </div>
          {current && !presets.includes(current) && (
            <span
              className="mono"
              style={{ fontSize: 10, color: theme.textMuted }}
            >
              current: {current}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Comparison bar: two stacked bars (baseline vs actual)

export function ComparisonBar({
  label,
  baselineLabel,
  actualLabel,
  baselineValue,
  actualValue,
  max,
}: {
  label?: string;
  baselineLabel: string;
  actualLabel: string;
  baselineValue: number;
  actualValue: number;
  max?: number;
}) {
  const m = max ?? Math.max(baselineValue, actualValue) * 1.05;
  const basePct = m > 0 ? (baselineValue / m) * 100 : 0;
  const actPct = m > 0 ? (actualValue / m) * 100 : 0;
  const exceeded = actualValue > baselineValue;
  return (
    <div style={{ marginTop: 4 }}>
      {label && (
        <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 6 }}>{label}</div>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: theme.textMuted,
          marginBottom: 6,
        }}
      >
        <span>{baselineLabel}</span>
        <span>{actualLabel}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div
          style={{
            height: 10,
            background: theme.border,
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${basePct}%`,
              height: "100%",
              background: theme.textDim,
              borderRadius: 3,
            }}
          />
        </div>
        <div
          style={{
            height: 10,
            background: theme.border,
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${actPct}%`,
              height: "100%",
              background: exceeded ? theme.redSoft : theme.greenSoft,
              borderRadius: 3,
            }}
          />
        </div>
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 11, color: theme.textMuted }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, background: theme.textDim, borderRadius: 2 }} />
          Typical baseline
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span
            style={{
              width: 10,
              height: 10,
              background: exceeded ? theme.redSoft : theme.greenSoft,
              borderRadius: 2,
            }}
          />
          Actual value
        </span>
      </div>
    </div>
  );
}

// ── Horizontal bar list: list of rows with label + value + inline bar

export function HBarRow({
  label,
  value,
  valueLabel,
  max,
  color,
}: {
  label: string;
  value: number;
  valueLabel?: string;
  max: number;
  color: string;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 0",
        borderBottom: `1px solid ${theme.border}`,
      }}
    >
      <div
        style={{
          flex: "0 0 35%",
          minWidth: 0,
          fontSize: 12,
          color: theme.text,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
      <div className="mono" style={{ flex: "0 0 auto", fontSize: 11, color: theme.text, minWidth: 70, textAlign: "right" }}>
        {valueLabel ?? value}
      </div>
      <div
        style={{
          flex: 1,
          height: 8,
          background: theme.border,
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.min(100, pct)}%`,
            height: "100%",
            background: color,
            borderRadius: 2,
          }}
        />
      </div>
    </div>
  );
}

// ── Key-value row (for tabular detail lists like alert-rule settings)

export function KVRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 14,
        padding: "7px 0",
        borderBottom: `1px solid ${theme.border}`,
        fontSize: 12,
      }}
    >
      <div style={{ flex: "0 0 32%", color: theme.textMuted }}>{label}</div>
      <div className="mono" style={{ flex: 1, color: theme.text, wordBreak: "break-word" }}>
        {value}
      </div>
    </div>
  );
}

// ── Pan/zoom overlay controls — shared across SVG-diagram views ────────────
//
// Usage: pair with `usePanZoom`. Place inside the same `position: relative`
// wrapper as the <svg>. Renders a compact floating panel (bottom-right) with
// zoom-in / zoom-out / reset buttons and a current-zoom readout, plus a faint
// "drag to pan · wheel to zoom" hint in the opposite corner that fades out
// once the user has interacted.

export function ZoomControls({
  currentZoom,
  minZoom,
  maxZoom,
  onZoomIn,
  onZoomOut,
  onReset,
  isDragging,
}: {
  currentZoom: number;
  minZoom: number;
  maxZoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  isDragging: boolean;
}) {
  return (
    <>
      <div
        style={{
          position: "absolute",
          bottom: 10,
          right: 10,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          background: `${theme.bgSecondary}ee`,
          border: `1px solid ${theme.borderStrong}`,
          borderRadius: 6,
          padding: 4,
          backdropFilter: "blur(4px)",
          zIndex: 10,
        }}
      >
        <ZoomButton onClick={onZoomIn} disabled={currentZoom >= maxZoom - 1e-3} label="+" title="Zoom in" />
        <ZoomButton onClick={onZoomOut} disabled={currentZoom <= minZoom + 1e-3} label="−" title="Zoom out" />
        <ZoomButton onClick={onReset} label="⟲" title="Reset view" />
        <div
          style={{
            fontSize: 9,
            color: theme.textDim,
            textAlign: "center",
            fontFamily: "'JetBrains Mono', monospace",
            marginTop: 2,
          }}
        >
          {currentZoom.toFixed(1)}×
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 10,
          left: 10,
          fontSize: 10,
          color: theme.textDim,
          fontFamily: "'JetBrains Mono', monospace",
          pointerEvents: "none",
          opacity: Math.abs(currentZoom - 1) < 0.01 && !isDragging ? 0.6 : 0,
          transition: "opacity 200ms",
          zIndex: 10,
        }}
      >
        drag to pan · wheel to zoom
      </div>
    </>
  );
}

function ZoomButton({
  onClick,
  disabled,
  label,
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: 26,
        height: 26,
        background: "transparent",
        color: disabled ? theme.textDim : theme.text,
        border: `1px solid ${theme.border}`,
        borderRadius: 4,
        cursor: disabled ? "default" : "pointer",
        fontSize: 14,
        fontWeight: 600,
        lineHeight: 1,
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {label}
    </button>
  );
}

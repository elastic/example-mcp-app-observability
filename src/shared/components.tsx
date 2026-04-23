/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Shared UI primitives used across all MCP App views. Keeps the four+ views
 * visually consistent so the whole server feels like one product.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { theme } from "./theme.js";
import {
  BackIcon,
  ChevronDownIcon,
  SearchIcon,
  XIcon,
} from "./icons.js";

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
// user-configurable lookback (k8s-blast-radius, manage-alerts) still
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
  inspect,
}: {
  label: string;
  value: number;
  valueLabel?: string;
  max: number;
  color: string;
  inspect?: { onClick: () => void; title?: string };
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
      {inspect && (
        <button
          onClick={inspect.onClick}
          title={inspect.title ?? "Inspect"}
          aria-label={inspect.title ?? "Inspect"}
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            padding: 0,
            background: "transparent",
            border: "none",
            borderRadius: 3,
            cursor: "pointer",
            color: theme.textMuted,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = theme.text;
            e.currentTarget.style.background = theme.border;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = theme.textMuted;
            e.currentTarget.style.background = "transparent";
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 L14 14" />
          </svg>
        </button>
      )}
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

// ── Density toggle ─────────────────────────────────────────────────────────
//
// Pair: `SectionTitleWithToggle` renders a section title with a trailing "Show
// details" / "Show condensed" pill; `CondensedChips` renders a chip strip that
// collapses a long HBarRow list into one row of label-value pairs. Used when a
// section is useful-by-default but gets long enough to crowd the view — e.g.
// "Top pods by memory", "Related anomalies".
//
// Toggle state lives on the parent so clicking does not re-invoke the tool.

export function SectionTitleWithToggle({
  label,
  detailed,
  onToggle,
}: {
  label: React.ReactNode;
  detailed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span>{label}</span>
      <button
        onClick={onToggle}
        style={{
          background: "transparent",
          color: theme.textMuted,
          border: `1px solid ${theme.border}`,
          borderRadius: 4,
          padding: "2px 8px",
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: 0.2,
          cursor: "pointer",
          textTransform: "none",
        }}
      >
        {detailed ? "Show condensed" : "Show details"}
      </button>
    </div>
  );
}

export interface CondensedChipItem {
  key: string;
  label: string;
  value: string;
  color?: string;
}

export function CondensedChips({ items }: { items: CondensedChipItem[] }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "4px 10px",
        fontSize: 11,
        lineHeight: 1.5,
      }}
    >
      {items.map((it, i) => (
        <span key={it.key} style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ color: theme.text }}>{it.label}</span>
          <span
            className="mono"
            style={{ color: it.color ?? theme.textMuted, fontSize: 10.5 }}
          >
            {it.value}
          </span>
          {i < items.length - 1 ? (
            <span style={{ color: theme.textDim, marginLeft: 4 }}>·</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// W1 design-system primitives.
//
// These compose the `.ds-*` utility layer injected by `applyTheme()` in
// `theme.ts`. They are the building blocks the refreshed views will use
// starting in W3 — the existing legacy components above stay in place while
// views migrate one-by-one.
// ─────────────────────────────────────────────────────────────────────────────

export type Severity = "critical" | "major" | "minor" | "ok";

const SEVERITY_ORDER: Severity[] = ["critical", "major", "minor", "ok"];

/**
 * Dot + label chip. Rounded corner (not pill) — matches the security app's
 * `SeverityChip` shape. Use for list rows and card headers.
 */
export function SeverityChip({
  severity,
  label,
  className,
}: {
  severity: Severity;
  label?: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={`ds-sev-chip ds-sev-chip-${severity}${className ? " " + className : ""}`}>
      <span className="ds-sev-chip-dot" aria-hidden="true" />
      <span>{label ?? severity}</span>
    </span>
  );
}

/**
 * 42×42 donut showing severity breakdown. Segments render in
 * critical → major → minor → ok order so the eye reads highest-severity
 * first. An empty breakdown shows a muted ring.
 */
export function SeverityDonut({
  counts,
  size = 42,
  thickness = 6,
  title,
}: {
  counts: Partial<Record<Severity, number>>;
  size?: number;
  thickness?: number;
  title?: string;
}) {
  const total = SEVERITY_ORDER.reduce((acc, s) => acc + (counts[s] ?? 0), 0);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;

  const segments = useMemo(() => {
    if (total === 0) return [];
    let offset = 0;
    return SEVERITY_ORDER.flatMap((sev) => {
      const v = counts[sev] ?? 0;
      if (v === 0) return [];
      const frac = v / total;
      const len = frac * circumference;
      const seg = { sev, offset, len };
      offset += len;
      return [seg];
    });
  }, [counts, total, circumference]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="var(--border-subtle)"
        strokeWidth={thickness}
      />
      {segments.map((seg) => (
        <circle
          key={seg.sev}
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={`var(--severity-${seg.sev})`}
          strokeWidth={thickness}
          strokeDasharray={`${Math.max(seg.len - 1, 0)} ${circumference}`}
          strokeDashoffset={-seg.offset}
          strokeLinecap="butt"
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      ))}
      <text
        x={cx}
        y={cy + 4}
        textAnchor="middle"
        fontSize={size * 0.32}
        fontFamily="var(--font-mono)"
        fontWeight={500}
        fill="var(--text-primary)"
      >
        {total}
      </text>
    </svg>
  );
}

/**
 * Bare icon button styled via `.ds-btn-icon`. Use for header actions
 * (fullscreen, close) and inline utilities.
 */
export function IconButton({
  children,
  onClick,
  label,
  disabled,
  className,
}: {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`ds-btn-icon${className ? " " + className : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

/**
 * Two-state toggle with `role="switch"`. Controlled.
 */
export function Switch({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: React.ReactNode;
  id?: string;
}) {
  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        onChange(!checked);
      }
    },
    [checked, onChange],
  );
  return (
    <span
      role="switch"
      aria-checked={checked}
      tabIndex={0}
      id={id}
      className="ds-switch"
      onClick={() => onChange(!checked)}
      onKeyDown={handleKey}
    >
      {label ? <span>{label}</span> : null}
      <span className="ds-switch-track" aria-hidden="true">
        <span className="ds-switch-thumb" />
      </span>
    </span>
  );
}

export interface DropdownOption<V extends string = string> {
  value: V;
  label: React.ReactNode;
}

/**
 * Listbox dropdown. Keyboard: Enter/Space to open, ArrowUp/Down to move,
 * Enter to select, Esc to close. Closes on outside click.
 */
export function Dropdown<V extends string = string>({
  value,
  onChange,
  options,
  label,
  triggerPrefix,
  align = "right",
}: {
  value: V;
  onChange: (next: V) => void;
  options: DropdownOption<V>[];
  label: string;
  triggerPrefix?: React.ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  const selectedIdx = options.findIndex((o) => o.value === value);
  const selected = selectedIdx >= 0 ? options[selectedIdx] : options[0];

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  useEffect(() => {
    if (open) setActiveIdx(Math.max(selectedIdx, 0));
  }, [open, selectedIdx]);

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = options[activeIdx];
      if (opt) {
        onChange(opt.value);
        setOpen(false);
      }
    }
  };

  return (
    <div className="ds-dropdown" ref={rootRef}>
      <button
        type="button"
        className="ds-dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
      >
        {triggerPrefix ? <span style={{ color: "var(--text-muted)" }}>{triggerPrefix}</span> : null}
        <span><strong>{selected?.label ?? ""}</strong></span>
        <ChevronDownIcon size={12} />
      </button>
      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={label}
          className="ds-dropdown-menu"
          style={align === "left" ? { right: "auto", left: 0 } : undefined}
          onKeyDown={onMenuKey}
          tabIndex={-1}
        >
          {options.map((opt, i) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={opt.value === value}
              className="ds-dropdown-option"
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => { onChange(opt.value); setOpen(false); }}
              style={i === activeIdx ? { background: "var(--bg-hover)" } : undefined}
            >
              <span>{opt.label}</span>
              {opt.value === value ? <span aria-hidden="true" style={{ color: "var(--accent)" }}>●</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * `Showing N items │ Sort by: … │ Details [switch] │ Group by: …`
 * The uniform toolkit the security app ships on every list view. All
 * controls are optional — the count + noun is always shown.
 */
export function Subheader<S extends string = string, G extends string = string>({
  total,
  itemNoun,
  sort,
  group,
  details,
  leftExtras,
  rightExtras,
}: {
  total: number;
  itemNoun: string;
  sort?: { value: S; onChange: (v: S) => void; options: DropdownOption<S>[] };
  group?: { value: G; onChange: (v: G) => void; options: DropdownOption<G>[] };
  details?: { checked: boolean; onChange: (v: boolean) => void };
  leftExtras?: React.ReactNode;
  rightExtras?: React.ReactNode;
}) {
  return (
    <div className="ds-subheader">
      <div className="ds-subheader-left">
        <span>
          Showing <strong>{total.toLocaleString()}</strong> {itemNoun}
        </span>
        {leftExtras}
      </div>
      <div className="ds-subheader-right">
        {sort ? (
          <Dropdown
            value={sort.value}
            onChange={sort.onChange}
            options={sort.options}
            label="Sort by"
            triggerPrefix="Sort by:"
          />
        ) : null}
        {details ? (
          <Switch checked={details.checked} onChange={details.onChange} label="Details" />
        ) : null}
        {group ? (
          <Dropdown
            value={group.value}
            onChange={group.onChange}
            options={group.options}
            label="Group by"
            triggerPrefix="Group by:"
          />
        ) : null}
        {rightExtras}
      </div>
    </div>
  );
}

/**
 * Label + value grid for the top of a detail pane. Auto-flows into as many
 * columns as fit. `value` falls back to em-dash when null/undefined/empty.
 */
export function FactCol({
  items,
}: {
  items: { label: React.ReactNode; value: React.ReactNode }[];
}) {
  return (
    <div className="ds-fact-col">
      {items.map((it, i) => {
        const empty = it.value === null || it.value === undefined || it.value === "";
        return (
          <div key={i} className="ds-fact-col-item">
            <div className="ds-fact-col-label">{it.label}</div>
            <div className="ds-fact-col-value">{empty ? "—" : it.value}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Collapsible section with a header row (title + optional preview count +
 * chevron). Controlled — parent owns open state so multiple sections can
 * be coordinated.
 */
export function ExpandSection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: React.ReactNode;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="ds-expand">
      <button
        type="button"
        className="ds-expand-trigger"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>{title}</span>
        {typeof count === "number" ? (
          <span className="ds-expand-count">{count}</span>
        ) : null}
        <ChevronDownIcon size={14} />
      </button>
      {open ? <div className="ds-expand-body">{children}</div> : null}
    </div>
  );
}

/**
 * Filter chip showing the active query / scope value. Click × to clear.
 */
export function QueryPill({
  children,
  onClear,
  label = "Clear filter",
}: {
  children: React.ReactNode;
  onClear?: () => void;
  label?: string;
}) {
  return (
    <span className="ds-query-pill">
      <span>{children}</span>
      {onClear ? (
        <button type="button" aria-label={label} onClick={onClear}>
          <XIcon size={12} />
        </button>
      ) : null}
    </span>
  );
}

/**
 * List → detail split. Renders children as the list; when `detail` is
 * supplied, the list narrows and the detail pane slides in.
 */
export function ListDetailLayout({
  children,
  detail,
}: {
  children: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    <div className="ds-list-detail">
      <div className={`ds-list-detail-list${detail ? " narrow" : ""}`}>{children}</div>
      {detail ? <div className="ds-list-detail-pane">{detail}</div> : null}
    </div>
  );
}

/**
 * Detail-pane header with "← Back to list" + optional close X + actions slot.
 * Use inside a `<ListDetailLayout detail={...}>`.
 */
export function DetailPaneHeader({
  onBack,
  onClose,
  title,
  actions,
}: {
  onBack?: () => void;
  onClose?: () => void;
  title?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="ds-list-detail-pane-header">
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {onBack ? (
          <button type="button" className="ds-back-btn" onClick={onBack}>
            <BackIcon size={14} /> Back to list
          </button>
        ) : null}
        {title ? (
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {title}
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {actions}
        {onClose ? (
          <IconButton label="Close detail" onClick={onClose}>
            <XIcon size={14} />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Controlled search input with the shared `.ds-search` shell. Includes a
 * magnifier icon and optional clear button when the value is non-empty.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search",
  onSubmit,
  onClear,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onSubmit?: () => void;
  onClear?: () => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="ds-search">
      <SearchIcon size={14} />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onSubmit) onSubmit();
          if (e.key === "Escape") {
            if (value) onChange("");
            onClear?.();
          }
        }}
      />
      {value ? (
        <IconButton label="Clear search" onClick={() => { onChange(""); onClear?.(); }}>
          <XIcon size={12} />
        </IconButton>
      ) : null}
    </label>
  );
}

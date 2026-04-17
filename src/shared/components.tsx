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

const badgeColors: Record<BadgeTone, { bg: string; fg: string; border: string }> = {
  critical: { bg: `${theme.red}20`, fg: theme.redSoft, border: `${theme.red}55` },
  major: { bg: `${theme.orange}20`, fg: theme.orange, border: `${theme.orange}55` },
  minor: { bg: `${theme.amber}20`, fg: theme.amber, border: `${theme.amber}55` },
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
      ? theme.redSoft
      : tone === "major"
      ? theme.orange
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

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from "react";
import type { RuleSummary, RuleHealth } from "../types";
import { ruleHealth, ruleStripeClass } from "../derive";
import { SeverityChip } from "@shared/components";

export function RuleCard({
  rule,
  selected,
  detailed,
  onClick,
}: {
  rule: RuleSummary;
  selected: boolean;
  detailed: boolean;
  onClick: () => void;
}) {
  const health: RuleHealth = ruleHealth(rule);
  const stripe = ruleStripeClass(health);

  return (
    <button
      type="button"
      className={`rule-card ${stripe}${selected ? " selected" : ""}`}
      onClick={onClick}
      aria-pressed={selected}
    >
      <div className="rule-card-head">
        <div className="rule-card-name-col">
          <div className="rule-card-name">{rule.name}</div>
          <div className="rule-card-meta">
            <span className="rule-card-type-pill">{shortType(rule.rule_type_id)}</span>
            <span className="rule-card-id mono">#{rule.id}</span>
            {typeof rule.active_alert_count === "number" && rule.active_alert_count > 0 ? (
              <span className="rule-card-alerts-pill">
                {rule.active_alert_count} active
              </span>
            ) : null}
          </div>
        </div>
        <div className="rule-card-chips">
          {health === "error" ? (
            <SeverityChip severity="critical" label="error" />
          ) : null}
          <span className={`rule-enabled-tag rule-enabled-${rule.enabled ? "yes" : "no"}`}>
            {rule.enabled ? "enabled" : "disabled"}
          </span>
        </div>
      </div>

      {detailed ? (
        <div className="ds-fact-box rule-facts">
          {rule.condition ? <FactRow label="CONDITION" value={rule.condition} mono /> : null}
          {rule.schedule_interval ? (
            <FactRow label="INTERVAL" value={`every ${rule.schedule_interval}`} />
          ) : null}
          {rule.window ? <FactRow label="WINDOW" value={rule.window} /> : null}
          {rule.index_pattern ? <FactRow label="INDEX" value={rule.index_pattern} mono /> : null}
          {rule.tags?.length ? (
            <div className="ds-fact-row">
              <span className="ds-fact-label">TAGS</span>
              <span className="ds-fact-value" style={{ display: "flex", gap: 6, flexWrap: "wrap", whiteSpace: "normal" }}>
                {rule.tags.map((t) => (
                  <span key={t} className="rule-tag">
                    {t}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

function FactRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  // title attr surfaces the full value on hover when ellipsis truncates
  // it. Only set for string values where the lossy native tooltip helps.
  const hoverTitle = typeof value === "string" ? value : undefined;
  return (
    <div className="ds-fact-row">
      <span className="ds-fact-label">{label}</span>
      <span
        className={`ds-fact-value${mono ? " mono" : ""}`}
        title={hoverTitle}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Collapse the Kibana dotted rule-type id into a short pill label.
 * `.esql-query` → `ES|QL`, `.threshold` → `threshold`, etc.
 */
function shortType(ruleTypeId: string): string {
  if (!ruleTypeId) return "rule";
  const tail = ruleTypeId.startsWith(".") ? ruleTypeId.slice(1) : ruleTypeId;
  const map: Record<string, string> = {
    "esql-query": "ES|QL",
    "threshold": "threshold",
  };
  const last = tail.split(".").pop() ?? tail;
  return map[last] ?? last;
}

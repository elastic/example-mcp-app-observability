/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Pure, testable helpers that derive UI state from the raw rule list.
 * Keeping these out of App.tsx makes it easier to unit-test later and keeps
 * the component file focused on layout.
 */

import type { GroupKey, RuleHealth, RuleSummary, SortKey, StatusTab } from "./types";

const ERROR_OUTCOMES = new Set(["failed", "error"]);

export function ruleHealth(rule: RuleSummary): RuleHealth {
  if (!rule.enabled) return "disabled";
  const last = (rule.last_run_outcome ?? rule.execution_status ?? "").toLowerCase();
  if (ERROR_OUTCOMES.has(last)) return "error";
  if ((rule.active_alert_count ?? 0) > 0) return "alerting";
  return "ok";
}

export function ruleStripeClass(health: RuleHealth): string {
  switch (health) {
    case "error":     return "ds-stripe-critical";
    case "alerting":  return "ds-stripe-major";
    case "disabled":  return ""; // no stripe — neutral
    default:          return "ds-stripe-ok";
  }
}

export function statusTabCounts(rules: RuleSummary[]): Record<StatusTab, number> {
  let enabled = 0, disabled = 0, errors = 0;
  for (const r of rules) {
    if (r.enabled) enabled++;
    else disabled++;
    if (ruleHealth(r) === "error") errors++;
  }
  return { all: rules.length, enabled, disabled, errors };
}

export function applyStatusTab(rules: RuleSummary[], tab: StatusTab): RuleSummary[] {
  if (tab === "all") return rules;
  if (tab === "enabled") return rules.filter((r) => r.enabled);
  if (tab === "disabled") return rules.filter((r) => !r.enabled);
  return rules.filter((r) => ruleHealth(r) === "error");
}

export function applySearch(rules: RuleSummary[], q: string): RuleSummary[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rules;
  return rules.filter((r) => {
    if (r.name.toLowerCase().includes(needle)) return true;
    if (r.id.toLowerCase().includes(needle)) return true;
    if (r.index_pattern?.toLowerCase().includes(needle)) return true;
    if (r.rule_type_id.toLowerCase().includes(needle)) return true;
    if (r.tags?.some((t) => t.toLowerCase().includes(needle))) return true;
    if (r.kql_filter?.toLowerCase().includes(needle)) return true;
    return false;
  });
}

export function applySort(rules: RuleSummary[], sort: SortKey): RuleSummary[] {
  const arr = [...rules];
  switch (sort) {
    case "name":
      arr.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "updated":
      arr.sort((a, b) => tsOf(b.updated_at) - tsOf(a.updated_at));
      break;
    case "enabled-first":
      arr.sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      break;
    case "attention":
    default:
      // error → alerting → rest; within a bucket, more alerts first, then name.
      arr.sort((a, b) => {
        const rank = (r: RuleSummary) => {
          const h = ruleHealth(r);
          if (h === "error") return 0;
          if (h === "alerting") return 1;
          if (h === "ok") return 2;
          return 3; // disabled
        };
        const dr = rank(a) - rank(b);
        if (dr !== 0) return dr;
        const da = (b.active_alert_count ?? 0) - (a.active_alert_count ?? 0);
        if (da !== 0) return da;
        return a.name.localeCompare(b.name);
      });
  }
  return arr;
}

function tsOf(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Group rules into ordered buckets for the Group-by dropdown. Each bucket has
 * a stable key, a human label, and its member rules in the order they arrived
 * (callers are expected to have sorted them first).
 */
export function applyGroup(
  rules: RuleSummary[],
  group: GroupKey,
): { key: string; label: string; rules: RuleSummary[] }[] {
  if (group === "none") return [{ key: "all", label: "", rules }];

  const buckets = new Map<string, { label: string; rules: RuleSummary[] }>();
  const push = (key: string, label: string, r: RuleSummary) => {
    const b = buckets.get(key) ?? { label, rules: [] };
    b.rules.push(r);
    buckets.set(key, b);
  };

  for (const r of rules) {
    if (group === "rule-type") {
      push(r.rule_type_id || "unknown", r.rule_type_id || "unknown", r);
    } else if (group === "status") {
      const h = ruleHealth(r);
      const label = h === "error" ? "Error" : h === "alerting" ? "Alerting" : h === "disabled" ? "Disabled" : "Healthy";
      push(h, label, r);
    } else if (group === "index") {
      const k = r.index_pattern || "(no index)";
      push(k, k, r);
    } else if (group === "tag") {
      if (!r.tags || r.tags.length === 0) {
        push("__untagged__", "Untagged", r);
      } else {
        for (const t of r.tags) push(t, t, r);
      }
    }
  }

  const order = group === "status"
    ? ["error", "alerting", "ok", "disabled"]
    : [...buckets.keys()].sort((a, b) => {
        if (a === "__untagged__") return 1;
        if (b === "__untagged__") return -1;
        return a.localeCompare(b);
      });

  const out: { key: string; label: string; rules: RuleSummary[] }[] = [];
  for (const k of order) {
    const b = buckets.get(k);
    if (b) out.push({ key: k, label: b.label, rules: b.rules });
  }
  return out;
}

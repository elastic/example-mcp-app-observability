/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useState } from "react";
import { ExpandSection, FactCol, SeverityChip } from "@shared/components";
import { timeAgo } from "@shared/theme";
import type { RuleSummary } from "../types";
import { ruleHealth } from "../derive";

/**
 * Detail-pane body for a single rule. Rendered either inline in the list→detail
 * layout or full-width for the get/create/delete operations.
 */
export function RuleDetailView({
  rule,
  onDelete,
  eyebrow,
}: {
  rule: RuleSummary;
  onDelete?: () => void;
  eyebrow?: React.ReactNode;
}) {
  const [openCondition, setOpenCondition] = useState(true);
  const [openFilter, setOpenFilter] = useState(true);
  const [openTags, setOpenTags] = useState(false);
  const [openHistory, setOpenHistory] = useState(false);

  const health = ruleHealth(rule);
  const lastRunLabel = rule.last_run_outcome ?? rule.execution_status ?? null;

  const facts: { label: string; value: React.ReactNode }[] = [
    { label: "Type", value: rule.rule_type_id },
    {
      label: "Status",
      value: rule.enabled ? (
        <SeverityChip severity="ok" label="enabled" />
      ) : (
        <SeverityChip severity="minor" label="disabled" />
      ),
    },
    { label: "Interval", value: rule.schedule_interval ? `every ${rule.schedule_interval}` : null },
    { label: "Window", value: rule.window },
    { label: "Active alerts", value: rule.active_alert_count ?? null },
    { label: "Updated", value: rule.updated_at ? timeAgo(rule.updated_at) : null },
  ];

  return (
    <div className="rule-detail">
      {eyebrow ? <div className="rule-detail-eyebrow">{eyebrow}</div> : null}
      <div className="rule-detail-title-row">
        <h2 className="rule-detail-title">{rule.name}</h2>
        <div className="rule-detail-chips">
          {health === "error" ? (
            <SeverityChip severity="critical" label="error" />
          ) : null}
          {lastRunLabel ? (
            <span className="rule-detail-outcome mono">last run: {lastRunLabel}</span>
          ) : null}
        </div>
      </div>
      <div className="rule-detail-id mono">#{rule.id}</div>

      <FactCol items={facts} />

      {rule.condition ? (
        <ExpandSection
          title="Condition"
          open={openCondition}
          onToggle={() => setOpenCondition((v) => !v)}
        >
          <pre className="rule-detail-code">{rule.condition}</pre>
        </ExpandSection>
      ) : null}

      {rule.kql_filter ? (
        <ExpandSection
          title="KQL filter"
          open={openFilter}
          onToggle={() => setOpenFilter((v) => !v)}
        >
          <pre className="rule-detail-code">{rule.kql_filter}</pre>
        </ExpandSection>
      ) : null}

      {rule.tags?.length ? (
        <ExpandSection
          title="Tags"
          count={rule.tags.length}
          open={openTags}
          onToggle={() => setOpenTags((v) => !v)}
        >
          <div className="rule-detail-tags">
            {rule.tags.map((t) => (
              <span key={t} className="rule-tag">{t}</span>
            ))}
          </div>
        </ExpandSection>
      ) : null}

      {(rule.created_at || rule.updated_at) ? (
        <ExpandSection
          title="History"
          open={openHistory}
          onToggle={() => setOpenHistory((v) => !v)}
        >
          <div className="rule-detail-history">
            {rule.created_at ? (
              <div>
                <span className="rule-detail-history-label">Created</span>{" "}
                <span className="mono">{new Date(rule.created_at).toLocaleString()}</span>
              </div>
            ) : null}
            {rule.updated_at ? (
              <div>
                <span className="rule-detail-history-label">Updated</span>{" "}
                <span className="mono">{new Date(rule.updated_at).toLocaleString()} ({timeAgo(rule.updated_at)})</span>
              </div>
            ) : null}
          </div>
        </ExpandSection>
      ) : null}

      {onDelete ? (
        <div className="rule-detail-actions">
          <button
            type="button"
            className="rule-action rule-action-danger"
            onClick={onDelete}
          >
            Delete alert rule
          </button>
        </div>
      ) : null}
    </div>
  );
}

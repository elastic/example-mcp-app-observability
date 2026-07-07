/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useState } from "react";
import { ExpandSection, FactCol, SeverityChip } from "@shared/components";
import { timeAgo } from "@shared/theme";
import type { RuleSummary, AlertInstance } from "../types";
import { ruleHealth } from "../derive";

/**
 * Detail-pane body for a single rule. Rendered either inline in the list→detail
 * layout or full-width for the get/create/delete operations.
 */
export function RuleDetailView({
  rule,
  onDelete,
  eyebrow,
  onOpenLink,
}: {
  rule: RuleSummary;
  onDelete?: () => void;
  eyebrow?: React.ReactNode;
  onOpenLink?: (url: string) => void;
}) {
  const [openCondition, setOpenCondition] = useState(true);
  const [openFilter, setOpenFilter] = useState(true);
  const [openTags, setOpenTags] = useState(false);
  const [openHistory, setOpenHistory] = useState(false);
  const [openMeta, setOpenMeta] = useState(true);
  const [openRawParams, setOpenRawParams] = useState(false);

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
        <h2 className="rule-detail-title">
          {rule.name}
          {rule.kibana_url && onOpenLink && (
            <button
              type="button"
              onClick={() => onOpenLink(rule.kibana_url!)}
              style={{
                background: "rgba(0,153,255,0.08)",
                border: "1px solid #09f",
                borderRadius: 3,
                cursor: "pointer",
                padding: "1px 6px",
                fontSize: 11,
                lineHeight: "16px",
                color: "#09f",
                marginLeft: 8,
                verticalAlign: "middle",
              }}
              title="View rule in Kibana"
            >{"↗"}</button>
          )}
        </h2>
        <div className="rule-detail-chips">
          {health === "error" ? (
            <SeverityChip severity="critical" label="error" />
          ) : null}
          {lastRunLabel ? (
            <span className="rule-detail-outcome mono">last run: {lastRunLabel}</span>
          ) : null}
        </div>
      </div>
      {rule.description ? (
        <div className="rule-detail-description">{rule.description}</div>
      ) : null}

      <FactCol items={facts} />

      {rule.active_alerts?.some((a) => a.reason) ? (
        <div className="rule-detail-alert-reasons">
          <div className="rule-detail-history-label" style={{ marginBottom: 6 }}>Alert reason</div>
          {rule.active_alerts
            .filter((a) => a.reason)
            .slice(0, 3)
            .map((a, i) => (
              <div key={i} className="rule-detail-reason-item">
                {a.grouping && Object.keys(a.grouping).length > 0 ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 3 }}>
                    {Object.entries(a.grouping).map(([k, v]) => (
                      <span key={k} style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>
                        {k}: <span style={{ color: "var(--text-secondary)" }}>{v}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
                <div style={{ fontSize: 12, color: "var(--text-primary)", lineHeight: 1.4 }}>{a.reason}</div>
              </div>
            ))}
          {rule.active_alerts.filter((a) => a.reason).length > 3 ? (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              +{rule.active_alerts.filter((a) => a.reason).length - 3} more — see Metadata below
            </div>
          ) : null}
        </div>
      ) : null}

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

      {(rule.active_alerts?.length || rule.group_by?.length || rule.esql_query || rule.all_criteria?.length || rule.rule_parameters || rule.id) ? (
        <ExpandSection
          title="Metadata"
          count={rule.active_alerts?.length ?? undefined}
          open={openMeta}
          onToggle={() => setOpenMeta((v) => !v)}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {rule.slo_id ? (
              <div>
                <div className="rule-detail-history-label" style={{ marginBottom: 6 }}>SLO burn rate</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                    <span style={{ color: "var(--text-muted)" }}>SLO ID: </span>
                    <span style={{ color: "var(--text-primary)" }}>{rule.slo_id}</span>
                  </div>
                  {(rule.burn_rate_windows as Array<{ burnRateThreshold?: number; longWindow?: { value?: number; unit?: string }; shortWindow?: { value?: number; unit?: string } }> | null)?.map((w, i) => (
                    <div key={i} style={{
                      padding: "6px 10px",
                      background: "var(--bg-secondary)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "var(--radius-sm)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--text-secondary)",
                    }}>
                      {`Burn rate > ${w.burnRateThreshold ?? "?"}×${w.longWindow ? ` · long: ${w.longWindow.value}${w.longWindow.unit}` : ""}${w.shortWindow ? ` · short: ${w.shortWindow.value}${w.shortWindow.unit}` : ""}`}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {rule.group_by?.length ? (
              <div>
                <div className="rule-detail-history-label" style={{ marginBottom: 6 }}>Group by</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {rule.group_by.map((f) => (
                    <span key={f} className="rule-tag">{f}</span>
                  ))}
                </div>
              </div>
            ) : null}

            {rule.esql_query ? (
              <div>
                <div className="rule-detail-history-label" style={{ marginBottom: 6 }}>ES|QL query</div>
                <pre className="rule-detail-code">{rule.esql_query}</pre>
              </div>
            ) : null}

            {rule.all_criteria?.length ? (
              <div>
                <div className="rule-detail-history-label" style={{ marginBottom: 6 }}>All criteria</div>
                <pre className="rule-detail-code">{JSON.stringify(rule.all_criteria, null, 2)}</pre>
              </div>
            ) : null}

            {rule.active_alerts?.length ? (
              <div>
                <div className="rule-detail-history-label" style={{ marginBottom: 6 }}>
                  Active alert instances ({rule.active_alerts.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {rule.active_alerts.map((a: AlertInstance) => (
                    <AlertInstanceRow key={a.id} alert={a} onOpenLink={onOpenLink} />
                  ))}
                </div>
              </div>
            ) : null}

            {rule.rule_parameters ? (
              <ExpandSection
                title="Raw parameters"
                open={openRawParams}
                onToggle={() => setOpenRawParams((v) => !v)}
              >
                <pre className="rule-detail-code">{JSON.stringify(rule.rule_parameters, null, 2)}</pre>
              </ExpandSection>
            ) : null}

            <div>
              <div className="rule-detail-history-label" style={{ marginBottom: 4 }}>Rule ID</div>
              <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>{rule.id}</div>
            </div>
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

function AlertInstanceRow({
  alert,
  onOpenLink,
}: {
  alert: AlertInstance;
  onOpenLink?: (url: string) => void;
}) {
  const isActive = alert.status === "active";
  const groupingEntries = alert.grouping ? Object.entries(alert.grouping) : [];

  return (
    <div
      style={{
        padding: "10px 12px",
        background: "var(--bg-secondary)",
        border: `1px solid ${isActive ? "var(--severity-major-border)" : "var(--border-subtle)"}`,
        borderRadius: "var(--radius-sm)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <SeverityChip severity={isActive ? "major" : "ok"} label={alert.status} />
        {alert.severity ? (
          <SeverityChip
            severity={
              alert.severity === "critical"
                ? "critical"
                : alert.severity === "high"
                  ? "major"
                  : alert.severity === "medium"
                    ? "minor"
                    : "ok"
            }
            label={alert.severity}
          />
        ) : null}
        {groupingEntries.map(([k, v]) => (
          <span key={k} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>
            <span style={{ color: "var(--text-muted)" }}>{k}:</span> {v}
          </span>
        ))}
        {alert.url && onOpenLink ? (
          <button
            type="button"
            onClick={() => onOpenLink(alert.url!)}
            style={{
              background: "rgba(0,153,255,0.08)",
              border: "1px solid #09f",
              borderRadius: 3,
              cursor: "pointer",
              padding: "1px 6px",
              fontSize: 11,
              lineHeight: "16px",
              color: "#09f",
              marginLeft: "auto",
            }}
          >
            View alert ↗
          </button>
        ) : null}
      </div>

      {alert.conditions ? (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-primary)" }}>
          {alert.conditions}
        </div>
      ) : alert.reason ? (
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.4 }}>
          {alert.reason}
        </div>
      ) : null}

      {alert.started_at ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Started {timeAgo(alert.started_at)}
        </div>
      ) : null}
    </div>
  );
}

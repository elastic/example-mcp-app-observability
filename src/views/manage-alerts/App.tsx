/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Manage Alerts view — renders four operation shapes emitted by the manage-alerts tool:
 *
 *   create → newly-created rule card (live badge, KV rows, next-step buttons)
 *   get    → single-rule detail card (same KV rows + execution status)
 *   list   → list of rule summary cards (name, condition, status, tags)
 *   delete → deletion confirmation card (deleted rule id + next steps)
 *
 * All operations emit `investigation_actions` as click-to-send prompts so the LLM can chain
 * operations (e.g. list → get → delete) without the user retyping IDs.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useApp, AppLike, ToolResultParams } from "@shared/use-app";
import { parseToolResult } from "@shared/parse-tool-result";
import { theme, baseStyles } from "@shared/theme";
import {
  SectionCard,
  KVRow,
  InvestigationActions,
  InvestigationAction,
  TimeRangeHeader,
  StatusBadge,
  BadgeTone,
} from "@shared/components";

interface RuleSummary {
  id: string;
  name: string;
  rule_type_id: string;
  enabled: boolean;
  tags?: string[];
  schedule_interval?: string | null;
  execution_status?: string | null;
  last_run_outcome?: string | null;
  active_alert_count?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  condition?: string | null;
  window?: string | null;
  index_pattern?: string | null;
  kql_filter?: string | null;
}

interface CreateResult {
  status: "success";
  operation: "create";
  rule_id: string;
  rule_name: string;
  rule_type?: string;
  metric_field?: string;
  threshold?: number;
  comparator?: string;
  check_interval?: string;
  agg_type?: string;
  time_size?: number;
  time_unit?: string;
  kql_filter?: string;
  index_pattern?: string;
  tags?: string[];
  enabled?: boolean;
  message?: string;
  investigation_actions?: InvestigationAction[];
}

interface ListResult {
  status: "success";
  operation: "list";
  total: number;
  returned: number;
  page: number;
  per_page: number;
  filter_summary?: string;
  filter_tags?: string[] | null;
  rules: RuleSummary[];
  message?: string;
  investigation_actions?: InvestigationAction[];
}

interface GetResult {
  status: "success";
  operation: "get";
  rule: RuleSummary;
  message?: string;
  investigation_actions?: InvestigationAction[];
}

interface DeleteResult {
  status: "success";
  operation: "delete";
  rule_id: string;
  deleted: boolean;
  confirmation_required?: boolean;
  preview?: RuleSummary;
  message?: string;
  investigation_actions?: InvestigationAction[];
}

interface ErrorResult {
  status: "error";
  error?: string;
  message?: string;
}

type Result = CreateResult | ListResult | GetResult | DeleteResult | ErrorResult;

function fmt(value: number | string | null | undefined, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return value.toLocaleString();
  return String(value);
}

function outcomeTone(outcome: string | null | undefined): BadgeTone {
  if (!outcome) return "neutral";
  const o = outcome.toLowerCase();
  if (o === "succeeded" || o === "success" || o === "ok" || o === "active") return "ok";
  if (o === "warning") return "major";
  if (o === "failed" || o === "error") return "critical";
  return "info";
}

function windowStr(size: number | undefined, unit: string | undefined): string {
  if (!size || !unit) return "last 5 minutes";
  const unitName = unit === "m" ? "minute" : unit === "h" ? "hour" : "day";
  return `last ${size} ${unitName}${size === 1 ? "" : "s"}`;
}

function TagList({ tags }: { tags?: string[] }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {tags.map((t) => (
        <span
          key={t}
          style={{
            padding: "2px 8px",
            background: `${theme.blue}20`,
            border: `1px solid ${theme.blue}55`,
            color: theme.blue,
            fontSize: 11,
            borderRadius: 999,
          }}
        >
          {t}
        </span>
      ))}
    </div>
  );
}

function RuleDetailCard({ summary }: { summary: RuleSummary }) {
  return (
    <SectionCard>
      <KVRow label="Rule ID" value={<span className="mono">{summary.id}</span>} />
      <KVRow label="Type" value={<span className="mono">{summary.rule_type_id}</span>} />
      {summary.condition && <KVRow label="Condition" value={summary.condition} />}
      {summary.window && <KVRow label="Window" value={summary.window} />}
      {summary.schedule_interval && (
        <KVRow label="Check interval" value={`every ${summary.schedule_interval}`} />
      )}
      {summary.kql_filter && <KVRow label="KQL filter" value={summary.kql_filter} />}
      {summary.index_pattern && <KVRow label="Index" value={summary.index_pattern} />}
      {summary.tags?.length ? <KVRow label="Tags" value={<TagList tags={summary.tags} />} /> : null}
      <KVRow
        label="Enabled"
        value={
          <StatusBadge tone={summary.enabled ? "ok" : "neutral"}>
            {summary.enabled ? "yes" : "no"}
          </StatusBadge>
        }
      />
      {summary.execution_status && (
        <KVRow
          label="Execution"
          value={
            <StatusBadge tone={outcomeTone(summary.execution_status)}>
              {summary.execution_status}
            </StatusBadge>
          }
        />
      )}
      {summary.last_run_outcome && (
        <KVRow
          label="Last run"
          value={
            <StatusBadge tone={outcomeTone(summary.last_run_outcome)}>
              {summary.last_run_outcome}
            </StatusBadge>
          }
        />
      )}
      {summary.active_alert_count !== null && summary.active_alert_count !== undefined && (
        <KVRow label="Active alerts" value={String(summary.active_alert_count)} />
      )}
      {summary.created_at && (
        <KVRow label="Created" value={new Date(summary.created_at).toLocaleString()} />
      )}
      {summary.updated_at && (
        <KVRow label="Updated" value={new Date(summary.updated_at).toLocaleString()} />
      )}
    </SectionCard>
  );
}

function RuleListItem({
  summary,
  onInspect,
  onDelete,
}: {
  summary: RuleSummary;
  onInspect: () => void;
  onDelete: () => void;
}) {
  const outcome = summary.last_run_outcome || summary.execution_status;
  return (
    <div
      style={{
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        padding: "10px 12px",
        marginBottom: 8,
        background: theme.bg,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 2 }}>
            {summary.name}
          </div>
          <div style={{ fontSize: 11, color: theme.textMuted }} className="mono">
            {summary.id}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
          <StatusBadge tone={summary.enabled ? "ok" : "neutral"}>
            {summary.enabled ? "enabled" : "disabled"}
          </StatusBadge>
          {outcome && <StatusBadge tone={outcomeTone(outcome)}>{outcome}</StatusBadge>}
        </div>
      </div>
      {summary.condition && (
        <div style={{ fontSize: 12, color: theme.text, marginTop: 6 }} className="mono">
          {summary.condition}
          {summary.window ? <span style={{ color: theme.textMuted }}> · {summary.window}</span> : null}
          {summary.schedule_interval ? (
            <span style={{ color: theme.textMuted }}> · every {summary.schedule_interval}</span>
          ) : null}
        </div>
      )}
      {summary.kql_filter && (
        <div
          style={{
            fontSize: 11,
            color: theme.textMuted,
            marginTop: 4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          className="mono"
        >
          {summary.kql_filter}
        </div>
      )}
      {summary.tags?.length ? (
        <div style={{ marginTop: 8 }}>
          <TagList tags={summary.tags} />
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          onClick={onInspect}
          style={{
            padding: "4px 10px",
            fontSize: 11,
            background: `${theme.blue}20`,
            color: theme.blue,
            border: `1px solid ${theme.blue}55`,
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Inspect
        </button>
        <button
          onClick={onDelete}
          style={{
            padding: "4px 10px",
            fontSize: 11,
            background: `${theme.redSoft}20`,
            color: theme.redSoft,
            border: `1px solid ${theme.redSoft}55`,
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

export function App() {
  const [data, setData] = useState<Result | null>(null);
  const [app, setApp] = useState<AppLike | null>(null);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = baseStyles;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const handleToolResult = useCallback((params: ToolResultParams) => {
    const d = parseToolResult<Result>(params);
    if (d) setData(d);
  }, []);

  useApp({
    appInfo: { name: "Manage Alerts", version: "1.0.0" },
    onAppCreated: (a) => {
      a.ontoolresult = handleToolResult;
      setApp(a);
    },
  });

  const onSend = useCallback((p: string) => app?.sendMessage(p), [app]);

  if (!data) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: theme.textMuted }}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>Waiting for manage-alerts result…</div>
        <div style={{ fontSize: 11 }}>Call manage-alerts to populate this view.</div>
      </div>
    );
  }

  if (data.status === "error") {
    return (
      <div style={{ padding: "14px 16px", maxWidth: 620 }}>
        <SectionCard>
          <div style={{ fontSize: 13, fontWeight: 700, color: theme.redSoft, marginBottom: 6 }}>
            manage-alerts failed
          </div>
          <div style={{ fontSize: 12, color: theme.text }}>{data.error || data.message}</div>
        </SectionCard>
      </div>
    );
  }

  if (data.operation === "create") {
    const d = data;
    const aggType = d.agg_type || "avg";
    const comparator = d.comparator || ">";
    const conditionStr = `${aggType}(${d.metric_field}) ${comparator} ${fmt(d.threshold)}`;
    return (
      <div style={{ padding: "14px 16px", maxWidth: 620 }}>
        <TimeRangeHeader
          title={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: theme.greenSoft,
                  boxShadow: `0 0 8px ${theme.green}80`,
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              {d.rule_name}
            </span>
          }
          subtitle={
            <span className="mono">{d.rule_type || "observability.rules.custom_threshold"}</span>
          }
          status={{ tone: "ok", label: "created" }}
        />
        <SectionCard>
          <KVRow label="Rule ID" value={<span className="mono">{d.rule_id}</span>} />
          <KVRow label="Condition" value={conditionStr} />
          <KVRow label="Window" value={windowStr(d.time_size, d.time_unit)} />
          <KVRow label="Check interval" value={`every ${d.check_interval || "5m"}`} />
          {d.kql_filter && <KVRow label="KQL filter" value={d.kql_filter} />}
          <KVRow label="Aggregation" value={aggType} />
          {d.tags?.length ? <KVRow label="Tags" value={<TagList tags={d.tags} />} /> : null}
          {d.index_pattern && <KVRow label="Index" value={d.index_pattern} />}
        </SectionCard>
        <InvestigationActions
          title="Next steps"
          actions={d.investigation_actions}
          onSend={onSend}
        />
      </div>
    );
  }

  if (data.operation === "get") {
    const d = data;
    return (
      <div style={{ padding: "14px 16px", maxWidth: 620 }}>
        <TimeRangeHeader
          title={d.rule.name}
          subtitle={<span className="mono">{d.rule.rule_type_id}</span>}
          status={{
            tone: d.rule.enabled ? "ok" : "neutral",
            label: d.rule.enabled ? "enabled" : "disabled",
          }}
        />
        <RuleDetailCard summary={d.rule} />
        <InvestigationActions
          title="Next steps"
          actions={d.investigation_actions}
          onSend={onSend}
        />
      </div>
    );
  }

  if (data.operation === "delete") {
    const d = data;
    if (d.confirmation_required && d.preview) {
      return (
        <div style={{ padding: "14px 16px", maxWidth: 620 }}>
          <TimeRangeHeader
            title="Confirm deletion"
            subtitle={<span className="mono">{d.preview.name}</span>}
            status={{ tone: "major", label: "confirmation required" }}
          />
          <SectionCard>
            <div
              style={{
                fontSize: 12,
                color: theme.text,
                marginBottom: 10,
                padding: "8px 10px",
                background: `${theme.redSoft}15`,
                border: `1px solid ${theme.redSoft}55`,
                borderRadius: 4,
              }}
            >
              <strong>This is irreversible.</strong> The rule below will be permanently removed
              from Kibana. Confirm with the user before dispatching the delete.
            </div>
          </SectionCard>
          <RuleDetailCard summary={d.preview} />
          <InvestigationActions
            title="Next steps"
            actions={d.investigation_actions}
            onSend={onSend}
          />
        </div>
      );
    }
    return (
      <div style={{ padding: "14px 16px", maxWidth: 620 }}>
        <TimeRangeHeader
          title="Rule deleted"
          subtitle={<span className="mono">{d.rule_id}</span>}
          status={{ tone: "neutral", label: "deleted" }}
        />
        <SectionCard>
          <div style={{ fontSize: 12, color: theme.text }}>
            {d.message || `Rule ${d.rule_id} has been permanently deleted.`}
          </div>
        </SectionCard>
        <InvestigationActions
          title="Next steps"
          actions={d.investigation_actions}
          onSend={onSend}
        />
      </div>
    );
  }

  // operation === "list"
  const d = data;
  return (
    <div style={{ padding: "14px 16px", maxWidth: 620 }}>
      <TimeRangeHeader
        title={
          <span>
            {d.total} rule{d.total === 1 ? "" : "s"}
            {d.total > d.returned ? (
              <span style={{ color: theme.textMuted, fontWeight: 400 }}>
                {" "}
                (showing {d.returned})
              </span>
            ) : null}
          </span>
        }
        subtitle={d.filter_summary ? <span className="mono">{d.filter_summary}</span> : undefined}
        status={{ tone: d.total === 0 ? "neutral" : "info", label: `page ${d.page}` }}
      />
      {d.rules.length === 0 ? (
        <SectionCard>
          <div style={{ fontSize: 12, color: theme.textMuted }}>
            {d.message || "No rules matched the filter."}
          </div>
        </SectionCard>
      ) : (
        <div>
          {d.rules.map((r) => (
            <RuleListItem
              key={r.id}
              summary={r}
              onInspect={() =>
                onSend(`Use manage-alerts with operation='get' and rule_id='${r.id}'.`)
              }
              onDelete={() =>
                onSend(
                  `Delete the rule '${r.name}' (id ${r.id}) via manage-alerts with operation='delete'. Confirm first before dispatching.`
                )
              }
            />
          ))}
        </div>
      )}
      <InvestigationActions title="Next steps" actions={d.investigation_actions} onSend={onSend} />
    </div>
  );
}

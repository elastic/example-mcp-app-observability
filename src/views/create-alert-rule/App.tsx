/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Create Alert Rule view — shows the newly-created Kibana custom-threshold rule.
 *
 * Layout:
 *   Header card:      rule name + type subtitle + live badge
 *   KV rows:          Rule ID, Condition, Window, Check interval, KQL filter, Aggregation, Tags
 *   Context section:  optional stat cards referencing the current session (anomaly peak, etc.)
 *   Next steps:       investigation-action buttons
 *
 * All context/next-step fields are optional — the tool emits them when it can derive context
 * from the session, but the view degrades cleanly without them.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useApp, AppLike, ToolResultParams } from "@shared/use-app";
import { parseToolResult } from "@shared/parse-tool-result";
import { theme, baseStyles } from "@shared/theme";
import {
  StatCard,
  StatGrid,
  SectionCard,
  KVRow,
  InvestigationActions,
  InvestigationAction,
  TimeRangeHeader,
} from "@shared/components";

interface ContextStat {
  label: string;
  value: string;
  tone?: "critical" | "major" | "ok" | "neutral";
  sub?: string;
}

interface AlertRuleResult {
  status: "success" | "error";
  rule_id?: string;
  rule_name?: string;
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
  error?: string;
  context_stats?: ContextStat[];
  investigation_actions?: InvestigationAction[];
}

function fmtThreshold(field: string | undefined, value: number | undefined): string {
  if (value === undefined) return "—";
  const f = (field || "").toLowerCase();
  if (f.includes("memory") || f.includes("bytes")) {
    return value.toLocaleString();
  }
  return value.toLocaleString();
}

export function App() {
  const [data, setData] = useState<AlertRuleResult | null>(null);
  const [app, setApp] = useState<AppLike | null>(null);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = baseStyles;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const handleToolResult = useCallback((params: ToolResultParams) => {
    const d = parseToolResult<AlertRuleResult>(params);
    if (d) setData(d);
  }, []);

  useApp({
    appInfo: { name: "Create Alert Rule", version: "1.0.0" },
    onAppCreated: (a) => {
      a.ontoolresult = handleToolResult;
      setApp(a);
    },
  });

  const onSend = useCallback((p: string) => app?.sendMessage(p), [app]);

  if (!data) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: theme.textMuted }}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>Waiting for alert-rule result…</div>
        <div style={{ fontSize: 11 }}>Call create-alert-rule to populate this view.</div>
      </div>
    );
  }

  if (data.status === "error" || data.error) {
    return (
      <div style={{ padding: "14px 16px", maxWidth: 620 }}>
        <SectionCard>
          <div style={{ fontSize: 13, fontWeight: 700, color: theme.redSoft, marginBottom: 6 }}>
            Rule creation failed
          </div>
          <div style={{ fontSize: 12, color: theme.text }}>{data.error || data.message}</div>
        </SectionCard>
      </div>
    );
  }

  const aggType = data.agg_type || "avg";
  const comparator = data.comparator || ">";
  const conditionStr = `${aggType}(${data.metric_field}) ${comparator} ${fmtThreshold(
    data.metric_field,
    data.threshold
  )}`;
  const windowStr = data.time_size && data.time_unit
    ? `last ${data.time_size} ${
        data.time_unit === "m" ? "minute" : data.time_unit === "h" ? "hour" : "day"
      }${data.time_size === 1 ? "" : "s"}`
    : "last 5 minutes";
  const checkIntervalStr = data.check_interval || "1m";

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
            {data.rule_name}
          </span>
        }
        subtitle={
          <span className="mono">
            {data.rule_type || "observability.rules.custom_threshold"}
          </span>
        }
        status={{ tone: "ok", label: "live" }}
      />
      <SectionCard>
        {data.rule_id && <KVRow label="Rule ID" value={data.rule_id} />}
        <KVRow label="Condition" value={conditionStr} />
        <KVRow label="Window" value={windowStr} />
        <KVRow label="Check interval" value={`every ${checkIntervalStr}`} />
        {data.kql_filter && <KVRow label="KQL filter" value={data.kql_filter} />}
        <KVRow label="Aggregation" value={aggType} />
        {data.tags?.length ? (
          <KVRow
            label="Tags"
            value={
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {data.tags.map((t) => (
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
            }
          />
        ) : null}
        {data.index_pattern && <KVRow label="Index" value={data.index_pattern} />}
      </SectionCard>

      {data.context_stats?.length ? (
        <SectionCard title="Context from this session">
          <StatGrid>
            {data.context_stats.map((s, i) => (
              <StatCard key={i} label={s.label} value={s.value} tone={s.tone} sub={s.sub} />
            ))}
          </StatGrid>
        </SectionCard>
      ) : null}

      <InvestigationActions
        title="Next steps"
        actions={data.investigation_actions}
        onSend={onSend}
      />
    </div>
  );
}

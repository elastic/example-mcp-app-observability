/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import fs from "fs";
import { createCustomThresholdRule } from "../elastic/alerting.js";
import { getConfig } from "../elastic/client.js";
import { resolveViewPath } from "./view-path.js";

const RESOURCE_URI = "ui://create-alert-rule/mcp-app.html";

export function registerCreateAlertRuleTool(server: McpServer) {
  registerAppTool(
    server,
    "create-alert-rule",
    {
      title: "Create Alert Rule",
      description:
        "Requires: Kibana with Alerting enabled. Backend-agnostic — works on any metric field in any index pattern " +
        "(logs, metrics, APM, custom). Creates a persistent Kibana alerting rule that monitors a metric and fires " +
        "when a threshold is breached, using the Observability custom-threshold rule type. This is a real, live rule " +
        "— not a simulation. The rule is tagged 'elastic-o11y-mcp' for easy cleanup. Use when the user wants durable " +
        "alerting ('page me if X', 'create a rule for Y') — not for transient one-off monitoring (use `watch` for that).",
      inputSchema: {
        rule_name: z.string().describe(
          "Human-readable name for the rule — derive from the user's intent. Examples: 'Frontend Pod Memory > 80MB', " +
          "'Checkout P99 Latency Breach', 'Payment Error Rate > 5%'."
        ),
        metric_field: z.string().describe(
          "Metric field to monitor — e.g. 'k8s.pod.memory.working_set', 'system.cpu.total.norm.pct', " +
          "'transaction.duration.histogram'. Must match a numeric field present in the index pattern."
        ),
        threshold: z.number().describe(
          "Threshold value in the metric's native units. Examples: 80000000 (80MB for a bytes field), 0.9 (90% for " +
          "a normalized CPU field), 500 (500ms for a latency field)."
        ),
        comparator: z.enum([">", ">=", "<", "<="]).optional().describe(
          "Comparison operator. Default '>' (fire when metric exceeds threshold). Use '<' for low-water-mark rules " +
          "(e.g. 'fire if free memory drops below X')."
        ),
        kql_filter: z.string().optional().describe(
          "Optional KQL filter to scope the rule — e.g. 'k8s.namespace.name: otel-demo AND service.name: frontend'. " +
          "Omit to apply across all documents matching the index pattern."
        ),
        check_interval: z.string().optional().describe(
          "How often the rule evaluates. Default '1m'. Examples: '30s', '1m', '5m', '1h'. Shorter intervals react " +
          "faster but cost more cycles."
        ),
        agg_type: z.enum(["avg", "max", "min", "sum", "count"]).optional().describe(
          "Aggregation applied over the time window. Default 'avg'. Use 'max' for worst-case detection, 'count' for " +
          "event-frequency rules."
        ),
        time_size: z.number().optional().describe(
          "Lookback window size in units of time_unit. Default 5. Window over which the aggregation is computed."
        ),
        time_unit: z.enum(["m", "h", "d"]).optional().describe(
          "Lookback window unit. Default 'm' (minutes). Combined with time_size — e.g. time_size=5, time_unit='m' " +
          "means a 5-minute window."
        ),
        index_pattern: z.string().optional().describe(
          "Index pattern to query. Default 'metrics-*'. Set explicitly for non-metrics indices — e.g. 'logs-*', " +
          "'traces-apm*', 'custom-*'."
        ),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async (input) => {
      try {
        const rule = await createCustomThresholdRule({
          ruleName: input.rule_name,
          metricField: input.metric_field,
          threshold: input.threshold,
          comparator: input.comparator,
          kqlFilter: input.kql_filter,
          checkInterval: input.check_interval,
          aggType: input.agg_type,
          timeSize: input.time_size,
          timeUnit: input.time_unit,
          indexPattern: input.index_pattern,
        });

        const kibanaUrl = getConfig().kibanaUrl;
        const aggType = input.agg_type ?? "avg";
        const comparator = input.comparator ?? ">";
        const checkInterval = input.check_interval ?? "1m";
        const timeSize = input.time_size ?? 5;
        const timeUnit = input.time_unit ?? "m";

        const actions: { label: string; prompt: string }[] = [
          {
            label: "Check new anomalies",
            prompt: "Use ml-anomalies with lookback 1h and min_score 50 to see if anything else has fired since creating this rule.",
          },
          {
            label: "Confirm cluster health",
            prompt: "Use apm-health-summary to confirm the rest of the cluster is healthy.",
          },
          {
            label: "Watch metric stabilize",
            prompt: `Use watch in metric mode with the same condition (${comparator} ${input.threshold}) to verify the metric now stays in the healthy range.`,
          },
        ];

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "success",
                rule_id: rule.id,
                rule_name: input.rule_name,
                rule_type: "observability.rules.custom_threshold",
                metric_field: input.metric_field,
                threshold: input.threshold,
                comparator,
                check_interval: checkInterval,
                agg_type: aggType,
                time_size: timeSize,
                time_unit: timeUnit,
                kql_filter: input.kql_filter,
                index_pattern: input.index_pattern ?? "metrics-*",
                enabled: true,
                tags: rule.tags,
                message: `Alert rule '${input.rule_name}' created successfully. It will check ${aggType}(${input.metric_field}) ${comparator} ${input.threshold} every ${checkInterval}. Rule ID: ${rule.id}. View in Kibana → Alerts → Rules.`,
                cleanup_hint: `To delete this rule: DELETE ${kibanaUrl}/api/alerting/rule/${rule.id} with kbn-xsrf: true header.`,
                investigation_actions: actions,
              }),
            },
          ],
        };
      } catch (exc) {
        const msg = exc instanceof Error ? exc.message : String(exc);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error: `Rule creation failed: ${msg}` }) }],
        };
      }
    }
  );

  const viewPath = resolveViewPath("create-alert-rule");
  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const html = fs.readFileSync(viewPath, "utf-8");
      return { contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }] };
    }
  );
}

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
import {
  createCustomThresholdRule,
  listRules,
  getRule,
  deleteRule,
  ListedRule,
} from "../elastic/alerting.js";
import { getConfig } from "../elastic/client.js";
import { resolveViewPath } from "./view-path.js";

const RESOURCE_URI = "ui://manage-alerts/mcp-app.html";

const OPERATIONS = ["create", "list", "get", "delete"] as const;

type ToolAction = { label: string; prompt: string };

function errorResult(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ status: "error", error: message }),
      },
    ],
  };
}

function successResult(payload: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ status: "success", ...payload }),
      },
    ],
  };
}

export function registerManageAlertsTool(server: McpServer) {
  registerAppTool(
    server,
    "manage-alerts",
    {
      title: "Manage Alerts",
      description:
        "Requires: Kibana with Alerting enabled. Backend-agnostic — works on any metric field in any index pattern " +
        "(logs, metrics, APM, custom). CRUD for Kibana alert rules (custom-threshold rule type). Supports four operations:\n" +
        "  • operation='create' — create a new persistent custom-threshold alerting rule. Real, live rule — not a simulation. " +
        "Tagged 'elastic-o11y-mcp' by default for easy cleanup. Use when the user wants durable alerting ('page me if X', " +
        "'create a rule for Y'). For transient session-scoped monitoring use `watch` instead.\n" +
        "  • operation='list' — list existing rules, optionally filtered by tags, name search, or rule_type_ids. Defaults to " +
        "tags=['elastic-o11y-mcp'] so you see the rules this MCP created. Pass tags=[] to see every rule in Kibana.\n" +
        "  • operation='get' — fetch a single rule by rule_id, including execution status and last-run outcome.\n" +
        "  • operation='delete' — permanently delete a rule by rule_id. Irreversible. The tool enforces a two-step " +
        "confirmation: on the first call (without confirm=true) you get a preview of the rule, nothing is deleted. " +
        "Re-invoke with confirm=true only after the user has explicitly approved.",
      inputSchema: {
        operation: z.enum(OPERATIONS).describe(
          "Which CRUD action to perform. 'create' = new rule. 'list' = find rules (filter by tag/search). " +
          "'get' = inspect one rule. 'delete' = remove one rule (irreversible — confirm first)."
        ),

        // --- create inputs ---
        rule_name: z.string().optional().describe(
          "[create] Human-readable rule name — derive from the user's intent. " +
          "Examples: 'Frontend Pod Memory > 80MB', 'Checkout P99 Latency Breach'."
        ),
        metric_field: z.string().optional().describe(
          "[create] Metric field to monitor — e.g. 'k8s.pod.memory.working_set', 'system.cpu.total.norm.pct'. " +
          "Must be a numeric field present in the target index pattern."
        ),
        threshold: z.number().optional().describe(
          "[create] Threshold value in the metric's native units. Examples: 80000000 (80MB for a bytes field), " +
          "0.9 (90% for a normalized CPU field), 500 (500ms for a latency field)."
        ),
        comparator: z.enum([">", ">=", "<", "<="]).optional().describe(
          "[create] Default '>'. Use '<' for low-water-mark rules (e.g. 'fire if free memory drops below X')."
        ),
        kql_filter: z.string().optional().describe(
          "[create] Optional KQL scope filter — e.g. 'k8s.namespace.name: otel-demo AND service.name: frontend'. " +
          "Omit to match every document in the index pattern (noisy — strongly recommended for shared envs)."
        ),
        check_interval: z.string().optional().describe(
          "[create] How often the rule evaluates. Default '5m' (matches Kibana's own default and pairs with the " +
          "default 5-minute lookback). Use '1m' only for pageable SLO breaches; '15m'–'1h' for capacity/trend alerts."
        ),
        agg_type: z.enum(["avg", "max", "min", "sum", "count"]).optional().describe(
          "[create] Default 'avg'. Use 'max' for worst-case detection, 'count' for event-frequency rules."
        ),
        time_size: z.number().optional().describe(
          "[create] Lookback window size (in units of time_unit). Default 5."
        ),
        time_unit: z.enum(["m", "h", "d"]).optional().describe(
          "[create] Lookback window unit. Default 'm' (minutes)."
        ),
        index_pattern: z.string().optional().describe(
          "[create] Default 'metrics-*'. Set for non-metrics indices — e.g. 'logs-*', 'traces-apm*', 'custom-*'."
        ),

        // --- list inputs ---
        tags: z.array(z.string()).optional().describe(
          "[list] Filter rules by tag. Defaults to ['elastic-o11y-mcp'] when operation='list' and this is omitted, " +
          "so the user sees rules this MCP created. Pass an empty array to list every rule in Kibana."
        ),
        search: z.string().optional().describe(
          "[list] Substring search against rule name."
        ),
        rule_type_ids: z.array(z.string()).optional().describe(
          "[list] Filter by Kibana rule_type_id — e.g. 'observability.rules.custom_threshold', 'apm.transaction_error_rate'. " +
          "Omit to include all rule types."
        ),
        per_page: z.number().optional().describe(
          "[list] Page size. Default 50."
        ),
        page: z.number().optional().describe(
          "[list] Page number (1-indexed). Default 1."
        ),

        // --- get / delete inputs ---
        rule_id: z.string().optional().describe(
          "[get, delete] Kibana rule saved-object ID. Find it via operation='list' or in Kibana → Alerts & Insights → Rules."
        ),
        confirm: z.boolean().optional().describe(
          "[delete] Must be explicitly set to true to actually delete a rule. If omitted or false " +
          "the tool returns a preview of the rule that WOULD be deleted and does nothing destructive. " +
          "Re-invoke with confirm=true after the user has explicitly approved the deletion. " +
          "This safeguard is enforced in the tool itself — the delete cannot proceed without it."
        ),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async (input) => {
      try {
        const op = input.operation;
        const kibanaUrl = getConfig().kibanaUrl;

        if (op === "create") {
          return await handleCreate(input, kibanaUrl);
        }
        if (op === "list") {
          return await handleList(input, kibanaUrl);
        }
        if (op === "get") {
          return await handleGet(input, kibanaUrl);
        }
        if (op === "delete") {
          return await handleDelete(input, kibanaUrl);
        }
        return errorResult(`Unknown operation: ${op}`);
      } catch (exc) {
        const msg = exc instanceof Error ? exc.message : String(exc);
        return errorResult(`manage-alerts failed: ${msg}`);
      }
    }
  );

  const viewPath = resolveViewPath("manage-alerts");
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

// -- operation handlers ----------------------------------------------------

interface ManageAlertsInput {
  operation: (typeof OPERATIONS)[number];
  rule_name?: string;
  metric_field?: string;
  threshold?: number;
  comparator?: ">" | ">=" | "<" | "<=";
  kql_filter?: string;
  check_interval?: string;
  agg_type?: "avg" | "max" | "min" | "sum" | "count";
  time_size?: number;
  time_unit?: "m" | "h" | "d";
  index_pattern?: string;
  tags?: string[];
  search?: string;
  rule_type_ids?: string[];
  per_page?: number;
  page?: number;
  rule_id?: string;
  confirm?: boolean;
}

async function handleCreate(input: ManageAlertsInput, kibanaUrl: string) {
  if (!input.rule_name) return errorResult("operation='create' requires rule_name.");
  if (!input.metric_field) return errorResult("operation='create' requires metric_field.");
  if (input.threshold === undefined) return errorResult("operation='create' requires threshold.");

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

  const aggType = input.agg_type ?? "avg";
  const comparator = input.comparator ?? ">";
  const checkInterval = input.check_interval ?? "5m";
  const timeSize = input.time_size ?? 5;
  const timeUnit = input.time_unit ?? "m";

  const actions: ToolAction[] = [
    {
      label: "List my rules",
      prompt: "Use manage-alerts with operation='list' to show all rules this MCP created.",
    },
    {
      label: "Watch metric stabilize",
      prompt: `Use watch in metric mode with the same condition (${comparator} ${input.threshold}) to verify the metric now stays in the healthy range.`,
    },
    {
      label: "Delete this rule",
      prompt: `Use manage-alerts with operation='delete' and rule_id='${rule.id}' to remove this rule.`,
    },
  ];

  return successResult({
    operation: "create",
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
    cleanup_hint: `To delete this rule: DELETE ${kibanaUrl}/api/alerting/rule/${rule.id} with kbn-xsrf: true header — or call manage-alerts with operation='delete' and rule_id='${rule.id}'.`,
    investigation_actions: actions,
  });
}

async function handleList(input: ManageAlertsInput, _kibanaUrl: string) {
  // Default to our own rules so the user sees MCP-created rules first.
  const tags = input.tags ?? ["elastic-o11y-mcp"];
  const effectiveTags = tags.length ? tags : undefined;

  const result = await listRules({
    tags: effectiveTags,
    search: input.search,
    ruleTypeIds: input.rule_type_ids,
    perPage: input.per_page,
    page: input.page,
  });

  const summaries = result.data.map(summarizeRule);

  const actions: ToolAction[] = [];
  if (summaries.length > 0) {
    actions.push({
      label: "Inspect first rule",
      prompt: `Use manage-alerts with operation='get' and rule_id='${summaries[0].id}'.`,
    });
  }
  if (effectiveTags) {
    actions.push({
      label: "List ALL rules (no tag filter)",
      prompt: "Use manage-alerts with operation='list' and tags=[] to see every rule in Kibana.",
    });
  }
  actions.push({
    label: "Create a new rule",
    prompt: "Use manage-alerts with operation='create' — ask me for rule_name, metric_field, and threshold.",
  });

  const filterSummary = [
    effectiveTags ? `tags: [${effectiveTags.join(", ")}]` : "tags: (all)",
    input.search ? `search: '${input.search}'` : null,
    input.rule_type_ids?.length ? `rule_type_ids: [${input.rule_type_ids.join(", ")}]` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return successResult({
    operation: "list",
    page: result.page,
    per_page: result.per_page,
    total: result.total,
    returned: summaries.length,
    filter_summary: filterSummary,
    filter_tags: effectiveTags ?? null,
    filter_search: input.search ?? null,
    filter_rule_type_ids: input.rule_type_ids ?? null,
    rules: summaries,
    message:
      result.total === 0
        ? `No rules matched (${filterSummary}).`
        : `Found ${result.total} rule${result.total === 1 ? "" : "s"} matching ${filterSummary}. Showing ${summaries.length} on page ${result.page}.`,
    investigation_actions: actions,
  });
}

async function handleGet(input: ManageAlertsInput, kibanaUrl: string) {
  if (!input.rule_id) return errorResult("operation='get' requires rule_id.");
  const rule = await getRule(input.rule_id);
  const summary = summarizeRule(rule);

  const actions: ToolAction[] = [
    {
      label: "Delete this rule",
      prompt: `Use manage-alerts with operation='delete' and rule_id='${rule.id}'.`,
    },
    {
      label: "List sibling rules",
      prompt: `Use manage-alerts with operation='list' and tags=${JSON.stringify(rule.tags ?? [])}.`,
    },
  ];

  return successResult({
    operation: "get",
    rule: summary,
    raw_rule: rule,
    message: `Rule '${rule.name}' (${rule.rule_type_id}) is ${rule.enabled ? "enabled" : "disabled"}. Last execution status: ${rule.execution_status?.status ?? "unknown"}.`,
    cleanup_hint: `To delete: DELETE ${kibanaUrl}/api/alerting/rule/${rule.id} with kbn-xsrf: true header.`,
    investigation_actions: actions,
  });
}

async function handleDelete(input: ManageAlertsInput, _kibanaUrl: string) {
  if (!input.rule_id) return errorResult("operation='delete' requires rule_id.");

  // Safety gate: the delete is irreversible, so we require an explicit confirm=true.
  // When confirm is missing/false, fetch the target rule and return a preview so the
  // LLM can quote the name back to the user and ask for confirmation before
  // re-invoking with confirm=true. Enforced here so skill-prompt drift can't bypass it.
  if (input.confirm !== true) {
    let preview;
    try {
      const rule = await getRule(input.rule_id);
      preview = summarizeRule(rule);
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      return errorResult(`Could not load rule '${input.rule_id}' for delete preview: ${msg}`);
    }

    return successResult({
      operation: "delete",
      deleted: false,
      confirmation_required: true,
      rule_id: input.rule_id,
      preview,
      message:
        `Confirmation required before deleting rule '${preview.name}' (id ${preview.id}). ` +
        `This is irreversible. Quote the rule name back to the user, get explicit approval, ` +
        `then re-invoke manage-alerts with operation='delete', rule_id='${preview.id}', and confirm=true.`,
      investigation_actions: [
        {
          label: `Confirm delete of '${preview.name}'`,
          prompt:
            `The user has confirmed. Use manage-alerts with operation='delete', rule_id='${preview.id}', and confirm=true.`,
        },
        {
          label: "Cancel",
          prompt: "Do not delete that rule. Keep it in place.",
        },
      ],
    });
  }

  await deleteRule(input.rule_id);

  return successResult({
    operation: "delete",
    rule_id: input.rule_id,
    deleted: true,
    confirmation_required: false,
    message: `Rule ${input.rule_id} deleted.`,
    investigation_actions: [
      {
        label: "List remaining rules",
        prompt: "Use manage-alerts with operation='list' to confirm the rule is gone.",
      },
    ],
  });
}

function summarizeRule(rule: ListedRule) {
  const params = rule.params ?? {};
  const criteria = (params as { criteria?: unknown[] }).criteria;
  const firstCriterion =
    Array.isArray(criteria) && criteria.length > 0
      ? (criteria[0] as {
          metrics?: { aggType?: string; field?: string }[];
          comparator?: string;
          threshold?: number[];
          timeSize?: number;
          timeUnit?: string;
        })
      : undefined;
  const metric = firstCriterion?.metrics?.[0];
  const search = (params as { searchConfiguration?: { index?: string; query?: { query?: string } } }).searchConfiguration;

  return {
    id: rule.id,
    name: rule.name,
    rule_type_id: rule.rule_type_id,
    enabled: rule.enabled,
    tags: rule.tags,
    schedule_interval: rule.schedule?.interval ?? null,
    execution_status: rule.execution_status?.status ?? null,
    last_run_outcome: rule.last_run?.outcome ?? null,
    active_alert_count: rule.last_run?.alerts_count?.active ?? null,
    created_at: rule.created_at ?? null,
    updated_at: rule.updated_at ?? null,
    condition: metric
      ? `${metric.aggType ?? "avg"}(${metric.field ?? "?"}) ${firstCriterion?.comparator ?? ">"} ${
          firstCriterion?.threshold?.[0] ?? "?"
        }`
      : null,
    window:
      firstCriterion?.timeSize && firstCriterion?.timeUnit
        ? `last ${firstCriterion.timeSize}${firstCriterion.timeUnit}`
        : null,
    index_pattern: search?.index ?? null,
    kql_filter: search?.query?.query || null,
  };
}

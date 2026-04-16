---
name: create-alert-rule
description: >
  Create a persistent Kibana custom-threshold alerting rule against any metric field. Use when the user
  says "alert me when", "create a rule for", "page me if", "set up an alert", "add monitoring for",
  "notify when X exceeds Y", or wants durable (saved-object) alerting — as opposed to transient one-off
  watching (use `watch` for that). Backend-agnostic — works on any metric field in any index pattern
  (metrics-*, logs-*, traces-apm*, custom). Requires Kibana with the Alerting feature enabled.
---

# Create Alert Rule

Creates a **real, persistent Kibana alerting rule** — a saved object that will keep running after the MCP
session ends, evaluate on its schedule, and (if connected to an action) notify via Slack, email, webhook,
etc. Rules are tagged `elastic-o11y-mcp` so they're easy to find and clean up.

## Prerequisites

- **Kibana with Alerting enabled.** No specific backend — works on any numeric metric field in any index
  pattern.
- A notification connector must be attached separately in Kibana if the rule should page someone. Without
  an action, the rule fires silently (visible in Kibana → Alerts & Insights).

## Tools

| Tool | Purpose |
|------|---------|
| `create-alert-rule` | Create the Kibana rule. |
| `watch` | Alternative: transient, session-scoped monitoring that doesn't persist. |
| `apm-health-summary` / `ml-anomalies` | Before: identify the right metric and threshold empirically. |

## When to use this vs `watch`

| Use `create-alert-rule` when... | Use `watch` when... |
|---------------------------------|---------------------|
| User wants durable alerting ("page me from now on") | User wants one-off monitoring ("for the next 10 min") |
| Rule should keep running after session ends | Rule only matters inside the current conversation |
| An operator should be paged out-of-band | The agent is validating a remediation in real time |
| The threshold is well-understood | The threshold is still being calibrated |

## How to call create-alert-rule

```json
{
  "rule_name": "Frontend Pod Memory > 80MB",
  "metric_field": "k8s.pod.memory.working_set",
  "threshold": 80000000,
  "comparator": ">",
  "kql_filter": "kubernetes.namespace: otel-demo AND service.name: frontend",
  "check_interval": "1m",
  "agg_type": "avg",
  "time_size": 5,
  "time_unit": "m",
  "index_pattern": "metrics-*"
}
```

Parameter-filling guidance:

- **`rule_name`**: derive from user intent — make it descriptive and specific. Bad: "Memory rule." Good:
  "Frontend Pod Memory > 80MB (otel-demo)."
- **`metric_field`**: a real numeric field present in the index. Don't guess — if the user names a metric
  vaguely ("memory"), ask which field or cross-reference with `apm-health-summary` output first.
- **`threshold`**: in the field's native units. 80 MB as a `working_set` is `80000000` (bytes), not `80`.
  Always clarify units.
- **`comparator`**: default `>`. Use `<` for low-watermark rules ("fire if free memory drops below").
- **`kql_filter`**: narrow the scope — without a filter the rule applies to every document in the index.
  Strongly recommended for shared environments.
- **`check_interval`**: default `1m`. `30s` for fast-reacting, `5m` for noisy metrics.
- **`agg_type`**: default `avg`. Use `max` for worst-case (p99-ish), `count` for event frequency.
- **`time_size` + `time_unit`**: the aggregation window. Default 5m. Wider windows smooth; narrow windows
  react fast but can be noisy.
- **`index_pattern`**: default `metrics-*`. Override for `logs-*`, `traces-apm*`, or custom indices.

## After the tool returns

Response includes:
- `rule_id`: the Kibana saved-object ID.
- `cleanup_hint`: a one-line DELETE command for teardown.
- `message`: a human summary of what the rule does.

Confirm to the user:
1. **What was created**: quote the rule name and the condition ("will check avg(k8s.pod.memory.working_set)
   > 80MB every 1m over a 5m window").
2. **Where to find it**: "Kibana → Alerts & Insights → Rules. Tagged `elastic-o11y-mcp`."
3. **Notification gap**: if no actions were attached, explicitly say "this rule fires but doesn't notify
   anyone yet — attach an action in Kibana to page Slack/email/webhook."
4. **Cleanup**: include the cleanup hint so the user can reverse the action.

## Key principles

- **This persists.** You're creating a saved object the user will need to manage. Always confirm the rule
  name and condition back to them.
- **Attach a KQL filter.** Unfiltered rules against `metrics-*` evaluate across everything — a recipe for
  noise and false alerts.
- **Units matter.** Bytes vs MB vs percentage — always be explicit about the threshold's units.
- **Offer the cleanup hint.** A tech-preview rule should be easy to remove. Always surface the delete path.
- **If the user is still calibrating, suggest `watch` first.** Don't create durable rules until the
  threshold is validated.

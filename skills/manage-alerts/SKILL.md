---
name: manage-alerts
description: >
  CRUD for Kibana alerting rules — create, list, get, or delete custom-threshold rules. Use when the
  user says "alert me when", "create a rule for", "page me if", "set up an alert", "show me my rules",
  "what alerts do I have", "delete that alert", "remove the rule". Backend-agnostic — works on any
  metric field in any index pattern (metrics-*, logs-*, traces-apm*, custom). For transient
  session-scoped monitoring use `observe` instead. Requires Kibana with the Alerting feature enabled —
  the tool is auto-disabled when no Kibana URL is configured.
---

# Manage Alerts

CRUD for **real, persistent Kibana alerting rules** — saved objects that keep running after the MCP
session ends, evaluate on their schedule, and (if connected to actions) notify via Slack, email,
webhook, etc. Rules created through this tool are tagged `elastic-o11y-mcp` by default so they're
easy to find and clean up.

## Prerequisites

- **Kibana with Alerting enabled.** No specific backend — works on any numeric metric field in any
  index pattern.
- **Tool gating.** This tool only registers when the operator has explicitly set a Kibana URL in the
  MCP install config. If `kibana_url` is blank the tool doesn't appear in the LLM's tool catalog at
  all — a deliberate feature so operators can run the server strictly read-only (no rule creation,
  and more importantly no rule deletion). If the user can't see `manage-alerts`, their server is
  read-only on purpose.
- A notification connector must be attached separately in Kibana for rules that should page someone.
  Without an action, rules fire silently (visible in Kibana → Alerts & Insights).

## Operations

| Operation  | Purpose                                              |
|------------|------------------------------------------------------|
| `create`   | Create a new persistent custom-threshold rule.       |
| `list`     | List rules, optionally filtered by tags/name/type.   |
| `get`      | Fetch a single rule by id, with execution status.    |
| `delete`   | Permanently remove a rule by id. Irreversible.       |

## When to use this vs `observe`

| Use `manage-alerts` (create) when... | Use `observe` when... |
|--------------------------------------|---------------------|
| User wants durable alerting ("page me from now on") | User wants one-off monitoring ("for the next 10 min") |
| Rule should keep running after session ends | Rule only matters inside the current conversation |
| An operator should be paged out-of-band | The agent is validating a remediation in real time |
| The threshold is well-understood | The threshold is still being calibrated |

If the user is still calibrating, suggest `observe` first — don't create durable rules until the
threshold is validated.

## operation='create'

```json
{
  "operation": "create",
  "rule_name": "Frontend Pod Memory > 80MB",
  "metric_field": "k8s.pod.memory.working_set",
  "threshold": 80000000,
  "comparator": ">",
  "kql_filter": "kubernetes.namespace: otel-demo AND service.name: frontend",
  "check_interval": "5m",
  "agg_type": "avg",
  "time_size": 5,
  "time_unit": "m",
  "index_pattern": "metrics-*"
}
```

Parameter-filling guidance:

- **`rule_name`**: derive from user intent — make it descriptive and specific. Bad: "Memory rule."
  Good: "Frontend Pod Memory > 80MB (otel-demo)."
- **`metric_field`**: a real numeric field present in the index. Don't guess — if the user names a
  metric vaguely ("memory"), ask which field or cross-reference with `apm-health-summary` output first.
- **`threshold`**: in the field's native units. 80 MB as a `working_set` is `80000000` (bytes), not
  `80`. Always clarify units.
- **`comparator`**: default `>`. Use `<` for low-watermark rules ("fire if free memory drops below").
- **`kql_filter`**: narrow the scope — without a filter the rule applies to every document in the
  index. Strongly recommended for shared environments.
- **`check_interval`**: default `5m` (matches Kibana's own default and pairs with the 5m lookback).
  Use `1m` only for pageable SLO breaches where the extra reactivity is worth the cycles; `15m`–`1h`
  for capacity or trend rules.
- **`agg_type`**: default `avg`. Use `max` for worst-case (p99-ish), `count` for event frequency.
- **`time_size` + `time_unit`**: the aggregation window. Default 5m. Wider windows smooth; narrow
  windows react fast but can be noisy.
- **`index_pattern`**: default `metrics-*`. Override for `logs-*`, `traces-apm*`, or custom indices.

## operation='list'

```json
{
  "operation": "list",
  "search": "memory",
  "per_page": 50
}
```

- **`tags`**: **omit by default** — the tool returns every alert rule in Kibana. Only pass
  `["elastic-o11y-mcp"]` when the user qualifies the request as scoped to this app:
  - "what rules did I create here / from this app" → `tags: ["elastic-o11y-mcp"]`
  - "show me my alerts" / "what alerts do I have" / "list all rules" → omit (show everything)
  - The view itself has a one-click toggle between "all rules" and "MCP-created rules", so users
    can switch without re-prompting. Don't pre-filter unless they asked.
- **`search`**: optional substring match against rule name.
- **`rule_type_ids`**: optional filter — e.g. `["observability.rules.custom_threshold"]`. Omit to
  include every rule type.
- **`per_page`** / **`page`**: standard pagination. Default 50 per page.

Response includes a `rules` array with a compact summary (name, condition, status, tags) per rule,
and the view renders each as a card with Inspect / Delete buttons.

## operation='get'

```json
{ "operation": "get", "rule_id": "c5f2e1b8-..." }
```

Returns the full rule definition plus execution status. Typical chain: `list` → user picks one → `get`.

## operation='delete'

**Two-step flow, enforced in the tool itself.** The tool refuses to delete anything without an
explicit `confirm: true` — on the first call you get a preview back, then you re-invoke with
`confirm: true` after the user approves.

**Step 1 — preview (omit `confirm` or pass `confirm: false`):**

```json
{ "operation": "delete", "rule_id": "c5f2e1b8-..." }
```

Response shape: `{ operation: "delete", deleted: false, confirmation_required: true, preview: {...} }`.
The `preview` contains the full rule summary (name, condition, tags, etc.). Nothing has been deleted
yet — the tool only fetched the rule.

Your job on seeing a preview:

1. **Quote the rule name (not just the id) back to the user.** "Delete rule 'Frontend Pod Memory >
   80MB' (id c5f2…)? This is irreversible."
2. **Wait for explicit approval.** "yes", "go ahead", "delete it" — not a vague "sure".
3. **If the user approves, dispatch Step 2. If they decline or hesitate, do nothing.**

**Step 2 — confirmed delete (pass `confirm: true`):**

```json
{ "operation": "delete", "rule_id": "c5f2e1b8-...", "confirm": true }
```

Only call this after the user has explicitly approved in the current turn. The Kibana saved object
is gone the moment the API returns 204; there is no undo.

**Never** pass `confirm: true` on the first invocation from a vague instruction like "clean up the
alerts". Always `list` first, preview each candidate, and confirm before every delete.

**Never** batch-delete multiple rules in one exchange unless the user has explicitly authorized it
with specific IDs or a clear scope ("delete all three of those").

## After the tool returns

All operations emit a common response envelope:
- `status`: `"success" | "error"`.
- `operation`: echoes the operation for view rendering.
- `message`: human-readable summary.
- `investigation_actions`: click-to-send next-step prompts (chain to `list`, `get`, `delete`, or
  `observe` as appropriate).

Ignore `_setup_notice` if present — it's view-side chrome (welcome banner) that the UI handles. Don't
echo or summarize it in chat.

`create` additionally returns `rule_id` and `cleanup_hint` (a one-line DELETE instruction plus the
equivalent `manage-alerts` call).

`list` returns `total`, `returned`, `page`, and a `rules` array.

`get` returns the full rule as `rule` (summary) and `raw_rule` (unfiltered Kibana response).

`delete` returns `rule_id` and `deleted: true`.

The MCP App view renders the appropriate layout per operation: a created-rule card for `create`, a
detail card for `get`, a list of rule cards with Inspect/Delete buttons for `list`, and a deletion
confirmation for `delete`.

Confirm to the user after each operation:

- **create**: quote the rule name and condition. Mention Kibana → Alerts & Insights → Rules. If no
  actions are attached, say so: "this rule fires but doesn't notify anyone yet — attach an action in
  Kibana to page Slack/email/webhook." Offer the cleanup hint.
- **list**: how many rules were found and what filter was applied. If you defaulted to the
  `elastic-o11y-mcp` tag, mention that the user can pass `tags: []` to see everything.
- **get**: summarize the rule's state — enabled/disabled, last execution, active alert count.
- **delete**: confirm the deletion and suggest a follow-up `list` to verify.

## Key principles

- **These are persistent, real saved objects.** Always confirm the rule name and condition back to
  the user after `create` and `delete`.
- **Attach a KQL filter on `create`.** Unfiltered rules against `metrics-*` evaluate across
  everything — a recipe for noise and false alerts.
- **Units matter.** Bytes vs MB vs percentage — always be explicit about the threshold's units.
- **Default `list` to ALL rules.** Unqualified prompts ("show me my alerts", "what alerts do I have")
  return every rule in Kibana — that's almost always what the user wants when they ask broadly.
  Apply `tags: ["elastic-o11y-mcp"]` only when they qualify with "this app" / "rules I created here"
  / similar. The view has a one-click toggle for users to switch states without a re-prompt.
- **Confirm before deleting.** The delete path is irreversible; quote the rule name, wait for
  explicit approval.
- **If the tool isn't available, the operator disabled it on purpose.** Don't suggest workarounds to
  create rules via raw ES / Kibana API calls — respect the read-only posture.

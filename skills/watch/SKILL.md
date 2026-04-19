---
name: watch
description: >
  The agent's "wait-and-see" primitive. Four modes: wait for an ML anomaly to fire, poll an ES|QL
  metric (live-sample or wait for a threshold), read a single-instance scalar value, or return a
  full ES|QL table. Use when the user says "tell me when...", "let me know if...", "wait until X
  drops below Y", "watch for anything unusual", "monitor for the next N minutes", "poll until
  stable", "what is X right now", "list …", "which … are …", or wants transient (session-scoped)
  monitoring or ad-hoc querying without creating a persistent Kibana rule. Also trigger for "keep
  an eye on" and post-remediation validation.
---

# Watch

Transient, session-scoped monitoring. Unlike `create-alert-rule` (which creates a durable saved
object in Kibana), `watch` polls in-process and returns once fired, once its window closes, or
— in `now` mode — immediately.

## Modes

| Mode | When to pick it | Blocks? |
|------|-----------------|---------|
| `anomaly` (default) | "tell me when anything unusual fires", "watch for anomalies", open-ended monitoring | Until an anomaly fires or `max_wait` elapses |
| `metric` | user names a specific metric — either with a threshold ("wait until memory drops below 80MB") or without ("show me a live chart of X") | Polls for `max_wait` seconds (default 60s, interval 5s) |
| `now` | "what is X right now", "check X", "current value of Y" — single-instance **scalar** read | Returns immediately |
| `table` | "list …", "which … are …", group-by / top-N queries, or any ES\|QL result with mixed-type columns | Returns immediately |

If the user wants durable alerting ("page me whenever..."), use `create-alert-rule` instead.

## Prerequisites

| Mode | Requires |
|------|----------|
| `anomaly` | Elastic ML anomaly detection jobs |
| `metric` | Any ES\|QL-queryable numeric field |
| `now` | Any ES\|QL-queryable numeric field |
| `table` | Any ES\|QL-queryable data |

## How to call watch

### Anomaly mode (default)

```json
{
  "mode": "anomaly",
  "min_score": 75,
  "max_wait": 600,
  "namespace": "otel-demo"
}
```

- `min_score`: 75 default (major+), 50 for minor inclusion, 90 for critical-only.
- `max_wait`: generous (600s default). Returns immediately on trigger — long waits are free.
- `namespace`: only if the user scopes to a K8s namespace.

### Metric mode — threshold watch

```json
{
  "mode": "metric",
  "esql": "FROM metrics-kubeletstatsreceiver.otel* | WHERE resource.attributes.k8s.pod.name == \"frontend-7d4b8f9c5-x2k9m\" | STATS v = AVG(metrics.k8s.pod.memory.working_set)",
  "condition": "< 80000000",
  "description": "frontend pod memory working set",
  "max_wait": 300
}
```

Condition format: `<comparator> <threshold>` — valid comparators: `<`, `<=`, `>`, `>=`, `==`.

### Metric mode — live sample (no threshold)

Omit `condition` and the tool live-samples for the full `max_wait` window — use for
"show me a live chart of X" prompts. The view renders an accumulating sparkline.

```json
{
  "mode": "metric",
  "esql": "FROM metrics-kubeletstatsreceiver.otel* | WHERE resource.attributes.k8s.namespace.name == \"oteldemo-esyox-default\" | STATS v = AVG(metrics.k8s.pod.memory.working_set)",
  "description": "oteldemo-esyox-default avg pod memory",
  "max_wait": 60
}
```

### Now mode — single read

```json
{
  "mode": "now",
  "esql": "FROM metrics-kubeletstatsreceiver.otel* | WHERE resource.attributes.k8s.namespace.name == \"oteldemo-esyox-default\" | STATS v = AVG(metrics.k8s.pod.memory.working_set)",
  "description": "current avg pod memory in oteldemo-esyox-default"
}
```

### Table mode — full ES|QL rows and columns

Use when the query groups, lists, or returns mixed-type rows (strings + numbers + dates). `now` mode
discards everything except the first numeric cell — `table` mode preserves the whole result.

```json
{
  "mode": "table",
  "esql": "FROM metrics-kubeletstatsreceiver.otel* | WHERE metrics.k8s.pod.memory.working_set IS NOT NULL | STATS avg_mem = AVG(metrics.k8s.pod.memory.working_set) BY resource.attributes.k8s.pod.name, resource.attributes.k8s.namespace.name | SORT avg_mem DESC | LIMIT 10",
  "description": "top 10 pods by memory"
}
```

Rows are capped at 50 by default. Prefer tightening the ES|QL with `LIMIT` / `SORT` over raising
`row_cap` — very wide tables clog the context window.

## Picking the right index pattern

Fields live where the data is emitted — ES|QL rejects queries that reference a field the
target index doesn't map (`verification_exception`). Before writing the query, match the
user's question to the right layer:

| User asks about… | Index | Carries |
|---|---|---|
| Node / pod / namespace topology, resource usage | `metrics-kubeletstatsreceiver.otel*` or `metrics-*` | `k8s.node.name`, `k8s.pod.name`, `k8s.namespace.name`, `service.name` (via resource attrs), CPU/memory/fs gauges |
| Service behavior — latency, errors, throughput, spans | `traces-*.otel-*` or `traces-apm*` | `service.name`, `transaction.duration.us`, `event.outcome`, `span.*` |
| Log rate / log content | `logs-*` | `message`, `log.level`, `service.name` |
| ML anomalies | `.ml-anomalies-*` | `record_score`, `by_field_value`, `partition_field_value` |

Cross-layer questions ("which **node** runs the most **services**") need the index that
carries **both** fields — that's almost always `metrics-*`, because OTel resource
attributes propagate through the Collector, so metrics docs carry `k8s.node.name` *and*
`service.name`. Trace indices (`traces-apm*`, `traces-*.otel-*`) don't carry infra
attributes like `k8s.node.name` — don't reach for them when the question is about nodes.

Example: "which node is running the most services"

```
FROM metrics-*
| WHERE @timestamp > NOW() - 5m AND k8s.node.name IS NOT NULL AND service.name IS NOT NULL
| STATS service_count = COUNT_DISTINCT(service.name) BY k8s.node.name
| SORT service_count DESC
| LIMIT 20
```

## Common query patterns

These are the field paths this deployment's data actually uses — prefer them over guessing.

### OTel Kubernetes (kubeletstats receiver)

Index: `metrics-kubeletstatsreceiver.otel*`

| Signal | Field |
|--------|-------|
| Pod memory working set (bytes) | `metrics.k8s.pod.memory.working_set` |
| Pod CPU (cores) | `metrics.k8s.pod.cpu.usage` |
| Pod name | `resource.attributes.k8s.pod.name` |
| Namespace | `resource.attributes.k8s.namespace.name` |
| Node | `resource.attributes.k8s.node.name` |

Namespace-wide memory average:

```
FROM metrics-kubeletstatsreceiver.otel*
| WHERE resource.attributes.k8s.namespace.name == "oteldemo-esyox-default"
| STATS v = AVG(metrics.k8s.pod.memory.working_set)
```

Single pod CPU:

```
FROM metrics-kubeletstatsreceiver.otel*
| WHERE resource.attributes.k8s.pod.name == "frontend-7d4b8f9c5-x2k9m"
| STATS v = AVG(metrics.k8s.pod.cpu.usage)
```

### APM traces

Index: `traces-apm*` or `traces-generic.otel*`

| Signal | Field |
|--------|-------|
| Transaction duration (µs) | `transaction.duration.us` |
| Service name | `service.name` |
| Transaction name | `transaction.name` |
| Outcome | `event.outcome` |

Service p95 latency:

```
FROM traces-apm*
| WHERE service.name == "checkout" AND @timestamp > NOW() - 5m
| STATS v = PERCENTILE(transaction.duration.us, 95)
```

Error rate for a service:

```
FROM traces-apm*
| WHERE service.name == "checkout" AND @timestamp > NOW() - 5m
| STATS errors = COUNT(*) WHERE event.outcome == "failure", total = COUNT(*)
| EVAL v = errors / total
| KEEP v
```

### Log rate

Index: `logs-*`

```
FROM logs-*
| WHERE service.name == "cartservice" AND @timestamp > NOW() - 5m
| STATS v = COUNT(*)
```

### Query-construction rules

- For `now` and `metric` mode, the query must return a single row with a numeric first column —
  the tool reads the first numeric cell. For `table` mode this restriction doesn't apply: any
  shape is fine.
- Scope with `@timestamp > NOW() - <window>` when the user implies "right now" (default 5m is
  usually fine; let the window match the user's language).
- When the user names a namespace, match it exactly (e.g. `oteldemo-esyox-default`, not
  `otel-demo`). If unsure, call `apm-health-summary` first — its `namespace_candidates` field
  surfaces fuzzy matches.
- **Match the aggregation to the field's storage shape.** Most metric fields in
  `metrics-kubeletstatsreceiver.otel*` are **gauges** (`memory.working_set`, `cpu.usage`,
  `memory.available`). Use `AVG` / `MAX` / `MIN` on gauges. **Do not `SUM` a gauge** — it will add
  every ~15s kubelet sample over your window and inflate the value by hundreds or thousands. Reserve
  `SUM` for pre-aggregated counters (e.g. `service_summary` on `metrics-service_summary.1m.otel-*`
  is a per-minute rollup designed to sum). If unsure, prefer `AVG` or `MAX`.

## After the tool returns

The watch MCP App view renders inline in one of several modes, picked automatically from the result:

- **Now mode (`status: NOW`)** — compact card: big unit-formatted number, ES|QL subtitle, "evaluated
  Xs ago" stamp, and three follow-up actions (re-check, escalate to live watch, create alert rule).
- **Metric mode** — area + line + dots sparkline with optional threshold line; stat cards for
  current / threshold / peak / baseline. Covers `CONDITION_MET`, `TIMEOUT`, and `SAMPLED`.
- **Anomaly mode** — severity-scored trigger card with affected entities and click-to-send
  investigation prompts.
- **Table mode (`status: TABLE`)** — styled HTML table with column headers, type-aware alignment
  (numeric right, text left), and zebra-striped rows. Row count + truncation notice in the subtitle.
- **Error (`status: ERROR`)** — red-toned card with the ES|QL failure message verbatim. Surfaces
  instead of throwing when the query is bad (unknown field, index missing, syntax error).

All modes surface an `investigation_actions` list as buttons. Follow up in chat too — don't rely
on the buttons alone.

### Status-by-status guidance

- **`NOW`** — State the value plainly. Offer to escalate to a live watch if the user seems to want
  ongoing visibility.
- **`TABLE`** — Summarize what the rows show (top entity, total count, any outliers). Don't just
  dump the full table back — the user can read the widget. If the result was truncated, say so and
  offer to tighten the ES|QL.
- **`ERROR`** — Read the error message, explain what likely went wrong (unknown field, index
  pattern, syntax), and propose a corrected query. Don't retry blindly.
- **`ALERT`** (anomaly fired) — The response includes affected entities, affected services, top
  anomalies, and `investigation_hints` naming the next tool to reach for. **Follow those hints
  immediately** — don't just report the alert, start investigating and narrate your reasoning.
- **`CONDITION_MET`** (metric threshold satisfied) — Confirm to the user and describe the trend
  from the returned history. If this was post-remediation validation, explicitly state the fix has
  been validated. Offer to graduate the condition into a durable rule via `create-alert-rule`.
- **`SAMPLED`** (live sample completed without a condition) — Summarize the trend (trending up /
  down / flat, peak, typical). Offer "keep watching" (extend window) or graduate to an alert rule.
- **`TIMEOUT`** (metric condition never met) — Tell the user the metric didn't stabilize. Suggest
  follow-ups: check `ml-anomalies`, persist as alert rule, re-examine the ES|QL.
- **`QUIET`** (anomaly mode, nothing fired) — Suggest adjustments: lower `min_score`, widen
  `lookback`, verify ML jobs are running.

## Accumulating timelines

Every metric-mode response includes a `watch_key` derived from `esql + condition`. When Claude
re-invokes watch with the same ES|QL (e.g. via the "Extend watch (+60s)" button), the view merges
the new samples into the existing sparkline instead of resetting — so the user sees a continuous
timeline across multiple tool calls. To keep this continuity, reuse the exact same ES|QL string
and condition when extending. Capped at 240 points to keep the chart readable.

## Tools

| Tool | Purpose |
|------|---------|
| `watch` | Polls and blocks. Four modes: `anomaly`, `metric`, `now`, `table`. |
| `ml-anomalies` | Follow-up: deeper look at the anomaly that fired. |
| `apm-service-dependencies` | Follow-up: topology of affected services (if APM available). |
| `apm-health-summary` | Follow-up: cluster-wide context, and useful for discovering which namespaces actually have data. |
| `k8s-blast-radius` | Follow-up: infra impact if a node is implicated. |
| `create-alert-rule` | Graduate to persistent alerting once the pattern is well-understood. |

## Key principles

- **Watch is transient.** Nothing is saved. If the user wants an ongoing rule, use `create-alert-rule`.
- **Pick the mode from the user's phrasing.** "What is X right now" (scalar) → `now`. "Show me a
  live chart of X" or "watch X for 60s" → `metric` (no condition). "Wait until X drops below Y" →
  `metric` (with condition). "Tell me when anything unusual fires" → `anomaly`. "List …", "which
  pods are on node X", "top N by Y" → `table`. If a user asks "what is X" and X is actually a list
  or grouping (not a single number), pick `table`, not `now`.
- **Use the known field paths.** Don't probe generic `metrics-*` patterns when the deployment
  indexes under `metrics-kubeletstatsreceiver.otel*`. The cheat sheet above is authoritative for
  this environment.
- **On ALERT, start investigating immediately.** The `investigation_hints` are suggestions —
  follow them and narrate your reasoning.
- **Don't over-tune `min_score`.** 75 catches the important stuff; dropping below 50 produces noise.

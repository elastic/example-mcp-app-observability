---
name: observe
description: >
  The agent's Elastic-access primitive. Four modes: wait for an ML anomaly to fire, poll an ES|QL
  metric (live-sample or wait for a threshold), read a single-instance scalar value, or return a
  full ES|QL table. Use when the user says "tell me when...", "let me know if...", "wait until X
  drops below Y", "watch for anything unusual", "monitor for the next N minutes", "poll until
  stable", "what is X right now", "list …", "which … are …", or wants transient (session-scoped)
  monitoring or ad-hoc querying without creating a persistent Kibana rule. Also trigger for "keep
  an eye on" and post-remediation validation.
---

# Observe

Transient, session-scoped monitoring and ad-hoc querying. Unlike `manage-alerts` (which
creates a durable saved object in Kibana), `observe` polls in-process and returns once fired,
once its window closes, or — in `now` / `table` mode — immediately.

## Modes

### Decision tree — pick based on tense FIRST, then on shape

```
Does the user phrase it as past or future?

PAST tense / windowed lookback                    FUTURE tense / live monitoring
("what WAS / over the past N /                    ("watch / monitor / wait until /
 in the last N / how did X look")                  live-sample / for the NEXT N")
       │                                                  │
       ▼                                                  ▼
Is it a single number or a series?                Is there a threshold to fire on?
       │                                                  │
   ┌───┴────┐                                          ┌──┴──┐
single   series                                       yes    no
   │        │                                          │      │
   ▼        ▼                                          ▼      ▼
 now     table                                      metric  metric
                                                    (with    (live-
                                                  condition) sample)

Other:
  • "tell me when anything unusual fires" → anomaly (default)
  • "list X / which X are Y / top N" (any tense) → table
  • "page me whenever..." → use manage-alerts instead
```

| Mode | When to pick it | Blocks? |
|------|-----------------|---------|
| `now` | **Past-tense windowed scalar.** "What was X right now / over the past 60 seconds / in the last 15 minutes / average X for the last hour". Put the window inside the ES\|QL via `WHERE @timestamp > NOW() - <window>`. Single number out. | Returns immediately |
| `table` | **Past-tense time series OR group-by.** "How did X look over the past hour" (with `BUCKET()` for the chart), "list X", "which X are Y", any group-by / top-N. The view auto-charts 2-column time-series tables. | Returns immediately |
| `metric` | **Forward-looking only.** "Watch X", "wait until X drops", "live-sample X for the next 60s", "wake me when X exceeds Y". Polls live for `max_wait` seconds. **Never use this for past-tense / "what was X" queries** — it will block for `max_wait` seconds before returning a value, which is the opposite of what the user asked. | Polls for `max_wait` seconds (default 60s) |
| `anomaly` (default) | "Tell me when anything unusual fires", open-ended monitoring | Until an anomaly fires or `max_wait` elapses |

> ⚠️ **Most common mistake: picking `metric` for a past-tense query.** A prompt like "what was the frontend memory over the past 60 seconds?" is asking about data that already exists — it's a windowed lookup, not a request to wait 60 more seconds and watch. Always inspect the verb before choosing `metric`:
>
> - **was / were / averaged / hit / spiked / over the past / in the last / for the last** → `now` or `table`. NEVER `metric`.
> - **watch / monitor / poll / wait until / wake me / for the next / until X happens / live-sample** → `metric`.
>
> If the user wants durable alerting ("page me whenever..."), use `manage-alerts` instead.
>
> ⚠️ **Don't use observe for health rollups.** "Show me the health of X", "status of the X
> environment", "how is X doing" — even with a time qualifier like "over the past hour" — should
> route to `apm-health-summary`, not observe. observe is for raw-metric / single-query investigations;
> apm-health-summary returns the full rollup (degraded services, anomalies, pod resources). Pick
> apm-health-summary whenever the user is asking a HEALTH question rather than a specific metric
> question.

## Prerequisites

| Mode | Requires |
|------|----------|
| `anomaly` | Elastic ML anomaly detection jobs |
| `metric` | Any ES\|QL-queryable numeric field |
| `now` | Any ES\|QL-queryable numeric field |
| `table` | Any ES\|QL-queryable data |

## How to call observe

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

### Metric mode — threshold condition

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

**Past-tense windowed read** — when the user asks "what was X over the past N seconds/minutes/hours", put the window in the ES\|QL `WHERE` clause, not in `max_wait`. The tool returns immediately with the aggregate; nothing is polled.

```json
{
  "mode": "now",
  "esql": "FROM metrics-kubeletstatsreceiver.otel* | WHERE resource.attributes.k8s.pod.name == \"frontend-7d4b8f9c5-x2k9m\" AND @timestamp > NOW() - 60 seconds | STATS v = AVG(metrics.k8s.pod.memory.working_set)",
  "description": "frontend memory, last 60 seconds (avg)"
}
```

If the user wants the time series (not just one number), use `table` mode with `BUCKET()` instead — that returns rows the view can chart.

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

**Past-tense time series** — use `table` with `BUCKET()` to return one row per time slice the view can chart:

```json
{
  "mode": "table",
  "esql": "FROM metrics-kubeletstatsreceiver.otel* | WHERE resource.attributes.k8s.pod.name == \"frontend-7d4b8f9c5-x2k9m\" AND @timestamp > NOW() - 60 seconds | STATS v = AVG(metrics.k8s.pod.memory.working_set) BY bucket = BUCKET(@timestamp, 5 second) | SORT bucket ASC",
  "description": "frontend memory · 60s · 5s buckets"
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

Each kubeletstats scrape emits **separate documents per metric** — a CPU doc, a memory doc, a network doc, etc. Always filter `WHERE <field> IS NOT NULL` for the field you're aggregating, otherwise most rows carry nulls for it.

**Gauge fields — use `AVG` / `MAX` / `MIN`, never `SUM`:**

| Signal | Field | Type |
|--------|-------|------|
| Pod memory working set | `k8s.pod.memory.working_set` | `long` (bytes) |
| Pod memory RSS | `k8s.pod.memory.rss` | `long` (bytes) |
| Pod memory available | `k8s.pod.memory.available` | `long` (bytes) |
| Pod CPU usage | `k8s.pod.cpu.usage` | `double` (cores — 1.0 = one full core) |
| Pod filesystem usage | `k8s.pod.filesystem.usage` | `long` (bytes) |
| Node memory working set | `k8s.node.memory.working_set` | `long` (bytes) |
| Node memory available | `k8s.node.memory.available` | `long` (bytes) |
| Node CPU usage | `k8s.node.cpu.usage` | `double` (cores) |
| Node filesystem usage | `k8s.node.filesystem.usage` | `long` (bytes) |

> For **counter** fields (network I/O, network errors, uptime), see the "Counter fields" section below — these require `TS` + `RATE()`.

**Dimension fields — use for filtering and `BY` grouping:**

| Dimension | Unprefixed | Prefixed (equivalent) |
|---|---|---|
| Pod name | `k8s.pod.name` | `resource.attributes.k8s.pod.name` |
| Namespace | `k8s.namespace.name` | `resource.attributes.k8s.namespace.name` |
| Node name | `k8s.node.name` | `resource.attributes.k8s.node.name` |
| Cluster name | `k8s.cluster.name` | (same) |

Both forms work on `metrics-kubeletstatsreceiver.otel*`. Prefer the unprefixed form — it's shorter and also works on counter-field queries via `TS`.

**Common recipes:**

Top pods by memory (last 5m, across all namespaces):

```
FROM metrics-kubeletstatsreceiver.otel*
| WHERE @timestamp > NOW() - 5 minutes AND k8s.pod.memory.working_set IS NOT NULL
| STATS avg_mem = AVG(k8s.pod.memory.working_set),
        max_mem = MAX(k8s.pod.memory.working_set)
  BY k8s.pod.name, k8s.namespace.name
| SORT max_mem DESC
| LIMIT 20
```

Which pods are on a specific node:

```
FROM metrics-kubeletstatsreceiver.otel*
| WHERE @timestamp > NOW() - 5 minutes
  AND k8s.node.name == "<node>" AND k8s.pod.name IS NOT NULL
| STATS last_seen = MAX(@timestamp) BY k8s.pod.name, k8s.namespace.name
| SORT last_seen DESC
```

Namespace-wide memory average (single scalar — works in `now`/`metric` mode):

```
FROM metrics-kubeletstatsreceiver.otel*
| WHERE k8s.namespace.name == "oteldemo-esyox-default"
  AND k8s.pod.memory.working_set IS NOT NULL
| STATS v = AVG(k8s.pod.memory.working_set)
```

Is this node under memory pressure (working-set vs available):

```
FROM metrics-kubeletstatsreceiver.otel*
| WHERE @timestamp > NOW() - 5 minutes
  AND k8s.node.name == "<node>" AND k8s.node.memory.working_set IS NOT NULL
| STATS working_set = AVG(k8s.node.memory.working_set),
        available = AVG(k8s.node.memory.available)
```

### Counter fields — require `TS` + `RATE()`

Network I/O, network errors, and uptime fields are stored as monotonically-increasing counters (`counter_long`), **not** instantaneous gauges. `FROM` + `MAX`/`AVG`/`SUM`/`VALUES` on a counter field is a hard error — ES|QL returns `argument of [...] must be [...numeric except counter types]`.

Counter fields in this deployment:

| Field | Notes |
|---|---|
| `k8s.pod.network.io` | bytes, carries `direction` attribute (`transmit` / `receive`) — emitted as separate docs per direction |
| `k8s.pod.network.errors` | error count, also carries `direction` |
| `k8s.node.network.io`, `k8s.node.network.errors` | node-level equivalents |
| `k8s.node.uptime`, `k8s.pod.uptime` | seconds since start |

**Correct pattern:** use `TS` as the source command, wrap `RATE()` in an aggregation, filter the counter field `IS NOT NULL`, and group by `direction` whenever you query network fields.

Network throughput by cluster, last 15m (result in bytes/sec):

```
TS metrics-kubeletstatsreceiver.otel*
| WHERE @timestamp > NOW() - 15 minutes
  AND k8s.pod.network.io IS NOT NULL
| STATS rate_bps = AVG(RATE(k8s.pod.network.io))
  BY k8s.cluster.name, direction
| SORT rate_bps DESC
```

Rules:
- `TS`, not `FROM`. `FROM` will be rejected.
- Wrap `RATE()` in `AVG()` (or similar) when grouping — bare `RATE(...) BY ...` is rejected.
- Network counters are emitted as **separate docs per direction**. Without `BY direction` or a `direction == "..."` filter, transmit and receive aggregate into a meaningless combined number.
- Without `IS NOT NULL` the query spans many kubeletstats docs that carry a different metric — you get nulls, not errors.

**Escape hatch — raw counter snapshot:** if you want the current counter value (e.g. "how long has node X been up"), cast first. `TO_LONG` strips the counter type and unlocks standard aggregations:

```
FROM metrics-kubeletstatsreceiver.otel*
| WHERE @timestamp > NOW() - 5 minutes AND k8s.node.uptime IS NOT NULL
| EVAL u = TO_LONG(k8s.node.uptime)
| STATS uptime_s = MAX(u) BY k8s.node.name
```

### APM traces

Primary index: `traces-*.otel-*` (OTel-native). Fallback: `traces-apm*` (classic APM — only if the OTel path returns empty).

In EDOT-ingested clusters, `traces-*.otel-*` carries **both** OTel-native fields (`duration`, `kind`, `status.code`) and classic-APM-compatible fields (`processor.event`, `event.outcome`, `transaction.duration.us` on transaction-level docs). The cluster's "APM-ness" isn't determined by the index — it's determined by which field shape you query.

| Signal | OTel-native (preferred) | Classic APM |
|---|---|---|
| Duration | `duration` (nanoseconds, long, populated on every span) | `transaction.duration.us` (microseconds, populated only on `processor.event == "transaction"` docs) |
| Error signal | `event.outcome == "failure"` — **use this**, 100% populated | `status.code == "Error"` (sparse; only set when instrumentation explicitly calls `SetStatus`) |
| Error message / type / stacktrace | `exception.message`, `exception.type`, `exception.stacktrace` | `error.message`, `error.exception.type`, `error.stack_trace` |
| Span kind | `kind` — values `Server`, `Internal`, `Client`, `Producer`, `Consumer` (**title case**, not `SERVER`/`CLIENT`) | `transaction.type` |
| Scope filter | `kind == "Server"` isolates incoming requests | `processor.event == "transaction"` |
| Service name | `service.name` | `service.name` |

> **Unit warning.** OTel `duration` is in **nanoseconds**. Divide by 1,000,000 for milliseconds. Classic `transaction.duration.us` is in **microseconds** — divide by 1,000. Mixing these across a comparison produces wildly wrong numbers.

> **Error-field warning.** On `traces-*.otel-*` the exception attributes use the `exception.*` namespace, **not** `error.*`. Querying `error.message` / `error.type` against an OTel-native index returns `verification_exception: Unknown column [error.message], did you mean any of [exception.message, message]?`. The `error.*` family belongs only to classic-APM `traces-apm*` documents. When you see the user ask "show me the error messages from X", reach for `exception.message` first.

Service p95 latency (OTel-native), last 15m — result in ms:

```
FROM traces-*.otel-*
| WHERE service.name == "checkout" AND @timestamp > NOW() - 15 minutes
  AND kind == "Server"
| STATS p95_ms = PERCENTILE(duration, 95) / 1000000
```

Error rate for a service — `event.outcome` is reliable here:

```
FROM traces-*.otel-*
| WHERE service.name == "checkout" AND @timestamp > NOW() - 15 minutes
  AND kind == "Server"
| STATS errors = COUNT(*) WHERE event.outcome == "failure", total = COUNT(*)
| EVAL error_rate_pct = ROUND(errors * 100.0 / total, 2)
| KEEP error_rate_pct, errors, total
```

Recent exception messages from a service (OTel-native) — `exception.message` lives on the same trace docs as the failed spans:

```
FROM traces-*.otel-*
| WHERE service.name == "checkout" AND @timestamp > NOW() - 15 minutes
  AND event.outcome == "failure"
  AND exception.message IS NOT NULL
| KEEP @timestamp, exception.type, exception.message
| SORT @timestamp DESC
| LIMIT 50
```

Classic-APM equivalent — only when the OTel path returns empty:

```
FROM traces-apm*
| WHERE service.name == "checkout" AND @timestamp > NOW() - 15 minutes
  AND processor.event == "error"
| KEEP @timestamp, error.exception.type, error.message
| SORT @timestamp DESC
| LIMIT 50
```

If `traces-*.otel-*` returns empty, the deployment is classic-APM-only — fall back to `traces-apm*` with `processor.event == "transaction"` and `transaction.duration.us`.

**Throughput trend — use the pre-aggregated rollup when possible.** `metrics-service_summary.1m.otel-*` carries per-minute request counts in `service_summary` (a regular `long`, designed to `SUM`). Cheaper and faster than scanning raw traces for "how many requests/min over the last hour":

```
FROM metrics-service_summary.1m.otel-*
| WHERE service.name == "frontend" AND @timestamp > NOW() - 1 hour
| STATS throughput = SUM(service_summary)
  BY bucket = BUCKET(@timestamp, 1 minute)
| SORT bucket ASC
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
- **Match the aggregation to the field's storage shape.** Three shapes to recognize:
  - **Gauges** (`memory.working_set`, `memory.available`, `cpu.usage`, `filesystem.usage` in
    `metrics-kubeletstatsreceiver.otel*`): use `AVG` / `MAX` / `MIN`. **Do not `SUM` a gauge** — it
    will add every ~15s kubelet sample over your window and inflate the value by hundreds or
    thousands.
  - **Counters** (`k8s.pod.network.io`, `k8s.node.uptime`, etc. — `counter_long` type): require
    `TS` + `RATE()`. See the "Counter fields" section above. `FROM` + `MAX`/`AVG`/`SUM` on a
    counter is a hard error, not a silent wrong number.
  - **Pre-aggregated rollups** (`service_summary` on `metrics-service_summary.1m.otel-*`,
    `span.destination.service.response_time.count` on `metrics-service_destination.1m.otel-*`):
    designed for `SUM` across the window. Each doc is already a per-minute bucket count.

## After the tool returns

Ignore `_setup_notice` if present in the response — it's view-side chrome (welcome banner or
skill-gap hint when a query failed in a way the skill would have prevented). The UI surfaces it
as a banner; don't echo or summarize it in chat.

The observe MCP App view renders inline in one of several modes, picked automatically from the result:

- **Now mode (`status: NOW`)** — compact card: big unit-formatted number, ES|QL subtitle, "evaluated
  Xs ago" stamp, and three follow-up actions (re-check, escalate to live observation, create alert rule).
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

- **`NOW`** — State the value plainly. Offer to escalate to a live observation if the user seems to
  want ongoing visibility.
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
  been validated. Offer to graduate the condition into a durable rule via `manage-alerts`.
- **`SAMPLED`** (live sample completed without a condition) — Summarize the trend (trending up /
  down / flat, peak, typical). Offer "keep observing" (extend window) or graduate to an alert rule.
- **`TIMEOUT`** (metric condition never met) — Tell the user the metric didn't stabilize. Suggest
  follow-ups: check `ml-anomalies`, persist as alert rule, re-examine the ES|QL.
- **`QUIET`** (anomaly mode, nothing fired) — Suggest adjustments: lower `min_score`, widen
  `lookback`, verify ML jobs are running.

## Accumulating timelines

Every metric-mode response includes an `observe_key` derived from `esql + condition`. When Claude
re-invokes observe with the same ES|QL (e.g. via the "Extend observation (+60s)" button), the view
merges the new samples into the existing sparkline instead of resetting — so the user sees a
continuous timeline across multiple tool calls. To keep this continuity, reuse the exact same
ES|QL string and condition when extending. Capped at 240 points to keep the chart readable.

## Tools

| Tool | Purpose |
|------|---------|
| `observe` | Polls and blocks. Four modes: `anomaly`, `metric`, `now`, `table`. |
| `ml-anomalies` | Follow-up: deeper look at the anomaly that fired. |
| `apm-service-dependencies` | Follow-up: topology of affected services (if APM available). |
| `apm-health-summary` | Follow-up: cluster-wide context, and useful for discovering which namespaces actually have data. |
| `k8s-blast-radius` | Follow-up: infra impact if a node is implicated. |
| `manage-alerts` | Graduate to persistent alerting once the pattern is well-understood. |

## Key principles

- **Observe is transient.** Nothing is saved. If the user wants an ongoing rule, use `manage-alerts`.
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
- **Don't start with `observe` for vague triage.** If the user reports a symptom without naming a
  specific metric ("something feels slow", "what's wrong with prod"), reach for `apm-health-summary`
  first — it surfaces the worst-offender services without needing a query. `observe` needs a target
  metric to poll; use it to drill in *after* the rollup names something.
- **Don't over-tune `min_score`.** 75 catches the important stuff; dropping below 50 produces noise.

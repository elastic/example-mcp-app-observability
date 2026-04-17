---
name: watch
description: >
  Actively wait for an ML anomaly or an ES|QL metric condition to be met — the agent's "wait-and-see" primitive.
  Use when the user says "tell me when...", "let me know if...", "wait until X drops below Y",
  "watch for anything unusual", "poll until stable", or wants transient (session-scoped) monitoring without
  creating a persistent Kibana rule. Also trigger for "monitor for the next N minutes", "block until",
  "keep an eye on", or when validating that a remediation has taken effect.
---

# Watch

Transient, session-scoped monitoring. Unlike `create-alert-rule` (which creates a durable saved object in Kibana),
`watch` polls in-process and returns once fired or once it times out. Use it for:

- **Autonomous investigation kickoff** — "watch for anomalies and investigate the first one that fires."
- **Post-remediation validation** — "wait until frontend memory drops below 80MB so we know the fix took."
- **Short-lived monitoring** — "keep an eye on this for the next 10 minutes" without paging anyone.

## Prerequisites

| Mode | Requires |
|------|----------|
| `anomaly` (default) | Elastic ML anomaly detection jobs |
| `metric` | Any ES\|QL-queryable numeric field — no specific backend |

If the user wants durable alerting ("page me whenever..."), use `create-alert-rule` instead.

## Tools

| Tool | Purpose |
|------|---------|
| `watch` | Polls and blocks. Two modes: `anomaly` (ML jobs) and `metric` (ES\|QL condition). |
| `ml-anomalies` | Follow-up: deeper look at the anomaly that fired. |
| `apm-service-dependencies` | Follow-up: topology of affected services (if APM available). |
| `k8s-blast-radius` | Follow-up: infra impact if a node is implicated (if K8s available). |
| `create-alert-rule` | Graduate to persistent alerting once the pattern is well-understood. |

## How to call watch

### Anomaly mode (default)

Use when the user doesn't name a specific metric — they just want to be told when anything unusual fires.

```json
{
  "mode": "anomaly",
  "min_score": 75,
  "max_wait": 600,
  "namespace": "otel-demo"
}
```

- `min_score`: 75 (default, major+), 50 for minor inclusion, 90 for critical-only.
- `max_wait`: generous (600s default). The tool returns immediately on trigger.
- `namespace`: only if the user scopes to a K8s namespace.

### Metric mode

Use when the user names a specific metric and condition.

```json
{
  "mode": "metric",
  "esql": "FROM metrics-* | WHERE host.name == \"srv-01\" | STATS v = AVG(system.memory.used.bytes)",
  "condition": "< 80000000",
  "description": "srv-01 memory usage",
  "max_wait": 300
}
```

Construct the ES|QL from context. The query must return a single row with a numeric first column.
Condition format: `<comparator> <threshold>` — valid comparators: `<`, `<=`, `>`, `>=`, `==`.

## After the tool returns

The `watch` MCP App view renders inline in one of two modes, picked automatically from the result:

- **Metric mode** — trend bar chart with threshold line; stat cards for current / threshold / peak / baseline.
- **Anomaly mode** — severity-scored trigger card with affected entities and click-to-send investigation prompts.

Both modes surface an `investigation_actions` list as buttons. Follow up in chat too — don't rely on the buttons alone.

**Anomaly fired (`status: ALERT`)**: the response includes affected entities, affected services, top anomalies,
and `investigation_hints` naming the next tool to reach for. Follow those hints — don't just report the alert,
start investigating.

**Metric condition met (`status: CONDITION_MET`)**: confirm to the user and describe the trend from the returned
history. If this was post-remediation validation, explicitly state the fix has been validated. Offer to graduate
the condition into a durable rule via `create-alert-rule`.

**Timeout (`status: TIMEOUT` or `QUIET`)**: tell the user nothing fired. Suggest adjustments — lower `min_score`,
widen `lookback`, verify ML jobs are running, or re-examine the ES|QL query.

## Key principles

- **Watch is transient.** Nothing is saved. If the user wants an ongoing rule, use `create-alert-rule`.
- **Default to anomaly mode** unless the user names a specific metric and condition.
- **Don't over-tune `min_score`.** 75 catches the important stuff; dropping below 50 produces noise.
- **On ALERT, start investigating immediately.** The `investigation_hints` are suggestions — follow them and
  narrate your reasoning.

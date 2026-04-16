---
name: apm-health-summary
description: >
  Get a cluster-level rollup of service health from APM telemetry — the "how's my environment right now?"
  entry point for observability investigations. Use when the user asks "how's my cluster", "what's broken",
  "any issues", "give me a status report", "what should I look at", or opens a session with a vague symptom
  ("things feel slow"). Gracefully degrades: layers in Kubernetes pod data and ML anomaly context when those
  backends are present, but still returns useful APM-only output if they aren't. Do not use for log-only or
  metrics-only customers — this tool requires Elastic APM.
---

# APM Health Summary

This is the **first tool to reach for** in vague-symptom investigations — "something feels off, where should
I look?" It gives you a one-shot rollup: degraded services, top resource consumers, active anomalies, and a
`data_coverage` report showing what backends contributed. From there, you pick the right follow-up tool.

## Prerequisites

| Signal | Required? | What happens without it |
|--------|-----------|--------------------------|
| Elastic APM | **Required** | Tool returns a warning and suggests `ml-anomalies`/`watch`/`create-alert-rule` instead. |
| Kubernetes (kubeletstats) | Optional | `pods` section is replaced by a note; service health still reported. |
| ML anomaly jobs | Optional | `anomalies` section is replaced by a note; service health still reported. |

If the user is log-only or metrics-only (no APM), do not call this tool. Suggest `ml-anomalies` (for ML-backed
anomaly detection) or `watch` / `create-alert-rule` (both universal).

## Tools

| Tool | Purpose |
|------|---------|
| `apm-health-summary` | The rollup. First call in most investigations. |
| `ml-anomalies` | Drill into anomalies flagged in the summary. |
| `apm-service-dependencies` | Map topology around any degraded service. |
| `k8s-blast-radius` | If the summary implicates a node (pod resource pressure), assess node impact. |
| `watch` | Post-investigation: watch for stabilization or follow-on anomalies. |

## How to call apm-health-summary

```json
{
  "namespace": "otel-demo",
  "lookback": "15m"
}
```

- **`namespace`**: only if the user scopes to a K8s namespace. Omit for cross-namespace or non-K8s.
- **`lookback`**: default `15m`. Use `5m` for "right now," `1h` for "since I noticed the issue."
- **`job_filter`**: optional ML-job prefix, e.g. `k8s-`. Rarely needed.
- **`exclude_entities`**: optional wildcard to hide known noise, e.g. `chaos-*`.

## After the tool returns

Inspect `data_coverage` first — this tells you which signals contributed.

Then walk the output top-down:

1. **Overall health** (`healthy` / `degraded` / `critical`): lead with this.
2. **Degraded services**: name them with reasons (error rate, latency). These are the investigation targets.
3. **Pods** (if present): top memory consumers — cross-reference with degraded services.
4. **Anomalies** (if present): by-severity counts + top entities. Drives the ML follow-up.
5. **Recommendation**: the tool emits a one-liner suggesting the next tool — use it.

Based on what you see, pick the next tool:
- Degraded service named → `apm-service-dependencies` with `service: <name>` to map the neighborhood.
- High anomaly count → `ml-anomalies` with matching `lookback` to drill in.
- Pod resource pressure on a specific node → `k8s-blast-radius` with that node name.

## Key principles

- **Start here, then narrow.** Don't guess which service is the problem — let the rollup tell you.
- **Respect `data_coverage`.** If K8s is absent, don't suggest `k8s-blast-radius`. If APM is absent, don't
  call this tool at all.
- **The overall health is coarse.** "Healthy" doesn't mean nothing is wrong — it means nothing meets the
  degraded thresholds. Always scan the details.
- **Graceful degradation is by design.** APM-only output is still useful — don't apologize for missing K8s
  or ML signals; just report what you have.

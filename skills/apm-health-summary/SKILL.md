---
name: apm-health-summary
description: >
  Get a cluster-level rollup of service health from APM telemetry — the "how's my environment right now?"
  entry point for observability investigations. Use whenever the user asks about HEALTH, STATUS, or
  general wellbeing of an environment / cluster / namespace ("how's my cluster", "status of the X env",
  "what's broken", "any issues", "show me the health of …", "give me a status report", "what should I
  look at", "things feel slow"). This applies regardless of any time qualifier — "show me the health
  of X over the past hour" still routes here (with lookback="1h"), NOT to observe. observe is for
  raw-metric queries; this tool is for the rollup. Gracefully degrades: layers in Kubernetes pod data
  and ML anomaly context when those backends are present, but still returns useful APM-only output if
  they aren't. Do not use for log-only or metrics-only customers — this tool requires Elastic APM.
---

# APM Health Summary

This is the **first tool to reach for** in vague-symptom investigations — "something feels off, where should
I look?" It gives you a one-shot rollup: degraded services, top resource consumers, active anomalies, and a
`data_coverage` report showing what backends contributed. From there, you pick the right follow-up tool.

## Prerequisites

| Signal | Required? | What happens without it |
|--------|-----------|--------------------------|
| Elastic APM | **Required** | Tool returns a warning and suggests `ml-anomalies`/`observe`/`manage-alerts` instead. |
| Kubernetes (kubeletstats) | Optional | `pods` section is replaced by a note; service health still reported. |
| ML anomaly jobs | Optional | `anomalies` section is replaced by a note; service health still reported. |

If the user is log-only or metrics-only (no APM), do not call this tool. Suggest `ml-anomalies` (for ML-backed
anomaly detection) or `observe` / `manage-alerts` (both universal).

## Tools

| Tool | Purpose |
|------|---------|
| `apm-health-summary` | The rollup. First call in most investigations. |
| `ml-anomalies` | Drill into anomalies flagged in the summary. |
| `apm-service-dependencies` | Map topology around any degraded service. |
| `k8s-blast-radius` | If the summary implicates a node (pod resource pressure), assess node impact. |
| `observe` | Post-investigation: observe for stabilization or follow-on anomalies. |

## How to call apm-health-summary

```json
{
  "cluster": "prod-us-east",
  "namespace": "otel-demo",
  "lookback": "15m"
}
```

- **`cluster`**: only when the user names a Kubernetes cluster — e.g. "how's prod-us-east doing", "check the staging cluster". Resolves fuzzily against `k8s.cluster.name` (OTel) / `orchestrator.cluster.name` (ECS); on miss the response includes `cluster_candidates`. Omit for single-cluster deployments or when the user wants a cross-cluster view.
- **`namespace`**: only if the user scopes to a K8s namespace. Omit for cross-namespace or non-K8s.
- **`lookback`**: default `1h` (good general-purpose window for "what's been going on"). Use `5m`–`15m`
  when the user implies "right now / this moment". Use the user's time window literally when they
  give one ("over the past 30 minutes" → `30m`; "in the last 6 hours" → `6h`).
- **`job_filter`**: optional ML-job prefix, e.g. `k8s-`. Rarely needed.
- **`exclude_entities`**: optional wildcard to hide known noise, e.g. `chaos-*`.

## After the tool returns

The tool renders an inline MCP App view — status badge, scope card (cluster › namespace › service/pod
counts plus an applications strip), KPI tile rows, anomaly-severity donut + heatmap, top memory pods,
service throughput list, and a next-step button row driven by `investigation_actions`. Use the view
for the visual rollup; narrate findings below it.

Inspect `data_coverage` first — this tells you which signals contributed.

The `scope` field anchors what the user is looking at — start narration with it when present:
"Looking at cluster `prod-us-east`, namespace `payments`, 12 services across 42 pods…". When `scope.service_groups`
is populated the view shows clickable application chips users can toggle to filter the page client-side
(throughput rows, top pods, anomaly heatmap, donut counts all recompute). **Don't suggest re-running the
tool when the user wants to narrow to one application — point them at the chips instead.** Only re-call
with a different `cluster` / `namespace` when they're crossing the scope boundary.

Ignore `_setup_notice` if present in the response — it's view-side chrome (welcome banner / skill-gap hint)
that the UI handles. Don't echo or summarize it in chat.

Then walk the output top-down:

1. **Overall health** (`healthy` / `degraded` / `critical`): lead with this.
2. **Degraded services**: name them with reasons (error rate, latency). These are the investigation targets.
3. **Pods** (if present): top memory consumers — cross-reference with degraded services.
4. **Anomalies** (if present): by-severity counts + top entities. Drives the ML follow-up.
5. **Next-step buttons**: the view surfaces `investigation_actions` as clickable prompts (drill into the
   top pod, investigate the degraded service, check blast radius). Mention them in chat so the user knows.

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

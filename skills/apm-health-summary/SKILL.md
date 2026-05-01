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
  "lookback": "1h"
}
```

- **`cluster`**: pass whenever the user names a cluster (even partially) — "the oteldemo cluster", "how's prod-us-east doing", "check the staging env". Use the user's literal phrasing; the tool fuzzy-matches it. Omit only when the user clearly wants a cross-cluster view or there's a single cluster in the env.
- **`namespace`**: pass when the user scopes to a K8s namespace. Same fuzzy-match logic as cluster.

### Handling disambiguation responses

When the user-supplied `cluster` or `namespace` matches multiple candidates (or none), the tool **does not** run the analysis. It returns a short response with `disambiguation_needed` set to `"cluster"`, `"namespace"`, or `"cluster_and_namespace"`, plus the candidate list:

```json
{
  "disambiguation_needed": "cluster",
  "cluster_requested": "oteldemo",
  "cluster_candidates": ["oteldemo-prod", "oteldemo-staging"],
  "cluster_match": "multiple"
}
```

When you see this, **don't re-call the tool with a guessed cluster name.** Surface the candidates to the user verbatim, ask which one they meant, then re-call the tool with the exact name they pick. Same flow for `namespace_match: "none"` (the requested name doesn't exist in recent telemetry) — show candidates and ask.
- **`lookback`**: **default `1h`** for any unqualified prompt — "what's the status of X", "how is X doing", "check on X", "give me a status report". Don't drop to 15m unless the user explicitly says something time-localized like "right now / this second / this minute". Use the user's time window literally when they give one ("over the past 30 minutes" → `30m`; "in the last 6 hours" → `6h`; "today" → `24h`). The 1h default is intentional — most cluster-state questions need a window wide enough to surface degradation patterns, and 15m hides slow-burning issues.
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
5. **Alerts** (`alerts` field, always emitted): `active_count` / `recovered_count` plus `top_rules` and `active_samples`. **Read these before reaching for `manage-alerts`** — the rollup already shows what fired and why. Only call `manage-alerts` when the user wants to create/modify rules (not just see what fired). Cross-reference active alerts with degraded services: a pod-memory alert on the same pod that's degrading is a strong signal.
6. **SLOs** (`slos` field, always emitted): authoritative source for "is this cluster meeting its objectives?". `configured: false` means no SLOs exist — surface the `note` once and move on. `configured: true` gives you `violated_count`, `healthy_count`, and `top_violations[]` with each violated SLO's current `sli_value`, `target`, and `one_hour_burn_rate`. **Read burn rate hard:** `> 14.4×` means the rolling-window error budget burns out in <2h at the current rate (page-worthy); `6–14×` is degrading; `< 1×` is safe pace. Cross-reference `top_violations[].name` with `degraded_services[]` — services that appear in both are the priority drilldowns. Don't suggest creating SLOs if `configured: true`; do suggest it if `configured: false`.
7. **Next-step buttons**: the view surfaces `investigation_actions` as clickable prompts (drill into the
   top pod, investigate the degraded service, check blast radius). Mention them in chat so the user knows.

Based on what you see, pick the next tool:
- **Degraded service named → `apm-service-dependencies` first.** This is the highest-yield drilldown for a known-degraded service in almost every cluster. The topology map points directly at upstream/downstream root causes (slow gRPC dependency, hung leaf node, fan-out timing). Don't reach for `ml-anomalies` first — most clusters don't have anomaly jobs configured for arbitrary services, and you'll waste a turn on an empty result.
- **`ml-anomalies` is a complementary, not primary, drilldown.** Use it when (a) the user wants anomaly *detail* on a known-degraded service AND `data_coverage.ml_anomalies` is true, OR (b) the user is investigating a vague symptom and wants detection. If `data_coverage.ml_anomalies` is false, skip `ml-anomalies` entirely — there are no jobs to query.
- **If you do call `ml-anomalies` and it returns empty / no-jobs for the entity**, fall back to `apm-service-dependencies` for that same service immediately. Don't leave the user at a dead end.
- High anomaly count in the rollup → `ml-anomalies` with matching `lookback` (this is the "lots of anomalies, what's worst?" path — different from the named-degraded-service path above).
- Pod resource pressure on a specific node → `k8s-blast-radius` with that node name.

## Key principles

- **Start here, then narrow.** Don't guess which service is the problem — let the rollup tell you.
- **Respect `data_coverage`.** If K8s is absent, don't suggest `k8s-blast-radius`. If APM is absent, don't
  call this tool at all.
- **The overall health is coarse.** "Healthy" doesn't mean nothing is wrong — it means nothing meets the
  degraded thresholds. Always scan the details.
- **Graceful degradation is by design.** APM-only output is still useful — don't apologize for missing K8s
  or ML signals; just report what you have.

## Investigation discipline

Multi-tool investigations should be **sequential and narrated**, not parallel and silent. Each tool call renders its own widget in the chat — firing 4-5 in a row after a single "yes" creates a wall of "Waiting…" placeholders that look like the system is broken.

- **One tool call per turn.** After a tool returns, narrate what you saw — the headline number, what it implies, what it rules in or out — *before* making the next call. The narration is the user's only signal that you read the result.
- **Sequential offers, not OR offers.** Don't ask "Want me to check X *or* Y?" — that's ambiguous and the user's "yes" turns into both calls in parallel. Phrase offers as a chain: "Want me to start with X? If it's inconclusive I can follow up with Y." The user gets the same options without the parallel-execution trap.
- **Commit to a plan before "yes."** If a triage will need 3-4 tool calls, lay out the plan first ("I'll check anomalies for flagd, then its pod resources, then trace errors from product-reviews — pause me if you've seen enough at any point") and execute one step at a time. Don't pre-fire all 3 calls because the user agreed to "the plan."
- **Read the rollup before drilling.** apm-health-summary already includes services, pods, anomalies, fired alerts, and SLOs in one response. If the user asks "what fired recently?" — answer from `alerts.top_rules`, don't call manage-alerts. If they ask "what's anomalous?" — answer from `anomalies.top_entities`, don't call ml-anomalies for the same data.

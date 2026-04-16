---
name: ml-anomalies
description: >
  Query Elastic ML anomaly detection results to understand what's behaving unusually, why, and how badly.
  Use when the user asks "what's anomalous", "is anything unusual happening", "why is X slow/spiking",
  "show me the weirdness", or mentions memory growth, CPU spikes, restart patterns, unusual latency,
  unexpected error rates, or drift from typical behavior. Also trigger for "ML anomalies", "anomaly detection",
  "Elastic ML", "what does ML think", or when the user wants to understand behavior that deviates from baseline.
  The tool opens an inline explainer view with a severity gauge, plain-English narrative, and per-entity
  deviation breakdown — so the agent should USE the visualization, not just dump JSON.
---

# ML Anomalies

You are an observability analyst who uses Elastic ML anomaly detection to surface unusual behavior the user
might otherwise miss. Your job: query the right anomalies, open the explainer view, and translate the output
into "here's what's wrong, where, and how bad."

## Prerequisites

- **Elastic ML anomaly detection jobs must be configured and running.** The tool queries `.ml-anomalies-*`.
- Jobs can target any signal domain — K8s metrics, APM latency, log rates, custom metrics. This tool is
  backend-agnostic — it returns whatever the configured jobs find.
- If no ML jobs exist, the tool returns an empty result with a hint to configure jobs in Kibana ML.

## Tools

| Tool | Purpose |
|------|---------|
| `ml-anomalies` | Fetch anomaly records and open the interactive explainer view. |
| `watch` (anomaly mode) | Block and wait for the next anomaly to fire rather than querying past ones. |
| `apm-service-dependencies` | Follow-up: understand topology around an affected service (if APM). |
| `k8s-blast-radius` | Follow-up: assess infra impact if a node/pod is implicated (if K8s). |

## How to call ml-anomalies

```json
{
  "min_score": 75,
  "lookback": "1h",
  "entity": "frontend"
}
```

Parameter-filling guidance:

- **`min_score`**: default 50. Raise to 75 for "only the important ones" or 90 for "only critical." Lower
  to 25 for a wide audit.
- **`lookback`**: default `24h`. Use `1h` for acute investigations, `7d` for weekly trend review.
- **`entity`**: derive from the user's request — service name, pod name, deployment, host. Matches against
  all influencer fields. Examples: "checkout" → `entity: "checkoutservice"`, "the frontend pod" →
  `entity: "frontend"`.
- **`job_id`**: only if the user names a specific job or scopes to a signal domain ("memory anomalies" →
  prefix filter `k8s-memory-`).
- **`limit`**: default 25. Raise for a full audit; lower to `1` for "show me the worst."

Call the tool **once**. The explainer view renders inline — do not call it twice trying to "refresh."

## After the tool returns

You receive:
- Anomaly records with `recordScore`, `jobId`, `fieldName`, `functionName`, `entity`, `deviationPercent`,
  and the actual vs typical values.
- A `jobsSummary` of counts per job.

The explainer view renders a severity gauge, timeline, and entity cards. **Use it** — don't restate the JSON
in chat. Instead, provide a narrative **below** the view:

1. **Headline the worst offender**: "Top anomaly — `frontend` memory working set anomalous, score 87
   (major), 340% above typical."
2. **Group by entity**: list the top 3-5 affected entities with one-line summaries.
3. **Suggest follow-ups**: if APM data exists, recommend `apm-service-dependencies` to map topology; if K8s,
   `k8s-blast-radius` for node impact.
4. **Flag gaps**: if the user expected anomalies and none fired, say so — might mean jobs are behind or
   thresholds need tuning.

## Key principles

- **Let the view do the visual work.** The explainer has a severity gauge and per-entity cards. Don't
  duplicate them in prose.
- **Anomaly score ≠ severity of the underlying issue.** A high score means "unusual," not "broken." Always
  cross-reference with what the user is actually seeing.
- **The ML baseline is what the jobs learned from the data's past.** Communicate anomalies as "unusual
  vs typical behavior learned from prior N days," not as absolute verdicts.
- **Empty result is a signal, not a failure.** If the user expected anomalies and none appear at the default
  `min_score`, try lowering it once before concluding "all quiet."

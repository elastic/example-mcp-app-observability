---
name: k8s-blast-radius
description: >
  Assess the impact of a Kubernetes node going offline — which deployments lose all replicas (full outage),
  which lose partial capacity (degraded), which are unaffected, and whether the cluster has enough spare
  capacity to reschedule the lost pods. Use when the user asks "what happens if node X goes down",
  "what's the blast radius of draining this node", "can I safely maintain node Y", "what's running on
  this node", "if I evict this node what breaks", or is planning node maintenance, a cluster upgrade, or
  investigating an actual node failure. Requires Kubernetes (kubeletstats metrics) and Elastic APM for
  downstream service impact — do not trigger for non-K8s deployments.
---

# Kubernetes Blast Radius

Answers hypothetical and real node-failure questions with data. Categorizes every deployment touching the
node into full-outage / degraded / unaffected, totals up memory at risk, and checks whether the remaining
cluster has capacity to reschedule.

## Prerequisites

| Signal | Required? | What you get without it |
|--------|-----------|--------------------------|
| Kubernetes (kubeletstats) | **Required** | Tool does not apply — suggest the user instrument with kubeletstats receiver. |
| Elastic APM | Optional | Core node-impact analysis still works. The `downstream_services` section (user-facing services in affected namespaces) is omitted with a note. |

If the user is not running Kubernetes, this tool does not apply. But a Kubernetes-only customer (no APM)
still gets the full pod-level impact assessment and rescheduling feasibility — the majority of the value.

## Tools

| Tool | Purpose |
|------|---------|
| `k8s-blast-radius` | Run the impact assessment for a specific node. |
| `apm-health-summary` | Before: check which services are already degraded. |
| `apm-service-dependencies` | After: map downstream ripple for affected services. |
| `ml-anomalies` | After: is unusual behavior already showing up on affected workloads? |

## How to call k8s-blast-radius

```json
{
  "node": "gke-prod-pool-1-abc123",
  "cluster": "prod-us-east",
  "layout": "summary"
}
```

Parameter-filling guidance:

- **`node`**: **must be exact**. Matched literally against `kubernetes.node.name`. If the user describes a
  node ambiguously ("the noisy node", "the one running frontend"), ask them to confirm the exact node name
  before calling. Do not guess.
- **`cluster`**: required when the same node name might exist in multiple clusters — auto-generated cloud
  node names (GKE / EKS) sometimes collide. Resolves fuzzily against `k8s.cluster.name` (OTel) /
  `orchestrator.cluster.name` (ECS); on miss the response includes `cluster_candidates`. Omit for
  single-cluster deployments.
- **`layout`**: default `summary` (compact, collapsible sections). Use `radial` when the user wants a visual
  "impact-by-proximity" diagram.

## After the tool returns

Response shape:
- `status`: `AT RISK` (full outage), `PARTIAL RISK` (degraded only), or `SAFE` (no impact).
- `data_coverage`: which backends contributed (always `kubernetes: true`; `apm: true|false`).
- `pods_at_risk`: count of pods on the node.
- `full_outage[]`: deployments losing all replicas — lead with these.
- `degraded[]`: deployments losing partial capacity.
- `unaffected` / `unaffected_count`: deployments not touching the node.
- `rescheduling`: memory required vs available, and whether it's feasible.
- `downstream_services[]` (only if APM present): user-facing services whose namespace is affected.
- `downstream_services_note` (only if APM absent): explains the gap.
- `investigation_actions`: next-step prompts surfaced as click-to-send buttons in the view (includes a SPOF
  callout when a single-replica deployment is implicated).
- `render_instructions`: HTML render spec — let the inline MCP App view handle visualization (floating
  summary card, radial affected-deployment sweep, safe-zone arc, hover tooltips).

Ignore `_setup_notice` if present — it's view-side chrome (welcome banner) that the UI handles. Don't
echo or summarize it in chat.

Narrate in this order:

1. **Headline status**: "AT RISK — 3 deployments lose all replicas if gke-prod-pool-1-abc123 goes offline."
2. **Full outage list**: name the deployments. These are the critical ones.
3. **Degraded list**: name them, note surviving replica counts.
4. **Rescheduling feasibility**: "Cluster has X GB available across N nodes to absorb Y GB required — safe
   / not safe / marginal."
5. **Downstream services** (if APM present): name the services in affected namespaces that might be
   user-visible.
6. **Recommend action**: for AT RISK + infeasible reschedule, "don't drain this node without scaling up."
   For PARTIAL RISK + feasible, "safe to drain with PodDisruptionBudgets in place."

## Key principles

- **Hypothetical framing.** Unless the node is actually down, always present results as "if X goes offline,
  then Y" — not as current reality.
- **Rescheduling feasibility is a heuristic.** It compares memory only — doesn't account for CPU, storage,
  affinity rules, taints, or PodDisruptionBudgets. Note this caveat.
- **Full-outage >> degraded.** A deployment with 1 replica on the node is a full outage; a deployment with
  3 replicas losing 1 is degraded. Treat them very differently in recommendations.
- **Downstream services matter.** Even if a deployment is degraded not down, user-facing services might see
  tail latency. Mention the downstream APM services.
- **Don't conflate "at risk" with "broken."** The status reflects *potential* impact. The node may be fine.

---
name: apm-service-dependencies
description: >
  Map the application topology from APM telemetry — which services call which, over what protocols, with
  what call volume and latency. Use when the user asks "what calls X", "what depends on X", "show me
  the topology", "what are the upstream/downstream services", "where does this service fit", or is doing
  root-cause investigation and needs to trace how a problem propagates through the call graph. Also trigger
  for "service map", "dependency graph", "blast radius of service X", or "who's the dependency of Y".
  Requires Elastic APM — do not trigger for log-only or metrics-only customers.
---

# APM Service Dependencies

This tool answers "how is my application wired together?" It returns the APM dependency graph — a set of
directed edges from caller services to callee services, with protocol (http, grpc, dns, etc.), call volume,
and per-service health (span count, latency, errors) when requested.

## Prerequisites

- **Elastic APM with OTel-instrumented services** producing `span.destination.service.resource` values.
- Optional: Kubernetes metadata on the spans (for namespace filtering).

If the user is log-only or metrics-only (no APM), this tool won't work. Do not reach for it.

## Tools

| Tool | Purpose |
|------|---------|
| `apm-service-dependencies` | Fetch the dependency graph (full or focal). |
| `apm-health-summary` | Prerequisite view: which services are degraded? Then map their neighborhood with this skill. |
| `ml-anomalies` | Drill into anomalies affecting a service discovered in the graph. |
| `k8s-blast-radius` | If a service is K8s-deployed and a node is implicated. |

## How to call apm-service-dependencies

### Focal mode (most common)

Use when you know which service is the investigation target. Returns only that service's direct upstream
and downstream neighbors — much easier to reason about than the full graph.

```json
{
  "service": "checkout",
  "lookback": "1h",
  "include_health": true
}
```

### Full-graph mode

Use sparingly — only when the user explicitly wants the whole topology, or during initial environment
discovery.

```json
{
  "lookback": "1h",
  "include_health": false
}
```

Parameter-filling guidance:

- **`service`**: the exact OTel `service.name` as deployed — typically lowercase and hyphenated for
  multi-word services (`frontend`, `checkout`, `product-catalog`). **Do not concatenate spaces** — if
  the user says "checkout service" pass `checkout`, not `checkoutservice`. If the name is ambiguous,
  ask the user to confirm before calling. If the tool returns no edges for the named focal service,
  confirm the name with the user before fuzzy-matching.
- **`namespace`**: only if the user scopes to a K8s namespace AND services are K8s-deployed.
- **`lookback`**: default `1h`. Use `15m` for "right now," `24h` to smooth transient topology changes.
- **`include_health`**: default true. Set false for a topology-only response when you don't need latency/error
  data.

## After the tool returns

Response shape:
- `services`: list of nodes with optional language/deployment/namespace metadata and health stats.
- `edges`: directed edges with `source`, `target`, `protocol`, `port`, `call_count`, `avg_latency_us`.
- `focal_service` + `upstream` + `downstream` (focal mode only).
- `service_count` / `edge_count`.
- `data_coverage_note` (only on focal mode when the focal service has inbound but zero outbound
  edges): flags a likely instrumentation gap — don't claim the service is a `leaf`; relay the note
  to the user as an advisory.

Lead your narrative with:

1. **Focal service**: "checkoutservice has 3 upstream callers and 5 downstream dependencies."
2. **Upstream callers** (who depends on this service): name them, note call volumes. Outage here cascades up.
3. **Downstream dependencies** (what this service relies on): name them. Problems here cascade in.
4. **Hot edges**: highest call volume or latency — likely the load-bearing paths.
5. **Follow-ups**: suggest `ml-anomalies` on a specific neighbor if its health shows errors or elevated latency.

## Key principles

- **Prefer focal mode.** The full graph is hard to narrate; a focal subgraph is crisp.
- **Direction matters.** Upstream = who calls me (blast radius goes up). Downstream = what I call (problems
  cascade in). Don't mix them up in explanations.
- **Protocols and ports are clues.** A DNS edge tells you the callee is resolved by name (k8s service?). A
  high-port HTTP call to a specific target hints at a sidecar or proxy.
- **Empty or tiny graphs are a signal.** If the focal service has zero edges, either the lookback is too
  narrow, the service isn't instrumented, or the name is wrong. Do not silently report "no dependencies."

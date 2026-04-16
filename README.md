# Elastic Observability MCP App

> **Tech preview** — interactive SRE workflows for Elastic Observability, delivered as an MCP App server for Claude Desktop and other MCP clients.

Bring agentic observability investigation to your MCP client of choice. Watch ML anomalies fire, roll up cluster health, assess blast radius, map service dependencies, and create persistent Kibana alerts — all against live Elasticsearch data.

## What's in v1

Tools are grouped by the backend they require. A logs-or-metrics-only Elastic Observability customer can use the **Universal** tools immediately; the prefixed tools (`apm-*`, `k8s-*`) surface their requirements in both name and description so users know up front whether a tool applies to their deployment.

### Universal (any Elastic Observability deployment)

| Tool | Description |
| --- | --- |
| `watch` | Blocks until an ML anomaly fires or an ES\|QL metric condition is met. Metric mode works on any numeric field. |
| `create-alert-rule` | Create a persistent Kibana custom-threshold alerting rule against any metric field in any index. |

### ML-dependent

| Tool | Description |
| --- | --- |
| `ml-anomalies` | Query ML anomaly detection records and open an inline anomaly-explainer view. Requires ML jobs configured. |

### APM-dependent

| Tool | Description |
| --- | --- |
| `apm-health-summary` | Cluster-level health rollup from APM service telemetry; layers in K8s and ML context when available. Gracefully degrades if K8s or ML is absent. |
| `apm-service-dependencies` | Service dependency graph (upstream/downstream, protocols, call volume). |

### Kubernetes-dependent

| Tool | Description |
| --- | --- |
| `k8s-blast-radius` | Assess the impact of a node going offline — full outage, degraded, unaffected, reschedule feasibility. APM is optional — enriches the output with user-facing service impact but is not required. |

One MCP App view ships in v1: `anomaly-explainer` — a severity gauge + timeline rendered inline in the client UI when `ml-anomalies` returns results.

One Agent Builder workflow ships alongside: `create-alert-rule` — the workflow form of the alert-rule tool, for clients that prefer Agent Builder over MCP tools.

Six skills ship as separate `.zip` artifacts (one per tool). Upload individually in Claude Desktop via **Customize → Skills → Create Skill → Upload a skill**. Each skill teaches the agent when to reach for the paired tool and how to fill its parameters from natural-language user intent, so users don't need to know tool names or deployment specifics.

### Deferred

`service-infra-map` (full K8s topology map) depends on the `k8s-discover` topology indices (`topology-nodes-*`, `topology-edges-*`), which are not yet published outside of Forge. It will land in the next release once those indices ship.

## Requirements

- Node ≥ 22
- An Elasticsearch cluster with OpenTelemetry data (EDOT + kube-stack recommended)
- A Kibana instance with Alerting enabled

## Install — Claude Desktop

Grab the latest `.mcpb` from [Releases](https://github.com/elastic/example-mcp-o11y/releases) and double-click it. Claude Desktop will prompt for the four connection settings.

## Install — other MCP clients

```bash
npm install -g example-mcp-o11y
```

Then point your MCP client at `example-mcp-o11y --stdio` with these env vars:

```bash
export ELASTICSEARCH_URL="https://<cluster>.es.cloud.example.com"
export ELASTICSEARCH_API_KEY="<api-key>"
export KIBANA_URL="https://<cluster>.kb.cloud.example.com"
export KIBANA_API_KEY="<api-key>"
```

HTTP transport is available by running without `--stdio` (default port `3001`, POST to `/mcp`).

## Development

```bash
npm install
cp .env.example .env       # fill in connection settings
npm run dev                # watch mode: tsx + vite
npm run typecheck
npm run build              # tsc + view bundles
npm run mcpb:pack          # produces example-mcp-o11y.mcpb
```

## License

Apache-2.0 at the package level. Individual source files are licensed under Elastic License 2.0 — see file headers and `LICENSE.txt`.

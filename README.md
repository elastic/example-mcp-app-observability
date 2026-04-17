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

Six MCP App views ship in v1 — one per tool, rendered inline when the tool returns:

- `anomaly-explainer` — dual-mode for `ml-anomalies`: overview (severity counts, affected entities, by-job breakdown) or single-anomaly detail (score / actual / typical / deviation, comparison bar, time-series)
- `apm-health-summary` — cluster health badge, anomaly-severity donut, top memory pods, service throughput
- `apm-service-dependencies` — layered DAG with call volume, latency, and hover-path highlighting
- `k8s-blast-radius` — radial node-impact diagram with floating summary, SPOF detection, safe-zone arc, rescheduling feasibility
- `watch` — dual-mode for `watch`: metric condition with trend chart and threshold line, or anomaly trigger with hypothesis-ready investigation hints
- `create-alert-rule` — live rule card with condition, window, check interval, KQL filter, tags, and next-step prompts

Every tool emits an `investigation_actions` list so the UI can surface opinionated next-step prompts — click-to-send without forcing the user to guess the right follow-up tool.

Two Agent Builder workflows ship alongside — for clients that prefer Agent Builder workflows over MCP tools:

- `create-alert-rule` — workflow form of the alert-rule tool (the MCP App version above is preferred for most clients).
- `k8s-crashloop-investigation-otel` — automatic CrashLoopBackOff / OOMKilled investigation for clusters on the OTel ingest path (EDOT / kube-stack). Pulls pod context, ML anomalies, upstream health, and recent changes, then synthesizes a root-cause hypothesis.

Six skills ship as separate `.zip` artifacts (one per tool). Upload individually in Claude Desktop via **Customize → Skills → Create Skill → Upload a skill**. Each skill teaches the agent when to reach for the paired tool and how to fill its parameters from natural-language user intent, so users don't need to know tool names or deployment specifics.

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

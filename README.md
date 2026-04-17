# Elastic Observability MCP App

An [MCP App](https://modelcontextprotocol.io/extensions/apps/overview) that brings interactive SRE workflows for Elastic Observability directly into Claude, VS Code, and other MCP-compatible AI hosts. Built on the [Model Context Protocol](https://modelcontextprotocol.io/) with interactive UI extensions that render inline in the conversation.

> **What are MCP Apps?** MCP Apps extend the Model Context Protocol to let tool servers return interactive HTML interfaces — dashboards, forms, visualizations — that render inside the AI conversation. The LLM calls a tool, and instead of just returning text, an interactive UI appears alongside the response.

## What This Does

This project provides six interactive SRE tools, each with a rich React-based UI that renders inline when Claude (or another MCP host) calls the tool. Tools are grouped by the backend they require — a logs-or-metrics-only Elastic Observability customer can use the **Universal** tools immediately; the prefixed tools (`apm-*`, `k8s-*`) surface their requirements in both name and description.

### Universal (any Elastic Observability deployment)

| Tool | What It Does |
|------|-------------|
| **watch** | Blocks until an ML anomaly fires or an ES\|QL metric condition is met. Metric mode works on any numeric field. |
| **create-alert-rule** | Create a persistent Kibana custom-threshold alerting rule against any metric field in any index. |

### ML-dependent

| Tool | What It Does |
|------|-------------|
| **ml-anomalies** | Query ML anomaly-detection records and open an inline anomaly-explainer view. Requires ML jobs configured. |

### APM-dependent

| Tool | What It Does |
|------|-------------|
| **apm-health-summary** | Cluster-level health rollup from APM service telemetry; layers in K8s and ML context when available. |
| **apm-service-dependencies** | Service dependency graph (upstream/downstream, protocols, call volume). |

### Kubernetes-dependent

| Tool | What It Does |
|------|-------------|
| **k8s-blast-radius** | Assess the impact of a node going offline — full outage, degraded, unaffected, reschedule feasibility. APM optional. |

Every tool emits an `investigation_actions` list so the UI can surface opinionated next-step prompts — click-to-send without forcing the user to guess the right follow-up tool.

Two Agent Builder workflows ship alongside — for clients that prefer Agent Builder workflows over MCP tools:

- `create-alert-rule` — workflow form of the alert-rule tool (the MCP App version is preferred for most clients).
- `k8s-crashloop-investigation-otel` — automatic CrashLoopBackOff / OOMKilled investigation for clusters on the OTel ingest path (EDOT / kube-stack). Pulls pod context, ML anomalies, upstream health, and recent changes, then synthesizes a root-cause hypothesis.

## How It Works

When a user asks Claude to watch for an anomaly or assess blast radius, Claude calls a model-facing tool on this server. The tool returns a compact text summary to Claude **and** an interactive React UI that renders inline in the conversation. The UI then calls app-only tools directly for all subsequent interactions — keeping the LLM context small while the UI has full data access.

### Skills

The `skills/` directory contains [Claude Skills](https://claude.com/docs/skills/overview) — `SKILL.md` files that teach Claude *when* and *how* to use the tools. Each skill teaches the agent to reach for the paired tool and fill its parameters from natural-language user intent, so users don't need to know tool names or deployment specifics. Skills ship as separate `.zip` artifacts (one per tool); upload individually in Claude Desktop via **Customize → Skills → Create Skill → Upload a skill**.

## Installation

| Guide | Description |
|-------|-------------|
| [Add to Claude Desktop](docs/setup-claude-desktop.md) | Install the MCP app via one-click `.mcpb` or manual config |
| [Add to Cursor](docs/setup-cursor.md) | Connect the MCP app via npx or a locally running server |
| [Add to VS Code](docs/setup-vscode.md) | Connect the MCP app via npx or a locally running server |
| [Add to Claude Code](docs/setup-claude-code.md) | Register the MCP app via the `claude mcp add` CLI |
| [Add to Claude.ai](docs/setup-claude-ai.md) | Expose the MCP app via a cloudflared tunnel |
| [Build and run locally](docs/setup-local.md) | Build the MCP server from source and run it on your machine |
| [Install skills](docs/setup-skills.md) | Install skills via npx, local clone, or zip upload |

### Requirements

- Node ≥ 22
- An Elasticsearch cluster with OpenTelemetry data (EDOT + kube-stack recommended)
- A Kibana instance with Alerting enabled

## Development

```bash
npm run dev          # Watch mode
npm run typecheck    # Type-check only
npm run build:views  # Build views only
npm run build:server # Build server only
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for project structure, build targets (`.mcpb`, `.tgz`, skill zips), and the release process.

## Inspired By

- [Elastic Agent Skills](https://github.com/elastic/agent-skills) — SRE triage methodology and observability skill patterns
- [MCP Apps Specification](https://modelcontextprotocol.io/extensions/apps/overview) — Interactive UI extensions for MCP

## License

Elastic-2.0

# Adding to Claude Desktop

## Option 1: One-click install (recommended)

Download `example-mcp-app-observability.mcpb` from the [latest GitHub release](https://github.com/elastic/example-mcp-app-observability/releases/latest) and double-click it.

Claude Desktop shows an install dialog with a settings UI for your Elasticsearch and Kibana credentials. Sensitive values (API keys) are stored in the OS keychain. No Node.js, cloning, or config-file editing required.

## Option 2: Manual config (build from source)

Requires the project to be [built locally](./setup-local.md).

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "elastic-observability": {
      "command": "node",
      "args": ["/path/to/example-mcp-app-observability/dist/main.js", "--stdio"],
      "env": {
        "ELASTICSEARCH_URL": "https://your-cluster.es.cloud.example.com",
        "ELASTICSEARCH_API_KEY": "your-api-key",
        "KIBANA_URL": "https://your-cluster.kb.cloud.example.com",
        "KIBANA_API_KEY": "your-kibana-api-key"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear under the MCP connector menu.

## Install Skills

Skills teach Claude _when_ and _how_ to use the tools. Download the skill zips from the [latest GitHub release](https://github.com/elastic/example-mcp-app-observability/releases/latest):

- `observe.zip`
- `manage-alerts.zip`
- `ml-anomalies.zip`
- `apm-health-summary.zip`
- `apm-service-dependencies.zip`
- `k8s-blast-radius.zip`

In Claude Desktop: **Customize → Skills → Create Skill → Upload a skill** → upload each zip individually.

If you're building from source, generate the zips locally instead:

```bash
npm run skills:zip
# Produces dist/skills/<skill-name>.zip for each skill
```

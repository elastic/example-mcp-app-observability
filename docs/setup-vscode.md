# Adding to VS Code

Three options depending on your setup.

## Option 1: Via npx (no local setup required)

Requires Node.js 22+. The server is downloaded and run automatically by VS Code.

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "elastic-observability": {
      "command": "npx",
      "args": [
        "-y",
        "https://github.com/elastic/example-mcp-app-observability/releases/latest/download/example-mcp-app-observability.tgz",
        "--stdio"
      ],
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

> **Pinning a version:** Replace `example-mcp-app-observability.tgz` with `example-mcp-app-observability-<version>.tgz` (e.g., `example-mcp-app-observability-0.2.0.tgz`).

## Option 2: Local server (stdio)

Requires the project to be [built locally](./setup-local.md). VS Code launches the server process directly.

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
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

## Option 3: Local server (HTTP)

Requires the server to be [running locally](./setup-local.md) at `http://localhost:3001/mcp`. VS Code connects over HTTP — the server process runs independently.

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "elastic-observability": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

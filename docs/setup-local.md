# Running the Server Locally

Build from source and run the MCP server on your machine.

## Prerequisites

- **Node.js 22+**
- **Elasticsearch 8.x or 9.x** with OpenTelemetry data (EDOT + kube-stack recommended)
- **Kibana 8.x or 9.x** with Alerting enabled (for the `create-alert-rule` tool)
- **API keys** for both Elasticsearch and Kibana

## Steps

```bash
# Clone and install
git clone https://github.com/elastic/example-mcp-app-observability.git
cd example-mcp-app-observability
npm install

# Configure
cp .env.example .env
# Edit .env with your Elasticsearch/Kibana URLs and API keys

# Build
npm run build

# Run
npm start
# Server is now running at http://localhost:3001/mcp
```

## Next Steps

With the server running, connect it to your MCP host:

- [Add to Cursor](./setup-cursor.md)
- [Add to VS Code](./setup-vscode.md)
- [Add to Claude Code](./setup-claude-code.md)
- [Add to Claude Desktop](./setup-claude-desktop.md)
- [Add to Claude.ai](./setup-claude-ai.md)

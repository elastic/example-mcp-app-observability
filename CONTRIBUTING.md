# Contributing

Thank you for your interest in contributing to the Elastic Observability MCP App.

## Prerequisites

- **Node.js 22+**
- **npm** (included with Node.js)
- **Elasticsearch 8.x or 9.x** with OpenTelemetry data (EDOT + kube-stack recommended for runtime testing)
- **Kibana 8.x or 9.x** with Alerting enabled (for the `manage-alerts` tool)

## Getting Started

```bash
git clone https://github.com/elastic/example-mcp-app-observability.git
cd example-mcp-app-observability
npm install
cp .env.example .env
# Edit .env with your Elasticsearch/Kibana URLs and API keys
```

## Development

```bash
npm run dev          # Watch mode (rebuilds server + views on change)
npm run typecheck    # Type-check only (no emit)
npm run build        # Full build: typecheck → tsc → Vite views
npm run build:server # Build server only (tsc)
npm run build:views  # Build views only (Vite)
```

The dev server runs on `http://localhost:3001/mcp` in HTTP mode. Use `npm run start:stdio` to test stdio transport locally.

For the **end-to-end dev workflow** — using [Forge](https://github.com/elastic/forge) to drive realistic K8s incident telemetry against a real cluster while you iterate on tools — see [`docs/development-with-forge.md`](./docs/development-with-forge.md). It covers the validation suite, patterns for enhancing existing tools and adding new ones, and the Claude Code skill that automates env bootstrap.

## Project Structure

| Path            | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `main.ts`       | Entry point — HTTP and stdio transport                       |
| `src/server.ts` | MCP server factory — registers all tool modules              |
| `src/elastic/`  | Elasticsearch and Kibana API clients                         |
| `src/tools/`    | MCP tool definitions (model-facing + app-only)               |
| `src/views/`    | React UIs (one per capability, bundled as single HTML files) |
| `src/shared/`   | Shared UI components, types, and utilities                   |
| `skills/`       | Claude Desktop Skills (`SKILL.md` per capability)            |
| `workflows/`    | Agent Builder workflow YAML files                            |

## Building Distribution Packages

The project supports three distribution formats. All start from the same build pipeline.

### Full Build

```bash
npm run build
```

This runs the TypeScript compiler (type-check + emit to `dist/`) and builds each React view into a self-contained HTML file under `dist/views/`.

### MCPB Bundle (for Claude Desktop)

[MCPB](https://github.com/modelcontextprotocol/mcpb) is a packaging format for MCP servers — a `.mcpb` file that users double-click to install in Claude Desktop with zero prerequisites (Node.js ships bundled with Claude Desktop).

```bash
npm run mcpb:pack
```

This script (`scripts/build-mcpb.sh`) does three things:

1. Runs `npm run build` (TypeScript + Vite views)
2. Bundles the server into a single file with esbuild (`dist/main.bundle.mjs`) — no `node_modules` needed at runtime
3. Runs `mcpb pack .` which reads `manifest.json` and `.mcpbignore` to produce the `.mcpb` archive

The resulting file is `example-mcp-app-observability.mcpb` in the repo root.

**Key files:**

- `manifest.json` — MCPB spec v0.3 manifest declaring server config, user-configurable credentials, tool metadata, and compatibility
- `.mcpbignore` — controls which files are excluded from the bundle (keeps it lean by only including the esbuild bundle + views)

### npm Tarball (for VS Code / npx)

The release workflow produces two `.tgz` tarballs via `npm pack` and attaches them to the GitHub release: a version-less `example-mcp-app-observability.tgz` (stable URL for docs) and a versioned `example-mcp-app-observability-<version>.tgz` (for pinning). Users install via `npx` pointing at the tarball URL — no npm registry publishing required.

To build a tarball locally:

```bash
npm run build
npm pack
```

This produces `example-mcp-app-observability-<version>.tgz` in the repo root. The `bin`, `main`, and `files` fields in `package.json` control what gets included.

### Skill Zips (for Claude Desktop Skills)

Each skill in `skills/` is packaged as an individual `.zip` for upload to Claude Desktop's Skills UI.

```bash
npm run skills:zip
```

This script (`scripts/build-skill-zips.sh`) iterates over `skills/*/`, zipping each directory that contains a `SKILL.md`. The resulting files are written to `dist/skills/` (e.g. `dist/skills/observe.zip`).

## Release Process

Releases are automated via GitHub Actions (`.github/workflows/release.yml`). To create a release:

```bash
npm version patch  # or minor/major — bumps package.json + manifest.json, commits, and tags
git push origin --tags
```

The workflow will:

1. Build the project and create the esbuild bundle
2. Pack the `.mcpb` bundle (for Claude Desktop)
3. Pack the `.tgz` tarball (for VS Code / npx)
4. Build skill zips (one `.zip` per skill in `dist/skills/`)
5. Attach any Agent Builder workflow YAMLs from `workflows/`
6. Create a GitHub release with all files attached

## Adding a New Tool

1. Create the Elastic API client functions in `src/elastic/`
2. Create the tool registration module in `src/tools/` using `registerAppTool` from `@modelcontextprotocol/ext-apps/server`
3. Register the module in `src/server.ts`
4. If the tool has a UI, create a new view directory under `src/views/` with `mcp-app.html` and `App.tsx`
5. Update `manifest.json` if the tool is model-facing (add to the `tools` array)
6. Run `npm run typecheck` to verify

## Code Style

- TypeScript strict mode is enabled
- Views use React 19
- Each view is bundled into a single self-contained HTML file (no external assets)
- Tool results should be compact summaries — the UI loads full data independently via app-only tools

## License

By contributing, you agree that your contributions will be licensed under the Elastic License 2.0.

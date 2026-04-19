#!/usr/bin/env bash
# Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
# or more contributor license agreements. Licensed under the Elastic License
# 2.0; you may not use this file except in compliance with the Elastic License
# 2.0.

#
# Build an MCPB bundle (.mcpb) for Claude Desktop distribution.
# Produces example-mcp-app-observability.mcpb in the repo root.
# Usage: ./scripts/build-mcpb.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Cleaning stale dist/views..."
# build-views.js is additive; stale view directories (e.g. after a source
# rename) linger and get bundled. Clean them so dist/views mirrors src/views.
rm -rf dist/views

echo "==> Building project..."
npm run build

echo "==> Bundling server with esbuild..."
npx esbuild dist/main.js \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --outfile=dist/main.bundle.mjs \
  --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"

echo "==> Packing MCPB bundle..."
npx @anthropic-ai/mcpb pack .

# Newer @anthropic-ai/mcpb versions name the output after the repo directory
# (elastic-o11y-mcp.mcpb) rather than the manifest name. Historical releases
# used the manifest name (example-mcp-app-observability.mcpb) and the README
# install steps depend on it, so normalize the filename here.
# Overwrite unconditionally — a prior release's mcpb can linger in the repo
# root, and without -f the new bundle would be stranded under the default
# name while the stale file got picked up on upload.
if [ -f elastic-o11y-mcp.mcpb ]; then
  mv -f elastic-o11y-mcp.mcpb example-mcp-app-observability.mcpb
fi

VERSION=$(node -e "console.log(require('./package.json').version)")
echo ""
echo "==> Done! example-mcp-app-observability.mcpb (v${VERSION}) is ready."
echo ""
echo "Distribute via GitHub release:"
echo "  gh release create v${VERSION} example-mcp-app-observability.mcpb"
echo ""
echo "Install in Claude Desktop:"
echo "  Double-click the .mcpb file"

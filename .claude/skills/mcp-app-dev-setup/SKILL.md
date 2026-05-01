---
name: mcp-app-dev-setup
description: >
  Bootstrap or repair a development environment for the Elastic Observability
  MCP App with Forge as the data driver. Use when the user says "set up Forge
  for me", "get me ready to work on this MCP app", "run the validation suite",
  "I just cloned this repo, what now", or wants the dev environment refreshed
  after a long gap. Verifies sibling Forge clone, Python venv, cluster
  credentials, MCP harness, and runs a smoke test against the canonical
  validation suite.
---

# MCP App Dev Setup

Bootstraps the development loop documented in `docs/development-with-forge.md`. The user is an L6/L7 engineer who knows their way around but hasn't worked with Forge before. Bias toward doing the work and reporting back, not asking each step.

## What you set up

The dev loop has four pieces, all of which must be working:

1. **Forge clone** at `../forge/` (sibling of `elastic-o11y-mcp/`)
2. **Forge Python venv** with the package installed in editable mode (`pip install -e ".[dev]"`)
3. **MCP App build** — `npm install && npm run build` in `elastic-o11y-mcp/`
4. **Cluster access** — `oteldemo-esyox` GKE cluster credentials in `.env`, validated by a Forge live status check

If any piece is missing or broken, repair it. If the user has a clear preference (different cluster, different repo location), defer to it.

## Sequence

### Step 1 — Locate or clone Forge

```bash
# If sibling exists:
ls -d ../forge

# If not, clone it
git clone https://github.com/elastic/forge.git ../forge
```

If the user has Forge in a non-sibling location, accept their path and adjust subsequent commands.

### Step 2 — Forge Python environment

```bash
cd ../forge
# Create venv if missing
python3 -m venv .venv 2>/dev/null || true
source .venv/bin/activate
pip install -e ".[dev]"

# Confirm
python3 -c "from forge.cli import main; print('forge cli ok')"
```

### Step 3 — MCP App build

```bash
cd ../elastic-o11y-mcp
npm install
npm run build
```

If `npm run build` fails on type errors, surface them — the user may have intentional in-progress changes.

### Step 4 — Cluster credentials

The canonical dev cluster is `oteldemo-esyox`. Credentials are in `.env`:

```
ELASTICSEARCH_URL=...
ELASTICSEARCH_API_KEY=...
KIBANA_URL=...
KIBANA_API_KEY=...
```

If `.env` is missing or fields are empty:

1. Check if `.env.example` is present — copy it to `.env` and prompt the user for the credentials. The credentials live in 1Password (`Forge — oteldemo-esyox`); the user can fetch them.
2. Once `.env` is populated, validate by running a basic Forge query:

```bash
cd ../forge
source .venv/bin/activate
python3 -c "
from forge.elastic.client import ElasticsearchClient
import os
c = ElasticsearchClient(url=os.environ['ELASTICSEARCH_URL'], api_key=os.environ['ELASTICSEARCH_API_KEY'])
print(c.info())
"
```

### Step 5 — Smoke test the validation suite

Confirm the bench manifest validates:

```bash
cd ../forge
source .venv/bin/activate
python3 -m forge.cli mcp-app-bench
```

Expected output: 6 entries, 4 with `✓` (eval pack present), 2 with `○` (eval pack missing — known gap).

If the manifest fails to validate, the genome library may be inconsistent with what the bench references — surface the error and stop.

## Daily workflow you can suggest

After setup, the user is ready to:

```bash
# Terminal 1 — Forge live session
cd ../forge && source .venv/bin/activate
python3 -m forge.cli  # explore commands; live session start needs a connected cluster

# Terminal 2 — MCP App harness
cd elastic-o11y-mcp
npm run dev          # builds the server in watch mode
npm run harness      # opens inline view harness at localhost:5371
```

For the actual incident-injection workflow, point the user at `docs/development-with-forge.md` — particularly the **Pattern: validating an existing tool** and **Pattern: enhancing a tool for a new failure mode** sections.

## Things to surface

When you finish setup, report:

- Whether each of the four pieces is working
- The dev cluster connection status (real cluster name + index count if reachable)
- Which validation suite entries have eval packs and which don't
- Any version drift detected (Node version, Python version, Forge head commit)

If something is broken in a way you can't fix without user input (missing credentials, ambiguous repo location), ask once with the specific question — don't guess.

## What you do NOT do

- Do not check in `.env` or any credential.
- Do not modify Forge's `library/` or `forge/` directories — that's the engineer's territory, not setup territory.
- Do not run `forge mcp-app-bench --run` against a cluster without explicit user approval — it consumes real cluster resources for ~25-35 minutes.

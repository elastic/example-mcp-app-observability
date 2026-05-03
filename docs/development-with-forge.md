# Developing the MCP App with Forge

Forge is the simulation and evaluation platform we use to validate, enhance, and extend the tools in this app. It runs realistic K8s incident scenarios against a real GKE cluster, blends synthetic failure signals into real OTel telemetry, and lets you watch a tool behave under conditions that match real-world post-mortems.

This guide assumes you'll use a Claude Code agent for setup and daily workflows. The patterns below explain *what* the agent should do; the [`mcp-app-dev-setup`](#claude-code-skill) skill encodes *how*.

> **Audience.** This guide assumes Node.js / TypeScript fluency, comfort with K8s and OTel concepts, and ability to read Python (Forge is Python; you'll mostly run it, occasionally extend it). If you're new to Forge itself, that's expected — Forge has its own [VISION.md](https://github.com/elastic/forge/blob/main/VISION.md). For a 5-minute "what is this?" walkthrough that doesn't require any cluster setup, start with Forge's [QUICKSTART.md](https://github.com/elastic/forge/blob/main/QUICKSTART.md) and look at the Showcase dashboard — you'll have model-tier benchmark data and per-investigation traces visible without writing any code.

---

## What you get

| Capability | Provided by | Use when |
|---|---|---|
| Realistic K8s telemetry against a real cluster | Forge baseline + 16 K8s genomes | Anywhere you need real OTel data plus a known failure injected |
| Score an agent investigation against a known root cause | Forge eval system | Validating that a tool change actually helps an investigating agent |
| Inline UI iteration without round-tripping through Claude | This repo's `harness/` (`npm run harness`) | Iterating on the React views inside each tool |
| Live cluster connection with topology + metrics | Forge `live` session | When you need real APM/k8s data flowing during dev |

The [genome × tool matrix](https://github.com/elastic/forge/blob/main/docs/strategy/genome-tool-matrix.md) is the index — it tells you which Forge genome exercises which tool.

---

## One-time setup

Hand the [`mcp-app-dev-setup`](#claude-code-skill) skill a `claude` session and it will:

1. Clone Forge as a sibling of this repo (`../forge`) if missing
2. Install Forge (`pip install -e ".[dev]"` in a venv)
3. Verify access to the canonical OTel demo cluster (`oteldemo-esyox`)
4. Configure your `.env` with the same Elastic cluster Forge writes to (so the MCP app reads what Forge wrote)
5. Run a smoke test: `npm run dev` + `forge live status` against the cluster

If you want to do it manually, the [Forge README](https://github.com/elastic/forge/blob/main/README.md) walks through it.

**Cluster credentials** live in 1Password (`Forge — oteldemo-esyox`); the skill knows how to fetch them.

---

## The validation suite

Before any tool change ships, run the **MCP App Validation Suite** against your changes. Six genomes, one per tool, each chosen to land Strong on its primary tool. The full matrix is in `forge/docs/strategy/genome-tool-matrix.md`.

```bash
forge mcp-app-bench --cluster oteldemo-esyox
```

This injects each genome in sequence against the live cluster, scores an investigation by the agent, and reports per-tool eval deltas. Takes ~25–35 minutes. Run it before opening a PR.

---

## Daily workflow

```bash
# In one terminal — Forge live session against the cluster
forge live start --cluster oteldemo-esyox
# Forge starts pulling real OTel telemetry, ready to inject

# In another terminal — MCP app dev server with the harness
cd ~/elastic-o11y-mcp
npm run dev    # builds the MCP server
npm run harness    # opens the inline view harness at localhost:5371

# Ready to iterate. Pick a genome that exercises your tool, inject it.
forge live inject --genome 17-k8s-oomkill-cascade
# Telemetry now blended into the cluster's indices, queryable as forge.source = incident
```

The MCP app reads the same indices Forge writes to. So the moment a genome is injected, your tool sees the new signal — refresh in Claude Desktop, or run the tool from the harness fixture.

To stop a session: `forge live stop`.

---

## Pattern: validating an existing tool

You changed `apm-health-summary` to add a new field. Did you break it?

1. **Pick the tool's canonical genome** from the matrix. For `apm-health-summary`, that's **22 Node NotReady cascade**.
2. **Capture baseline output**: with no incident injected, call the tool. Save the response.
3. **Inject** the genome (`forge live inject --genome 22-k8s-node-notready-cascade`).
4. **Capture incident output**: call the tool again. The output should differ in the dimensions the genome exercises (degraded service chips, pod resource pressure, etc.).
5. **Compare**: if the output didn't change, the tool isn't reading the data correctly — your change broke it, or the genome's signal projection broke. Either way, root-cause before merging.

For a fuller test, run the entire `mcp-app-bench` suite — it scores all six tools, not just one.

---

## Pattern: enhancing a tool for a new failure mode

You want `k8s-blast-radius` to handle "what happens if this **deployment** is unavailable?" (currently it only handles "what happens if this **node** is unavailable?").

Step 1 — **Find the matching genome.** Check the matrix for genomes that exercise deployment-unavailability:
- 26 ImagePull cascade (deployment stuck at n-1/n replicas)
- 31 Resource quota exhaustion (deployment can't add replicas)

Both are marked **Partial** for `k8s-blast-radius` today. That Partial-not-Strong is *the gap your enhancement closes.*

Step 2 — **Confirm the genome projects the right signals.** Read `forge/library/genomes/26-k8s-imagepull-cascade.yaml` and `forge/library/genomes/31-k8s-resource-quota-exhaustion.yaml`. Verify they produce the metrics your enhanced tool will consume (e.g., `k8s.deployment.replicas_ready` vs `replicas_desired`).

Step 3 — **If the genome's signals don't match what you need:** extend the genome's projection. Most projection logic lives in `forge/genome/k8s_primitives.py` (failure primitives) and `forge/genome/projectors.py` (signal mapping). Add fields the YAML primitive can request. Land a Forge PR before you start work on the tool.

Step 4 — **Build the enhancement against the genome's data shape.** Use the harness with a fixture captured from a Forge run.

Step 5 — **Update the matrix.** Once your enhancement lands, the cell for `k8s-blast-radius` × `26 ImagePull` and `× 31 Resource quota` should move from **P** to **S**. Update `forge/docs/strategy/genome-tool-matrix.md` in the same PR.

The principle: **a tool change without a matching genome is not falsifiable.** Forge is your test of "does this tool actually help an SRE?" — without the genome, you don't have the test.

---

## Pattern: adding a new MCP tool

You want to add a new tool — say, `k8s-pod-restart-history` — that surfaces the restart timeline of a pod across a window.

You need three things, not one:

### 1. The genome (or a primitive extension)

Pick a real post-mortem the new tool addresses. If a genome already exercises that failure mode, use it. If not, design one — see [`forge/docs/incident-genomes-explained.md`](https://github.com/elastic/forge/blob/main/docs/incident-genomes-explained.md).

For pod restart history, **17 OOMKill cascade** and **18 Probe misconfiguration** are the canonical genomes — both produce restart sequences with distinct fingerprints (exponential backoff vs. fast cycles).

### 2. The Forge MCP mirror

Forge's eval agent calls Forge MCP tools (`forge/forge/mcp/`) during a scored investigation. If the customer-facing tool isn't mirrored on the Forge side, the eval agent has a different toolset than what ships to customers — eval scores won't transfer.

Add the mirror at the same time as the customer-facing tool:

```
forge/forge/mcp/pod_restart_history.py    # the Forge mirror
elastic-o11y-mcp/src/tools/k8s-pod-restart-history.ts    # the customer tool
```

Both should query the same indices and surface the same fields. The customer-facing tool wraps the response in an MCP UI resource; the Forge mirror returns plain JSON for the eval agent.

Existing mirrors to model after: `forge_health_summary` mirrors `apm-health-summary`; `forge_blast_radius` mirrors `k8s-blast-radius`; `forge_service_dependencies` mirrors `apm-service-dependencies`. (Note: `observe` does not yet have a Forge mirror — flagging this gap as one to close opportunistically.)

### 3. The skill

Customer-facing tool needs a `SKILL.md` in `skills/<tool-name>/` so Claude knows when to reach for it. Match the shape of the existing skills (`skills/observe/SKILL.md` is the most thorough reference).

### Wire it together

Once all three exist:
1. `forge mcp-app-bench --tool k8s-pod-restart-history` — runs the canonical genomes and validates your tool detects what it should.
2. Add a row to the genome × tool matrix in `forge/docs/strategy/genome-tool-matrix.md`.
3. Open paired PRs: one in this repo (tool + skill), one in Forge (mirror + matrix update + any new genome / primitive).

---

## Forge gaps to know about

These are open Forge gaps that affect the dev workflow. Track them in your head:

- **`observe` has no Forge mirror.** Add one or extend `forge_query` if you need the eval agent to do polling.
- **Six genomes (27–32) lack eval cards.** Their YAMLs project signal, but `forge mcp-app-bench` can't score an investigation of them yet. Add `library/eval/<genome>.yaml` if you want to score these.
- **Genome 27 (`priority-preemption-storm`) isn't executable yet.** It references a primitive that isn't registered. Adding the primitive + the eval card is the canonical "first PR" for the new engineer — see Gap 4 in the matrix.
- **ML-anomalies coverage is shallow.** Only three ML jobs are configured (`k8s-container-restart-rate`, `k8s-pod-memory-growth`, `k8s-pod-network-io`). Adding more (CPU throttling rate, error-rate spike, etcd fsync latency, eviction rate) widens `ml-anomalies` coverage substantially. Jobs live in `forge/library/ml-jobs/`.

---

## Claude Code skill

The `mcp-app-dev-setup` skill automates env bootstrap. It lives at `.claude/skills/mcp-app-dev-setup/` so it's picked up by Claude Code in this project but isn't bundled into the customer-facing skill zips.

When using Claude Code in this repo, the skill is auto-discovered. Just ask: *"set up Forge for me"* or *"get me ready to work on this MCP app"*. The skill handles the four-piece setup (Forge clone, Python venv, MCP build, cluster credentials) and runs a smoke test of the validation suite.

---

## Reference

- [Forge VISION.md](https://github.com/elastic/forge/blob/main/VISION.md) — what Forge is and why
- [Genome × Tool Matrix](https://github.com/elastic/forge/blob/main/docs/strategy/genome-tool-matrix.md) — which genomes exercise which tools, plus open gaps
- [Forge incident genomes explained](https://github.com/elastic/forge/blob/main/docs/incident-genomes-explained.md) — how to read and write a genome
- [MCP App harness README](../harness/README.md) — inline view dev environment
- [CONTRIBUTING.md](../CONTRIBUTING.md) — repo conventions, build, test

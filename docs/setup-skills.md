# Installing Skills

Skills teach your AI agent _when_ and _how_ to use the tools. You can install them via the `skills` CLI with `npx`, or upload the zipped skills directly into Claude Desktop.

## npx (Recommended)

The fastest way to install skills — no need to clone this repository:

```sh
npx skills add elastic/example-mcp-app-observability
```

This launches an interactive prompt to select skills and [target agents](https://github.com/vercel-labs/skills?tab=readme-ov-file#supported-agents). The CLI copies each skill folder into the correct location for the agent to discover.

Install all skills to all agents (non-interactive):

```sh
npx skills add elastic/example-mcp-app-observability --all
```

## Claude Desktop (zip upload)

Download the skill zips from the [latest GitHub release](https://github.com/elastic/example-mcp-app-observability/releases/latest):

- `watch.zip`
- `create-alert-rule.zip`
- `ml-anomalies.zip`
- `apm-health-summary.zip`
- `apm-service-dependencies.zip`
- `k8s-blast-radius.zip`

In Claude Desktop: **Customize → Skills → Create Skill → Upload a skill** → upload each zip individually.

If you're building from source, you can generate the zips locally:

```bash
npm run skills:zip
# Produces dist/skills/<skill-name>.zip for each skill
```

## Supported agents (via npx)

| Agent          | Install directory  |
| -------------- | ------------------ |
| claude-code    | `.claude/skills`   |
| cursor         | `.agents/skills`   |
| codex          | `.agents/skills`   |
| opencode       | `.agents/skills`   |
| pi             | `.pi/agent/skills` |
| windsurf       | `.windsurf/skills` |
| roo            | `.roo/skills`      |
| cline          | `.agents/skills`   |
| github-copilot | `.agents/skills`   |
| gemini-cli     | `.agents/skills`   |

## Updating skills

Check whether any installed skills have changed upstream, then pull the latest:

```sh
npx skills check
npx skills update
```

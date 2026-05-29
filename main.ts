#!/usr/bin/env node
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import { createServer } from "./src/server.js";
import { createAnalyticsClient, type AnalyticsClient } from "./src/elastic/analytics/index.js";
import { TelemetryConfigClient } from "./src/elastic/telemetryConfigClient.js";
import { TelemetryService } from "./src/elastic/telemetryService.js";
import { createContextLoader } from "./src/elastic/analytics/index.js";
import { createStderrLogger } from "./src/shared/logger.js";
import { readPackageVersion } from "./src/shared/package-version.js";

const isStdio = process.argv.includes("--stdio");
const telemetryLogger = createStderrLogger(["telemetry"]);

let analytics: AnalyticsClient;
try {
  analytics = createAnalyticsClient({
    mcpAppVersion: readPackageVersion(import.meta.url),
    logger: telemetryLogger,
  });

  const telemetryConfigClient = new TelemetryConfigClient();
  const telemetryService = new TelemetryService({
    telemetryConfigClient,
    analytics,
    logger: telemetryLogger,
  });
  const contextLoader = createContextLoader({
    analytics,
    logger: telemetryLogger,
  });

  void Promise.allSettled([
    telemetryService.applyOptIn(),
    contextLoader.loadAndApply(),
  ]);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[elastic-o11y] startup failed: ${message}\n`);
  process.exit(1);
}

const ANALYTICS_SHUTDOWN_TIMEOUT_MS = 1500;

const shutdown = ((): ((signal: NodeJS.Signals) => Promise<void>) => {
  let started: Promise<void> | null = null;
  return (signal) => {
    if (started) return started;
    started = (async () => {
      try {
        await Promise.race([
          analytics.shutdown(),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ANALYTICS_SHUTDOWN_TIMEOUT_MS);
            timer.unref();
          }),
        ]);
      } catch { /* ignore shutdown errors */ }
      process.exit(signal === "SIGINT" ? 130 : 143);
    })();
    return started;
  };
})();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => { void shutdown(signal); });
}

if (isStdio) {
  const server = createServer(analytics);
  const transport = new StdioServerTransport();
  await server.connect(transport);
} else {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const server = createServer(analytics);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ error: "Use POST for MCP requests" }));
  });

  app.delete("/mcp", async (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ error: "Session management not supported in stateless mode" }));
  });

  const port = parseInt(process.env.PORT || "3001", 10);
  app.listen(port, () => {
    console.log(`Elastic Observability MCP App server running on http://localhost:${port}/mcp`);
  });
}

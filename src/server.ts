/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMlAnomaliesTool } from "./tools/ml-anomalies.js";
import { registerObserveTool } from "./tools/observe.js";
import { registerApmHealthSummaryTool } from "./tools/apm-health-summary.js";
import { registerK8sBlastRadiusTool } from "./tools/k8s-blast-radius.js";
import { registerApmServiceDependenciesTool } from "./tools/apm-service-dependencies.js";
import { registerManageAlertsTool } from "./tools/manage-alerts.js";
import { registerSetupDismissTool } from "./tools/setup-dismiss.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { isKibanaConfigured } from "./elastic/client.js";
import { noopAnalyticsClient, type AnalyticsClient } from "./elastic/analytics/index.js";

export function createServer(analytics: AnalyticsClient = noopAnalyticsClient): McpServer {
  const server = new McpServer({
    name: "elastic-o11y",
    version: "0.1.0",
  });

  registerMlAnomaliesTool(server, analytics);
  registerObserveTool(server, analytics);
  registerApmHealthSummaryTool(server, analytics);
  registerK8sBlastRadiusTool(server, analytics);
  registerApmServiceDependenciesTool(server, analytics);

  if (isKibanaConfigured()) {
    registerManageAlertsTool(server, analytics);
  }

  registerSetupDismissTool(server);
  registerAnalyticsTools(server, { analytics });

  return server;
}

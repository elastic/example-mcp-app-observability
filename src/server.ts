/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMlAnomaliesTool } from "./tools/ml-anomalies.js";
import { registerWatchTool } from "./tools/watch.js";
import { registerApmHealthSummaryTool } from "./tools/apm-health-summary.js";
import { registerK8sBlastRadiusTool } from "./tools/k8s-blast-radius.js";
import { registerApmServiceDependenciesTool } from "./tools/apm-service-dependencies.js";
import { registerManageAlertsTool } from "./tools/manage-alerts.js";
import { isKibanaConfigured } from "./elastic/client.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "elastic-o11y",
    version: "0.1.0",
  });

  registerMlAnomaliesTool(server);
  registerWatchTool(server);
  registerApmHealthSummaryTool(server);
  registerK8sBlastRadiusTool(server);
  registerApmServiceDependenciesTool(server);

  // manage-alerts hits Kibana APIs and can delete persistent rules. Gate its
  // registration on an explicit KIBANA_URL so operators can selectively disable
  // the tool (and its destructive operation=delete path) by leaving `kibana_url`
  // blank in the install config. When unregistered the LLM never sees the tool
  // and can't invoke it.
  if (isKibanaConfigured()) {
    registerManageAlertsTool(server);
  }

  return server;
}

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { VIEW_IDS, type AnalyticsClient } from "../elastic/analytics/index.js";
import { createStderrLogger, type Logger } from "../shared/logger.js";

export interface AnalyticsToolDeps {
  readonly analytics: Pick<AnalyticsClient, "trackViewRendered">;
  readonly logger?: Pick<Logger, "warn">;
}

const analyticsEventSchema = z.discriminatedUnion("eventType", [
  z.object({
    eventType: z.literal("view_rendered"),
    viewId: z.enum(VIEW_IDS),
  }),
]);

export function registerAnalyticsTools(server: McpServer, deps: AnalyticsToolDeps): void {
  const { analytics } = deps;
  const logger = deps.logger ?? createStderrLogger(["analytics-tool"]);

  registerAppTool(
    server,
    "report-analytics-event",
    {
      title: "Report Analytics Event",
      description: "Internal: report a UI analytics event",
      inputSchema: analyticsEventSchema,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (event) => {
      try {
        switch (event.eventType) {
          case "view_rendered":
            analytics.trackViewRendered({ view_id: event.viewId });
            break;
          default: {
            const _exhaustive: never = event.eventType;
            void _exhaustive;
          }
        }
      } catch (err) {
        logger.warn(`report-analytics-event: trackViewRendered failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
      };
    },
  );
}

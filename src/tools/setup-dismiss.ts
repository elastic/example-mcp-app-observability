/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Internal tool: dismiss the welcome setup notice. Invoked by the views'
 * banner close button via the MCP UI app.callServerTool side-channel — does
 * NOT go through Claude. Accepts no arguments and writes a marker file in
 * the user's home directory so subsequent server starts no longer surface
 * the welcome banner.
 *
 * Tool name uses the `_setup-` prefix as a convention for "intended for
 * view-side invocation, not Claude". The tool is still listed in the
 * server's tool registry (no MCP visibility flag yet to fully hide it),
 * so a sufficiently curious LLM might call it; that's harmless — calling
 * it dismisses the banner, which is the same effect as the user clicking
 * the close button.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dismissWelcomeNotice } from "../setup/notice.js";

export function registerSetupDismissTool(server: McpServer) {
  server.registerTool(
    "_setup-dismiss-welcome",
    {
      title: "Dismiss Setup Welcome",
      description:
        "Internal: dismisses the welcome banner shown on the first few tool " +
        "responses after server start. Called by the view banner's close " +
        "button via app.callServerTool. Persists across server restarts via " +
        "a marker file in the user's home directory.",
      inputSchema: {},
    },
    async () => {
      const result = dismissWelcomeNotice();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );
}

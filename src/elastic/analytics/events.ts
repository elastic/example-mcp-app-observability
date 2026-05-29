/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EventTypeOpts } from "@elastic/ebt/client/index.js";
import type { ViewId } from "../../shared/analytics-events.js";

export { VIEW_IDS, type ViewId } from "../../shared/analytics-events.js";

export const EVENT_TYPES = {
  mcpToolCalled: "mcp_tool_called",
  viewRendered: "view_rendered",
} as const;

export interface McpToolCalledEbtPayload {
  readonly tool_id: string;
  readonly duration_ms: number;
  readonly success: boolean;
}

export interface ViewRenderedEbtPayload {
  readonly view_id: ViewId;
}

export const mcpToolCalledEventDef: EventTypeOpts<McpToolCalledEbtPayload> = {
  eventType: EVENT_TYPES.mcpToolCalled,
  schema: {
    tool_id: { type: "keyword", _meta: { description: "MCP tool that was invoked" } },
    duration_ms: { type: "long", _meta: { description: "Wall-clock duration of the tool handler in ms" } },
    success: { type: "boolean", _meta: { description: "Whether the handler resolved (true) or threw (false)" } },
  },
};

export const viewRenderedEventDef: EventTypeOpts<ViewRenderedEbtPayload> = {
  eventType: EVENT_TYPES.viewRendered,
  schema: {
    view_id: { type: "keyword", _meta: { description: "Identifier of the React view that mounted" } },
  },
};

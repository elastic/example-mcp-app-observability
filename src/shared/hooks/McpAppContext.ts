/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createContext } from "react";
import type { App as McpApp } from "@modelcontextprotocol/ext-apps";

export type { App as McpApp } from "@modelcontextprotocol/ext-apps";

export type ToolResultParams = Parameters<NonNullable<McpApp["ontoolresult"]>>[0];
export type OnToolResult = (params: ToolResultParams) => void;
export type Unsubscribe = () => void;

export interface McpAppContextValue {
  readonly app: McpApp | null;
  readonly getApp: () => McpApp | null;
  readonly connected: boolean;
  readonly subscribeToToolResult: (listener: OnToolResult) => Unsubscribe;
}

export const McpAppContext = createContext<McpAppContextValue | null>(null);

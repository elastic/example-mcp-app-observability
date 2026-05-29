/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { App as McpApp } from "@modelcontextprotocol/ext-apps";
import { applyTheme } from "../theme.js";
import { McpAppContext, type McpAppContextValue, type OnToolResult, type Unsubscribe } from "./McpAppContext.js";

export interface McpAppProviderProps {
  name: string;
  version: string;
  children: ReactNode;
}

export function McpAppProvider({ name, version, children }: McpAppProviderProps): ReactNode {
  const appRef = useRef<McpApp | null>(null);
  const [connected, setConnected] = useState(false);
  const toolResultListeners = useRef<Set<OnToolResult>>(new Set());

  useEffect(() => {
    const app = new McpApp({ name, version });
    appRef.current = app;
    setConnected(false);
    applyTheme();

    let cancelled = false;

    app.ontoolresult = (params) => {
      for (const listener of [...toolResultListeners.current]) {
        try { listener(params); } catch (e) { console.error("onToolResult listener failed:", e); }
      }
    };

    app.connect()
      .then(() => { if (cancelled) return; setConnected(true); })
      .catch((err) => { if (cancelled) return; console.error("MCP app connect() failed:", err); });

    return () => { cancelled = true; app.close(); appRef.current = null; };
  }, [name, version]);

  const subscribeToToolResult = useCallback((listener: OnToolResult): Unsubscribe => {
    toolResultListeners.current.add(listener);
    return () => { toolResultListeners.current.delete(listener); };
  }, []);

  const value = useMemo<McpAppContextValue>(
    () => ({ app: appRef.current, getApp: () => appRef.current, connected, subscribeToToolResult }),
    [connected, subscribeToToolResult],
  );

  return <McpAppContext.Provider value={value}>{children}</McpAppContext.Provider>;
}

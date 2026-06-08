/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Harness mock for the MCP App context.
 *
 * Views consume the host connection through `useMcpApp()`, which reads
 * `McpAppContext`. The real `McpAppProvider` constructs an `@mcp/ext-apps`
 * App and bridges it to the Claude Desktop host over postMessage. Here we
 * supply the SAME context with a stand-in `app` so views render in-process
 * with a fixture instead of a live host: `FixtureProvider` pushes the
 * selected fixture's tool-result payload to every `subscribeToToolResult`
 * listener, and the mock `app` routes `sendMessage` / `callServerTool` /
 * `requestDisplayMode` back to the harness chrome's callbacks.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  McpAppContext,
  type McpAppContextValue,
  type McpApp,
  type OnToolResult,
  type ToolResultParams,
} from "@shared/hooks/McpAppContext";

export type DisplayMode = "inline" | "fullscreen" | "pip";

export interface Fixture {
  label: string;
  result: ToolResultParams;
  /**
   * Optional sample LLM prompt — what a user would have typed in Claude
   * to call this tool and produce this fixture's payload. Rendered in a
   * strip above the harness iframe so demos can show "this is the chat
   * input that would have produced this view state".
   */
  prompt?: string;
}

interface HarnessContextValue {
  fixture: Fixture | null;
  onSendMessage: (text: string) => void;
  onCallServerTool: (name: string, args: Record<string, unknown>) => void;
  onRequestDisplayMode: (mode: DisplayMode) => DisplayMode;
}

/**
 * Build a stand-in for the `@mcp/ext-apps` App. Only the surface the views and
 * shared hooks actually touch is implemented: `sendMessage`, `callServerTool`,
 * `requestDisplayMode`, `openLink`, and the `ontoolresult` sink. Everything is
 * routed to the harness chrome's callbacks; the rest is typed away with a cast.
 */
function makeMockApp(handlers: HarnessContextValue): McpApp {
  const extractText = (msg: unknown): string => {
    const content = (msg as { content?: Array<{ text?: string }> } | undefined)?.content;
    return Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : String(msg ?? "");
  };
  const app = {
    ontoolresult: null as ((p: ToolResultParams) => void) | null,
    ontoolinput: null,
    sendMessage: (msg: unknown) => handlers.onSendMessage(extractText(msg)),
    callServerTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      handlers.onCallServerTool(name, args);
      return { content: [] };
    },
    requestDisplayMode: async ({ mode }: { mode: DisplayMode }) => ({
      mode: handlers.onRequestDisplayMode(mode),
    }),
    openLink: async ({ url }: { url: string }) => {
      window.open(url, "_blank", "noopener,noreferrer");
      return {};
    },
    connect: async () => {},
    close: () => {},
  };
  return app as unknown as McpApp;
}

export function FixtureProvider({
  value,
  children,
}: {
  value: HarnessContextValue;
  children: React.ReactNode;
}) {
  const listeners = useRef<Set<OnToolResult>>(new Set());

  // One mock app instance per provider; its callbacks read live handlers via ref
  // so a fixture/handler change never forces the view to re-acquire the app.
  const handlersRef = useRef(value);
  handlersRef.current = value;
  const appRef = useRef<McpApp | null>(null);
  if (!appRef.current) {
    appRef.current = makeMockApp({
      fixture: null,
      onSendMessage: (t) => handlersRef.current.onSendMessage(t),
      onCallServerTool: (n, a) => handlersRef.current.onCallServerTool(n, a),
      onRequestDisplayMode: (m) => handlersRef.current.onRequestDisplayMode(m),
    });
  }

  const [connected, setConnected] = useState(false);
  useEffect(() => {
    setConnected(true);
  }, []);

  const ctx = useMemo<McpAppContextValue>(
    () => ({
      app: appRef.current,
      getApp: () => appRef.current,
      connected,
      subscribeToToolResult: (listener: OnToolResult) => {
        listeners.current.add(listener);
        // Deliver the current fixture to a freshly-subscribed view one tick
        // later, mirroring the async ontoolresult delivery in production.
        const f = handlersRef.current.fixture;
        if (f) {
          const t = setTimeout(() => listener(f.result), 0);
          return () => {
            clearTimeout(t);
            listeners.current.delete(listener);
          };
        }
        return () => listeners.current.delete(listener);
      },
    }),
    [connected],
  );

  // Re-dispatch whenever the selected fixture changes.
  useEffect(() => {
    if (!value.fixture) return;
    const t = setTimeout(() => {
      for (const l of [...listeners.current]) {
        try {
          l(value.fixture!.result);
        } catch (e) {
          console.error("[harness] tool-result listener failed:", e);
        }
      }
    }, 0);
    return () => clearTimeout(t);
  }, [value.fixture]);

  return <McpAppContext.Provider value={ctx}>{children}</McpAppContext.Provider>;
}

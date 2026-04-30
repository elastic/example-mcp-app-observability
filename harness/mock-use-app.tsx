/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Harness drop-in replacement for `@shared/use-app`.
 *
 * `vite.harness.config.ts` aliases `@shared/use-app` → this file so every view
 * imports the mock hook without any view-code changes. The harness chrome
 * renders each view inside `<FixtureProvider>` and changes the `fixture` prop
 * as the user selects states in the sidebar; this hook re-delivers the payload
 * through the view's own `ontoolresult` handler.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// Mirror the real shapes so views compile unchanged.

export type DisplayMode = "inline" | "fullscreen" | "pip";

export interface ToolResultParams {
  content?: Array<{ type: string; text?: string }>;
}

export interface AppLike {
  ontoolresult: ((params: ToolResultParams) => void) | null;
  ontoolinput: ((params: Record<string, unknown>) => void) | null;
  callServerTool: (params: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<ToolResultParams>;
  sendMessage: (text: string) => void;
  requestDisplayMode: (params: { mode: DisplayMode }) => Promise<{ mode: DisplayMode }>;
}

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

const HarnessContext = createContext<HarnessContextValue>({
  fixture: null,
  onSendMessage: () => {},
  onCallServerTool: () => {},
  onRequestDisplayMode: (m) => m,
});

export function FixtureProvider({
  value,
  children,
}: {
  value: HarnessContextValue;
  children: React.ReactNode;
}) {
  const memo = useMemo(
    () => value,
    [value.fixture, value.onSendMessage, value.onCallServerTool, value.onRequestDisplayMode],
  );
  return <HarnessContext.Provider value={memo}>{children}</HarnessContext.Provider>;
}

interface UseAppOptions {
  appInfo?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
  onAppCreated?: (app: AppLike) => void;
}

export function useApp(opts: UseAppOptions): {
  isConnected: boolean;
  error: Error | null;
} {
  const { fixture, onSendMessage, onCallServerTool, onRequestDisplayMode } =
    useContext(HarnessContext);
  const appRef = useRef<AppLike>({
    ontoolresult: null,
    ontoolinput: null,
    callServerTool: () => Promise.resolve({}),
    sendMessage: () => {},
    requestDisplayMode: () => Promise.resolve({ mode: "inline" }),
  });
  const setupRef = useRef(false);
  const [, force] = useState(0);

  // One-time setup: hand the view its AppLike so it can register handlers.
  useEffect(() => {
    if (setupRef.current) return;
    setupRef.current = true;
    const app = appRef.current;
    app.sendMessage = (text) => onSendMessage(text);
    app.callServerTool = async ({ name, arguments: args }) => {
      onCallServerTool(name, args);
      return { content: [] };
    };
    app.requestDisplayMode = async ({ mode }) => {
      const applied = onRequestDisplayMode(mode);
      return { mode: applied };
    };
    opts.onAppCreated?.(app);
    force((n) => n + 1);
  }, [opts, onSendMessage, onCallServerTool, onRequestDisplayMode]);

  // Whenever the fixture changes, re-dispatch through the view's handler.
  useEffect(() => {
    if (!fixture) return;
    // Defer one tick so the view has applied its own handler even if the
    // setup effect just ran in the same microtask.
    const t = setTimeout(() => {
      appRef.current.ontoolresult?.(fixture.result);
    }, 0);
    return () => clearTimeout(t);
  }, [fixture]);

  return { isConnected: !!fixture, error: null };
}

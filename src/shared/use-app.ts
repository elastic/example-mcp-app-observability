/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Minimal MCP Apps shim — implements just enough of the UI protocol to:
 *   1. Handshake with the host via ui/initialize + ui/notifications/initialized
 *   2. Receive ui/notifications/tool-result
 *   3. Call server tools via tools/call
 *   4. Send user messages via ui/message (for next-step buttons)
 *   5. Report size via ui/notifications/size-changed (ResizeObserver-driven)
 *
 * Matches the @modelcontextprotocol/ext-apps spec (protocolVersion 2026-01-26)
 * without pulling in the full library's 450KB of Zod schemas.
 */

import { useState, useEffect, useRef } from "react";

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
}

interface UseAppOptions {
  appInfo?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
  onAppCreated?: (app: AppLike) => void;
}

const _pending = new Map<
  number,
  { resolve: (v: ToolResultParams) => void; reject: (e: Error) => void }
>();
let _nextId = 100;

export function useApp({ appInfo, onAppCreated }: UseAppOptions): {
  isConnected: boolean;
  error: Error | null;
} {
  const [isConnected, setIsConnected] = useState(false);
  const [error] = useState<Error | null>(null);
  const appRef = useRef<AppLike>({
    ontoolresult: null,
    ontoolinput: null,
    callServerTool: () => Promise.reject(new Error("not initialized")),
    sendMessage: () => {},
  });

  useEffect(() => {
    const app = appRef.current;

    app.callServerTool = (params) => {
      return new Promise<ToolResultParams>((resolve, reject) => {
        const id = _nextId++;
        _pending.set(id, { resolve, reject });

        window.parent.postMessage(
          { jsonrpc: "2.0", id, method: "tools/call", params },
          "*"
        );

        setTimeout(() => {
          if (_pending.has(id)) {
            _pending.delete(id);
            reject(new Error(`Tool call '${params.name}' timed out after 60s`));
          }
        }, 60_000);
      });
    };

    app.sendMessage = (text) => {
      const id = _nextId++;
      window.parent.postMessage(
        {
          jsonrpc: "2.0",
          id,
          method: "ui/message",
          params: {
            role: "user",
            content: [{ type: "text", text }],
          },
        },
        "*"
      );
    };

    onAppCreated?.(app);

    const handleMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;

      if (msg.id !== undefined && msg.id !== 1 && _pending.has(msg.id)) {
        const { resolve, reject } = _pending.get(msg.id)!;
        _pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "Tool call failed"));
        else resolve(msg.result ?? {});
        return;
      }

      if (msg.id === 1 && msg.result) {
        window.parent.postMessage(
          { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} },
          "*"
        );
        setIsConnected(true);
      }

      if (msg.method === "ui/notifications/tool-result") {
        app.ontoolresult?.(msg.params);
        setIsConnected(true);
      }

      if (msg.method === "ui/notifications/tool-input") {
        const args = msg.params?.arguments as Record<string, unknown> | undefined;
        if (args) app.ontoolinput?.(args);
      }

      if (
        msg.method === "ui/notifications/initialized" ||
        msg.method === "ui/notifications/host-context-changed"
      ) {
        setIsConnected(true);
      }
    };

    window.addEventListener("message", handleMessage);

    window.parent.postMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "ui/initialize",
        params: {
          protocolVersion: "2026-01-26",
          appCapabilities: {},
          appInfo: appInfo ?? { name: "example-mcp-o11y", version: "1.0.0" },
        },
      },
      "*"
    );

    let pending = false;
    let lastW = 0;
    let lastH = 0;
    const notifySize = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const root = document.documentElement;
        const prev = root.style.height;
        root.style.height = "max-content";
        const h = Math.ceil(root.getBoundingClientRect().height);
        root.style.height = prev;
        const w = Math.ceil(window.innerWidth);
        if (w !== lastW || h !== lastH) {
          lastW = w;
          lastH = h;
          window.parent.postMessage(
            {
              jsonrpc: "2.0",
              method: "ui/notifications/size-changed",
              params: { width: w, height: h },
            },
            "*"
          );
        }
      });
    };
    notifySize();
    const ro = new ResizeObserver(notifySize);
    ro.observe(document.documentElement);
    ro.observe(document.body);

    return () => {
      window.removeEventListener("message", handleMessage);
      ro.disconnect();
    };
  }, []);

  return { isConnected, error };
}

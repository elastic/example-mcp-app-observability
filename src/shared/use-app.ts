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

export type DisplayMode = "inline" | "fullscreen" | "pip";

export interface AppLike {
  ontoolresult: ((params: ToolResultParams) => void) | null;
  ontoolinput: ((params: Record<string, unknown>) => void) | null;
  callServerTool: (params: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<ToolResultParams>;
  sendMessage: (text: string) => void;
  /**
   * Ask the host to switch the view's display mode. Host may return a
   * different mode than requested if the requested one isn't supported.
   * Wraps the MCP protocol method `ui/request-display-mode`.
   */
  requestDisplayMode: (params: { mode: DisplayMode }) => Promise<{ mode: DisplayMode }>;
  /**
   * Ask the host to open an external URL — typically by routing it to
   * the user's default browser. `<a target="_blank">` doesn't work
   * inside Claude Desktop's sandboxed iframe; this is the only way to
   * open documentation / install / release-notes links from a view.
   * Wraps MCP protocol method `ui/open-link`.
   */
  openLink: (params: { url: string }) => Promise<unknown>;
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
    requestDisplayMode: () => Promise.reject(new Error("not initialized")),
    openLink: () => Promise.reject(new Error("not initialized")),
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

    app.openLink = (params) => {
      return new Promise<unknown>((resolve, reject) => {
        const id = _nextId++;
        _pending.set(id, {
          resolve: (r: unknown) => resolve(r),
          reject,
        } as { resolve: (v: ToolResultParams) => void; reject: (e: Error) => void });

        window.parent.postMessage(
          { jsonrpc: "2.0", id, method: "ui/open-link", params },
          "*"
        );

        setTimeout(() => {
          if (_pending.has(id)) {
            _pending.delete(id);
            reject(new Error("openLink timed out after 10s"));
          }
        }, 10_000);
      });
    };

    app.requestDisplayMode = (params) => {
      return new Promise<{ mode: DisplayMode }>((resolve, reject) => {
        const id = _nextId++;
        _pending.set(id, {
          // Cast: this pending map is shared with callServerTool, whose
          // resolvers expect ToolResultParams. The host echoes back
          // `{ mode }` for this method, so the cast is safe at runtime.
          resolve: (r: unknown) => resolve(r as { mode: DisplayMode }),
          reject,
        } as { resolve: (v: ToolResultParams) => void; reject: (e: Error) => void });

        window.parent.postMessage(
          { jsonrpc: "2.0", id, method: "ui/request-display-mode", params },
          "*"
        );

        setTimeout(() => {
          if (_pending.has(id)) {
            _pending.delete(id);
            reject(new Error("requestDisplayMode timed out after 10s"));
          }
        }, 10_000);
      });
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
          appInfo: appInfo ?? { name: "example-mcp-app-observability", version: "1.0.0" },
        },
      },
      "*"
    );

    // Iframe size reporting. The previous implementation set
     // documentElement.style.height = "max-content" temporarily and
    // measured the root, but that didn't override children with
    // height/max-height: 100vh — measurements came back as the
    // viewport regardless of actual content. Result: Claude Desktop
    // sized the iframe to viewport, leaving visible whitespace below
    // short content.
    //
    // Direct fix: measure the actual `.ds-view` element when it exists
    // (it's the shell every refreshed view uses). Falls back to
    // documentElement when ds-view isn't present (legacy / error
    // states). Bonus: also observe ds-view directly so size changes
    // from inside the shell (pagination, fixture switches) trigger a
    // re-notify.
    let pending = false;
    let lastW = 0;
    let lastH = 0;
    let observedView: HTMLElement | null = null;
    const measureContent = (): number => {
      const view = document.querySelector<HTMLElement>(".ds-view");
      if (view) {
        return Math.ceil(view.getBoundingClientRect().height);
      }
      // Fallback for views/states without a .ds-view shell.
      const root = document.documentElement;
      const prev = root.style.height;
      root.style.height = "max-content";
      const h = Math.ceil(root.getBoundingClientRect().height);
      root.style.height = prev;
      return h;
    };
    const notifySize = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const h = measureContent();
        const w = Math.ceil(window.innerWidth);
        // Sanity floor: ignore measurements below 50px. They happen
        // transiently during re-render (DOM briefly empty, ds-view
        // not yet mounted, etc.). If we report 0 or 12 to Claude
        // Desktop, the iframe collapses to that — and the host
        // typically doesn't grow it back. Skip the notification and
        // wait for the next stable measurement.
        if (h < 50) return;
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
        // (Re-)observe the .ds-view element so size changes from
        // inside the shell propagate. ds-view appears asynchronously
        // (React mounts it after the iframe initializes).
        const view = document.querySelector<HTMLElement>(".ds-view");
        if (view && view !== observedView) {
          if (observedView) ro.unobserve(observedView);
          ro.observe(view);
          observedView = view;
        }
      });
    };
    const ro = new ResizeObserver(notifySize);
    ro.observe(document.documentElement);
    ro.observe(document.body);

    // MutationObserver as a safety net. ResizeObserver only fires when
    // the observed element's box size changes. If the iframe's html /
    // body has a fixed size (depending on host CSS), ds-view content
    // changes might not bubble up as a resize event. The MutationObserver
    // catches DOM changes that DIDN'T trigger a resize, which is the
    // common case when tool-result data arrives after first render.
    const mo = new MutationObserver(notifySize);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true });

    // Aggressive initial polling. The first measurement happens before
    // tool-result data arrives, so .ds-view at that moment is just the
    // empty-state shell. Several follow-up measurements after mount
    // catch the data-arrival render even if neither observer fires.
    notifySize();
    const earlyTicks = [50, 200, 600, 1500, 3000].map((ms) =>
      setTimeout(notifySize, ms)
    );

    return () => {
      window.removeEventListener("message", handleMessage);
      ro.disconnect();
      mo.disconnect();
      for (const t of earlyTicks) clearTimeout(t);
    };
  }, []);

  return { isConnected, error };
}

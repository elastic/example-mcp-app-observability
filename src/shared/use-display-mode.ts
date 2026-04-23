/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Shared hook for toggling an MCP App view between inline and fullscreen
 * display modes. Uses the `ui/request-display-mode` protocol method (via
 * AppLike.requestDisplayMode), which asks the host (Claude Desktop) to
 * expand the iframe in the conversation — NOT browser-native fullscreen.
 */

import { useCallback, useState } from "react";
import type { AppLike, DisplayMode } from "./use-app.js";

export function useDisplayMode(app: AppLike | null): {
  mode: DisplayMode;
  isFullscreen: boolean;
  toggle: () => Promise<void>;
} {
  const [mode, setMode] = useState<DisplayMode>("inline");

  const toggle = useCallback(async () => {
    if (!app) return;
    const next: DisplayMode = mode === "fullscreen" ? "inline" : "fullscreen";
    try {
      const result = await app.requestDisplayMode({ mode: next });
      setMode(result?.mode ?? next);
    } catch (err) {
      // Hosts that don't support the capability, or that reject the
      // request, land here. Log and leave the mode unchanged.
      console.warn("[useDisplayMode] requestDisplayMode failed:", err);
    }
  }, [app, mode]);

  return { mode, isFullscreen: mode === "fullscreen", toggle };
}

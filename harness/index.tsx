/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Vite harness entry point. Renders a sidebar of views + states next to the
 * active view, wraps each view in FixtureProvider so the mocked useApp hook
 * receives the current fixture, and exposes a one-click axe-core runner for
 * ad-hoc accessibility checks.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./harness.css";
import { applyTheme, setTheme } from "../src/shared/theme";
import { FixtureProvider, type Fixture, type DisplayMode } from "./mock-use-app";
import { VIEWS, type ViewEntry } from "./fixtures";

type HarnessTheme = "dark" | "light";

type AxeImpact = "critical" | "serious" | "moderate" | "minor" | null;

interface AxeResult {
  id: string;
  impact: AxeImpact;
  help: string;
  helpUrl: string;
  nodes: { target: string[] }[];
}

function normalizeImpact(v: unknown): AxeImpact {
  return v === "critical" || v === "serious" || v === "moderate" || v === "minor" ? v : null;
}

function HarnessShell() {
  const [viewSlug, setViewSlug] = useState<string>(VIEWS[0].slug);
  const view = useMemo<ViewEntry>(
    () => VIEWS.find((v) => v.slug === viewSlug) ?? VIEWS[0],
    [viewSlug],
  );

  const [stateKey, setStateKey] = useState<string>(view.defaultState);
  useEffect(() => {
    setStateKey(view.defaultState);
  }, [view.slug, view.defaultState]);

  const fixture: Fixture | null = view.fixtures[stateKey] ?? null;

  const [harnessTheme, setHarnessTheme] = useState<HarnessTheme>("dark");
  useEffect(() => {
    document.documentElement.setAttribute("data-harness-theme", harnessTheme);
    setTheme(harnessTheme);
  }, [harnessTheme]);

  useEffect(() => {
    applyTheme();
  }, []);

  const onSendMessage = useCallback((text: string) => {
    console.log("[harness] view sent message →", text);
  }, []);
  const onCallServerTool = useCallback((name: string, args: Record<string, unknown>) => {
    console.log(`[harness] view called server tool '${name}' with`, args);
  }, []);

  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const onRequestDisplayMode = useCallback((mode: DisplayMode): DisplayMode => {
    // `pip` isn't modeled in the harness — fall back to inline.
    const applied: DisplayMode = mode === "fullscreen" ? "fullscreen" : "inline";
    setDisplayMode(applied);
    return applied;
  }, []);

  const stageBodyRef = useRef<HTMLDivElement | null>(null);
  const [axe, setAxe] = useState<{ passes: number; violations: AxeResult[] } | null>(null);
  const [axeOpen, setAxeOpen] = useState(false);
  const [axeBusy, setAxeBusy] = useState(false);

  const runAxe = useCallback(async () => {
    if (!stageBodyRef.current) return;
    setAxeBusy(true);
    try {
      const axeMod = await import("axe-core");
      const axe = (axeMod as unknown as { default: typeof import("axe-core") }).default ?? axeMod;
      const result = await axe.run(stageBodyRef.current, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] },
      });
      setAxe({
        passes: result.passes.length,
        violations: result.violations.map((v) => ({
          id: v.id,
          impact: normalizeImpact(v.impact),
          help: v.help,
          helpUrl: v.helpUrl,
          nodes: v.nodes.map((n) => ({ target: n.target.map(String) })),
        })),
      });
      setAxeOpen(true);
    } catch (err) {
      console.error("[harness] axe run failed", err);
    } finally {
      setAxeBusy(false);
    }
  }, []);

  const ViewComponent = view.Component;
  const stateKeys = Object.keys(view.fixtures);

  return (
    <FixtureProvider value={{ fixture, onSendMessage, onCallServerTool, onRequestDisplayMode }}>
      <div className={`harness-shell${displayMode === "fullscreen" ? " harness-display-fullscreen" : ""}`}>
        <aside className="harness-sidebar">
          <h1>MCP App · Harness</h1>

          <div className="harness-section">
            <h2>View</h2>
            <ul className="harness-list">
              {VIEWS.map((v) => (
                <li key={v.slug}>
                  <button
                    className={`harness-item${v.slug === view.slug ? " active" : ""}`}
                    onClick={() => setViewSlug(v.slug)}
                  >
                    {v.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="harness-section">
            <h2>State</h2>
            <ul className="harness-list">
              {stateKeys.map((k) => (
                <li key={k}>
                  <button
                    className={`harness-item${k === stateKey ? " active" : ""}`}
                    onClick={() => setStateKey(k)}
                  >
                    {view.fixtures[k].label}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="harness-section">
            <h2>Theme</h2>
            <div className="harness-toggle-row">
              <button
                className={harnessTheme === "dark" ? "active" : ""}
                onClick={() => setHarnessTheme("dark")}
              >
                Dark
              </button>
              <button
                className={harnessTheme === "light" ? "active" : ""}
                onClick={() => setHarnessTheme("light")}
              >
                Light
              </button>
            </div>
          </div>

          <div className="harness-section">
            <h2>Accessibility</h2>
            <button className="harness-action" onClick={runAxe} disabled={axeBusy}>
              {axeBusy ? "Scanning…" : "Run axe-core on this view"}
            </button>
            {axe && (
              <div style={{ marginTop: 8, fontSize: 11, color: "#8f939b" }}>
                {axe.violations.length === 0 ? (
                  <span className="harness-axe-pass">
                    ✓ No violations · {axe.passes} passes
                  </span>
                ) : (
                  <span>
                    {axe.violations.length} violation{axe.violations.length === 1 ? "" : "s"} · {axe.passes} passes
                  </span>
                )}
              </div>
            )}
          </div>
        </aside>

        <main className="harness-stage">
          <div className="harness-stage-header">
            <strong style={{ color: "#d6d8df" }}>{view.label}</strong>
            <span>·</span>
            <span>{fixture?.label ?? "no fixture"}</span>
            <span style={{ marginLeft: "auto", fontSize: 11 }}>
              mock server-tool calls log to browser console
            </span>
          </div>
          {fixture?.prompt && (
            <div className="harness-prompt-strip" role="note" aria-label="Sample prompt">
              <span className="harness-prompt-label">Demo prompt</span>
              <span className="harness-prompt-text">"{fixture.prompt}"</span>
              <button
                type="button"
                className="harness-prompt-copy"
                onClick={() => navigator.clipboard?.writeText(fixture.prompt!)}
                title="Copy prompt"
                aria-label="Copy prompt to clipboard"
              >
                Copy
              </button>
            </div>
          )}
          <div className="harness-stage-body" ref={stageBodyRef}>
            <div className={`harness-view-frame${displayMode === "fullscreen" ? " harness-view-frame-fullscreen" : ""}`}>
              <ViewComponent key={`${view.slug}`} />
            </div>
          </div>

          {axeOpen && axe && (
            <div className="harness-axe-panel" role="region" aria-label="Accessibility results">
              <div className="harness-axe-panel-header">
                <span>
                  axe-core · {axe.violations.length} violations · {axe.passes} passes
                </span>
                <button
                  className="harness-close-btn"
                  aria-label="Close axe results"
                  onClick={() => setAxeOpen(false)}
                >
                  ×
                </button>
              </div>
              <div className="harness-axe-panel-body">
                {axe.violations.length === 0 ? (
                  <div className="harness-axe-pass">No WCAG 2 AA / best-practice violations.</div>
                ) : (
                  axe.violations.map((v) => (
                    <div key={v.id} className="harness-axe-violation">
                      <div className={`harness-axe-violation-impact ${v.impact ?? ""}`}>
                        {v.impact ?? "info"} · {v.id}
                      </div>
                      <div className="harness-axe-violation-help">{v.help}</div>
                      {v.nodes.slice(0, 3).map((n, i) => (
                        <div key={i} className="harness-axe-violation-target">
                          {n.target.join(" ")}
                        </div>
                      ))}
                      {v.nodes.length > 3 && (
                        <div className="harness-axe-violation-target">
                          + {v.nodes.length - 3} more
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </FixtureProvider>
  );
}

createRoot(document.getElementById("root")!).render(<HarnessShell />);

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Shared theme for the MCP App views.
 *
 *   `theme` + `baseStyles`  — legacy exports used by inline styles across all
 *                             existing views. Frozen; do not change values
 *                             without auditing every view.
 *   `applyTheme(app?)`      — the new W1 entry point. Injects CSS custom
 *                             properties + the `.ds-*` utility layer, wires
 *                             dark/light via host-context with a
 *                             prefers-color-scheme fallback.
 *   `setTheme(mode)`        — force a theme (used by the Vite harness).
 *   `timeAgo(date)`         — relative-time helper used by card components.
 *
 * Color decisions
 * ────────────────
 * Severity hues are the Okabe-Ito-derived palette we were already using in
 * `components.tsx` (vermillion / orange / sky-blue / green). That palette is
 * colorblind-safe; we deliberately did NOT inherit the security app's red /
 * amber / green severity ramp. The CSS-variable *names* mirror the security
 * app so cross-team readers see the same tokens.
 */

import type { App } from "@modelcontextprotocol/ext-apps";

// ─────────────────────────────────────────────────────────────────────────────
// Legacy exports — used by inline styles across every existing view.
// Views will migrate to the `.ds-*` utility layer view-by-view starting in W3.
// ─────────────────────────────────────────────────────────────────────────────

export const theme = {
  bg: "#1f1f1e",
  bgSecondary: "#1f1f1e",
  bgTertiary: "#171716",
  border: "#2a2a2a",
  borderStrong: "#474745",
  text: "#e5e7eb",
  textMuted: "#9ca3af",
  // #9097a8 hits ~6.5:1 on #0f1117, passing WCAG 2 AA for body text. The
  // prior value (#6b7280) landed at ~3.9:1, which axe-core flagged as a
  // serious violation across every dim-text callsite in the legacy views.
  textDim: "#9097a8",
  blue: "#3b82f6",
  // #ef4444 only hit ~4.3:1 on --bg-secondary / bg-elevated, which axe-core
  // flagged on the "AT RISK" label in k8s-blast-radius and the health-indicator
  // text in apm-service-dependencies. #f56565 clears ~5.7:1 on the same bgs
  // while staying in the same hue family.
  red: "#f56565",
  redSoft: "#e06c6c",
  green: "#22c55e",
  greenSoft: "#5aba6f",
  amber: "#f59e0b",
  purple: "#a855f7",
  cyan: "#14b8a6",
  orange: "#f97316",
  pink: "#ec4899",
};

export const baseStyles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: ${theme.bg}; color: ${theme.text}; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.5;
  }
  code, .mono { font-family: 'JetBrains Mono', 'SF Mono', monospace; }
  button { font-family: inherit; }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Design-system stylesheet — CSS variables + `.ds-*` utilities.
// ─────────────────────────────────────────────────────────────────────────────

const DS_STYLE_ID = "ds-stylesheet";

const DS_STYLESHEET = `
  :root {
    /* ── Surfaces (dark, warm neutral — aligned with security app) ───── */
    --bg-primary: #1f1f1e;
    --bg-secondary: #1f1f1e;
    --bg-tertiary: #171716;
    --bg-elevated: #262626;
    --bg-hover: #2a2a2a;
    --bg-active: #333333;

    /* ── Text ────────────────────────────────────────────────────────── */
    --text-primary: #e5e7eb;
    --text-secondary: #c6c9d1;
    --text-muted: #9ca3af;
    /* #9097a8 → ~6.5:1 on --bg-primary; passes WCAG 2 AA body text. */
    --text-dim: #9097a8;
    --ds-text-label: #a9adb8;

    /* ── Borders ─────────────────────────────────────────────────────── */
    --border: #474745;
    --border-subtle: #2a2a2a;
    --border-focus: #7c97fb;

    /* ── Accent ──────────────────────────────────────────────────────── *
     * Brighter than #5c7cfa so that text using var(--accent) on the tinted
     * --accent-dim background still clears WCAG 2 AA (~5.1:1). The
     * prior value hit ~4.13:1 and axe-core flagged every pill using it. */
    --accent: #7c97fb;
    --accent-hover: #95adff;
    --accent-dim: rgba(124, 151, 251, 0.12);

    /* ── Severity (Okabe-Ito, colorblind-safe) ───────────────────────── *
     * Stripes / dots / chart marks keep the canonical Okabe-Ito values.
     * Chip text uses the -text variant: #D55E00 on the tinted-critical
     * background failed AA (~3.9:1); #F07840 clears at ~4.8:1 while staying
     * in the same hue family so the colorblind separation is preserved. */
    --severity-critical: #D55E00;
    --severity-major:    #E69F00;
    --severity-minor:    #56B4E9;
    --severity-ok:       #5aba6f;

    --severity-critical-text: #F07840;
    --severity-major-text:    #E69F00;
    --severity-minor-text:    #56B4E9;
    --severity-ok-text:       #5aba6f;

    --severity-critical-bg: rgba(213, 94, 0, 0.12);
    --severity-major-bg:    rgba(230, 159, 0, 0.12);
    --severity-minor-bg:    rgba(86, 180, 233, 0.12);
    --severity-ok-bg:       rgba(90, 186, 111, 0.12);

    --severity-critical-border: rgba(213, 94, 0, 0.40);
    --severity-major-border:    rgba(230, 159, 0, 0.40);
    --severity-minor-border:    rgba(86, 180, 233, 0.40);
    --severity-ok-border:       rgba(90, 186, 111, 0.40);

    --success: var(--severity-ok);
    --warning: var(--severity-major);
    --error:   var(--severity-critical);

    /* ── Typography (system stack — fonts deferred until W1 bundle budget is known) */
    --font-sans: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, 'Helvetica Neue', Arial, sans-serif;
    --font-mono: 'SF Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Consolas, monospace;

    /* ── Radii ───────────────────────────────────────────────────────── */
    --radius-sm: 4px;
    --radius-md: 8px;
    --radius-lg: 12px;
    --radius-tag: 6px;
    --radius-input: 7px;
    --radius-track: 10px;

    /* ── Elevation + motion ──────────────────────────────────────────── */
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
    --shadow-lg: 0 8px 32px rgba(0,0,0,0.5);
    --transition-fast:   0.15s cubic-bezier(0.4, 0, 0.2, 1);
    --transition-normal: 0.25s cubic-bezier(0.4, 0, 0.2, 1);

    color-scheme: dark;
  }

  [data-theme="light"] {
    --bg-primary:   #f7f7f6;
    --bg-secondary: #ffffff;
    --bg-tertiary:  #ececea;
    --bg-elevated:  #ffffff;
    --bg-hover:     #ececea;
    --bg-active:    #dddcd8;

    --text-primary:   #1a1a19;
    --text-secondary: #2f2f2e;
    --text-muted:     #6a6a66;
    /* #6e6e6e → ~4.8:1 on light --bg-primary; sits just below --text-muted
     * (5.9:1) while still passing WCAG 2 AA body text. The prior value
     * (#8a8a86) failed at ~3.2:1. */
    --text-dim:       #6e6e6e;
    --ds-text-label:  #4a4a46;

    --border:        #d8d8d4;
    --border-subtle: #ececea;

    --accent-dim: rgba(124, 151, 251, 0.14);

    /* Severity *text* in light mode needs dark variants — the base hues
     * are too bright on a light background. Values below clear WCAG 2 AA
     * body (>=4.79:1) while staying in the canonical hue family. */
    --severity-critical-text: #8A3D00;
    --severity-major-text:    #8B6100;
    --severity-minor-text:    #2A72A0;
    --severity-ok-text:       #2F7549;

    --severity-critical-bg: rgba(213, 94, 0, 0.10);
    --severity-major-bg:    rgba(230, 159, 0, 0.14);
    --severity-minor-bg:    rgba(86, 180, 233, 0.14);
    --severity-ok-bg:       rgba(90, 186, 111, 0.14);

    --shadow-sm: 0 1px 2px rgba(0,0,0,0.06);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
    --shadow-lg: 0 8px 32px rgba(0,0,0,0.12);

    color-scheme: light;
  }

  /* ────────────────────────────────────────────────────────────────────
   * .ds-* utility layer
   * ────────────────────────────────────────────────────────────────── */

  /* App-shell: the view fills the viewport and child panes handle their own
   * scroll. Content-sizing felt right for graph views but regressed list
   * views (no internal scroll → page-level scroll trap in the harness, and
   * an iframe sizing feedback loop risk in Claude Desktop). Graph views
   * that want the SVG to scale with the viewport use CSS aspect-ratio on
   * the SVG itself rather than opting the shell into content-sizing. */
  .ds-view {
    /* max-height + content-driven sizing. The iframe collapses with
     * the content when it fits in less than 100vh, and caps at 100vh
     * when it doesn't (inner overflow:auto bodies handle the scroll).
     * No min-height — even an empty-state 'Waiting for…' message is
     * tall enough to be readable, and any floor reintroduces the
     * whitespace problem for short payloads. */
    max-height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: var(--font-sans);
  }

  .ds-header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 24px;
    row-gap: 10px;
    padding: 16px;
    background: var(--bg-primary);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    z-index: 10;
  }

  .ds-header-title {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 20px;
    font-weight: 600;
    line-height: 1.1;
    color: var(--text-primary);
    white-space: nowrap;
  }

  .ds-header-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px 12px;
    flex: 1 1 auto;
    justify-content: flex-end;
    min-width: 0;
  }

  .ds-card {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    padding: 24px;
  }

  .ds-panel {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 24px;
    background: var(--bg-primary);
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .ds-panel:last-child { border-right: none; }

  .ds-panel-title {
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .ds-search {
    position: relative;
    display: flex;
    align-items: center;
    gap: 9px;
    width: 366px;
    max-width: 100%;
    height: 36px;
    padding: 0 12px 0 10px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-input);
    transition: border-color var(--transition-fast);
  }
  .ds-search:focus-within { border-color: var(--accent); }
  .ds-search svg { color: var(--text-muted); flex-shrink: 0; }
  .ds-search input {
    flex: 1 1 0;
    min-width: 0;
    padding: 0;
    background: transparent;
    border: none;
    outline: none;
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--text-primary);
  }
  .ds-search input::placeholder { color: var(--text-muted); }

  .ds-btn-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
    transition: color var(--transition-fast), background var(--transition-fast);
  }
  .ds-btn-icon:hover { color: var(--text-primary); background: var(--bg-hover); }
  .ds-btn-icon:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }

  .ds-setup-notice {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin: 12px 16px 0;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid;
    font-family: var(--font-sans);
    font-size: 12px;
    line-height: 1.45;
  }
  .ds-setup-notice-info {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    color: var(--text-primary);
  }
  .ds-setup-notice-warn {
    background: color-mix(in srgb, var(--severity-major) 12%, transparent);
    border-color: color-mix(in srgb, var(--severity-major) 50%, transparent);
    color: var(--text-primary);
  }
  .ds-setup-notice-body { flex: 1 1 auto; min-width: 0; }
  .ds-setup-notice-title {
    font-weight: 700;
    margin-bottom: 2px;
  }
  .ds-setup-notice-warn .ds-setup-notice-title {
    color: var(--severity-major-text);
  }
  .ds-setup-notice-info .ds-setup-notice-title {
    color: var(--accent);
  }
  .ds-setup-notice-reason {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 4px;
    font-family: var(--font-mono);
  }
  .ds-setup-notice-message {
    color: var(--text-secondary);
    margin-bottom: 6px;
  }
  .ds-setup-notice-link {
    display: inline-block;
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
    background: transparent;
    border: none;
    padding: 0;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
  }
  .ds-setup-notice-link:hover { text-decoration: underline; }
  .ds-setup-notice-link:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
    border-radius: 2px;
  }
  .ds-setup-notice-dismiss {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ds-setup-notice-dismiss:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }
  .ds-setup-notice-dismiss:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }

  .ds-tag {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px 8px;
    border-radius: var(--radius-tag);
    font-family: var(--font-sans);
    font-size: 12px;
    line-height: 16px;
    color: var(--text-muted);
    white-space: nowrap;
    border: 1px solid var(--border);
    background: transparent;
  }
  .ds-tag-secondary {
    background: var(--bg-secondary);
    border-color: var(--border-subtle);
  }

  .ds-subheader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    row-gap: 8px;
    padding: 10px 16px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 16px;
    color: var(--ds-text-label);
    border-bottom: 1px solid var(--border);
    background: var(--bg-primary);
  }
  .ds-subheader-left,
  .ds-subheader-right {
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
    row-gap: 8px;
    min-width: 0;
  }
  .ds-subheader strong {
    font-weight: 500;
    color: var(--text-primary);
  }

  /* Progress-bar rows */
  .ds-bar-row {
    display: flex;
    align-items: center;
    gap: 36px;
    height: 16px;
  }
  .ds-bar-label {
    flex: 0 0 130px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 16px;
    color: var(--ds-text-label);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ds-bar-track {
    flex: 1 1 0;
    min-width: 0;
    height: 4px;
    background: var(--bg-tertiary);
    border-radius: var(--radius-track);
    overflow: hidden;
  }
  .ds-bar-fill { height: 100%; transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1); background: var(--accent); }
  .ds-bar-fill-critical { background: var(--severity-critical); }
  .ds-bar-fill-major    { background: var(--severity-major); }
  .ds-bar-fill-minor    { background: var(--severity-minor); }
  .ds-bar-fill-ok       { background: var(--severity-ok); }
  .ds-bar-value {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 16px;
    color: var(--ds-text-label);
    font-variant-numeric: tabular-nums;
    flex: 0 0 auto;
    min-width: 20px;
    text-align: right;
  }

  /* Fact sub-box */
  .ds-fact-box {
    background: var(--bg-secondary);
    padding: 16px;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 16px;
    color: var(--ds-text-label);
  }
  .ds-fact-row { display: flex; align-items: center; gap: 28px; min-width: 0; }
  .ds-fact-label { flex-shrink: 0; width: 72px; color: var(--ds-text-label); text-transform: uppercase; letter-spacing: 0.04em; }
  .ds-fact-value {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
  }
  .ds-fact-value-interactive {
    text-decoration: underline dotted;
    text-decoration-thickness: from-font;
    text-underline-offset: 2px;
    text-decoration-skip-ink: none;
    cursor: pointer;
  }
  .ds-fact-value-interactive:hover { color: var(--accent); }

  /* Fact column grid (detail pane) */
  .ds-fact-col {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 20px 28px;
    padding: 16px 0;
  }
  .ds-fact-col-item { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .ds-fact-col-label {
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .ds-fact-col-value {
    font-family: var(--font-sans);
    font-size: 13px;
    color: var(--text-primary);
    word-break: break-word;
  }

  /* Severity stripes — apply with position: relative on the container */
  .ds-stripe-critical { box-shadow: inset 3px 0 0 0 var(--severity-critical); }
  .ds-stripe-major    { box-shadow: inset 3px 0 0 0 var(--severity-major); }
  .ds-stripe-minor    { box-shadow: inset 3px 0 0 0 var(--severity-minor); }
  .ds-stripe-ok       { box-shadow: inset 3px 0 0 0 var(--severity-ok); }

  /* Query pill (filter chip with close button) */
  .ds-query-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 20px;
    background: var(--accent-dim);
    border: 1px solid var(--border-focus);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent);
    max-width: 100%;
    min-width: 0;
  }
  .ds-query-pill > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ds-query-pill button {
    background: transparent;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0;
    display: inline-flex;
    align-items: center;
  }

  /* Dropdown popup (role=listbox) */
  .ds-dropdown { position: relative; display: inline-flex; }
  .ds-dropdown-trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 12px;
    cursor: pointer;
  }
  .ds-dropdown-trigger:hover { background: var(--bg-hover); }
  .ds-dropdown-trigger[aria-expanded="true"] { background: var(--bg-hover); border-color: var(--border); }
  .ds-dropdown-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 180px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-md);
    padding: 4px;
    z-index: 100;
  }
  .ds-dropdown-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--text-primary);
    cursor: pointer;
    user-select: none;
  }
  .ds-dropdown-option:hover,
  .ds-dropdown-option[aria-selected="true"] { background: var(--bg-hover); }
  .ds-dropdown-option[aria-selected="true"] { color: var(--accent); }

  /* Switch (role=switch) */
  .ds-switch {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ds-text-label);
    cursor: pointer;
    user-select: none;
  }
  .ds-switch-track {
    position: relative;
    width: 28px;
    height: 16px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 10px;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }
  .ds-switch-thumb {
    position: absolute;
    top: 1px; left: 1px;
    width: 12px; height: 12px;
    background: var(--text-muted);
    border-radius: 50%;
    transition: left var(--transition-fast), background var(--transition-fast);
  }
  .ds-switch[aria-checked="true"] .ds-switch-track { background: var(--accent-dim); border-color: var(--accent); }
  .ds-switch[aria-checked="true"] .ds-switch-thumb { left: 14px; background: var(--accent); }
  .ds-switch:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; border-radius: 4px; }

  /* Severity chip (dot + label) */
  .ds-sev-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    border-radius: var(--radius-tag);
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 500;
    line-height: 16px;
    border: 1px solid transparent;
    text-transform: lowercase;
    white-space: nowrap;
  }
  .ds-sev-chip-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .ds-sev-chip-critical { background: var(--severity-critical-bg); color: var(--severity-critical-text); border-color: var(--severity-critical-border); }
  .ds-sev-chip-major    { background: var(--severity-major-bg);    color: var(--severity-major-text);    border-color: var(--severity-major-border); }
  .ds-sev-chip-minor    { background: var(--severity-minor-bg);    color: var(--severity-minor-text);    border-color: var(--severity-minor-border); }
  .ds-sev-chip-ok       { background: var(--severity-ok-bg);       color: var(--severity-ok-text);       border-color: var(--severity-ok-border); }
  .ds-sev-chip-critical .ds-sev-chip-dot { background: var(--severity-critical); }
  .ds-sev-chip-major    .ds-sev-chip-dot { background: var(--severity-major); }
  .ds-sev-chip-minor    .ds-sev-chip-dot { background: var(--severity-minor); }
  .ds-sev-chip-ok       .ds-sev-chip-dot { background: var(--severity-ok); }

  /* List → detail pane layout */
  /* List / detail split — fills the remaining vertical space in the shell
   * and scrolls each pane internally. Keeps a single scroll target per
   * pane so the user always knows which column owns the scrollbar. */
  .ds-list-detail { display: flex; flex: 1 1 0; min-height: 0; overflow: hidden; }
  .ds-list-detail-list { flex: 1 1 0; min-width: 0; overflow-y: auto; }
  .ds-list-detail-list.narrow { flex: 0 0 360px; border-right: 1px solid var(--border); }
  .ds-list-detail-pane {
    flex: 1 1 0;
    min-width: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    animation: ds-slide-in 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }
  @keyframes ds-slide-in {
    from { opacity: 0; transform: translateX(16px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  .ds-list-detail-pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .ds-back-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 12px;
    cursor: pointer;
  }
  .ds-back-btn:hover { color: var(--text-primary); background: var(--bg-hover); }

  /* Expand sections */
  .ds-expand { border-top: 1px solid var(--border-subtle); }
  .ds-expand-trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 12px 0;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }
  .ds-expand-trigger svg {
    transition: transform var(--transition-fast);
    color: var(--text-muted);
  }
  .ds-expand-trigger[aria-expanded="true"] svg { transform: rotate(180deg); }
  .ds-expand-count {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-left: auto;
    margin-right: 8px;
  }
  .ds-expand-body { padding-bottom: 12px; }

  /* Scrollbar */
  .ds-view ::-webkit-scrollbar,
  .ds-harness ::-webkit-scrollbar { width: 6px; height: 6px; }
  .ds-view ::-webkit-scrollbar-track,
  .ds-harness ::-webkit-scrollbar-track { background: transparent; }
  .ds-view ::-webkit-scrollbar-thumb,
  .ds-harness ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  .ds-view ::-webkit-scrollbar-thumb:hover,
  .ds-harness ::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

type ThemeMode = "dark" | "light";

let mediaQueryCleanup: (() => void) | null = null;

function resolveSystemPreference(): ThemeMode {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyMode(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
}

/**
 * Force a specific theme. Pass `null` to revert to the automatic
 * host-context + prefers-color-scheme behavior.
 */
export function setTheme(mode: ThemeMode | null) {
  if (mode === null) {
    applyMode(resolveSystemPreference());
    return;
  }
  applyMode(mode);
}

/**
 * Inject the design-system stylesheet (idempotent) and wire up theme mode.
 *
 * If `app` is supplied, the host-context `theme` field drives the mode and
 * takes precedence over the OS-level `prefers-color-scheme`. Hosts that
 * don't emit a theme field fall through to `prefers-color-scheme` and
 * respond to OS theme changes in real time.
 *
 * Safe to call multiple times.
 */
export function applyTheme(app?: App): void {
  if (typeof document === "undefined") return;

  if (!document.getElementById(DS_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = DS_STYLE_ID;
    style.textContent = DS_STYLESHEET;
    document.head.appendChild(style);
  }

  let hostOverride: ThemeMode | null = null;

  const resolve = () => {
    applyMode(hostOverride ?? resolveSystemPreference());
  };

  if (mediaQueryCleanup) {
    mediaQueryCleanup();
    mediaQueryCleanup = null;
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => { if (hostOverride === null) resolve(); };
    mq.addEventListener("change", onChange);
    mediaQueryCleanup = () => mq.removeEventListener("change", onChange);
  }

  if (app) {
    app.onhostcontextchanged = (ctx) => {
      const hc = (ctx.hostContext ?? {}) as Record<string, unknown>;
      const t = hc.theme;
      if (t === "light" || t === "dark") hostOverride = t;
      else hostOverride = null;
      resolve();
    };
  }

  resolve();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function timeAgo(date: string | Date): string {
  const then = new Date(date).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * View-scoped styles for apm-health-summary. Composes the .ds-* utility layer.
 */

export const viewStyles = `
  .health-body {
    /* Body grows naturally; ds-view + iframe expand to match. No
     * internal scroll — the chat scrolls past the iframe. */
    flex: 0 1 auto;
    min-height: 0;
    padding: 14px 16px;
  }

  .health-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 64px 20px;
    text-align: center;
    color: var(--text-muted);
    flex: 1 1 0;
  }
  .health-empty-title {
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--text-primary);
  }
  .health-empty-sub {
    font-size: 12px;
    color: var(--text-muted);
  }

  .health-provenance {
    position: relative;
    display: inline-flex;
    align-items: center;
    cursor: help;
    user-select: none;
    line-height: 16px;
  }
  .health-provenance::after {
    content: attr(data-provenance-tip);
    position: absolute;
    bottom: calc(100% + 6px);
    left: -4px;
    z-index: 20;
    width: max-content;
    max-width: 280px;
    padding: 8px 10px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow-md);
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 400;
    line-height: 1.45;
    color: var(--text-primary);
    white-space: normal;
    text-align: left;
    pointer-events: none;
    opacity: 0;
    transform: translateY(2px);
    transition: opacity 0.12s, transform 0.12s;
  }
  .health-provenance:hover::after,
  .health-provenance:focus-visible::after {
    opacity: 1;
    transform: translateY(0);
  }

  .health-namespace-warn {
    margin-bottom: 10px;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--severity-major) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--severity-major) 35%, transparent);
    border-radius: 6px;
    font-size: 11px;
    color: var(--text-primary);
  }
  .health-namespace-warn-title {
    font-weight: 700;
    color: var(--severity-major-text);
    margin-bottom: 4px;
  }

  .health-rerun-strip {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .health-rerun-label {
    font-size: 10px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .health-rerun-presets {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .health-rerun-btn {
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: 5px;
    padding: 4px 10px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.12s;
  }
  .health-rerun-btn:hover:not(:disabled):not(.is-active) {
    background: var(--border-subtle);
    border-color: var(--border);
  }
  .health-rerun-btn.is-active {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    font-weight: 700;
    cursor: default;
  }
  .health-rerun-btn:disabled {
    cursor: default;
  }

  .health-scope {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    margin-bottom: 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
  }
  .health-scope-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .health-scope-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .health-scope-sep {
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1;
  }
  .health-scope-static {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: 5px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-primary);
  }
  .health-scope-static-prefix {
    color: var(--text-muted);
  }
  .health-scope-count {
    font-size: 11px;
    color: var(--text-muted);
  }

  .health-scope-groups {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-top: 6px;
    border-top: 1px solid var(--border-subtle);
    flex-wrap: wrap;
  }
  .health-scope-groups-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex-shrink: 0;
  }
  .health-scope-groups-source {
    font-weight: 500;
    color: var(--text-muted);
    text-transform: none;
    letter-spacing: 0;
    font-family: var(--font-mono);
  }

  .health-scope-groups-helpwrap {
    position: relative;
    display: inline-flex;
    margin-left: 6px;
    vertical-align: baseline;
  }
  .health-scope-groups-help {
    width: 14px;
    height: 14px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: 50%;
    font-family: var(--font-sans);
    font-size: 9px;
    font-style: italic;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
  }
  .health-scope-groups-help:hover,
  .health-scope-groups-help[aria-expanded="true"] {
    color: var(--text-primary);
    border-color: var(--text-muted);
    background: var(--bg-hover);
  }
  .health-scope-groups-help:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .health-scope-groups-help-pop {
    position: absolute;
    top: calc(100% + 6px);
    left: -4px;
    z-index: 20;
    width: 360px;
    padding: 10px 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow-md);
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
  .health-scope-groups-help-lead {
    font-size: 12px;
    color: var(--text-primary);
    line-height: 1.45;
    margin-bottom: 8px;
  }
  .health-scope-groups-help-legend {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 10px 12px;
    align-items: start;
    margin: 0;
    font-size: 11px;
    color: var(--text-muted);
  }
  .health-scope-groups-help-legend dt {
    display: inline-flex;
    align-items: center;
    padding-top: 1px;
    color: var(--text-primary);
  }
  .health-scope-groups-help-legend dd {
    margin: 0;
    line-height: 1.45;
  }
  .health-scope-groups-help-legend .mono {
    font-family: var(--font-mono);
    color: var(--text-primary);
  }
  .health-scope-groups-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .health-scope-group-wrap {
    position: relative;
    display: inline-flex;
  }
  .health-scope-group {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s, opacity 0.12s;
  }
  .health-scope-group:hover {
    border-color: var(--border);
    background: var(--bg-hover);
  }
  .health-scope-group:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .health-scope-group.is-deselected {
    opacity: 0.45;
    text-decoration: line-through;
    text-decoration-color: var(--text-dim);
    text-decoration-thickness: 1px;
  }
  .health-scope-group.is-deselected:hover {
    opacity: 0.7;
  }
  .health-scope-group.is-pseudo .health-scope-group-label {
    font-style: italic;
    color: var(--text-muted);
  }
  .health-scope-group-label {
    color: var(--text-primary);
  }
  .health-scope-group-count {
    color: var(--text-muted);
    font-size: 10px;
  }
  .health-scope-group.is-partial {
    border-color: color-mix(in srgb, var(--severity-major) 40%, transparent);
    background: color-mix(in srgb, var(--severity-major) 8%, var(--bg-tertiary));
  }
  .health-scope-group-overflow {
    color: var(--severity-major-text);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
  }

  .health-scope-group-example {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    font-size: 11px;
    cursor: default;
    vertical-align: middle;
  }
  .health-scope-group-example.is-partial {
    border-color: color-mix(in srgb, var(--severity-major) 40%, transparent);
    background: color-mix(in srgb, var(--severity-major) 8%, var(--bg-tertiary));
  }
  .health-scope-group-example.is-pseudo .health-scope-group-label {
    font-style: italic;
    color: var(--text-muted);
  }

  .health-scope-group-pop {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 240px;
    max-width: 320px;
    padding: 10px 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow-md);
    font-family: var(--font-sans);
    font-size: 11px;
    line-height: 1.45;
    color: var(--text-muted);
    text-align: left;
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
    white-space: normal;
    visibility: hidden;
    opacity: 0;
    transform: translateY(2px);
    pointer-events: none;
    transition: opacity 0.12s, transform 0.12s, visibility 0s 0.12s;
  }
  .health-scope-group-wrap:hover .health-scope-group-pop,
  .health-scope-group-wrap:focus-within .health-scope-group-pop {
    visibility: visible;
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
    transition: opacity 0.12s, transform 0.12s;
  }
  .health-scope-group-pop strong {
    color: var(--text-primary);
    font-weight: 600;
  }
  .health-scope-group-broaden {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    border-radius: 5px;
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .health-scope-group-broaden:hover {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    border-color: var(--accent);
  }
  .health-scope-group-broaden:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .health-scope-filter-active {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed var(--border-subtle);
    font-size: 11px;
    color: var(--text-muted);
  }
  .health-scope-filter-clear {
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    border-radius: 5px;
    padding: 3px 10px;
    font-size: 11px;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .health-scope-filter-clear:hover {
    background: var(--bg-hover);
    border-color: var(--border);
  }
`;

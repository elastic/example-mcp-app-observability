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
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
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
  .health-scope-groups-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
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
    font-size: 10px;
    line-height: 1;
  }
`;

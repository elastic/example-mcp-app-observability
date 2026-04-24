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
`;

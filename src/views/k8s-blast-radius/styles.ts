/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * View-scoped styles for k8s-blast-radius. The radial SVG itself is unchanged
 * from the legacy view; these styles cover the chrome only.
 */

export const viewStyles = `
  .blast-graph {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    padding: 8px 14px;
  }

  .blast-summary-card {
    position: absolute;
    top: 16px;
    left: 22px;
    background: color-mix(in srgb, var(--bg-secondary) 92%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    min-width: 220px;
    backdrop-filter: blur(6px);
    z-index: 5;
  }
  .blast-summary-card-title {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 8px;
  }
  .blast-summary-card-divider {
    height: 1px;
    background: var(--border-subtle);
    margin: 8px 0;
  }
  .blast-summary-card-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    margin-bottom: 4px;
    color: var(--text-secondary);
  }
  .blast-summary-card-row strong {
    font-weight: 500;
    color: var(--text-primary);
    min-width: 24px;
    display: inline-block;
    text-align: right;
  }
  .blast-summary-card-foot {
    margin-top: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .blast-meta {
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg-primary);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .blast-meta-row {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .blast-meta-note {
    font-family: var(--font-sans);
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .blast-actions {
    padding: 12px 16px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg-primary);
    flex-shrink: 0;
  }

  .blast-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 64px 20px;
    text-align: center;
    color: var(--text-muted);
  }
  .blast-empty-title {
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--text-primary);
  }
  .blast-empty-sub {
    font-size: 12px;
    color: var(--text-muted);
  }
`;

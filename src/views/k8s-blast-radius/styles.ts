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

  /* Inspect strip OVERLAYS the bottom of the graph instead of pushing
   * layout — same pattern as apm-service-dependencies. Backdrop blur +
   * semi-transparent fill so the graph stays visible behind. Up to 4
   * cards before horizontal scroll kicks in. */
  .blast-inspect-strip {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 36px; /* leaves room for the meta overlay below */
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--bg-secondary) 88%, transparent);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    backdrop-filter: blur(6px);
    overflow-x: auto;
    z-index: 5;
  }
  .blast-inspect-card {
    flex: 0 0 240px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .blast-inspect-card-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .blast-inspect-card-name {
    flex: 1 1 0;
    min-width: 0;
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .blast-inspect-card-close {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 4px;
  }
  .blast-inspect-card-close:hover { color: var(--text-primary); }
  .blast-inspect-card-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  /* Bottom meta overlay — replaces the prior 40px+ row taking real
   * estate below the graph. Slim, flush with the bottom of the
   * graph container so the rescheduling capacity line stays visible
   * but doesn't compete with the diagram. */
  .blast-meta-overlay {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 6px 14px;
    background: color-mix(in srgb, var(--bg-primary) 88%, transparent);
    border-top: 1px solid var(--border-subtle);
    font-size: 11px;
    color: var(--text-muted);
    backdrop-filter: blur(4px);
    z-index: 3;
  }
  .blast-meta-overlay .blast-meta-note {
    font-family: var(--font-sans);
    color: var(--text-secondary);
  }

  /* Header-inline action buttons — moved from a bottom card so the
   * graph gets the full vertical space. */
  .blast-header-actions-inline {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .blast-header-action-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
    font-size: 11px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }
  .blast-header-action-btn:hover {
    background: var(--bg-hover);
    border-color: var(--border);
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

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const viewStyles = `
  /* Header context pills row */
  .anom-context-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }

  /* Summary panel — ScoreRing + textual summary */
  .anom-summary {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 24px 24px 20px;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
  }
  .anom-summary-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .anom-summary-headline {
    font-family: var(--font-sans);
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .anom-summary-sub {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Score ring text inside the donut */
  .anom-score-value {
    font-family: var(--font-mono);
    font-weight: 600;
    fill: var(--text-primary);
  }
  .anom-score-suffix {
    font-family: var(--font-mono);
    fill: var(--text-muted);
  }

  /* Section blocks (FactCol, charts) */
  .anom-section {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .anom-section:last-of-type { border-bottom: none; }
  .anom-section-title {
    font-family: var(--font-sans);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: 12px;
  }

  /* Anomaly-detail fact grid: explicit per-row column counts. The
     shared .ds-fact-col uses auto-fit at 140px min, which collapses to
     a single column in the ~280px right-pane width — that's why the
     facts stacked vertically before. Forcing 2- and 3-column rows here
     packs short fields (Function / Deviation / Detected, Actual /
     Typical) horizontally and only the long ones (Field, influencer
     names) take a full row. */
  .anom-fact-grid {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .anom-fact-row {
    display: grid;
    gap: 14px 16px;
  }
  .anom-fact-row-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .anom-fact-row-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .anom-fact-item { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .anom-fact-label {
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .anom-fact-value {
    font-family: var(--font-sans);
    font-size: 13px;
    color: var(--text-primary);
    word-break: break-word;
  }

  /* Time-series chart */
  .anom-chart {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 12px;
  }
  .anom-chart-legend {
    display: flex;
    gap: 16px;
    margin-top: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .anom-chart-legend-swatch {
    display: inline-block;
    width: 14px;
    height: 2px;
    margin-right: 6px;
    vertical-align: middle;
  }
  .anom-chart-legend-swatch-dashed {
    border-top: 2px dashed var(--text-muted);
    height: 0;
  }
  .anom-chart-meta {
    margin-top: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }

  /* Action bar at the bottom of detail */
  .anom-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 24px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg-primary);
  }
  .anom-action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--transition-fast);
  }
  .anom-action:hover { background: var(--bg-hover); }
  .anom-action-primary {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent);
  }

  /* Overview KPI strip */
  .anom-kpi {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 20px 24px;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
  }
  .anom-kpi-totals {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .anom-kpi-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ds-text-label);
  }
  .anom-kpi-row strong {
    font-weight: 500;
    color: var(--text-primary);
    min-width: 24px;
    display: inline-block;
    text-align: right;
  }

  /* Anomaly entity card list */
  .anom-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px 24px;
  }
  .anom-group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 4px;
    margin-top: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .anom-group-header:first-child { margin-top: 0; }

  .anom-empty-page {
    padding: 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: 12px;
  }

  .anom-paginator {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px 4px 4px;
    margin-top: 4px;
    border-top: 1px solid var(--border-subtle);
  }
  .anom-paginator-range {
    font-size: 11px;
    color: var(--text-muted);
  }
  .anom-paginator-range strong {
    color: var(--text-primary);
    font-weight: 600;
    font-family: var(--font-mono);
  }
  .anom-paginator-controls {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .anom-paginator-btn {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: 5px;
    padding: 4px 10px;
    font-size: 11px;
    font-family: var(--font-sans);
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .anom-paginator-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--border);
  }
  .anom-paginator-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .anom-paginator-btn:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  .anom-paginator-page {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    min-width: 44px;
    text-align: center;
  }
  .anom-paginator-perpage {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .anom-paginator-perpage select {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 3px 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    cursor: pointer;
  }
  .anom-paginator-perpage select:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }

  .anom-entity-card {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    align-items: center;
    width: 100%;
    padding: 12px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: inherit;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }
  .anom-entity-card:hover { background: var(--bg-hover); }
  .anom-entity-card.selected { border-color: var(--accent); background: var(--bg-hover); }
  .anom-entity-card:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
  .anom-entity-card-name {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .anom-entity-card-meta {
    margin-top: 2px;
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .anom-entity-card-score {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    font-family: var(--font-mono);
    color: var(--text-primary);
  }
  .anom-entity-card-score-value {
    font-size: 18px;
    font-weight: 600;
  }
  .anom-entity-card-score-label {
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* Empty / waiting */
  .anom-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 64px 24px;
    text-align: center;
    color: var(--text-muted);
    gap: 6px;
  }
  .anom-empty-title {
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--text-primary);
  }
  .anom-empty-sub {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Headline banner (echo of payload.headline) */
  .anom-headline {
    padding: 10px 24px;
    background: var(--severity-critical-bg);
    border-bottom: 1px solid var(--severity-critical-border);
    color: var(--severity-critical-text);
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
  }
`;

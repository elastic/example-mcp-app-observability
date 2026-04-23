/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * View-specific styles for manage-alerts. Composes the .ds-* utility layer
 * injected by shared/theme.ts → applyTheme().
 */

export const viewStyles = `
  /* Tabs row */
  .rule-tabs {
    display: flex;
    gap: 0;
    padding: 0 16px;
    background: var(--bg-primary);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .rule-tab {
    position: relative;
    padding: 12px 16px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    letter-spacing: 0.02em;
  }
  .rule-tab:hover { color: var(--text-primary); }
  .rule-tab[aria-selected="true"] { color: var(--text-primary); }
  .rule-tab[aria-selected="true"]::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
    background: var(--accent);
  }
  .rule-tab-count {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    vertical-align: baseline;
  }
  .rule-tab[aria-selected="true"] .rule-tab-count {
    background: var(--accent-dim);
    color: var(--accent);
  }

  /* List body */
  .rule-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
  }
  .rule-group-header {
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
  .rule-group-header:first-child { margin-top: 0; }
  .rule-group-header-count {
    color: var(--ds-text-label);
  }

  /* Rule card */
  .rule-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
    padding: 14px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: inherit;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }
  .rule-card:hover { background: var(--bg-hover); }
  .rule-card.selected { border-color: var(--accent); background: var(--bg-hover); }
  .rule-card:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }

  .rule-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .rule-card-name-col { min-width: 0; flex: 1 1 0; }
  .rule-card-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.3;
    word-break: break-word;
  }
  .rule-card-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    flex-wrap: wrap;
  }
  .rule-card-type-pill {
    display: inline-flex;
    align-items: center;
    padding: 1px 8px;
    border-radius: var(--radius-tag);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.02em;
  }
  .rule-card-id {
    font-size: 11px;
    color: var(--text-muted);
  }
  .rule-card-alerts-pill {
    display: inline-flex;
    align-items: center;
    padding: 1px 8px;
    border-radius: var(--radius-tag);
    background: var(--severity-major-bg);
    color: var(--severity-major);
    border: 1px solid var(--severity-major-border);
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 500;
  }

  .rule-card-chips {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .rule-enabled-tag {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: var(--radius-tag);
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 500;
  }
  .rule-enabled-yes {
    background: var(--severity-ok-bg);
    color: var(--severity-ok);
    border: 1px solid var(--severity-ok-border);
  }
  .rule-enabled-no {
    background: var(--bg-tertiary);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }

  .rule-facts {
    margin-top: 4px;
  }

  .rule-tag {
    display: inline-flex;
    align-items: center;
    padding: 1px 8px;
    border-radius: var(--radius-tag);
    background: var(--accent-dim);
    color: var(--accent);
    border: 1px solid var(--border-focus);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  /* Detail pane */
  .rule-detail {
    padding: 20px 24px 28px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .rule-detail-eyebrow {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .rule-detail-title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .rule-detail-title {
    font-family: var(--font-sans);
    font-size: 18px;
    font-weight: 600;
    line-height: 1.25;
    color: var(--text-primary);
    margin: 0;
    word-break: break-word;
  }
  .rule-detail-chips {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .rule-detail-outcome {
    font-size: 11px;
    color: var(--text-muted);
  }
  .rule-detail-id {
    font-size: 12px;
    color: var(--text-muted);
  }
  .rule-detail-code {
    margin: 0;
    padding: 12px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .rule-detail-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .rule-detail-history {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--text-secondary);
  }
  .rule-detail-history-label {
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .rule-detail-actions {
    display: flex;
    gap: 8px;
    margin-top: 6px;
    padding-top: 12px;
    border-top: 1px solid var(--border-subtle);
  }
  .rule-action {
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
  .rule-action:hover { background: var(--bg-hover); }
  .rule-action-danger {
    background: var(--severity-critical-bg);
    border-color: var(--severity-critical-border);
    color: var(--severity-critical);
  }
  .rule-action-danger:hover {
    background: var(--severity-critical-bg);
    filter: brightness(1.15);
  }

  /* Empty state */
  .rule-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 16px;
    color: var(--text-muted);
    text-align: center;
    gap: 6px;
  }
  .rule-empty-title {
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--text-primary);
  }
  .rule-empty-sub {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Next-steps footer (InvestigationActions replacement) */
  .rule-next-steps {
    padding: 12px 16px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg-primary);
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .rule-next-steps-label {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-right: 6px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  /* Error card */
  .rule-error {
    margin: 16px;
    padding: 16px;
    background: var(--severity-critical-bg);
    border: 1px solid var(--severity-critical-border);
    border-radius: var(--radius-sm);
  }
  .rule-error-title {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 600;
    color: var(--severity-critical);
    margin-bottom: 6px;
  }
  .rule-error-body {
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--text-primary);
  }
`;

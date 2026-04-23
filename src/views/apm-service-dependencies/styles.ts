/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * View-scoped styles for apm-service-dependencies. The SVG graph itself is
 * unchanged from the legacy view (per the call to keep our pan/zoom + visual
 * graph design intact); these styles cover only the chrome around it.
 */

export const viewStyles = `
  .dep-stats {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-primary);
    flex-shrink: 0;
  }

  .dep-coverage {
    margin: 8px 16px 0;
    padding: 8px 12px;
    background: var(--severity-major-bg);
    border: 1px solid var(--severity-major-border);
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.4;
    flex-shrink: 0;
  }
  .dep-coverage strong {
    color: var(--severity-major-text);
    font-weight: 600;
    margin-right: 6px;
  }

  .dep-graph {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    padding: 8px 14px;
  }

  .dep-legend {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    align-items: center;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg-primary);
    flex-shrink: 0;
  }

  .dep-actions {
    padding: 12px 16px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg-primary);
    flex-shrink: 0;
  }

  .dep-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 64px 20px;
    text-align: center;
    color: var(--text-muted);
  }
  .dep-empty-title {
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--text-primary);
  }
  .dep-empty-sub {
    font-size: 12px;
    color: var(--text-muted);
  }
`;

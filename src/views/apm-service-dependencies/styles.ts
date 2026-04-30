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
  /* Inline header stats — replaces the prior full-width .dep-stats row.
   * Sits next to the layout dropdown; on narrow viewports the
   * .ds-header-actions wrap keeps everything readable. */
  .dep-header-stats {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .dep-header-stat strong {
    color: var(--text-primary);
    font-weight: 700;
  }
  .dep-header-stat-sep {
    color: var(--text-dim);
    opacity: 0.5;
  }

  .dep-header-actions-inline {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .dep-header-action-btn {
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
  .dep-header-action-btn:hover {
    background: var(--bg-hover);
    border-color: var(--border);
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

  /* Graph container fills the remaining view height and scrolls internally
   * when the SVG is taller than the available space (tight viewports or
   * dense graphs). Horizontal fill comes from the SVG using width:100%
   * plus aspect-ratio — element dimensions match the viewBox, so the
   * content can pan all the way to the container edges. */
  .dep-graph {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    padding: 8px 14px;
  }


  /* Inspect "+" badge on a NodeCard. Hidden by default, appears on node
   * hover, stays visible while the node is inspected. */
  .dep-inspect-badge {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 50%;
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  }
  .dep-inspect-badge:hover { background: var(--bg-hover); color: var(--text-primary); }
  .dep-inspect-badge.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-primary);
  }
  .dep-inspect-badge:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  /* Inspected node gets a subtle dotted accent ring so the bright node
   * in the graph is recognizable as "pinned for compare" vs simply not
   * dimmed. */
  .dep-node-inspected {
    outline: 1px dashed var(--accent);
    outline-offset: 2px;
  }

  /* Inspect strip is now an OVERLAY at the bottom of the graph
   * container — it floats over the SVG instead of pushing the graph
   * up. Semi-transparent backdrop so the graph stays visible behind
   * the cards; horizontal scroll for > 4 cards. */
  .dep-inspect-strip {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 8px;
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

  .dep-inspect-card {
    flex: 0 0 240px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    position: relative;
  }
  .dep-inspect-card.focused { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-dim) inset; }
  .dep-inspect-card-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dep-inspect-card-name {
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
  .dep-inspect-card-focused-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--accent);
    background: var(--accent-dim);
    border: 1px solid var(--accent);
    border-radius: var(--radius-tag);
  }
  .dep-inspect-card-close {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 4px;
  }
  .dep-inspect-card-close:hover { color: var(--text-primary); }
  .dep-inspect-card-meta {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .dep-inspect-card-meta-row { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dep-inspect-card-meta-row strong { color: var(--text-primary); font-weight: 500; }
  .dep-inspect-card-foot {
    display: flex;
    gap: 6px;
    margin-top: 2px;
  }
  .dep-inspect-card-action {
    flex: 1;
    padding: 5px 8px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 11px;
    cursor: pointer;
  }
  .dep-inspect-card-action:hover { background: var(--bg-hover); }
  .dep-inspect-card-action:disabled {
    color: var(--text-muted);
    cursor: default;
    background: transparent;
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

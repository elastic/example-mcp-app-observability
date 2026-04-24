/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * View-scoped styles for observe. Composes the .ds-* utility layer.
 */

export const viewStyles = `
  .observe-body {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    padding: 16px 20px;
  }

  .observe-description {
    font-family: var(--font-sans);
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 4px;
  }
  .observe-subdescription {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 14px;
    word-break: break-word;
  }

  .observe-empty {
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
  .observe-empty-title {
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--text-primary);
  }
  .observe-empty-sub {
    font-size: 12px;
    color: var(--text-muted);
  }
`;

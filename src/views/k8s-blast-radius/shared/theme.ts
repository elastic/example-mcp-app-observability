/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const theme = {
  bg: "#0f1117",
  bgSecondary: "#161922",
  border: "#2a2d3a",
  text: "#e5e7eb",
  textMuted: "#6b7280",
  textDim: "#4b5563",
  blue: "#3b82f6",
  red: "#ef4444",
  green: "#22c55e",
  amber: "#f59e0b",
  purple: "#a855f7",
  cyan: "#14b8a6",
  orange: "#f97316",
  pink: "#ec4899",
};

export const baseStyles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${theme.bg};
    color: ${theme.text};
    font-size: 13px;
    line-height: 1.5;
  }
  code, .mono { font-family: 'JetBrains Mono', 'SF Mono', monospace; }
`;

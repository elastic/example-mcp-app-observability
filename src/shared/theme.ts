/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const theme = {
  bg: "#0f1117",
  bgSecondary: "#161922",
  bgTertiary: "#1e222d",
  border: "#2a2d3a",
  borderStrong: "#383c4b",
  text: "#e5e7eb",
  textMuted: "#9ca3af",
  textDim: "#6b7280",
  blue: "#3b82f6",
  red: "#ef4444",
  redSoft: "#e06c6c",
  green: "#22c55e",
  greenSoft: "#5aba6f",
  amber: "#f59e0b",
  purple: "#a855f7",
  cyan: "#14b8a6",
  orange: "#f97316",
  pink: "#ec4899",
};

export const baseStyles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: ${theme.bg}; color: ${theme.text}; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.5;
  }
  code, .mono { font-family: 'JetBrains Mono', 'SF Mono', monospace; }
  button { font-family: inherit; }
`;

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export function parseToolResult<T>(
  params: { content?: Array<{ type: string; text?: string }> }
): T | null {
  const textBlock = params.content?.find((c) => c.type === "text");
  if (!textBlock?.text) return null;
  try {
    return JSON.parse(textBlock.text) as T;
  } catch {
    return null;
  }
}

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Fixture } from "../mock-use-app";

/** Named states for a single view — the sidebar renders these as options. */
export type FixtureSet = Record<string, Fixture>;

/**
 * Wrap a plain JSON payload into a ToolResultParams for the mock hook.
 * Optional `prompt` is the sample user input a demo can show as "this is
 * what I'd type to Claude to call this tool" — rendered in a strip above
 * the harness iframe.
 */
export function fixture(label: string, payload: unknown, prompt?: string): Fixture {
  return {
    label,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
    ...(prompt ? { prompt } : {}),
  };
}

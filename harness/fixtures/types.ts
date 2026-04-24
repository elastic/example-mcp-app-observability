/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Fixture } from "../mock-use-app";

/** Named states for a single view — the sidebar renders these as options. */
export type FixtureSet = Record<string, Fixture>;

/** Wrap a plain JSON payload into a ToolResultParams for the mock hook. */
export function fixture(label: string, payload: unknown): Fixture {
  return {
    label,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  };
}

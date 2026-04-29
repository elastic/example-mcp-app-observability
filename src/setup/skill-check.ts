/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Heuristic detection of "this query failed in a way the skill would have
 * caught". Used to surface a Setup Notice banner in tool responses pointing
 * users to skill installation when their queries trip patterns the skill
 * specifically warns against.
 *
 * Patterns are intentionally narrow: each one fires only when (a) the query
 * matches a known anti-pattern AND (b) the resulting error message is one
 * the skill would have prevented. The combination dramatically reduces
 * false positives — we don't nag users for unrelated query failures, and
 * we don't nag at all when the user's query happens to use the right
 * field names but failed for an indexing/data reason.
 *
 * Adding a new pattern: keep the regex anchored to fields the skill
 * actively teaches about, and pair it with a verification_exception or
 * other ES error that the skill's guidance would have prevented.
 */

import type { SetupNotice } from "./notice.js";

const INSTALL_URL =
  "https://github.com/elastic/example-mcp-app-observability/releases/latest";

interface Pattern {
  /** Which skill teaches the relevant guidance — surfaces in the banner. */
  skill: string;
  /** Short rationale for the banner subtitle. */
  reason: string;
  /** Regex over the user-supplied ES|QL query. */
  query: RegExp;
  /** Regex over the ES error message. */
  error: RegExp;
  /** User-facing explanation. Should describe what to do. */
  message: string;
}

const PATTERNS: Pattern[] = [
  {
    skill: "observe",
    reason: "ECS error field on OTel-native trace index",
    query: /traces-\*\.otel-\*/i,
    error:
      /Unknown column \[error\.(message|type|stack_trace|exception(\.[a-z_]+)?)\]/i,
    message:
      "Your query referenced an ECS-style `error.*` field on an OTel-native " +
      "trace index. The observe skill includes guidance to use `exception.*` " +
      "(e.g. `exception.message`, `exception.type`) on these indexes. " +
      "Re-upload the latest observe.zip skill to enable this guidance.",
  },
  {
    skill: "observe",
    reason: "OTel exception field on classic-APM index",
    query: /traces-apm\*/i,
    error: /Unknown column \[exception\.(message|type|stacktrace)\]/i,
    message:
      "Your query referenced an OTel-style `exception.*` field on a " +
      "classic-APM trace index. The observe skill includes guidance to use " +
      "`error.message`, `error.exception.type`, `error.stack_trace` on these " +
      "indexes. Re-upload the latest observe.zip skill to enable this guidance.",
  },
  {
    skill: "observe",
    reason: "Wrong span-kind casing",
    query: /kind\s*==\s*"(SERVER|CLIENT|INTERNAL|PRODUCER|CONSUMER)"/,
    error: /(Unknown column|cannot resolve)|/, // generic — pattern is mostly query-driven
    message:
      "Your query used uppercase span kind values (SERVER / CLIENT / etc). " +
      "OTel ES|QL stores `kind` in title case (Server, Client, Internal, " +
      "Producer, Consumer). The observe skill includes this guidance. " +
      "Re-upload the latest observe.zip skill.",
  },
];

/**
 * Run the user's query + error through every pattern. Returns the first
 * matching SetupNotice or null. The first-match-wins policy is fine — only
 * one pattern fires per query in practice, and showing multiple banners
 * stacked would be more noise than help.
 */
export function detectSkillGap(
  esql: string | undefined,
  errorMessage: string
): SetupNotice | null {
  if (!esql || !errorMessage) return null;
  for (const p of PATTERNS) {
    if (p.query.test(esql) && p.error.test(errorMessage)) {
      return {
        type: "skill-gap",
        title: `Skill missing: ${p.skill}`,
        message: p.message,
        install_url: INSTALL_URL,
        skill: p.skill,
        reason: p.reason,
      };
    }
  }
  return null;
}

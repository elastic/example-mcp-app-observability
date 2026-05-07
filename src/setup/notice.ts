/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Setup notice: structured field tools attach to their responses so views
 * can render a dismissible banner pointing users at skill installation.
 *
 * Three variants share the shape:
 *   - "welcome"     fires on the first few responses after server start when
 *                   no dismissal marker file exists; nudges the user to
 *                   install skills proactively.
 *   - "skill-gap"   fires when a query has tripped a pattern the skill
 *                   specifically warns against — i.e., the user is missing
 *                   guidance the latest skill would have provided. Pushes the
 *                   install link.
 *   - "schema-hint" fires when a query failed in a way that's *expected* on a
 *                   particular deployment shape — the skill is current, but
 *                   the LLM needs a nudge toward the right fallback. No
 *                   install link; informational tone (see skill-check.ts).
 *
 * Welcome dismissal is persisted in a marker file in the user's home dir so
 * subsequent server starts don't keep re-nagging. Skill-gap notices are
 * stateless — they fire whenever the heuristic matches, on the assumption
 * that "your queries keep failing in skill-preventable ways" is exactly
 * the moment a nudge is most useful.
 */

import fs from "fs";
import path from "path";
import os from "os";

export interface SetupNotice {
  type: "welcome" | "skill-gap" | "schema-hint";
  title: string;
  message: string;
  install_url?: string;
  /** For "skill-gap" / "schema-hint": which skill teaches the relevant guidance. */
  skill?: string;
  /** For "skill-gap" / "schema-hint": short reason — used as a subtitle. */
  reason?: string;
}

const MARKER_DIR = path.join(os.homedir(), ".elastic-mcp-app-observability");
const MARKER_PATH = path.join(MARKER_DIR, "welcomed");

/**
 * In-memory tally of how many tool responses have shipped a welcome notice
 * so far this server-process. We bound the welcome to the first few calls
 * to avoid noise on long sessions where the user has clearly noticed (or
 * dismissed via the marker file).
 */
let welcomeShownCount = 0;
const MAX_WELCOME_RESPONSES = 5;

function markerExists(): boolean {
  try {
    return fs.existsSync(MARKER_PATH);
  } catch {
    // Best-effort — if fs probing fails, treat as not-dismissed and keep nudging.
    return false;
  }
}

/**
 * Returns the welcome notice if we should show it on this response, or null.
 * Each call increments the in-memory tally; once it exceeds MAX_WELCOME_RESPONSES
 * we stop returning a notice for the rest of this server-process.
 *
 * Marker-file dismissal is checked on every call (cheap stat; no caching) so
 * a user who dismisses mid-session sees the banner stop on the next response.
 */
export function consumeWelcomeNotice(): SetupNotice | null {
  if (welcomeShownCount >= MAX_WELCOME_RESPONSES) return null;
  if (markerExists()) return null;
  welcomeShownCount++;
  return {
    type: "welcome",
    title: "Welcome to Elastic Observability",
    message:
      "If you haven't already, install the skill packs from the latest GitHub release. " +
      "Without them Claude has only minimal guidance on picking index patterns and field " +
      "shapes — tools may produce verification_exception errors or wrong numbers. Each " +
      "skill is a separate .zip uploaded via Customize → Skills in Claude Desktop.",
    install_url:
      "https://github.com/elastic/example-mcp-app-observability/releases/latest",
  };
}

/**
 * Persistently dismiss the welcome banner. Called by the dismiss-setup-notice
 * tool, which the view's banner-close button invokes via app.callTool. Best-
 * effort — if the filesystem is read-only / sandboxed we just keep showing
 * the banner; not the worst failure mode.
 */
export function dismissWelcomeNotice(): { dismissed: boolean; reason?: string } {
  try {
    fs.mkdirSync(MARKER_DIR, { recursive: true });
    fs.writeFileSync(MARKER_PATH, new Date().toISOString());
    welcomeShownCount = MAX_WELCOME_RESPONSES; // also stop in-memory
    return { dismissed: true };
  } catch (e) {
    return {
      dismissed: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

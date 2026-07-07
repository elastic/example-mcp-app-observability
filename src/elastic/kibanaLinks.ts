/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { getConfig, isKibanaConfigured } from "./client.js";

export interface LinkCtx {
  base: string;
  spacePath: string;
  enabled: boolean;
}

type SpaceState = "unchecked" | "valid" | "not_found" | "unknown";
let spaceState: SpaceState = "unchecked";
let spaceNote: string | null = null;
let spaceValidationPromise: Promise<void> | null = null;

function readSpaceId(): string {
  const raw = process.env.KIBANA_SPACE_ID;
  if (!raw || raw.includes("${user_config.")) return "default";
  return raw.trim() || "default";
}

async function runSpaceValidation(spaceId: string): Promise<void> {
  if (spaceId === "default") {
    spaceState = "valid";
    return;
  }
  try {
    const config = getConfig();
    const res = await fetch(
      `${config.kibanaUrl}/api/spaces/space/${encodeURIComponent(spaceId)}`,
      {
        headers: { Authorization: `ApiKey ${config.kibanaApiKey}` },
        signal: AbortSignal.timeout(3_000),
      }
    );
    if (res.status === 404) {
      spaceState = "not_found";
      spaceNote = `Kibana space "${spaceId}" was not found — deep links disabled. Check KIBANA_SPACE_ID.`;
    } else {
      // 200, 403 (no permission to read space but it exists), or other non-404 → assume valid
      spaceState = "valid";
    }
  } catch {
    // Timeout or network error — proceed with links rather than silently breaking them
    spaceState = "unknown";
  }
}

export async function getLinkCtx(): Promise<{ ctx: LinkCtx; note: string | null }> {
  if (!isKibanaConfigured()) {
    return { ctx: { base: "", spacePath: "", enabled: false }, note: null };
  }
  const spaceId = readSpaceId();
  if (spaceState === "unchecked") {
    if (!spaceValidationPromise) spaceValidationPromise = runSpaceValidation(spaceId);
    await spaceValidationPromise;
  }
  const config = getConfig();
  const spacePath = spaceId === "default" ? "" : `/s/${encodeURIComponent(spaceId)}`;
  const enabled = spaceState !== "not_found";
  return {
    ctx: { base: config.kibanaUrl, spacePath, enabled },
    note: spaceState === "not_found" ? spaceNote : null,
  };
}

export function buildApmServiceLink(
  ctx: LinkCtx,
  opts: { serviceName: string; environment?: string; rangeFrom?: string; rangeTo?: string }
): string | null {
  if (!ctx.enabled || !opts.serviceName) return null;
  const url = new URL(
    `${ctx.base}${ctx.spacePath}/app/apm/services/${encodeURIComponent(opts.serviceName)}/overview`
  );
  if (opts.environment) url.searchParams.set("environment", opts.environment);
  if (opts.rangeFrom) url.searchParams.set("rangeFrom", opts.rangeFrom);
  if (opts.rangeTo) url.searchParams.set("rangeTo", opts.rangeTo);
  return url.toString();
}

export function buildSloLink(ctx: LinkCtx, sloId: string | undefined): string | null {
  if (!ctx.enabled || !sloId) return null;
  return `${ctx.base}${ctx.spacePath}/app/observability/slos/${encodeURIComponent(sloId)}`;
}

export function buildAlertRuleLink(ctx: LinkCtx, ruleId: string | undefined): string | null {
  if (!ctx.enabled || !ruleId) return null;
  return `${ctx.base}${ctx.spacePath}/app/observability/alerts/rules/${encodeURIComponent(ruleId)}`;
}

export function buildMlJobLink(ctx: LinkCtx, jobId: string | undefined): string | null {
  if (!ctx.enabled || !jobId) return null;
  // Rison _g param pre-selects job in anomaly explorer; stable across Kibana 8.x, no time range embedded
  const gParam = `(ml:(jobIds:!('${jobId}')))`;
  return `${ctx.base}${ctx.spacePath}/app/ml/explorer?_g=${encodeURIComponent(gParam)}`;
}

export function buildApmServicesLink(ctx: LinkCtx): string | null {
  if (!ctx.enabled) return null;
  return `${ctx.base}${ctx.spacePath}/app/apm/services`;
}

export function buildApmServiceErrorsLink(
  ctx: LinkCtx,
  serviceName: string,
  groupingKey?: string
): string | null {
  if (!ctx.enabled || !serviceName) return null;
  const base = `${ctx.base}${ctx.spacePath}/app/apm/services/${encodeURIComponent(serviceName)}/errors`;
  return groupingKey ? `${base}/${encodeURIComponent(groupingKey)}` : base;
}

export function buildK8sIntegrationAssetsLink(ctx: LinkCtx): string | null {
  if (!ctx.enabled) return null;
  return `${ctx.base}${ctx.spacePath}/app/integrations/detail/kubernetes_otel/assets`;
}

export function buildMlAnomalyExplorerLink(ctx: LinkCtx): string | null {
  if (!ctx.enabled) return null;
  return `${ctx.base}${ctx.spacePath}/app/ml/explorer`;
}

export function buildAlertsPageLink(ctx: LinkCtx): string | null {
  if (!ctx.enabled) return null;
  return `${ctx.base}${ctx.spacePath}/app/observability/alerts/rules`;
}

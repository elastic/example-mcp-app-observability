/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createAnalytics } from "@elastic/ebt/client/index.js";
import type { AnalyticsClientInitContext } from "@elastic/ebt/client/index.js";
import { ElasticV3ServerShipper } from "@elastic/ebt/shippers/elastic_v3/server/index.js";
import { createStderrLogger, type Logger } from "../../shared/logger.js";
import { BehaviorSubject } from "rxjs";
import type { AnalyticsClient, ClusterContext, LicenseContext } from "./analytics-client.js";
import {
  EVENT_TYPES,
  mcpToolCalledEventDef,
  viewRenderedEventDef,
  type McpToolCalledEbtPayload,
  type ViewRenderedEbtPayload,
} from "./events.js";

type EbtLogger = AnalyticsClientInitContext["logger"];

const CHANNEL_NAME = "elastic-observability-mcp-app";
const noop = (): void => undefined;

export type TelemetrySendTo = "production" | "staging";

const defaultLoggerBase: Pick<Logger, "info" | "warn" | "error" | "debug"> = {
  debug: noop,
  info: (msg) => createStderrLogger(["telemetry"]).info(msg),
  warn: (msg) => createStderrLogger(["telemetry"]).warn(msg),
  error: (msg) => createStderrLogger(["telemetry"]).error(msg),
};

export function resolveTelemetrySendTo(env: string | undefined): TelemetrySendTo {
  return env === "staging" ? "staging" : "production";
}

function baseUrlFor(sendTo: TelemetrySendTo): string {
  return sendTo === "production"
    ? "https://telemetry.elastic.co"
    : "https://telemetry-staging.elastic.co";
}

function logReportedEvent(
  logger: Pick<EbtLogger, "info">,
  sendTo: TelemetrySendTo,
  eventType: string,
  event: McpToolCalledEbtPayload | ViewRenderedEbtPayload,
): void {
  logger.info(`reported event: send_to=${sendTo} type=${eventType} payload=${JSON.stringify(event)}`);
}

function adaptLogger(base: Pick<Logger, "info" | "warn" | "error" | "debug">): EbtLogger {
  const logger: EbtLogger = {
    debug: (msg) => base.debug(typeof msg === "function" ? msg() : msg),
    info: (msg) => base.info(typeof msg === "function" ? msg() : msg),
    warn: (msg) => {
      if (msg instanceof Error) base.warn(msg);
      else base.warn(typeof msg === "function" ? msg() : msg);
    },
    error: (msg) => {
      if (msg instanceof Error) base.error(msg);
      else base.error(typeof msg === "function" ? msg() : msg);
    },
    get: () => logger,
  };
  return logger;
}

export interface CreateAnalyticsClientOptions {
  readonly mcpAppVersion: string;
  readonly sendTo?: TelemetrySendTo;
  readonly logger?: Pick<Logger, "info" | "warn" | "error" | "debug">;
}

export function createAnalyticsClient(opts: CreateAnalyticsClientOptions): AnalyticsClient {
  const sendTo = opts.sendTo ?? resolveTelemetrySendTo(process.env.MCP_APP_TELEMETRY_ENV);
  const baseUrl = baseUrlFor(sendTo);
  const logger = adaptLogger(opts.logger ?? defaultLoggerBase);
  let optedIn = false;

  const ebt = createAnalytics({
    isDev: process.env.NODE_ENV === "development",
    logger,
  });

  ebt.registerShipper(ElasticV3ServerShipper, {
    channelName: CHANNEL_NAME,
    version: opts.mcpAppVersion,
    buildShipperHeaders: (clusterUuid, version, licenseId) => ({
      "content-type": "application/x-ndjson",
      "x-elastic-cluster-id": clusterUuid,
      "x-elastic-stack-version": version,
      ...(licenseId ? { "x-elastic-license-id": licenseId } : {}),
    }),
    buildShipperUrl: ({ channelName }) => `${baseUrl}/v3/send/${channelName}`,
  });

  ebt.optIn({ global: { enabled: false } });

  ebt.registerEventType(mcpToolCalledEventDef);
  ebt.registerEventType(viewRenderedEventDef);

  const cluster$ = new BehaviorSubject<ClusterContext | undefined>(undefined);
  const license$ = new BehaviorSubject<LicenseContext | undefined>(undefined);

  ebt.registerContextProvider({
    name: "elasticsearch info",
    context$: cluster$,
    schema: {
      cluster_uuid: { type: "keyword", _meta: { description: "Elasticsearch cluster UUID" } },
      cluster_version: { type: "keyword", _meta: { description: "Elasticsearch / stack version" } },
    },
  });

  ebt.registerContextProvider({
    name: "license info",
    context$: license$,
    schema: {
      license_id: { type: "keyword", _meta: { description: "License id", optional: true } },
      license_status: { type: "keyword", _meta: { description: "License status", optional: true } },
      license_type: { type: "keyword", _meta: { description: "License type", optional: true } },
    },
  });

  const mcpApp$ = new BehaviorSubject<{ mcp_app_version: string }>({
    mcp_app_version: opts.mcpAppVersion,
  });
  ebt.registerContextProvider({
    name: "mcp app info",
    context$: mcpApp$,
    schema: {
      mcp_app_version: { type: "keyword", _meta: { description: "Version of the Elastic Observability MCP App" } },
    },
  });

  return {
    trackToolCalled(event: McpToolCalledEbtPayload): void {
      ebt.reportEvent(EVENT_TYPES.mcpToolCalled, event);
      if (optedIn) logReportedEvent(logger, sendTo, EVENT_TYPES.mcpToolCalled, event);
    },
    trackViewRendered(event: ViewRenderedEbtPayload): void {
      ebt.reportEvent(EVENT_TYPES.viewRendered, event);
      if (optedIn) logReportedEvent(logger, sendTo, EVENT_TYPES.viewRendered, event);
    },
    setOptIn(enabled: boolean): void {
      optedIn = enabled;
      ebt.optIn({ global: { enabled } });
    },
    setClusterContext(ctx: ClusterContext): void {
      cluster$.next(ctx);
    },
    setLicenseContext(ctx: LicenseContext): void {
      license$.next(ctx);
    },
    async shutdown(): Promise<void> {
      await ebt.shutdown();
    },
  };
}

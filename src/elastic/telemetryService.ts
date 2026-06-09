/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AnalyticsClient, TelemetrySendTo } from "./analytics/index.js";
import { resolveTelemetrySendTo } from "./analytics/index.js";
import { resolveTelemetryKibanaUrl } from "./client.js";
import type { TelemetryConfigClient } from "./telemetryConfigClient.js";
import { createStderrLogger, type Logger } from "../shared/logger.js";

interface TelemetryServiceOptions {
  readonly telemetryConfigClient: TelemetryConfigClient;
  readonly analytics: Pick<AnalyticsClient, "setOptIn">;
  readonly sendTo?: TelemetrySendTo;
  readonly logger?: Pick<Logger, "info" | "warn">;
}

export class TelemetryService {
  constructor(private readonly options: TelemetryServiceOptions) {}

  async applyOptIn(): Promise<void> {
    const {
      telemetryConfigClient,
      analytics,
      sendTo = resolveTelemetrySendTo(process.env.MCP_APP_TELEMETRY_ENV),
      logger = createStderrLogger(["telemetry"]),
    } = this.options;

    const target = resolveTelemetryKibanaUrl();

    // No usable Kibana endpoint: kibana_url is blank and the Elasticsearch URL
    // isn't a recognizable Elastic Cloud host to derive one from (the common
    // self-managed case). Stay opted-out quietly — this is expected, not a
    // misconfiguration, so it's logged at info and never as an error.
    if (!target) {
      analytics.setOptIn(false);
      logger.info(`Kibana telemetry opt-in resolved: enabled=false raw=unavailable send_to=${sendTo} (no Kibana endpoint)`);
      return;
    }

    try {
      const config = await telemetryConfigClient.fetchConfig(target.url);
      const enabled = config.optIn === true;
      analytics.setOptIn(enabled);
      logger.info(`Kibana telemetry opt-in resolved: enabled=${enabled} raw=${String(config.optIn)} send_to=${sendTo}${target.derived ? " (kibana url derived from es url)" : ""}`);
    } catch (err) {
      analytics.setOptIn(false);
      const detail = err instanceof Error ? err.message : String(err);
      if (target.derived) {
        // The Kibana URL was a Cloud-convention guess; a failure here just means
        // the guess didn't land (e.g. self-managed host that happens to contain
        // ".es."). Not the user's problem — keep it quiet, no warning.
        logger.info(`Kibana telemetry opt-in resolved: enabled=false raw=unavailable send_to=${sendTo} (derived Kibana endpoint unreachable)`);
      } else {
        // kibana_url was explicitly configured, so a failed config read is worth
        // surfacing — the user opted into Kibana and it isn't responding.
        logger.warn(`failed to read Kibana telemetry config; staying opted-out: ${detail}`);
        logger.info(`Kibana telemetry opt-in resolved: enabled=false raw=unavailable send_to=${sendTo}`);
      }
    }
  }
}

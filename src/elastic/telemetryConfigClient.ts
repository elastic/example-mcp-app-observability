/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { kibanaRequest } from "./client.js";

const TELEMETRY_CONFIG_PATH = "/api/telemetry/v2/config";
const KIBANA_API_VERSION = "2023-10-31";

export interface TelemetryConfig {
  readonly allowChangingOptInStatus: boolean;
  readonly optIn: boolean | null;
  readonly sendUsageFrom: "server" | "browser";
  readonly telemetryNotifyUserAboutOptInDefault: boolean;
  readonly labels: Record<string, string>;
}

export class TelemetryConfigClient {
  async fetchConfig(): Promise<TelemetryConfig> {
    return kibanaRequest<TelemetryConfig>(TELEMETRY_CONFIG_PATH, {
      apiVersion: KIBANA_API_VERSION,
    });
  }
}

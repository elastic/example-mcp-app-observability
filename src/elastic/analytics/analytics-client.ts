/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  McpToolCalledEbtPayload,
  ViewRenderedEbtPayload,
} from "./events.js";

export interface ClusterContext {
  readonly cluster_uuid: string;
  readonly cluster_version: string;
}

export interface LicenseContext {
  readonly license_id?: string;
  readonly license_status?: string;
  readonly license_type?: string;
}

export interface AnalyticsClient {
  trackToolCalled(event: McpToolCalledEbtPayload): void;
  trackViewRendered(event: ViewRenderedEbtPayload): void;
  setOptIn(enabled: boolean): void;
  setClusterContext(ctx: ClusterContext): void;
  setLicenseContext(ctx: LicenseContext): void;
  shutdown(): Promise<void>;
}

export const noopAnalyticsClient: AnalyticsClient = {
  trackToolCalled: () => {},
  trackViewRendered: () => {},
  setOptIn: () => {},
  setClusterContext: () => {},
  setLicenseContext: () => {},
  shutdown: async () => {},
};

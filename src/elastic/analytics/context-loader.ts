/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { esRequest, kibanaRequest } from "../client.js";
import type { AnalyticsClient } from "./analytics-client.js";
import { createStderrLogger, type Logger } from "../../shared/logger.js";

interface EsRootResponse {
  readonly cluster_uuid?: string;
  readonly version?: { readonly number?: string };
}

interface EsLicenseResponse {
  readonly license?: {
    readonly uid?: string;
    readonly status?: string;
    readonly type?: string;
  };
}

export interface ContextLoader {
  loadAndApply(): Promise<void>;
}

export interface CreateContextLoaderDeps {
  readonly analytics: Pick<AnalyticsClient, "setClusterContext" | "setLicenseContext">;
  readonly logger?: Pick<Logger, "warn">;
}

export function createContextLoader(deps: CreateContextLoaderDeps): ContextLoader {
  const { analytics, logger = createStderrLogger(["telemetry"]) } = deps;

  return {
    async loadAndApply(): Promise<void> {
      await Promise.all([loadCluster(), loadLicense()]);

      async function loadCluster(): Promise<void> {
        try {
          const data = await esRequest<EsRootResponse>("/");
          if (!data.cluster_uuid || !data.version?.number) {
            logger.warn("elasticsearch root response missing required cluster fields; skipping cluster context");
            return;
          }
          analytics.setClusterContext({
            cluster_uuid: data.cluster_uuid,
            cluster_version: data.version.number,
          });
        } catch (err) {
          logger.warn(`failed to load cluster context: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      async function loadLicense(): Promise<void> {
        try {
          const data = await esRequest<EsLicenseResponse>("/_license");
          if (!data.license) return;
          analytics.setLicenseContext({
            license_id: data.license.uid,
            license_status: data.license.status,
            license_type: data.license.type,
          });
        } catch (err) {
          logger.warn(`failed to load license context: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}

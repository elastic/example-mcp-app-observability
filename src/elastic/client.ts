/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticConfig } from "../shared/types.js";

let _config: ElasticConfig | null = null;

// When an optional `user_config` field in manifest.json is left blank,
// Claude Desktop's mcpb host does not strip the corresponding env entry —
// it passes the literal, un-substituted placeholder string (e.g.
// `${user_config.kibana_api_key}`) to the child process. That string is
// truthy, so a naive `value || fallback` check won't fall back.
// Any value that still contains the placeholder syntax is treated as unset.
function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes("${user_config.")) return undefined;
  return value;
}

export function setConfig(config: ElasticConfig) {
  _config = {
    elasticsearchUrl: config.elasticsearchUrl.replace(/\/$/, ""),
    elasticsearchApiKey: config.elasticsearchApiKey,
    kibanaUrl: (config.kibanaUrl || config.elasticsearchUrl).replace(/\/$/, ""),
    kibanaApiKey: config.kibanaApiKey || config.elasticsearchApiKey,
  };
}

export function getConfig(): ElasticConfig {
  if (!_config) {
    const elasticsearchUrl = cleanEnv(process.env.ELASTICSEARCH_URL);
    const elasticsearchApiKey = cleanEnv(process.env.ELASTICSEARCH_API_KEY);
    const kibanaUrl = cleanEnv(process.env.KIBANA_URL);
    const kibanaApiKey = cleanEnv(process.env.KIBANA_API_KEY);

    if (!elasticsearchUrl || !elasticsearchApiKey) {
      throw new Error(
        "ELASTICSEARCH_URL and ELASTICSEARCH_API_KEY environment variables are required"
      );
    }

    _config = {
      elasticsearchUrl: elasticsearchUrl.replace(/\/$/, ""),
      elasticsearchApiKey,
      kibanaUrl: (kibanaUrl || elasticsearchUrl).replace(/\/$/, ""),
      kibanaApiKey: kibanaApiKey || elasticsearchApiKey,
    };
  }
  return _config;
}

/**
 * Returns true only when the user explicitly configured a Kibana URL. The config
 * fallback silently reuses the Elasticsearch URL so ES-only tools keep working, but
 * that fallback is NOT valid for Kibana API calls. Tools that depend on Kibana
 * endpoints (alerting, saved objects, etc.) should gate their registration on this
 * so the LLM never sees a tool that can't actually work — and so destructive tools
 * can be selectively disabled by leaving `kibana_url` blank in the install config.
 */
export function isKibanaConfigured(): boolean {
  return Boolean(cleanEnv(process.env.KIBANA_URL));
}

export async function esRequest<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
  } = {}
): Promise<T> {
  const config = getConfig();
  const url = new URL(path, config.elasticsearchUrl);
  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) {
      url.searchParams.set(k, v);
    }
  }

  const isRawBody = typeof options.body === "string";
  const contentType = isRawBody && path.includes("_bulk")
    ? "application/x-ndjson"
    : "application/json";

  const timeoutMs = path.includes("_bulk") ? 120_000 : 30_000;
  const res = await fetch(url.toString(), {
    method: options.method || (options.body ? "POST" : "GET"),
    headers: {
      Authorization: `ApiKey ${config.elasticsearchApiKey}`,
      "Content-Type": contentType,
    },
    body: options.body
      ? isRawBody ? (options.body as string) : JSON.stringify(options.body)
      : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Elasticsearch ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export async function kibanaRequest<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
    apiVersion?: string;
  } = {}
): Promise<T> {
  const config = getConfig();
  const url = new URL(config.kibanaUrl + path);
  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `ApiKey ${config.kibanaApiKey}`,
    "Content-Type": "application/json",
    "kbn-xsrf": "true",
    "x-elastic-internal-origin": "Kibana",
  };

  if (options.apiVersion) {
    headers["elastic-api-version"] = options.apiVersion;
  }

  const res = await fetch(url.toString(), {
    method: options.method || (options.body ? "POST" : "GET"),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kibana ${res.status}: ${text}`);
  }

  // Some Kibana endpoints (e.g. DELETE rule) return 204 No Content.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

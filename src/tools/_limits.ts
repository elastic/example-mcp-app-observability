/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 *
 * Centralized payload + query caps for Observability MCP tools.
 *
 * For field engineers and reviewers: every constant here is a tuning knob.
 * If a real-world deployment is hitting a ceiling — bars truncated, "_other"
 * rolling up too much, suggestion lists feeling cramped — the fix is to bump
 * the relevant constant and re-pack the build, not to special-case in the
 * tool. Each cap carries a "Last reviewed" line; please update it when you
 * touch the value, and note the rough deployment shape that motivated the
 * change so the next reviewer has context.
 */

/**
 * Per-entity anomaly count cap. The `apm-health-summary` response includes a
 * `by_entity` breakdown so the view can recompute filtered anomaly totals
 * (donut + count chips) when the user toggles application chips. Capped to
 * keep the response payload bounded on busy clusters with many services /
 * pods that throw anomalies.
 *
 * Anything beyond the cap is rolled into a synthetic `_other` bucket so the
 * total count remains honest even when individual entities are hidden.
 *
 * Last reviewed: 2026-04-24 (initial value).
 */
export const ANOMALY_BY_ENTITY_CAP = 50;

/**
 * Per-app k8s rollup cap. The `pods.by_app` field reports cpu/mem/restart
 * sums grouped by app label so client-side filtering can recompute aggregate
 * tiles. We cap at the top-N busiest apps by pod count; the long tail
 * collapses into `_ungrouped` so totals reconcile with the namespace-level
 * tiles.
 *
 * Last reviewed: 2026-04-24 (initial value).
 */
export const PODS_BY_APP_CAP = 30;

/**
 * Cluster suggestion cap on namespace-not-found / cluster-not-found responses.
 * Used by `resolveCluster` and `resolveNamespace` when offering "did you mean"
 * candidates. Higher = more useful but noisier; 8 is a balance that fits in
 * a single line of view chrome.
 *
 * Last reviewed: 2026-04-24 (carried forward from existing namespace
 * resolution behavior, just centralized here).
 */
export const RESOLUTION_CANDIDATE_CAP = 8;

/**
 * Cap on the `clusters_available` field in `apm-health-summary.scope`. The
 * field is informational (no UI mutator); Claude can use it to suggest
 * scope changes in chat. We cap to avoid blowing up payload size in
 * environments with many ephemeral test clusters.
 *
 * Last reviewed: 2026-04-24 (initial value).
 */
export const CLUSTERS_AVAILABLE_CAP = 20;

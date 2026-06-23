/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Unit tests for buildPodsByApp's app-identity resolution + collision handling.
// Run: npm test  (tsx --test, no extra deps)

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPodsByApp, type PodResourceSnapshot } from "./apm-health-summary.js";

function snap(pod: string, namespace?: string, app_label?: string): PodResourceSnapshot {
  // 50% cpu, 50% mem so util is non-zero and easy to reason about.
  return {
    pod,
    cpu_use_cores: 1,
    cpu_lim_cores: 2,
    mem_use_bytes: 1,
    mem_lim_bytes: 2,
    restart_delta: 0,
    namespace,
    app_label,
  };
}

const NONE = new Map<string, string>();

test("two same-named workloads in different namespaces do NOT collide", () => {
  const snaps = new Map([
    ["pg-demo", snap("pg-demo", "otel-demo", "postgresql")],
    ["pg-prod", snap("pg-prod", "otel-prod", "postgresql")],
  ]);
  const out = buildPodsByApp(snaps, NONE, NONE)!;

  // Distinct, namespace-qualified buckets — not one merged "postgresql".
  assert.ok(out["otel-demo/postgresql"], "demo bucket exists");
  assert.ok(out["otel-prod/postgresql"], "prod bucket exists");
  assert.equal(out["postgresql"], undefined, "no merged bare bucket");
  assert.equal(out["otel-demo/postgresql"].pod_count, 1);
  assert.equal(out["otel-prod/postgresql"].pod_count, 1);
  // Short name + namespace preserved for display.
  assert.equal(out["otel-demo/postgresql"].name, "postgresql");
  assert.equal(out["otel-demo/postgresql"].namespace, "otel-demo");
  assert.equal(out["otel-prod/postgresql"].namespace, "otel-prod");
});

test("single-namespace names stay clean (unqualified)", () => {
  const snaps = new Map([
    ["cart-1", snap("cart-1", "otel-demo", "cart")],
    ["checkout-1", snap("checkout-1", "otel-demo", "checkout")],
  ]);
  const out = buildPodsByApp(snaps, NONE, NONE)!;
  assert.ok(out["cart"], "cart is unqualified");
  assert.ok(out["checkout"], "checkout is unqualified");
  assert.equal(out["otel-demo/cart"], undefined);
});

test("same name + same namespace via service AND label merge into one bucket", () => {
  const snaps = new Map([
    ["pg-a", snap("pg-a", "otel-demo", "postgresql")], // resolves via label
    ["pg-b", snap("pg-b", "otel-demo")], // resolves via service
  ]);
  const podServiceMap = new Map([["pg-b", "postgresql"]]);
  const serviceNamespaceMap = new Map([["postgresql", "otel-demo"]]);
  const out = buildPodsByApp(snaps, podServiceMap, serviceNamespaceMap)!;
  assert.ok(out["postgresql"], "merged into one bucket");
  assert.equal(out["postgresql"].pod_count, 2);
});

test("service source carries service.namespace as group", () => {
  const snaps = new Map([["cart-1", snap("cart-1", "oteldemo-default")]]);
  const podServiceMap = new Map([["cart-1", "cart"]]);
  const serviceNamespaceMap = new Map([["cart", "otel-demo"]]);
  const out = buildPodsByApp(snaps, podServiceMap, serviceNamespaceMap)!;
  assert.equal(out["cart"].source, "service");
  assert.equal(out["cart"].group, "otel-demo");
});

test("pods with no service and no label fall back to namespace, then _ungrouped", () => {
  const snaps = new Map([
    ["x", snap("x", "infra")], // no label, no service -> namespace
    ["y", snap("y")], // nothing -> _ungrouped
  ]);
  const out = buildPodsByApp(snaps, NONE, NONE)!;
  assert.equal(out["infra"].source, "namespace");
  assert.ok(out["_ungrouped"], "truly unidentifiable pod is _ungrouped");
  assert.equal(out["_ungrouped"].pod_count, 1);
});

test("collision qualification does not double-count totals", () => {
  const snaps = new Map([
    ["pg-demo", snap("pg-demo", "otel-demo", "postgresql")],
    ["pg-prod", snap("pg-prod", "otel-prod", "postgresql")],
    ["cart", snap("cart", "otel-demo", "cart")],
  ]);
  const out = buildPodsByApp(snaps, NONE, NONE)!;
  const totalPods = Object.values(out).reduce((n, b) => n + b.pod_count, 0);
  assert.equal(totalPods, 3, "every pod counted exactly once");
});

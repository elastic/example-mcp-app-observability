# Field Audit

Generated: 2026-04-18T04:39:27.248Z

Every (field, aggregation) tuple extracted from ES|QL queries under `src/tools/`, probed against the live cluster's mapping. The audit is opinionated about which combinations are safe — `SUSPECT`/`WRONG` verdicts are the ones to look at first.

Verdicts:

- **OK** — standard, expected to work correctly.
- **CHECK** — valid but context-dependent; confirm the grouping / filter makes the aggregation meaningful.
- **SUSPECT** — behavior may differ from naive expectation (e.g. `AVG` on `aggregate_metric_double`).
- **WRONG** — aggregation does not match the field's storage shape.
- **UNKNOWN** — field not present in the probed cluster's mapping; can't assess.

## CHECK (3)

| Tool | Field | Aggregation | ES type | Metric type | Index resolved from | Rationale |
|------|-------|-------------|---------|-------------|---------------------|-----------|
| `apm-service-dependencies` | `service_summary` | `SUM` | `long` | `gauge` | `metrics-service_summary.1m.otel-*` | SUM on a gauge is only meaningful across entities (pods, hosts); within one entity's samples it multiplies by sample count. Confirm the grouping collapses samples first. |
| `apm-service-dependencies` | `span.destination.service.response_time.count` | `SUM` | `long` | `gauge` | `metrics-service_destination.1m.otel-*` | SUM on a gauge is only meaningful across entities (pods, hosts); within one entity's samples it multiplies by sample count. Confirm the grouping collapses samples first. |
| `apm-service-dependencies` | `span.destination.service.response_time.sum.us` | `SUM` | `double` | `gauge` | `metrics-service_destination.1m.otel-*` | SUM on a gauge is only meaningful across entities (pods, hosts); within one entity's samples it multiplies by sample count. Confirm the grouping collapses samples first. |

## UNKNOWN (1)

| Tool | Field | Aggregation | ES type | Metric type | Index resolved from | Rationale |
|------|-------|-------------|---------|-------------|---------------------|-----------|
| `apm-service-dependencies` | `transaction.duration.us` | `AVG` | `—` | `—` | `—` | field not found in mapping; query may match no docs or field may be dynamically created only in some clusters *(field not present in field_caps for any probed pattern)* |

## OK (8)

| Tool | Field | Aggregation | ES type | Metric type | Index resolved from | Rationale |
|------|-------|-------------|---------|-------------|---------------------|-----------|
| `apm-health-summary` | `metrics.k8s.pod.memory.working_set` | `MAX` | `long` | `gauge` | `metrics-kubeletstatsreceiver.otel-*` | MAX on long (gauge) — standard usage. |
| `k8s-blast-radius` | `metrics.k8s.pod.memory.working_set` | `MAX` | `long` | `gauge` | `metrics-kubeletstatsreceiver.otel-*` | MAX on long (gauge) — standard usage. |
| `k8s-blast-radius` | `metrics.k8s.pod.memory.working_set` | `MAX` | `long` | `gauge` | `metrics-kubeletstatsreceiver.otel-*` | MAX on long (gauge) — standard usage. |
| `apm-health-summary` | `metrics.k8s.pod.cpu.usage` | `AVG` | `double` | `gauge` | `metrics-kubeletstatsreceiver.otel-*` | AVG on double (gauge) — standard usage. |
| `k8s-blast-radius` | `k8s.pod.name` | `COUNT` | `keyword` | `—` | `metrics-kubeletstatsreceiver.otel-*` | COUNT on keyword — standard usage. |
| `k8s-blast-radius` | `k8s.pod.name` | `COUNT` | `keyword` | `—` | `metrics-kubeletstatsreceiver.otel-*` | COUNT on keyword — standard usage. |
| `k8s-blast-radius` | `metrics.k8s.node.memory.available` | `MAX` | `long` | `gauge` | `metrics-kubeletstatsreceiver.otel-*` | MAX on long (gauge) — standard usage. |
| `k8s-blast-radius` | `k8s.node.name` | `COUNT` | `keyword` | `—` | `metrics-kubeletstatsreceiver.otel-*` | COUNT on keyword — standard usage. |

## Sample values

First non-null sample values for each probed field — useful for sanity-checking units and scale.

### `metrics.k8s.pod.memory.working_set` (metrics-kubeletstatsreceiver.otel-*)

```
18456576
32292864
49782784
```

### `metrics.k8s.pod.cpu.usage` (metrics-kubeletstatsreceiver.otel-*)

```
0.009065825
0.005632216
0.000208327
```

### `service_summary` (metrics-service_summary.1m.otel-*)

```
507
86
91
```

### `span.destination.service.response_time.count` (metrics-service_destination.1m.otel-*)

```
6
1
1
```

### `span.destination.service.response_time.sum.us` (metrics-service_destination.1m.otel-*)

```
258323
1201658
176949
```

### `k8s.pod.name` (metrics-kubeletstatsreceiver.otel-*)

```
"opentelemetry-kube-stack-daemon-collector-bgknx"
"opentelemetry-kube-stack-daemon-collector-bgknx"
"opentelemetry-kube-stack-daemon-collector-bgknx"
```

### `metrics.k8s.node.memory.available` (metrics-kubeletstatsreceiver.otel-*)

```
14068584448
14360993792
14487879680
```

### `k8s.node.name` (metrics-kubeletstatsreceiver.otel-*)

```
"gke-jmiller-bookinfo-default-pool-5fdcf7a0-j9ck"
"gke-jmiller-bookinfo-default-pool-5fdcf7a0-j9ck"
"gke-jmiller-bookinfo-default-pool-5fdcf7a0-j9ck"
```


# K8s CrashLoopBackOff Investigation (OTel) — workflow notes

Automated RCA for a Kubernetes **CrashLoopBackOff / OOMKilled** alert on clusters using the
OTel ingest path (EDOT / kube-stack). Triggered by an alert, it characterizes the event,
branches on OOMKilled vs not, consults ML / logs, checks whether the failure is isolated or
environment-wide, correlates recent K8s changes, and synthesizes a root-cause hypothesis —
before anyone opens a dashboard.

## Two variants — identical except one const

| File | `ml_memory_job` const | Use |
|---|---|---|
| `k8s-crashloop-investigation-otel.yaml` | `demo_k8s_workload_memory_anomaly` | Our demo deployment (ML job installed with a `demo_` prefix) |
| `k8s-crashloop-investigation-otel.shippable.yaml` | `k8s_workload_memory_anomaly` | **Customer-shippable** (integration default, no prefix) |

The step graphs are byte-for-byte identical (11 top-level steps). The **only** per-environment
knob is the `ml_memory_job` const — it must equal the installed job id. The `kubernetes_otel`
integration installs the job as **`k8s_workload_memory_anomaly`** (job def in
`packages/kubernetes_otel/kibana/ml_module/kubernetes_otel-metrics-ml.json`); if a deployment
applies a job-id prefix, match it in the const.

> The `demo_*` job has the same detector — `high_mean k8s.pod.memory.working_set BY
> k8s.deployment.name PARTITION k8s.namespace.name`. The OOM-branch ML query reads
> `.ml-anomalies-*` record-level results: `by_field_value` = alerting workload (deployment),
> `partition_field_value` = namespace, scored on `record_score`.

## Works OOTB — what each section needs

- **Core RCA (characterize → OOM/log branch → recent K8s changes → synthesis)** needs **only
  the Kubernetes OTel integration's standard data** (`metrics-k8sclusterreceiver.otel-*`,
  `metrics-kubeletstatsreceiver.otel-*`, `logs-*.otel-*`, `logs-k8seventsreceiver.otel-*`).
  No APM, no customer tinkering. Every field is OTel/EDOT semantic convention; **no demo
  service names are hard-coded** — the workflow is fully parameterized by the alert inputs.
- **ML "leak suspected" signal** (OOM branch) needs the integration's `k8s_workload_memory_anomaly`
  job enabled (a one-click enable; start the datafeed real-time so it baselines forward — do
  **not** backfill a noisy history). If absent, the branch degrades to "load-driven OOM".
- **Environment scope** (Step 3) needs APM `service_transaction` metrics. If APM isn't
  instrumented, it returns `insufficient_data` and the rest of the RCA is unaffected.

## Why Step 3 is "environment scope", not "upstream dependency health"

The earlier design resolved the alerting service's dependencies from `service_destination`
(`span.destination.service.resource`) and then looked up each dependency's health in
`service_transaction` by `service.name`. **Those two identifiers don't match across ingest
paths** — `span.destination.service.resource` is an RPC service name (e.g.
`oteldemo.ProductCatalogService`) or `host:port`, while `service.name` is the OTel service
(`product-catalog`). There is no field bridging them in the metric indices, so the join
returned `insufficient_data` for most environments — a non-functional enrichment OOTB.

The replacement compares **every** APM service's error rate + mean latency now vs. its 7-day
baseline and asks one robust question: is the degradation **isolated to the alerting service**
(→ likely a local root cause, e.g. a memory leak) or **widespread** (→ a shared/upstream
cause worth chasing)? It uses only `service.name`, which is present on every OTel/EDOT ingest
path, so it works OOTB and never needs customer setup.

**Known limitation (intentionally not solved here):** naming *which specific dependency*
degraded would require service-map / trace-correlation resolution of destination → service.
The environment-scope check is a robust proxy that answers the triage question without it.

## Deploy

1. Import the YAML on the **Workflows** page (in-place edit to preserve the id + any alert
   binding). Inputs are declared under the `manual` trigger (the strict workflow schema
   disallows a root-level `inputs` block); the same names are populated from the alert event
   at runtime, so `{{ inputs.* }}` resolves for both manual and alert runs.
2. Enable the `[K8s OTel] Pod CrashLoopBackOff` (and/or `OOMKilled containers`) rule from the
   Kubernetes OTel integration and attach this workflow so it runs on fire.
3. Enable the `k8s_workload_memory_anomaly` ML job (datafeed real-time from now).
4. Manual test: Run → "Manual custom JSON data" → `{ "service_name", "namespace",
   "pod_name", "alert_timestamp" }`. On a healthy cluster it returns a "no incident" RCA —
   that's a passing plumbing test.

## Validation status

- Demo version smoke-tested live: 20/20 steps completed, inputs resolved via the manual
  trigger, healthy-path RCA produced.
- Option B's `get_env_health_current` query validated against live data (returns per-service
  error rate / latency / volume). The OOM-branch ML query exercises during an actual
  OOMKilled incident.

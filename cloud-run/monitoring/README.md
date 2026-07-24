# Cloud Monitoring Dashboards

Infrastructure-as-code for the translation pipeline's Cloud Monitoring dashboards and log-based metrics.

## Dashboards

- **Translation Pipeline - Overview** (`dashboard-pipeline-overview.json`) — Request count, latency (p50/p95), error rates, container instances, and memory utilization across all three Cloud Run functions. Also includes log-based charts for pipeline stage executions by status and translations by provider/model.

- **Translation Quality - Reviewer Feedback** (`dashboard-translation-quality.json`) — Acceptance rate, normalized word edit distance, terminology decisions per review, and time-to-approve. Uses MQL queries to extract percentiles and means from distribution-valued log-based metrics.

## Log-based metrics

Defined in `log-based-metrics/`. These extract structured fields from Cloud Run stdout logs (JSON payloads emitted by each function's `logStructured` call).

| Metric | Type | Source field |
|---|---|---|
| `pipeline_stage_status` | Counter (with labels) | `jsonPayload.pipeline_stage`, `.status`, `.provider`, `.model` |
| `capture_feedback_acceptance_rate` | Distribution | `jsonPayload.acceptanceRate` |
| `capture_feedback_word_edit_distance` | Distribution | `jsonPayload.normalizedWordEditDistance` |
| `capture_feedback_terminology_decisions` | Distribution | `jsonPayload.terminologyDecisions` |
| `capture_feedback_time_to_approve` | Distribution | `jsonPayload.timeToApproveSeconds` |

Log-based metrics only capture data from the moment they are created. They do not backfill historical logs.

## Deploying

Replace `$PROJECT` with your GCP project ID.

### Create log-based metrics

```bash
for f in log-based-metrics/*.json; do
  name=$(python3 -c "import json; print(json.load(open('$f'))['name'])")
  gcloud logging metrics create "$name" \
    --project="$PROJECT" \
    --config-from-file="$f"
done
```

### Create dashboards

```bash
gcloud monitoring dashboards create \
  --project="$PROJECT" \
  --config-from-file=dashboard-pipeline-overview.json

gcloud monitoring dashboards create \
  --project="$PROJECT" \
  --config-from-file=dashboard-translation-quality.json
```

## Gotchas

- **Distribution metrics + Cloud Monitoring filter API**: The filter-based aggregation API cannot extract scalar values (mean, percentile) from distribution-valued log-based metrics. Use MQL (`timeSeriesQueryLanguage`) instead.
- **Dashboard display names**: Avoid em dashes or other non-ASCII characters in `displayName` — they can cause intermittent Console UI loading failures.
- **Rapid create/delete churn**: The Console UI caches dashboard IDs aggressively. After deleting and recreating dashboards, use direct URLs (`/monitoring/dashboards/builder/<id>?project=<project>`) rather than the sidebar list.

# Service Account Access

The Cloud Run functions run as a dedicated GCP service account. This document describes the IAM roles and Google Workspace sharing it requires.

## GCP IAM Roles

### Project-level

| Role | Purpose |
|---|---|
| Pub/Sub Publisher | Extract publishes completion messages to Pub/Sub |
| Eventarc Event Receiver | Translate receives Pub/Sub events via Eventarc |
| Secret Manager Secret Accessor | All functions read API keys from Secret Manager |

### Service-account-level

| Role | Granted to | Purpose |
|---|---|---|
| Service Account Token Creator | Pub/Sub service agent | Pub/Sub mints identity tokens as the pipeline service account to authenticate pushes to Cloud Run |

### Per Cloud Run service (set at deploy time)

| Role | Purpose |
|---|---|
| Cloud Run Invoker | Apps Script (orchestrator + editor add-on) can call Cloud Run functions |

## Google Workspace Sharing

The service account is shared on these Google Workspace resources via the standard Drive sharing UI.

### Viewer access

| Resource | Used by |
|---|---|
| Input Drive folder | Extract — fetches PDFs to process |
| Extraction prompt doc | Extract — loads the extraction prompt |
| Config sheet | Extract, Translate, Eval Quality, Eval Drift — reads model config |
| Translation prompt doc | Translate — loads the translation prompt |
| Glossary sheet (curated) | Translate — loads terminology glossary |
| Output template doc | Translate — copies template to create output docs |
| Evaluation rubric doc | Eval Quality, Eval Drift — LLM-as-judge scoring rubric |
| Golden set sheet | Eval Drift — reference translations for regression detection |

### Editor access (Shared Drive)

Service accounts cannot own files in regular Google Drive (no storage quota). Output folders must be in a Shared Drive, with the service account added as a Content Manager.

| Resource | Used by |
|---|---|
| Extraction JSON output folder | Extract — stores extraction JSON |
| Translation JSON output folder | Translate — stores translation JSON |
| Output docs folder | Translate — creates reviewer-facing Google Docs |
| Derived glossary sheet | Capture Feedback — writes terminology decisions from reviewer edits |
| Quality results sheet | Eval Quality — stores evaluation scores |
| Drift results sheet | Eval Drift — stores drift metrics |

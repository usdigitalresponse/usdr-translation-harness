# health-check

Daily check that everything the pipeline depends on exists and looks the way the code expects. Posts one message to an ops Google Chat space: each problem with what to do about it, or an all-clear. Not part of the translation pipeline; nothing calls it except Cloud Scheduler.

## What it checks

It reads each pipeline service's **live settings** from Cloud Run, so it checks what's actually deployed (no separate list of IDs to keep in sync). Every check runs over a list of resources (all prompt docs, all glossaries), so new prompts or glossaries are picked up from the services' settings without code changes.

| Check | Problem when |
|---|---|
| Services | A service is missing, its latest deploy never became ready, traffic isn't all on the latest revision, a required env var is unset, or services that share a sheet point at different ones |
| Prompt and rubric docs | Any `*_PROMPT_DOC_ID*` / `*_RUBRIC_DOC_ID` doc can't be opened, or has no text. Prompts are read the way Translate reads them (paragraphs only); the rubric includes tables |
| Glossary | The tab (`GLOSSARY_SHEET_TAB`, default `FAMLI Spanish Glossary`) can't be read, is missing a column Translate uses, or has no entries |
| Model Config | The `Config` tab can't be read, is missing role/provider/model/active, or a service's role has no row with active = YES |
| Processing Log | The `ProcessingLog` header row differs from the Orchestrator's, or files submitted in the last 24 hours have a blank Submitted By |
| Refinement log | Reviewed / ModelFlagged / OtherChanges is missing or its header row differs from Capture Feedback's |
| Eval results | The `EvalQuality` header row differs from Eval Quality's (a missing tab or empty row is fine: the service creates them) |
| Drive folders | Any `DRIVE_*_FOLDER_ID` folder can't be opened, is in the trash, or isn't a folder; or the service account can't add files to one the pipeline writes to (`*_INPUT_*` folders only need to be readable) |
| Statutes | `STATUTES_GCS_BUCKET` / `STATUTES_GCS_PREFIX` can't be listed or has no `.txt`/`.md` files |
| Extract → Translate hand-off | The `PUBSUB_TOPIC_EXTRACTION_COMPLETE` topic is missing, has no subscription, or a subscription's ack deadline is under 600s |
| Logged problems | Any `input_problem` entry or "Chat webhook" error from the pipeline's services (not other services in the project) in the last 24 hours |

The expected headers, tabs and roles are copies of the owning services' rules (`rules.js`); `cloud-run/tests/test_health_check_rules.js` fails if a copy drifts. The "what to do" text for each problem is in `runbook.js`.

## Settings

| Env var | |
|---|---|
| `HEALTH_CHECK_CHAT_WEBHOOK_URL` | Incoming webhook for the **ops** Chat space (not the translators' space). Store in Secret Manager |
| `HEALTH_CHECK_REGION` | Region of the pipeline's Cloud Run services |
| `HEALTH_CHECK_ENVIRONMENT` | Name shown in the message, e.g. `USDR` or `Maryland` |
| `GOOGLE_CLOUD_PROJECT` | Optional; defaults to the project it runs in |

Runs as the **pipeline service account**, so "the check can read it" means "the pipeline can read it". Besides the Drive/Sheets/Docs sharing and statutes bucket access it already has, that account needs three read-only project roles:

| Role | For |
|---|---|
| Cloud Run Viewer (`roles/run.viewer`) | Reading the services' settings and traffic |
| Pub/Sub Viewer (`roles/pubsub.viewer`) | The topic and subscription check |
| Logs Viewer (`roles/logging.viewer`) | The logged-problems check |

## Run it locally

```sh
cd cloud-run/health-check
npm install
node run-local.js --project=<project-id> --region=<region> --environment=USDR          # prints the message
node run-local.js --project=<project-id> --region=<region> --environment=USDR --post   # also posts it
```

Uses Application Default Credentials. To see exactly what the pipeline can see, impersonate its service account: `gcloud auth application-default login --impersonate-service-account=<pipeline SA email>`.

## Deploy

```sh
cd cloud-run/health-check
gcloud run deploy health-check --source=. --region=<region> --project=<project-id> \
  --service-account=<pipeline SA email> --no-allow-unauthenticated \
  --update-env-vars=HEALTH_CHECK_REGION=<region>,HEALTH_CHECK_ENVIRONMENT=<name> \
  --update-secrets=HEALTH_CHECK_CHAT_WEBHOOK_URL=<secret name>:latest
```

Then schedule it daily (Cloud Scheduler calls it with an identity token from a service account that has `roles/run.invoker` on health-check):

```sh
gcloud scheduler jobs create http health-check-daily --location=<region> --project=<project-id> \
  --schedule="0 8 * * *" --time-zone=America/New_York \
  --uri=<health-check URL> --http-method=POST \
  --oidc-service-account-email=<invoker SA email>
```

A failed run (checks crashed or the Chat post failed) responds 500, which Cloud Scheduler records as a failed attempt; it also tries to post the failure to Chat.

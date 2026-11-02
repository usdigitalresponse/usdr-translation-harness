// What to do about each kind of problem, shown under it in the Chat alert.
// Kept in one table, keyed by problem code, so it can later move to a Google
// Doc the team edits (phase 2) without touching the checks.

const WHAT_TO_DO = {
  // Services
  settings_unreadable:
    "Give the health check's service account the Cloud Run Viewer role (roles/run.viewer) in this project.",
  service_missing:
    "Deploy the service, or remove it from the health check's service list if it was retired on purpose.",
  service_not_ready:
    "The latest deploy didn't start. Open the service in Cloud Run, check the failed revision's logs, fix and redeploy.",
  traffic_not_latest:
    "Send traffic to the latest revision: gcloud run services update-traffic <service> --to-latest.",
  env_var_missing:
    "Set it on the service with gcloud run services update <service> --update-env-vars (never --set-env-vars, which wipes the others).",
  setting_mismatch:
    "Services that share this resource should point at the same ID. Update the odd one out with --update-env-vars.",

  // Prompt and rubric docs
  doc_unreadable:
    "Share the doc with the pipeline service account (Viewer), or fix the doc ID in the service's settings if it was moved or deleted.",
  doc_empty:
    "The doc has no text. Restore its content (File > Version history) before the next file is processed.",

  // Glossary
  glossary_unreadable:
    "Check the glossary sheet is shared with the service account and the tab name matches GLOSSARY_SHEET_TAB (default 'FAMLI Spanish Glossary').",
  glossary_missing_columns:
    "Restore the missing column headers in row 1. Until then, translations run without those glossary fields.",
  glossary_empty:
    "The glossary tab has no entries, so translations run with no glossary. Restore the rows (File > Version history).",

  // Model Config
  model_config_unreadable:
    "Share the Model Config sheet with the service account, or rename the tab back to 'Config' if it was renamed.",
  model_config_missing_columns:
    "Restore the role / provider / model / active headers in row 1 of the Config tab. Services fail until they're back.",
  model_config_no_active_model:
    "Set active = YES on at least one row for this role in the Config tab. The service can't run without one.",

  // Processing Log
  processing_log_unreadable:
    "Share the Processing Log sheet with the service account, or rename the tab back to 'ProcessingLog' if it was renamed.",
  processing_log_headers:
    "Restore row 1 to the expected headers. The Orchestrator stops processing files until they match.",
  processing_log_blank_submitter:
    "The Orchestrator couldn't read who submitted these files. Check its Executions log for 'Could not get lastModifyingUser'.",

  // Refinement log
  refinement_log_unreadable:
    "Check the refinement log sheet is shared with the service account and has tabs Reviewed, ModelFlagged and OtherChanges.",
  refinement_log_headers:
    "Restore row 1 of this tab to the expected headers. Until then, reviewer decisions for this tab aren't recorded.",

  // Eval results sheet
  eval_results_unreadable:
    "Check the eval results sheet is shared with the service account (Editor), or fix EVAL_QUALITY_RESULTS_SHEET_ID.",
  eval_results_headers:
    "Restore row 1 of the EvalQuality tab to the expected headers. Rows are written by position, so new results land in the wrong columns.",

  // Drive folders
  drive_folder_unreadable:
    "Share the folder (or its Shared Drive) with the pipeline service account as Content manager, or fix the folder ID setting.",
  drive_folder_not_folder:
    "The setting points at a file, not a folder. Copy the folder's ID from its URL into the setting.",
  drive_folder_trashed:
    "Restore the folder from the trash (Drive > Trash), or point the setting at a new folder.",
  drive_folder_read_only:
    "Give the pipeline service account Content manager (or Editor) on the folder or its Shared Drive.",

  // Statutes
  statutes_unreadable:
    "Check STATUTES_GCS_BUCKET is right and the service account has Storage Object Viewer on the bucket.",
  statutes_empty:
    "Upload the statute files, or fix STATUTES_GCS_PREFIX. Until then, translations run without statutes.",

  // Extract -> Translate hand-off
  pubsub_topic_missing:
    "Recreate the topic (setup guide 4), or fix PUBSUB_TOPIC_EXTRACTION_COMPLETE on extract. Until then, no file gets translated.",
  pubsub_no_subscription:
    "Recreate the Eventarc trigger from the topic to Translate (setup guide 5). Until then, no file gets translated.",
  pubsub_ack_deadline_short:
    "Set the subscription's ack deadline to 600s: gcloud pubsub subscriptions update <subscription> --ack-deadline=600.",

  // Problems the services logged
  logged_input_problem:
    "A service reported a problem with one of its inputs. Search Logs Explorer for jsonPayload.input_problem in the last day for details.",
  logged_chat_webhook_error:
    "Translate couldn't post to the translators' Chat space. Check GOOGLE_CHAT_WEBHOOK_URL and the space's webhook settings.",

  // The check itself
  check_crashed:
    "The health check hit an unexpected error. See the health-check service logs in Cloud Run.",
};

const FALLBACK = "See the health-check service logs for details.";

/**
 * @param {string} code - Problem code from a check result
 * @returns {string} What an operator should do about it
 */
function whatToDo(code) {
  return WHAT_TO_DO[code] || FALLBACK;
}

module.exports = { whatToDo, WHAT_TO_DO };

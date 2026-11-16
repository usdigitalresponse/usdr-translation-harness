"""Google Chat notice when an extraction fails and nothing goes on to
Translate, so the submitter would otherwise hear nothing. Same webhook and
format as Translate's notifier.js."""
import json
import logging
import os
import urllib.request

logger = logging.getLogger(__name__)

WEBHOOK_ENV_VAR = "GOOGLE_CHAT_WEBHOOK_URL"
# Shared with Translate: one log-based metric alerts on webhook problems
LOG_PREFIX = "Chat webhook"
WEBHOOK_TIMEOUT_SECONDS = 10


def _user_line(name, email):
    if name and email:
        return f"User: {name} ({email})\n"
    if name or email:
        return f"User: {name or email}\n"
    return ""


def notify_extraction_failed(source_file_name, reasons, submitted_by_email="", submitted_by_name=""):
    """Post a plain-language "translation failed" notice. Never raises.

    reasons: plain-language lines (see failure_reasons.py); the technical error
    is in the Processing Log row.
    """
    webhook_url = os.environ.get(WEBHOOK_ENV_VAR)
    if not webhook_url:
        logger.warning("%s not configured: %s is unset. No Chat notifications will be sent.",
                       LOG_PREFIX, WEBHOOK_ENV_VAR)
        return

    if len(reasons) == 1:
        reason_text = f"*Reason:* {reasons[0]}"
    else:
        reason_text = "*Reasons:*\n" + "\n".join(f"• {r}" for r in reasons)
    text = (
        _user_line(submitted_by_name, submitted_by_email)
        + f"⚠️ Translation failed for *{source_file_name}* while reading the document. "
        + "It won't be retried automatically.\n"
        + f"{reason_text}\n"
        + "Contact your workflow owner. Full details are in the Processing Log."
    )
    _post_to_chat(webhook_url, text)


def _post_to_chat(webhook_url, text):
    """Best effort: failures are logged and swallowed so they never mask the
    extraction failure being reported."""
    request = urllib.request.Request(
        webhook_url,
        data=json.dumps({"text": text}).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=UTF-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=WEBHOOK_TIMEOUT_SECONDS):
            pass
    except Exception:
        logger.exception("%s post failed", LOG_PREFIX)

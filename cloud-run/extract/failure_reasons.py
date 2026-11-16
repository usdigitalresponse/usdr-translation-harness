"""Plain-language reasons for an extraction failure, for the Chat notice.

The technical error (provider response, request ID) stays in the Processing
Log row and Cloud Run logs. Same style as Translate's failure-reasons.js.
"""
from http import HTTPStatus

import anthropic
from google.genai import errors as genai_errors

from llm import model_retry_reason, _error_classes, TIMEOUT_ERROR_CLASSES
from loaders import ModelConfigError, MissingSettingError

# Named constants, imported by name: a misspelled one fails at import (caught
# by tests and on deploy), not while reporting a failure.
REASON_MODEL_NOT_FOUND = "The extraction model in Model Config wasn't found. Check the model name."
REASON_MODEL_ACCESS = "The pipeline couldn't access the extraction model (an API key or permission problem)."
REASON_TIMEOUT = "The document took too long to read. It may be too long or complex; try splitting it into shorter files."
REASON_PROVIDER_BUSY = "The model provider was busy or unreachable (rate limit, overload or network problem)."
REASON_INVALID_OUTPUT = "The model's reading of the document came back in an unexpected format."
REASON_SAVING_FAILED = "The document was read, but saving the result failed."
REASON_HANDOFF_FAILED = "The document was read, but handing it on for translation failed."
REASON_FILE_NOT_FOUND = "The file, or a file the pipeline needs (the extraction prompt doc or Model Config sheet), couldn't be found or isn't shared with the pipeline."
REASON_FILE_UNREADABLE = "The file couldn't be read. It may be damaged or not a real Word or Google Docs file."
REASON_UNSUPPORTED_TYPE = "The file type isn't supported. Use a PDF, Google Doc or Word (.docx) file."
REASON_MODEL_CONFIG = "There's a problem with the Model Config sheet."
REASON_NO_ACTIVE_MODELS = "Model Config has no active extract model."
REASON_MISSING_SETTING = "The pipeline is missing a setting (an environment variable on the Extract service)."
REASON_UNEXPECTED = "Something unexpected went wrong."

NOT_FOUND_OR_NO_ACCESS = {HTTPStatus.NOT_FOUND, HTTPStatus.FORBIDDEN}
UNAUTHORIZED_OR_FORBIDDEN = {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}


def _http_status(err):
    """HTTP status on a model SDK or Google API error, or None.

    Claude SDK errors and googleapiclient's HttpError carry status_code;
    google-genai's APIError carries code.
    """
    if isinstance(err, genai_errors.APIError):
        return err.code
    return getattr(err, "status_code", None)


def model_failure_reason(err):
    """Plain-language reason one model's extraction call failed."""
    if _error_classes(err) & TIMEOUT_ERROR_CLASSES:
        return REASON_TIMEOUT
    if model_retry_reason(err):
        return REASON_PROVIDER_BUSY
    status = _http_status(err) if isinstance(err, (anthropic.APIStatusError, genai_errors.APIError)) else None
    if status == HTTPStatus.NOT_FOUND:
        return REASON_MODEL_NOT_FOUND
    if status in UNAUTHORIZED_OR_FORBIDDEN:
        return REASON_MODEL_ACCESS
    return REASON_UNEXPECTED


def input_failure_reason(err):
    """Plain-language reason a step outside the model call failed: loading the
    config, prompt doc or file from Drive."""
    if isinstance(err, MissingSettingError):
        return REASON_MISSING_SETTING
    if isinstance(err, ModelConfigError):
        return REASON_MODEL_CONFIG
    if _http_status(err) in NOT_FOUND_OR_NO_ACCESS:
        return REASON_FILE_NOT_FOUND
    return REASON_UNEXPECTED


def text_fetch_failure_reason(err):
    """Plain-language reason a Google Doc / Word file couldn't be fetched or read.
    Not an HTTP error means Drive returned the file but it couldn't be parsed."""
    if _http_status(err) is not None:
        return input_failure_reason(err)
    return REASON_FILE_UNREADABLE


def combine_reasons(failures):
    """One line if every model failed the same way; otherwise one per model.

    failures: list of (provider, model, reason).
    """
    distinct = list(dict.fromkeys(reason for _, _, reason in failures))
    if len(distinct) == 1:
        return distinct
    return [f"{provider}/{model}: {reason}" for provider, model, reason in failures]

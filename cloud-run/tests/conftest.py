"""Shared pytest fixtures for Cloud Run function tests."""

import os

import pytest

# The functions load the repo-root .env at import time, so without this a test
# that reaches real I/O would write to the live pipeline (e.g. a processing log
# row). Tests that need one of these set it explicitly with patch.dict.
LIVE_RESOURCE_SUFFIXES = ("_SHEET_ID", "_FOLDER_ID", "_DOC_ID")
LIVE_RESOURCE_PREFIXES = ("PUBSUB_TOPIC",)


@pytest.fixture(autouse=True)
def no_live_resources(monkeypatch):
    for key in list(os.environ):
        if key.endswith(LIVE_RESOURCE_SUFFIXES) or key.startswith(LIVE_RESOURCE_PREFIXES):
            monkeypatch.delenv(key)

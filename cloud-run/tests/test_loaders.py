import json
import os
from unittest.mock import patch, MagicMock

import pytest

from extract.loaders import (
    _load_config_from_sheet,
    load_config,
    _write_to_drive,
    _write_to_local,
    write_output,
)


SHEET_ROWS = [
    ["Role", "Provider", "Model", "Active", "Notes"],
    ["extract", "Anthropic", "claude-sonnet-4-6", "YES", ""],
    ["extract", "Google", "gemini-3.5-flash", "NO", "disabled for now"],
    ["translate", "Anthropic", "claude-sonnet-4-6", "YES", ""],
]


class TestLoadConfigFromSheet:
    @patch("extract.loaders.build")
    @patch("extract.loaders.google.auth.default", return_value=(MagicMock(), "project"))
    def test_parses_sheet_rows_into_config(self, mock_auth, mock_build):
        mock_service = MagicMock()
        mock_build.return_value = mock_service
        mock_service.spreadsheets().values().get().execute.return_value = {
            "values": SHEET_ROWS
        }

        config = _load_config_from_sheet("sheet-id-123")

        assert len(config["models"]) == 3
        assert config["models"][0] == {
            "role": "extract",
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "active": True,
            "notes": "",
        }
        assert config["models"][1]["active"] is False
        assert config["models"][1]["notes"] == "disabled for now"

    @patch("extract.loaders.build")
    @patch("extract.loaders.google.auth.default", return_value=(MagicMock(), "project"))
    def test_raises_when_sheet_has_no_data_rows(self, mock_auth, mock_build):
        mock_service = MagicMock()
        mock_build.return_value = mock_service
        mock_service.spreadsheets().values().get().execute.return_value = {
            "values": [["Role", "Provider", "Model", "Active", "Notes"]]
        }

        with pytest.raises(ValueError, match="no data rows"):
            _load_config_from_sheet("sheet-id-123")

    @patch("extract.loaders.build")
    @patch("extract.loaders.google.auth.default", return_value=(MagicMock(), "project"))
    def test_handles_short_rows_with_missing_columns(self, mock_auth, mock_build):
        mock_service = MagicMock()
        mock_build.return_value = mock_service
        mock_service.spreadsheets().values().get().execute.return_value = {
            "values": [
                ["Role", "Provider", "Model", "Active", "Notes"],
                ["extract", "Anthropic", "claude-sonnet-4-6"],
            ]
        }

        config = _load_config_from_sheet("sheet-id-123")
        assert config["models"][0]["active"] is False
        assert config["models"][0]["notes"] == ""


class TestLoadConfig:
    @patch("extract.loaders._load_config_from_sheet", return_value={"models": []})
    def test_uses_sheet_when_env_var_set(self, mock_sheet):
        with patch.dict("os.environ", {"MODEL_CONFIG_SHEET_ID": "sheet-123"}):
            result = load_config()
        mock_sheet.assert_called_once_with("sheet-123")
        assert result == {"models": []}

    @patch("extract.loaders._load_config_from_fixture", return_value={"models": [{"role": "extract"}]})
    def test_falls_back_to_fixture_without_env_var(self, mock_fixture):
        with patch.dict("os.environ", {}, clear=False):
            env = dict(os.environ)
            env.pop("MODEL_CONFIG_SHEET_ID", None)
            with patch.dict("os.environ", env, clear=True):
                result = load_config()
        mock_fixture.assert_called_once()


class TestWriteToDrive:
    @patch("extract.loaders.build")
    @patch("extract.loaders.google.auth.default", return_value=(MagicMock(), "project"))
    def test_uploads_dict_as_json(self, mock_auth, mock_build):
        mock_service = MagicMock()
        mock_build.return_value = mock_service
        mock_service.files().create().execute.return_value = {"id": "new-file-id"}

        data = {"blocks": [{"text": "hello"}]}
        result = _write_to_drive("folder-123", "output.json", data)

        assert result == "new-file-id"
        mock_service.files().create.assert_called()

    @patch("extract.loaders.build")
    @patch("extract.loaders.google.auth.default", return_value=(MagicMock(), "project"))
    def test_uploads_string_data(self, mock_auth, mock_build):
        mock_service = MagicMock()
        mock_build.return_value = mock_service
        mock_service.files().create().execute.return_value = {"id": "new-file-id"}

        result = _write_to_drive("folder-123", "raw.txt", "raw llm output")

        assert result == "new-file-id"


class TestWriteToLocal:
    def test_writes_dict_as_json(self, tmp_path):
        with patch("extract.loaders.FIXTURES_DIR", tmp_path):
            _write_to_local("test.json", {"key": "value"})

        written = json.loads((tmp_path / "output" / "test.json").read_text())
        assert written == {"key": "value"}

    def test_writes_string_directly(self, tmp_path):
        with patch("extract.loaders.FIXTURES_DIR", tmp_path):
            _write_to_local("raw.txt", "raw text content")

        written = (tmp_path / "output" / "raw.txt").read_text()
        assert written == "raw text content"


class TestWriteOutput:
    @patch("extract.loaders._write_to_drive", return_value="drive-file-id")
    def test_uses_drive_when_env_var_set(self, mock_drive):
        with patch.dict("os.environ", {"DRIVE_EXTRACTION_JSON_FOLDER_ID": "folder-123"}):
            result = write_output("test.json", {"key": "value"})
        mock_drive.assert_called_once_with("folder-123", "test.json", {"key": "value"})
        assert result == "drive-file-id"

    @patch("extract.loaders._write_to_local")
    def test_falls_back_to_local_without_env_var(self, mock_local):
        with patch.dict("os.environ", {}, clear=False):
            env = dict(os.environ)
            env.pop("DRIVE_EXTRACTION_JSON_FOLDER_ID", None)
            with patch.dict("os.environ", env, clear=True):
                result = write_output("test.json", {"key": "value"})
        mock_local.assert_called_once_with("test.json", {"key": "value"})
        assert result is None

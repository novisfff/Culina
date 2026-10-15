"""Exercise actual pytest selection, including imported database fixtures."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


BACKEND_ROOT = Path(__file__).resolve().parents[2]


def run_pytest(directory: Path, *arguments: str, env: dict | None = None):
    environment = {**os.environ, "PYTHONPATH": str(BACKEND_ROOT), "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1"}
    environment.pop("CULINA_TEST_MYSQL_URL", None)
    environment.pop("MODEL_USAGE_REFERENCE_PROFILE", None)
    environment.update(env or {})
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-p", "scripts.pytest_ci", "-q", *arguments],
        cwd=directory, env=environment, text=True, capture_output=True, timeout=30,
    )


def test_imported_mysql_fixture_follows_its_consumer_and_local_suite_deselects_it(tmp_path: Path) -> None:
    (tmp_path / "database_support.py").write_text(
        'import pytest\npytestmark = pytest.mark.mysql\n'
        '@pytest.fixture\ndef db():\n    raise AssertionError("database fixture executed")\n'
    )
    (tmp_path / "test_behavior.py").write_text(
        'from database_support import db\ndef test_db(db): pass\ndef test_local(): pass\n'
    )
    evidence = tmp_path / "selection.json"
    result = run_pytest(tmp_path, "-m", "not mysql", f"--ci-selection-report={evidence}")
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(evidence.read_text())
    assert report["selected"] == ["test_behavior.py::test_local"]
    assert report["deselected"] == ["test_behavior.py::test_db"]


@pytest.mark.parametrize("url", [None, "sqlite:///:memory:", "mysql+pymysql://localhost/culina"])
def test_selected_mysql_suite_refuses_missing_or_unsafe_database(tmp_path: Path, url: str | None) -> None:
    (tmp_path / "test_probe.py").write_text('def test_probe(): raise AssertionError("must not execute")\n')
    result = run_pytest(tmp_path, "--require-mysql", env={"CULINA_TEST_MYSQL_URL": url} if url else {})
    assert result.returncode == pytest.ExitCode.USAGE_ERROR
    assert "must not execute" not in result.stdout
    assert "MySQL" in result.stderr


def test_unexpected_selected_database_skip_fails_but_reference_skip_is_reported(tmp_path: Path) -> None:
    (tmp_path / "test_probe.py").write_text(
        'import pytest\n@pytest.mark.mysql\ndef test_db(): pytest.skip("database missing")\n'
        '@pytest.mark.model_usage_reference\ndef test_reference(): pytest.skip("reference host only")\n'
    )
    evidence = tmp_path / "selection.json"
    result = run_pytest(tmp_path, "--require-mysql", f"--ci-selection-report={evidence}",
                        env={"CULINA_TEST_MYSQL_URL": "mysql+pymysql://localhost/culina_test"})
    assert result.returncode == pytest.ExitCode.TESTS_FAILED, result.stdout + result.stderr
    assert "Selected CI test skipped unexpectedly" in result.stdout
    report = json.loads(evidence.read_text())
    assert [(item["nodeid"], item["expected"]) for item in report["skipped"]] == [
        ("test_probe.py::test_db", False), ("test_probe.py::test_reference", True)
    ]

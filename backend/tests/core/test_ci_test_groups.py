from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.run_ci_test_group import (
    CiTestGroupConfigurationError,
    build_pytest_command,
    discover_test_directories,
    load_test_groups,
    validate_test_groups,
)


BACKEND_ROOT = Path(__file__).resolve().parents[2]


def test_repository_ci_groups_cover_every_backend_test_directory_once() -> None:
    groups = load_test_groups(BACKEND_ROOT / "ci-test-groups.json")
    discovered = discover_test_directories(BACKEND_ROOT / "tests")

    validate_test_groups(groups, discovered)

    assert "meal_logs" in groups["service"]
    assert "deployment" in groups["service"]
    assert "ai_audio" in groups["ai"]
    assert len(discovered) == 16


def test_group_validation_rejects_missing_duplicate_and_unknown_directories() -> None:
    groups = {
        "service": ("account", "activity", "ghost"),
        "ai": ("activity",),
    }

    with pytest.raises(CiTestGroupConfigurationError) as exc_info:
        validate_test_groups(groups, {"account", "activity", "media"})

    message = str(exc_info.value)
    assert "missing assignments: media" in message
    assert "duplicate assignments: activity (ai, service)" in message
    assert "unknown assignments: ghost" in message


def test_group_manifest_requires_versioned_non_empty_string_lists(tmp_path: Path) -> None:
    manifest = tmp_path / "groups.json"
    manifest.write_text(
        json.dumps({"version": 2, "groups": {"service": []}}),
        encoding="utf-8",
    )

    with pytest.raises(CiTestGroupConfigurationError, match="version must be 1"):
        load_test_groups(manifest)


def test_build_pytest_command_uses_current_interpreter_and_forwards_arguments() -> None:
    command = build_pytest_command(
        "service",
        {"service": ("account", "meal_logs")},
        ["-q", "--maxfail=1"],
        python_executable="/python",
    )

    assert command == [
        "/python",
        "-m",
        "pytest",
        "tests/account",
        "tests/meal_logs",
        "-q",
        "--maxfail=1",
    ]


def test_build_pytest_command_rejects_unknown_group() -> None:
    with pytest.raises(CiTestGroupConfigurationError, match="unknown CI test group: missing"):
        build_pytest_command(
            "missing",
            {"service": ("account",)},
            [],
            python_executable="/python",
        )

from __future__ import annotations

from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def test_quality_gates_run_family_model_settings_mysql_release_suite() -> None:
    workflow = (REPOSITORY_ROOT / ".github" / "workflows" / "quality-gates.yml").read_text(
        encoding="utf-8"
    )

    assert "backend-model-usage:" in workflow
    assert "CULINA_TEST_MYSQL_URL:" in workflow
    for test_path in (
        "tests/family_model_settings/test_draft_mysql_concurrency.py",
        "tests/family_model_settings/test_publishing_mysql_concurrency.py",
        "tests/family_model_settings/test_search_activation_mysql_concurrency.py",
        "tests/family_model_settings/test_migration_mysql.py",
    ):
        assert test_path in workflow

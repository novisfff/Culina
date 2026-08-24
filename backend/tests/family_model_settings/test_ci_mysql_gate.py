from __future__ import annotations

from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def test_quality_gates_run_family_model_settings_mysql_release_suite() -> None:
    workflow = (REPOSITORY_ROOT / ".github" / "workflows" / "quality-gates.yml").read_text(
        encoding="utf-8"
    )

    assert "backend-mysql-suite:" in workflow
    assert "suite: family-model-settings" in workflow
    assert "CULINA_TEST_MYSQL_URL:" in workflow
    assert "npm run backend:test:family-model-settings" in workflow
    assert "--durations=20" in workflow

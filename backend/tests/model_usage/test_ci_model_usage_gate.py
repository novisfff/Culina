from __future__ import annotations

from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def test_quality_gates_run_focused_model_usage_suite_against_disposable_mysql() -> None:
    workflow = (REPOSITORY_ROOT / ".github" / "workflows" / "quality-gates.yml").read_text(
        encoding="utf-8"
    )

    assert "backend-model-usage:" in workflow
    assert "name: Backend Model Usage Tests" in workflow
    assert "mysql:8.4" in workflow
    assert "MYSQL_ROOT_HOST: '%'" in workflow
    assert "CULINA_TEST_MYSQL_URL:" in workflow
    assert "mysql+pymysql://root:root@127.0.0.1:3306/culina_model_usage_test" in workflow
    assert "culina_model_usage_test" in workflow
    assert "npm run backend:test:model-usage" in workflow

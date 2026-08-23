from __future__ import annotations

from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def test_quality_gates_run_focused_model_usage_suite_against_disposable_mysql() -> None:
    workflow = (REPOSITORY_ROOT / ".github" / "workflows" / "quality-gates.yml").read_text(
        encoding="utf-8"
    )

    assert "backend-mysql-suite:" in workflow
    assert "suite: model-usage-core" in workflow
    assert "--ignore=tests/model_usage/test_reporting_queries_mysql.py" in workflow
    assert "suite: model-usage-reporting" in workflow
    assert "tests/model_usage/test_reporting_queries_mysql.py" in workflow
    assert "needs: backend-mysql-suite" in workflow
    assert "if: always()" in workflow
    assert "name: Backend Model Usage Tests" in workflow
    assert "mysql:8.4" in workflow
    assert "MYSQL_ROOT_HOST: '%'" in workflow
    assert "CULINA_TEST_MYSQL_URL:" in workflow
    assert "mysql+pymysql://root:root@127.0.0.1:3306/culina_model_usage_test" in workflow
    assert "culina_model_usage_test" in workflow
    assert "needs.backend-mysql-suite.result" in workflow
    assert 'if [ "$SUITE_RESULT" != "success" ]; then' in workflow

from __future__ import annotations

from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def _workflow() -> str:
    return (REPOSITORY_ROOT / ".github" / "workflows" / "quality-gates.yml").read_text(
        encoding="utf-8"
    )


def test_backend_ci_jobs_use_complete_manifest_groups_and_dev_dependencies() -> None:
    workflow = _workflow()

    assert "-r backend/requirements.txt" not in workflow
    assert workflow.count("-r backend/requirements-dev.txt") >= 5
    for script in (
        "backend:test:service",
        "backend:test:ai",
        "backend:test:ai-evals",
        "backend:test:search",
        "backend:test:family-model-settings",
        "backend:test:model-usage",
    ):
        assert f"npm run {script}" in workflow


def test_quality_gates_block_style_drift_migrations_and_production_vulnerabilities() -> None:
    workflow = _workflow()

    assert "frontend-style-drift:" in workflow
    assert "npm --prefix frontend run check:style-tokens" in workflow
    assert "backend-migration-smoke:" in workflow
    assert "MYSQL_DATABASE: culina_migration_smoke" in workflow
    assert "npm run backend:migrate:smoke" in workflow
    assert "production-dependency-audit:" in workflow
    assert "pip-audit==2.9.0" in workflow
    assert "npm run audit:prod" in workflow


def test_quality_gates_run_media_permission_and_websocket_compose_smokes() -> None:
    workflow = _workflow()

    assert "deployment-compose-smokes:" in workflow
    assert "npm run deploy:smoke:media" in workflow
    assert "npm run deploy:smoke:realtime" in workflow
    assert "playwright install --with-deps chromium" in workflow

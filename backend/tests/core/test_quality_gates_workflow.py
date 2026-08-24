from __future__ import annotations

from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def _quality_gates_workflow() -> str:
    return (REPOSITORY_ROOT / ".github" / "workflows" / "quality-gates.yml").read_text(
        encoding="utf-8"
    )


def test_backend_ci_jobs_use_complete_manifest_groups_and_dev_dependencies() -> None:
    workflow = _quality_gates_workflow()

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


def test_quality_gates_cancel_stale_runs_and_cache_backend_dependencies() -> None:
    workflow = _quality_gates_workflow()

    assert "concurrency:" in workflow
    assert "cancel-in-progress: true" in workflow
    assert workflow.count("cache: pip") >= 6
    assert workflow.count("backend/requirements.txt") >= 6
    assert workflow.count("backend/requirements-dev.txt") >= 6
    assert "pip install --upgrade pip" not in workflow


def test_quality_gates_shard_vitest_and_keep_a_fail_closed_required_check() -> None:
    workflow = _quality_gates_workflow()

    assert "frontend-vitest-shard:" in workflow
    assert "shard: [1, 2]" in workflow
    assert "--shard=${{ matrix.shard }}/2" in workflow
    assert "frontend-vitest:" in workflow
    assert "name: Frontend Vitest" in workflow
    assert "needs: frontend-vitest-shard" in workflow
    assert "needs.frontend-vitest-shard.result" in workflow
    assert 'if [ "$SHARD_RESULT" != "success" ]; then' in workflow


def test_e2e_uses_a_dedicated_build_without_repeating_the_standalone_gate() -> None:
    workflow = _quality_gates_workflow()
    package_json = (REPOSITORY_ROOT / "frontend" / "package.json").read_text(
        encoding="utf-8"
    )

    assert '"build:e2e": "vite build"' in package_json
    assert "run: npm --prefix frontend run build:e2e" in workflow
    assert "run: npm run frontend:build" in workflow


def test_quality_gates_block_style_drift_migrations_and_production_vulnerabilities() -> None:
    workflow = _quality_gates_workflow()

    assert "frontend-style-drift:" in workflow
    assert "npm --prefix frontend run check:style-tokens" in workflow
    assert "backend-migration-smoke:" in workflow
    assert "MYSQL_DATABASE: culina_migration_smoke" in workflow
    assert "npm run backend:migrate:smoke" in workflow
    assert "production-dependency-audit:" in workflow
    assert "pip-audit==2.9.0" in workflow
    assert "npm run audit:prod" in workflow


def test_quality_gates_run_blocking_media_and_websocket_compose_smokes() -> None:
    workflow = _quality_gates_workflow()

    assert "deployment-compose-smokes:" in workflow
    assert "npm run deploy:smoke:media" in workflow
    assert "npm run deploy:smoke:realtime" in workflow
    assert "playwright install --with-deps chromium" in workflow
    assert workflow.count("set -o pipefail") == 2

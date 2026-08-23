from __future__ import annotations

from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def _quality_gates_workflow() -> str:
    return (REPOSITORY_ROOT / ".github" / "workflows" / "quality-gates.yml").read_text(
        encoding="utf-8"
    )


def test_quality_gates_cancel_stale_runs_and_cache_backend_dependencies() -> None:
    workflow = _quality_gates_workflow()

    assert "concurrency:" in workflow
    assert "cancel-in-progress: true" in workflow
    assert workflow.count("cache: pip") >= 5
    assert workflow.count("cache-dependency-path: backend/requirements.txt") >= 5
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

from __future__ import annotations

import re
from pathlib import Path

import yaml

from scripts.run_ci_test_group import load_mysql_suites, load_test_groups

ROOT = Path(__file__).resolve().parents[3]


def jobs():
    return yaml.safe_load((ROOT / ".github/workflows/quality-gates.yml").read_text())["jobs"]


def commands(job):
    return "\n".join(step.get("run", "") for step in job["steps"])


def test_pr_gate_directly_waits_for_every_result_it_checks():
    workflow = jobs()
    gate = workflow["pr-gate"]
    assert gate["if"] == "always()"
    verify = next(step for step in gate["steps"] if "CLASSIFY_RESULT" in step.get("env", {}))
    results = {name: expression for name, expression in verify["env"].items() if name.startswith("RESULT_")}
    dependencies = set(gate["needs"])
    assert set(re.findall(r"needs\.([a-z0-9-]+)\.result", " ".join(results.values()))) <= dependencies
    for matrix in ("frontend-vitest-shard", "backend-mysql-suite"):
        assert matrix in dependencies
        assert any(f"needs.{matrix}.result" in value for value in results.values())
        assert workflow[matrix]["strategy"]["fail-fast"] is False
    assert "classify" in dependencies


def test_mysql_selection_uses_manifest_and_requires_a_disposable_database():
    workflow = jobs()
    job = workflow["backend-mysql-suite"]
    groups = load_test_groups(ROOT / "backend/ci-test-groups.json")
    suites = load_mysql_suites(ROOT / "backend/ci-test-groups.json", groups)
    assert {group for suite in suites.values() for group in suite["groups"]} == {"service", "ai", "family_model_settings", "model_usage"}
    assert "needs.classify.outputs.mysql_suites" in job["strategy"]["matrix"]["suite"]
    assert job["services"]["mysql"]["image"] == "mysql:8.4"
    assert job["env"]["CULINA_TEST_MYSQL_URL"].endswith("_test")
    assert "--mysql-suite=${{ matrix.suite }}" in commands(job)
    assert "--local-only" in commands(workflow["backend-service"])
    assert "--local-only" in commands(workflow["backend-ai"])


def test_shared_frontend_evidence_has_dependencies_and_no_second_test_or_build_run():
    workflow = jobs()
    build = workflow["frontend-build"]
    for consumer in ("frontend-e2e-p0", "frontend-governance"):
        assert "frontend-build" in workflow[consumer]["needs"]
        downloads = [step for step in workflow[consumer]["steps"] if step.get("uses", "").startswith("actions/download-artifact@")]
        assert any(step["with"].get("name") == "frontend-build" for step in downloads)
    assert "frontend:typecheck" in commands(build)
    assert "build:ci" in commands(build)
    governance = workflow["frontend-governance"]
    assert "frontend-vitest-shard" in governance["needs"]
    assert "test:ci:merge" in commands(governance)
    assert "coverage:report" not in commands(governance)
    assert "--mode=ratchet" in commands(governance)
    assert "frontend_build != 'true'" in workflow["frontend-typecheck"]["if"]
    assert "frontend_full != 'true'" in workflow["frontend-ai-contract"]["if"]


def test_selected_checks_publish_evidence_and_do_not_ignore_failures():
    workflow = jobs()
    for name in ("backend-service", "backend-ai", "backend-search", "ai-skill-evals", "backend-mysql-suite"):
        job = workflow[name]
        assert "--junitxml=" in commands(job)
        assert "--ci-selection-report=" in commands(job)
        assert not any(step.get("continue-on-error") for step in job["steps"])
        assert any(step.get("if") == "always()" and step.get("uses", "").startswith("actions/upload-artifact@") for step in job["steps"])
    smokes = workflow["deployment-compose-smokes"]
    assert "deploy:smoke:media" in commands(smokes)
    assert "deploy:smoke:websocket" in commands(smokes)
    audit = workflow["production-dependency-audit"]
    assert "npm run audit:prod" in commands(audit)
    assert "exit 0" not in commands(audit)

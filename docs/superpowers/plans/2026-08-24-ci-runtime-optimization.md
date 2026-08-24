# CI Runtime Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce pull-request CI wall time without removing any existing family-model-settings, model-usage, frontend unit, build, or P0 browser coverage.

**Architecture:** Run the three expensive MySQL workloads and two Vitest shards on independent GitHub-hosted runners, then preserve the existing required-check names with explicit fail-closed aggregator jobs. Remove repeated test setup work by precomputing password hashes and caching per-file provider-source analysis using file metadata for invalidation.

**Tech Stack:** GitHub Actions, pytest, SQLAlchemy/MySQL 8.4, Python `functools.lru_cache`, Vitest, Vite, Playwright.

## Global Constraints

- Keep all current PR test coverage; the 100k reporting suite still runs on every pull request.
- Preserve `Backend Model Usage Tests` and `Frontend Vitest` as fail-closed aggregate check names for branch protection compatibility.
- Do not run shared-database pytest workers in parallel inside one job; every MySQL matrix entry receives its own service container.
- Keep Vitest files serial inside each shard because the repository documents async timeout starvation under same-runner file parallelism.
- Do not commit, push, or create a pull request unless the user explicitly requests it.

---

### Task 1: Reuse family fixture password hashes

**Files:**
- Create: `backend/tests/family_model_settings/test_support_performance.py`
- Modify: `backend/tests/family_model_settings/_support.py:135-201`

**Interfaces:**
- Consumes: `get_password_hash(password: str) -> str` and the existing `family_model_api` fixture.
- Produces: module-level `_OWNER_PASSWORD_HASH` and `_MEMBER_PASSWORD_HASH` values reused by every fixture instance.

- [x] **Step 1: Write the failing regression test**

```python
from __future__ import annotations

import pytest

from tests.family_model_settings import _support


def test_family_model_api_does_not_hash_passwords_per_fixture(monkeypatch) -> None:
    def fail_if_called(password: str) -> str:
        raise AssertionError(f"unexpected runtime password hash: {password}")

    monkeypatch.setattr(_support, "get_password_hash", fail_if_called)
    fixture = _support.family_model_api.__wrapped__()
    context = next(fixture)
    try:
        assert context.auth_state.user_id == "owner-a"
    finally:
        with pytest.raises(StopIteration):
            next(fixture)
```

- [x] **Step 2: Verify the regression test fails because fixture construction still hashes three passwords**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_support_performance.py -q`

Expected: FAIL with `unexpected runtime password hash`.

- [x] **Step 3: Precompute the two valid hashes once at module import and reuse them in `UserCredential` rows**

```python
_OWNER_PASSWORD_HASH = get_password_hash("OwnerPass123")
_MEMBER_PASSWORD_HASH = get_password_hash("MemberPass123")
```

Replace the three fixture calls with the corresponding constants.

- [x] **Step 4: Verify the regression and representative API tests pass**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_support_performance.py tests/family_model_settings/test_profile_api.py -q`

Expected: all selected tests pass.

### Task 2: Cache provider source analysis safely

**Files:**
- Modify: `backend/tests/model_usage/test_provider_send_inventory.py:1-121`
- Modify: `backend/app/services/model_usage/provider_registry.py:1-365`

**Interfaces:**
- Consumes: a Python source path, its repository-relative path, `st_mtime_ns`, and `st_size`.
- Produces: `_analyze_source_file(...) -> _SourceFileAnalysis` containing immutable remote-send points and SDK retry gaps.

- [x] **Step 1: Add a failing test that invokes both public discovery functions repeatedly and counts `ast.parse` calls**

```python
def test_provider_source_analysis_is_shared_for_unchanged_files(tmp_path, monkeypatch) -> None:
    app_root = tmp_path / "app"
    app_root.mkdir()
    (app_root / "runtime.py").write_text(
        "from openai import OpenAI\n\n"
        "def send(client):\n"
        "    client.post('https://provider.example')\n"
        "    return OpenAI(max_retries=0)\n",
        encoding="utf-8",
    )
    real_parse = provider_registry.ast.parse
    parse_calls = 0

    def counting_parse(*args, **kwargs):
        nonlocal parse_calls
        parse_calls += 1
        return real_parse(*args, **kwargs)

    monkeypatch.setattr(provider_registry.ast, "parse", counting_parse)
    discover_remote_send_points(app_root)
    discover_sdk_retry_configuration_gaps(app_root)
    discover_remote_send_points(app_root)

    assert parse_calls == 1
```

- [x] **Step 2: Verify it fails with three parses**

Run: `cd backend && .venv/bin/python -m pytest tests/model_usage/test_provider_send_inventory.py::test_provider_source_analysis_is_shared_for_unchanged_files -q`

Expected: FAIL because `parse_calls` is greater than one.

- [x] **Step 3: Implement one cached per-file analysis shared by both discovery functions**

Add an immutable `_SourceFileAnalysis`, an `@lru_cache(maxsize=1024)` helper keyed by resolved path, relative source path, nanosecond mtime, and size, and a small iterator that maps current `*.py` files to cached results. Parse each file once, run both visitors over the same AST, and translate I/O/syntax failures to the existing stable error code.

- [x] **Step 4: Verify cache reuse and invalidation behavior**

Run: `cd backend && .venv/bin/python -m pytest tests/model_usage/test_provider_send_inventory.py -q`

Expected: all inventory tests pass, including the existing rewrite test proving changed files are reanalyzed.

### Task 3: Parallelize expensive CI suites while preserving required checks

**Files:**
- Modify: `backend/tests/model_usage/test_ci_model_usage_gate.py`
- Modify: `backend/tests/family_model_settings/test_ci_mysql_gate.py`
- Create: `backend/tests/core/test_quality_gates_workflow.py`
- Modify: `.github/workflows/quality-gates.yml`

**Interfaces:**
- Produces: `backend-mysql-suite` matrix entries `family-model-settings`, `model-usage-core`, and `model-usage-reporting`; fail-closed `backend-model-usage` aggregator; `frontend-vitest-shard` matrix entries `1/2` and `2/2`; fail-closed `frontend-vitest` aggregator.

- [x] **Step 1: Update/add workflow contract tests before editing YAML**

The tests must require:

```python
assert "backend-mysql-suite:" in workflow
assert "tests/family_model_settings" in workflow
assert "--ignore=tests/model_usage/test_reporting_queries_mysql.py" in workflow
assert "tests/model_usage/test_reporting_queries_mysql.py" in workflow
assert "needs: backend-mysql-suite" in workflow
assert "frontend-vitest-shard:" in workflow
assert "--shard=${{ matrix.shard }}/2" in workflow
assert "needs: frontend-vitest-shard" in workflow
assert "cancel-in-progress: true" in workflow
assert workflow.count("cache: pip") >= 5
```

- [x] **Step 2: Verify the workflow tests fail against the current serial workflow**

Run: `cd backend && .venv/bin/python -m pytest tests/model_usage/test_ci_model_usage_gate.py tests/family_model_settings/test_ci_mysql_gate.py tests/core/test_quality_gates_workflow.py -q`

Expected: FAIL because matrix, aggregators, sharding, cancellation, and pip cache are absent.

- [x] **Step 3: Implement the backend MySQL matrix and fail-closed aggregate check**

Each matrix entry gets MySQL 8.4 and the same safe `_test` URL on its isolated runner. Core excludes only `test_reporting_queries_mysql.py`; the reporting entry runs that file explicitly. Add `--durations=20`, pip caching, and remove redundant `pip install --upgrade pip` calls.

- [x] **Step 4: Implement two serial Vitest shards and the fail-closed aggregate check**

Run each shard with `npm run frontend:test -- --shard=${{ matrix.shard }}/2`. Aggregators use `if: always()`, read `needs.<job>.result`, and exit nonzero unless the matrix result is exactly `success`.

- [x] **Step 5: Add top-level stale-run cancellation and verify workflow contracts pass**

Run: `cd backend && .venv/bin/python -m pytest tests/model_usage/test_ci_model_usage_gate.py tests/family_model_settings/test_ci_mysql_gate.py tests/core/test_quality_gates_workflow.py -q`

Expected: all workflow contract tests pass.

### Task 4: Remove redundant E2E typecheck and bundle-budget work

**Files:**
- Modify: `frontend/package.json:6-20`
- Modify: `.github/workflows/quality-gates.yml:148-165`
- Modify: `backend/tests/core/test_quality_gates_workflow.py`

**Interfaces:**
- Produces: frontend script `build:e2e` running `vite build`; the standalone `Frontend Build` job remains responsible for TypeScript and bundle budgets.

- [x] **Step 1: Extend the workflow contract test to require the dedicated E2E build script**

```python
package_json = (REPOSITORY_ROOT / "frontend" / "package.json").read_text(encoding="utf-8")
assert '"build:e2e": "vite build"' in package_json
assert "npm --prefix frontend run build:e2e" in workflow
```

- [x] **Step 2: Verify the test fails because the script does not exist**

Run: `cd backend && .venv/bin/python -m pytest tests/core/test_quality_gates_workflow.py -q`

Expected: FAIL on the missing script.

- [x] **Step 3: Add `build:e2e` and switch only the P0 job to it**

Keep `npm run frontend:build` unchanged in the standalone production build gate.

- [x] **Step 4: Verify configuration and a production build**

Run: `npm --prefix frontend run build:e2e && npm run frontend:build`

Expected: both builds exit zero; the second also passes bundle budgets.

### Task 5: Fresh end-to-end verification and timing

**Files:**
- Verify only; no additional production changes.

- [x] **Step 1: Run the complete frontend quality/build gates**

Run: `npm run frontend:quality && npm run frontend:build`

Expected: typecheck, 1745+ tests, style-token report, and production build all exit zero.

- [x] **Step 2: Run both Vitest shards independently and record wall time**

Run each of:

```bash
npm run frontend:test -- --shard=1/2
npm run frontend:test -- --shard=2/2
```

Expected: both pass and their combined file/test counts equal the full suite.

- [x] **Step 3: Run all three backend MySQL matrix commands against a disposable MySQL 8.4 container**

Run the exact family, core, and reporting pytest commands from the workflow with `CULINA_TEST_MYSQL_URL` pointed to the disposable database.

Expected: all three commands pass; the container is removed afterward.

- [x] **Step 4: Run static delivery checks**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors; only planned files are modified.

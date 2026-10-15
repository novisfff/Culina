"""Database selection and evidence for CI; ordinary local pytest stays unchanged."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import time

import pytest
from sqlalchemy.engine import make_url


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("culina-ci")
    group.addoption("--require-mysql", action="store_true", help="Fail if the selected CI suite lacks a test MySQL URL")
    group.addoption("--ci-strict-skips", action="store_true", help="Reject unexpected skips in a selected CI group")
    group.addoption("--ci-selection-report", help="Write collected/selected/deselected tests and skip reasons as JSON")


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "mysql: requires a disposable real MySQL database (including dependent fixtures)")
    config.addinivalue_line("markers", "mysql_reporting: representative-scale MySQL reporting suite")
    config._culina_ci_evidence = {"collected": [], "deselected": [], "selected": [], "mysql": [], "skipped": [], "results": {}}
    config._culina_ci_started = time.monotonic()
    if config.getoption("--require-mysql") and not config.option.collectonly:
        value = os.getenv("CULINA_TEST_MYSQL_URL", "").strip()
        if not value:
            _write_environment_failure(config, "missing_mysql_url")
            raise pytest.UsageError("selected MySQL suite requires CULINA_TEST_MYSQL_URL")
        try:
            url = make_url(value)
            safe = url.get_backend_name() == "mysql" and (url.database or "").endswith("_test")
        except Exception:
            safe = False
        if not safe:
            _write_environment_failure(config, "unsafe_mysql_url")
            raise pytest.UsageError("CI MySQL URL must use mysql and a database name ending with _test")


def _write_environment_failure(config: pytest.Config, reason: str) -> None:
    value = config.getoption("--ci-selection-report")
    if value:
        path = Path(value)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"environment_status": reason, "exit_code": int(pytest.ExitCode.USAGE_ERROR)}), encoding="utf-8")


def _module_requires_mysql(module_name: str) -> bool:
    module = sys.modules.get(module_name)
    marks = getattr(module, "pytestmark", [])
    if not isinstance(marks, (tuple, list)):
        marks = [marks]
    return any(getattr(mark, "name", None) == "mysql" for mark in marks)


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    # Fixture closures include fixtures imported from another test module. Their
    # database requirement must follow the fixture, not the consumer filename.
    for item in items:
        fixture_info = getattr(item, "_fixtureinfo", None)
        definitions = getattr(fixture_info, "name2fixturedefs", {})
        if any(
            _module_requires_mysql(definition.func.__module__)
            for choices in definitions.values()
            for definition in choices or ()
        ):
            item.add_marker(pytest.mark.mysql)
        if item.get_closest_marker("model_usage_reference"):
            item.add_marker(pytest.mark.mysql)
    config._culina_ci_evidence["collected"] = [item.nodeid for item in items]
    config._culina_ci_evidence["mysql"] = [item.nodeid for item in items if item.get_closest_marker("mysql")]


def pytest_deselected(items: list[pytest.Item]) -> None:
    for item in items:
        item.config._culina_ci_evidence["deselected"].append(item.nodeid)


def pytest_collection_finish(session: pytest.Session) -> None:
    session.config._culina_ci_evidence["selected"] = [item.nodeid for item in session.items]


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo):
    outcome = yield
    report = outcome.get_result()
    evidence = item.config._culina_ci_evidence
    if report.skipped:
        expected = bool(item.get_closest_marker("model_usage_reference")) and not os.getenv("MODEL_USAGE_REFERENCE_PROFILE")
        evidence["skipped"].append({
            "nodeid": item.nodeid,
            "reason": str(report.longrepr),
            "expected": expected,
        })
        if (item.config.getoption("--ci-strict-skips") or item.config.getoption("--require-mysql")) and not expected:
            report.outcome = "failed"
            report.longrepr = f"Selected CI test skipped unexpectedly: {report.longrepr}"
    result = evidence["results"].setdefault(item.nodeid, {"phases": {}, "outcome": "passed"})
    result["phases"][report.when] = {"outcome": report.outcome, "duration_seconds": report.duration}
    if report.failed or (report.skipped and result["outcome"] != "failed"):
        result["outcome"] = report.outcome


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    value = session.config.getoption("--ci-selection-report")
    if value:
        path = Path(value)
        path.parent.mkdir(parents=True, exist_ok=True)
        evidence = {**session.config._culina_ci_evidence, "exit_code": int(exitstatus), "duration_seconds": time.monotonic() - session.config._culina_ci_started}
        evidence["counts"] = {name: len(evidence[name]) for name in ("collected", "deselected", "selected", "mysql", "skipped", "results")}
        evidence["counts"]["expected_skips"] = sum(item["expected"] for item in evidence["skipped"])
        evidence["counts"]["executed"] = sum("call" in item["phases"] for item in evidence["results"].values())
        path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        summary = os.getenv("GITHUB_STEP_SUMMARY")
        if summary:
            counts = evidence["counts"]
            slow = sorted(
                ((nodeid, phase, data["duration_seconds"]) for nodeid, result in evidence["results"].items() for phase, data in result["phases"].items()),
                key=lambda item: item[2], reverse=True,
            )[:10]
            with Path(summary).open("a", encoding="utf-8") as output:
                output.write(f"\n### pytest: {path.stem}\n\n收集 {counts['collected']}，选中 {counts['selected']}，排除 {counts['deselected']}，执行 {counts['executed']}，跳过 {counts['skipped']}（预期 {counts['expected_skips']}）。退出码：{exitstatus}。\n\n")
                output.write("| 用例 | 阶段 | 秒 |\n| --- | --- | --- |\n")
                output.writelines(f"| `{nodeid}` | {phase} | {seconds:.3f} |\n" for nodeid, phase, seconds in slow)

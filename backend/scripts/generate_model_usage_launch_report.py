from __future__ import annotations

"""Generate a factual, content-free first-launch gate report.

The report is deliberately fail-closed.  It summarizes only fixed evidence
fields and hashes; prompt/response/media data from operator artifacts is never
copied into the report.  Missing or insufficient evidence always produces a
blocked report and a non-zero exit status.
"""

import argparse
import hashlib
import json
import math
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = BACKEND_ROOT.parent
sys.path.insert(0, str(BACKEND_ROOT))

from app.core.config import get_settings
from app.services.model_usage.preflight import run_first_launch_preflight
from app.services.model_usage.provider_registry import provider_usage_registrations
from scripts.check_model_usage_adapter_coverage import build_coverage_report


REPORT_SCHEMA_VERSION = "model_usage_first_launch_report.v2"
_SMOKE_SCHEMA_VERSION = "model_usage_provider_smoke.v1"
_PERFORMANCE_SCHEMA_VERSION = "model_usage_reference_performance.v1"
_VERIFICATION_SCHEMA_VERSION = "model_usage_launch_verification.v1"
_REFERENCE_PROFILE = "culina-first-launch-mysql84-v1"
_EXPECTED_CAPABILITIES = (
    "llm",
    "embedding",
    "rerank",
    "stt",
    "tts",
    "realtime_audio",
    "image_generation",
)
_EXPECTED_VIEWPORTS = (
    "360x800",
    "375x812",
    "390x844",
    "430x932",
    "768x1024",
    "1024x768",
    "1440x900",
)
_VISUAL_REVIEW_DOCUMENT_KEYS = frozenset(
    {"schemaVersion", "status", "viewports", "unresolvedP0P1", "checks", "notes"}
)
_VISUAL_REVIEW_CHECK_KEYS = frozenset(
    {
        "keyboard",
        "reducedMotion",
        "textZoom200",
        "noHorizontalOverflow",
        "screenReaderLabels",
        "voiceOver",
        "safeArea",
        "offlineRestore",
        "longModelNames",
    }
)
_PERFORMANCE_DOCUMENT_KEYS = frozenset({"schemaVersion", "exitCode", "payload"})
_PERFORMANCE_PAYLOAD_KEYS = frozenset(
    {
        "profile",
        "status",
        "sampleCount",
        "reserveP95Ms",
        "settleP95Ms",
        "currentOverviewP95Ms",
        "currentBreakdownP95Ms",
        "historicalRollupP95Ms",
        "hasFullTableScan",
        "currentAggregateQueryCount",
        "currentBreakdownQueryCount",
        "historicalRollupQueryCount",
    }
)
_VERIFICATION_ENVIRONMENT_KEYS = (
    "architecture",
    "browser",
    "containerRuntime",
    "database",
    "node",
    "os",
    "profile",
    "python",
    "runner",
)
_SAFE_VERSION = re.compile(r"^v?(\d+)(?:\.(\d+))?(?:\.\d+)?$")
_SAFE_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_SAFE_EVENT_ID = re.compile(r"^usage-event-[a-z0-9]+$")
_SMOKE_DOCUMENT_KEYS = frozenset(
    {"schemaVersion", "generatedAt", "status", "executionMode", "blockers", "capabilities"}
)
_SMOKE_PASSED_CAPABILITY_KEYS = frozenset(
    {"capability", "status", "eventId"}
)
_VERIFICATION_DOCUMENT_KEYS = frozenset({"schemaVersion", "commands"})
_VERIFICATION_COMMAND_ROW_KEYS = frozenset(
    {"commit", "environment", "exitCode", "assertions"}
)
_REQUIRED_VERIFICATION_COMMANDS = (
    (
        "focusedModelUsageTests",
        "focused_model_usage_tests",
        "pytest tests/model_usage -q",
        frozenset({"focusedSuitePassed"}),
    ),
    (
        "backendQuality",
        "backend_quality",
        "npm run backend:quality",
        frozenset({"compileCheckPassed", "pytestSuitePassed"}),
    ),
    (
        "frontendQuality",
        "frontend_quality",
        "npm run frontend:quality",
        frozenset({"styleTokenScanCompleted", "typecheckPassed", "vitestPassed"}),
    ),
    (
        "frontendBuild",
        "frontend_build",
        "npm run frontend:build",
        frozenset({"productionBuildPassed"}),
    ),
    (
        "frontendStyleTokens",
        "frontend_style_tokens",
        "npm --prefix frontend run check:style-tokens",
        frozenset({"newViolationsAbsentOrAccepted", "reportReviewed"}),
    ),
    (
        "frontendSmoke",
        "frontend_smoke",
        "npm run frontend:smoke",
        frozenset({"modelUsageSmokePassed"}),
    ),
    (
        "frontendE2EP0",
        "frontend_e2e_p0",
        "npm run frontend:e2e:p0",
        frozenset({"p0JourneysPassed", "targetViewportsCovered"}),
    ),
    (
        "dockerBuild",
        "docker_build",
        "docker compose -f deploy/docker-compose.yml build backend frontend",
        frozenset({"backendImageBuilt", "frontendImageBuilt"}),
    ),
    (
        "mysqlMigrationConcurrency",
        "mysql_migration_concurrency",
        "model-usage MySQL migration/concurrency/query-plan suite",
        frozenset({"concurrencyPassed", "migrationPassed", "queryPlansPassed"}),
    ),
    (
        "dispatchPolicyInterleaving",
        "dispatch_policy_interleaving",
        "dispatch-policy MySQL interleaving suite",
        frozenset({"interleavingPassed"}),
    ),
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _git_commit() -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    commit = result.stdout.strip()
    return commit if commit else None


def _read_json(path: Path | None) -> tuple[dict[str, Any] | None, str | None]:
    if path is None or not path.is_file():
        return None, None
    try:
        raw = path.read_bytes()
        decoded = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None, None
    if not isinstance(decoded, dict):
        return None, None
    return decoded, hashlib.sha256(raw).hexdigest()


def _safe_verification_environment(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) - set(_VERIFICATION_ENVIRONMENT_KEYS):
        return {}
    environment: dict[str, str] = {}
    for key in _VERIFICATION_ENVIRONMENT_KEYS:
        item = value.get(key)
        if item is None:
            continue
        if not isinstance(item, str) or not item or len(item) > 160:
            return {}
        summary = _safe_verification_environment_value(key, item)
        if summary is None:
            return {}
        environment[key] = summary
    return environment


def _safe_verification_environment_value(key: str, value: str) -> str | None:
    """Return a fixed public category, never an operator-provided value."""

    normalized = value.strip().lower()
    if key == "architecture":
        if normalized in {"arm64", "aarch64"}:
            return "arm64"
        if normalized in {"x64", "x86_64", "amd64"}:
            return "x64"
        return None
    if key == "browser":
        for browser in ("chromium", "firefox", "webkit"):
            if normalized.startswith(browser):
                return browser
        return "none" if normalized == "none" else None
    if key == "containerRuntime":
        for runtime in ("docker", "podman"):
            if normalized.startswith(runtime):
                return runtime
        return "none" if normalized == "none" else None
    if key == "database":
        if normalized.startswith("mysql"):
            return "mysql"
        if normalized.startswith("sqlite"):
            return "sqlite"
        return None
    if key in {"node", "python"}:
        match = _SAFE_VERSION.fullmatch(normalized)
        if match is None:
            return None
        major, minor = match.groups()
        if key == "python" and major != "3":
            return None
        return f"{major}.{minor}" if minor is not None else major
    if key == "os":
        for operating_system in ("ubuntu", "macos", "darwin", "windows", "linux"):
            if normalized.startswith(operating_system):
                return "macos" if operating_system == "darwin" else operating_system
        return None
    if key == "profile":
        return _REFERENCE_PROFILE if normalized == _REFERENCE_PROFILE else None
    if key == "runner":
        if normalized.startswith("github-actions"):
            return "github-actions"
        return "local" if normalized == "local" else None
    return None


def _required_verification_evidence(
    path: Path,
    *,
    expected_commit: str | None,
) -> tuple[dict[str, object], list[str]]:
    document, digest = _read_json(path)
    if document is None:
        return (
            {"status": "not_run", "sha256": None, "commands": {}},
            ["required_verification_evidence_not_run"],
        )
    commands = document.get("commands")
    command_ids = {
        command_id
        for command_id, _blocker_prefix, _canonical_command, _required_assertions in _REQUIRED_VERIFICATION_COMMANDS
    }
    if (
        set(document) != _VERIFICATION_DOCUMENT_KEYS
        or document.get("schemaVersion") != _VERIFICATION_SCHEMA_VERSION
        or not isinstance(commands, dict)
        or bool(set(commands) - command_ids)
    ):
        return (
            {"status": "blocked", "sha256": digest, "commands": {}},
            ["required_verification_evidence_invalid"],
        )

    evidence_commands: dict[str, object] = {}
    blockers: list[str] = []
    for (
        command_id,
        blocker_prefix,
        canonical_command,
        required_assertions,
    ) in _REQUIRED_VERIFICATION_COMMANDS:
        row = commands.get(command_id)
        if not isinstance(row, dict):
            evidence_commands[command_id] = {
                "command": canonical_command,
                "status": "not_run",
                "commit": None,
                "environment": {},
                "exitCode": None,
            }
            blockers.append(f"required_verification_{blocker_prefix}_not_run")
            continue

        if set(row) != _VERIFICATION_COMMAND_ROW_KEYS:
            evidence_commands[command_id] = {
                "command": canonical_command,
                "status": "blocked",
                "commit": None,
                "environment": {},
                "exitCode": None,
            }
            blockers.append(f"required_verification_{blocker_prefix}_schema_invalid")
            continue

        raw_commit = row.get("commit")
        commit = (
            raw_commit
            if isinstance(raw_commit, str) and _SAFE_COMMIT.fullmatch(raw_commit)
            else None
        )
        environment = _safe_verification_environment(row.get("environment"))
        exit_code = row.get("exitCode") if type(row.get("exitCode")) is int else None
        assertions = row.get("assertions")
        assertions_passed = (
            isinstance(assertions, dict)
            and set(assertions) == required_assertions
            and all(value is True for value in assertions.values())
        )
        status = "passed"
        if expected_commit is None or commit != expected_commit:
            status = "blocked"
            blockers.append(f"required_verification_{blocker_prefix}_commit_mismatch")
        elif not environment:
            status = "blocked"
            blockers.append(f"required_verification_{blocker_prefix}_environment_missing")
        elif exit_code != 0:
            status = "blocked"
            blockers.append(f"required_verification_{blocker_prefix}_failed")
        elif not assertions_passed:
            status = "blocked"
            blockers.append(f"required_verification_{blocker_prefix}_assertions_not_passed")
        evidence_commands[command_id] = {
            "command": canonical_command,
            "status": status,
            "commit": commit,
            "environment": environment,
            "exitCode": exit_code,
        }
    return (
        {
            "status": "passed" if not blockers else "blocked",
            "sha256": digest,
            "commands": evidence_commands,
        },
        blockers,
    )


def _command_payload(document: dict[str, Any] | None) -> tuple[dict[str, Any] | None, int | None]:
    if document is None:
        return None, None
    exit_code = document.get("exitCode")
    if type(exit_code) is not int:
        exit_code = None
    payload = document.get("payload", document)
    return (payload if isinstance(payload, dict) else None), exit_code


def _provider_smoke_evidence(path: Path) -> tuple[dict[str, object], str | None]:
    document, digest = _read_json(path)
    if document is None:
        return {"status": "not_run", "sha256": None}, "provider_smoke_not_run"
    capability_rows = document.get("capabilities")
    by_capability = (
        {
            item.get("capability"): item
            for item in capability_rows
            if isinstance(item, dict) and isinstance(item.get("capability"), str)
        }
        if isinstance(capability_rows, list)
        else {}
    )
    generated_at = document.get("generatedAt")
    passed = (
        set(document) == _SMOKE_DOCUMENT_KEYS
        and document.get("schemaVersion") == _SMOKE_SCHEMA_VERSION
        and isinstance(generated_at, str)
        and 1 <= len(generated_at) <= 40
        and generated_at.endswith("Z")
        and document.get("status") == "passed"
        and document.get("executionMode") == "real_provider"
        and document.get("blockers") == []
        and isinstance(capability_rows, list)
        and len(capability_rows) == len(_EXPECTED_CAPABILITIES)
        and set(by_capability) == set(_EXPECTED_CAPABILITIES)
        and all(
            set(by_capability[item]) == _SMOKE_PASSED_CAPABILITY_KEYS
            and by_capability[item].get("status") == "passed"
            and isinstance(by_capability[item].get("eventId"), str)
            and _SAFE_EVENT_ID.fullmatch(by_capability[item]["eventId"])
            for item in _EXPECTED_CAPABILITIES
        )
    )
    return (
        {
            "status": "passed" if passed else "blocked",
            "sha256": digest,
            "capabilityCount": len(by_capability),
            "executionMode": (
                document.get("executionMode")
                if document.get("executionMode") in {"not_run", "real_provider"}
                else "unknown"
            ),
        },
        None if passed else "provider_smoke_not_passed",
    )


def _audit_evidence(path: Path) -> tuple[dict[str, object], list[str]]:
    document, digest = _read_json(path)
    payload, exit_code = _command_payload(document)
    if payload is None:
        return {"status": "not_run", "sha256": None, "exitCode": None}, ["counter_audit_not_run"]
    healthy = payload.get("healthy") is True
    passed = healthy and exit_code == 0
    blockers: list[str] = []
    if not healthy:
        blockers.append("counter_audit_not_healthy")
    if exit_code is None:
        blockers.append("counter_audit_exit_code_missing")
    elif exit_code != 0:
        blockers.append("counter_audit_command_failed")
    return (
        {
            "status": "passed" if passed else "blocked",
            "sha256": digest,
            "exitCode": exit_code,
            "healthy": healthy,
        },
        blockers,
    )


def _rollup_evidence(path: Path) -> tuple[dict[str, object], list[str]]:
    document, digest = _read_json(path)
    payload, exit_code = _command_payload(document)
    if payload is None:
        return {"status": "not_run", "sha256": None, "exitCode": None}, ["rollup_not_run"]
    completed = type(payload.get("revision")) is int and type(payload.get("rows")) is int
    passed = completed and exit_code == 0
    blockers: list[str] = []
    if not completed:
        blockers.append("rollup_artifact_invalid")
    if exit_code is None:
        blockers.append("rollup_exit_code_missing")
    elif exit_code != 0:
        blockers.append("rollup_command_failed")
    return (
        {
            "status": "passed" if passed else "blocked",
            "sha256": digest,
            "exitCode": exit_code,
            "revision": payload.get("revision") if type(payload.get("revision")) is int else None,
            "rows": payload.get("rows") if type(payload.get("rows")) is int else None,
        },
        blockers,
    )


def _health_evidence(path: Path) -> tuple[dict[str, object], list[str]]:
    document, digest = _read_json(path)
    payload, exit_code = _command_payload(document)
    if payload is None:
        return {"status": "not_run", "sha256": None, "exitCode": None}, ["health_not_run"]
    healthy = payload.get("healthy") is True
    passed = healthy and exit_code == 0
    blockers: list[str] = []
    if not healthy:
        blockers.append("health_not_healthy")
    if exit_code is None:
        blockers.append("health_exit_code_missing")
    elif exit_code != 0:
        blockers.append("health_command_failed")
    return (
        {
            "status": "passed" if passed else "blocked",
            "sha256": digest,
            "exitCode": exit_code,
            "healthy": healthy,
        },
        blockers,
    )


def _performance_evidence(path: Path | None) -> tuple[dict[str, object], str | None]:
    document, digest = _read_json(path)
    payload, exit_code = _command_payload(document)
    if payload is None:
        return {"status": "not_run", "sha256": None, "exitCode": None}, "reference_performance_not_run"
    targets = {
        "reserveP95Ms": 150,
        "settleP95Ms": 150,
        "currentOverviewP95Ms": 300,
        "currentBreakdownP95Ms": 1000,
        "historicalRollupP95Ms": 500,
    }
    query_targets = {
        "currentAggregateQueryCount": 11,
        "currentBreakdownQueryCount": 6,
        "historicalRollupQueryCount": 3,
    }
    timings_valid = all(
        type(payload.get(field)) in {int, float}
        and math.isfinite(payload[field])
        and 0 <= payload[field] <= maximum
        for field, maximum in targets.items()
    )
    query_counts_valid = all(
        type(payload.get(field)) is int and 0 <= payload[field] <= maximum
        for field, maximum in query_targets.items()
    )
    passed = (
        document is not None
        and set(document) == _PERFORMANCE_DOCUMENT_KEYS
        and document.get("schemaVersion") == _PERFORMANCE_SCHEMA_VERSION
        and set(payload) == _PERFORMANCE_PAYLOAD_KEYS
        and payload.get("profile") == _REFERENCE_PROFILE
        and payload.get("status") == "passed"
        and payload.get("sampleCount") == 20
        and payload.get("hasFullTableScan") is False
        and timings_valid
        and query_counts_valid
        and exit_code == 0
    )
    return (
        {
            "status": "passed" if passed else "blocked",
            "sha256": digest,
            "exitCode": exit_code,
            "profile": payload.get("profile") if payload.get("profile") == _REFERENCE_PROFILE else None,
            "sampleCount": payload.get("sampleCount") if type(payload.get("sampleCount")) is int else None,
            **{
                field: payload.get(field)
                if type(payload.get(field)) in {int, float} and math.isfinite(payload[field])
                else None
                for field in targets
            },
            "hasFullTableScan": payload.get("hasFullTableScan")
            if type(payload.get("hasFullTableScan")) is bool
            else None,
            **{
                field: payload.get(field) if type(payload.get(field)) is int else None
                for field in query_targets
            },
        },
        None if passed else "reference_performance_not_passed",
    )


def _visual_review_evidence(path: Path) -> tuple[dict[str, object], list[str]]:
    document, digest = _read_json(path / "review.json")
    if document is None:
        return {"status": "not_run", "sha256": None, "viewports": []}, ["visual_review_not_run"]
    viewports = document.get("viewports")
    observed_viewports = tuple(item for item in viewports if isinstance(item, str)) if isinstance(viewports, list) else ()
    checks = document.get("checks") if isinstance(document.get("checks"), dict) else {}
    notes = document.get("notes")
    notes_valid = (
        isinstance(notes, list)
        and len(notes) <= 20
        and all(isinstance(item, str) and len(item) <= 200 for item in notes)
    )
    passed = (
        set(document) == _VISUAL_REVIEW_DOCUMENT_KEYS
        and document.get("schemaVersion") == "model_usage_visual_review.v1"
        and document.get("status") == "passed"
        and len(observed_viewports) == len(_EXPECTED_VIEWPORTS)
        and set(observed_viewports) == set(_EXPECTED_VIEWPORTS)
        and type(document.get("unresolvedP0P1")) is int
        and document.get("unresolvedP0P1") == 0
        and set(checks) == _VISUAL_REVIEW_CHECK_KEYS
        and all(checks.get(name) is True for name in _VISUAL_REVIEW_CHECK_KEYS)
        and notes_valid
    )
    return (
        {
            "status": "passed" if passed else "blocked",
            "sha256": digest,
            "viewports": sorted(set(observed_viewports) & set(_EXPECTED_VIEWPORTS)),
            "unresolvedP0P1": (
                document.get("unresolvedP0P1")
                if type(document.get("unresolvedP0P1")) is int
                else None
            ),
        },
        [] if passed else ["visual_review_not_passed"],
    )


def _send_coverage_evidence() -> tuple[dict[str, object], str | None]:
    try:
        coverage = build_coverage_report()
    except Exception:
        return {"status": "unavailable", "exitCode": 1}, "provider_send_coverage_unavailable"
    passed = coverage.get("status") == "covered"
    return (
        {
            "status": "covered" if passed else "blocked",
            "exitCode": 0 if passed else 1,
            "modelProviderSendPointCount": len(coverage.get("model_provider_send_points", [])),
            "nonModelRemoteSendPointCount": len(coverage.get("non_model_remote_send_points", [])),
        },
        None if passed else "provider_send_coverage_not_passed",
    )


def _preflight_evidence() -> tuple[dict[str, object], list[dict[str, str]], list[str]]:
    try:
        settings = get_settings()
        report = run_first_launch_preflight(settings)
        registrations = provider_usage_registrations(settings)
    except Exception:
        return (
            {"ready": False, "blockers": ["first_launch_preflight_unavailable"]},
            [],
            ["first_launch_preflight_unavailable"],
        )
    variants = [
        {
            "capability": registration.capability.value,
            "provider": registration.provider,
            "billingModel": registration.billing_model,
            "variantKey": registration.variant_key,
            "recoveryMode": registration.recovery_policy.mode.value,
        }
        for registration in sorted(
            registrations,
            key=lambda item: (
                item.capability.value,
                item.provider,
                item.billing_model,
                item.variant_key,
            ),
        )
    ]
    evidence = report.as_dict()
    blockers = [str(item) for item in evidence.get("blockers", []) if isinstance(item, str)]
    return evidence, variants, blockers


def build_launch_report(
    *,
    provider_smoke: Path,
    audit: Path,
    rollup: Path,
    health: Path,
    visual_review: Path,
    performance: Path | None,
    verification_evidence: Path,
) -> dict[str, object]:
    git_commit = _git_commit()
    smoke, smoke_blocker = _provider_smoke_evidence(provider_smoke)
    audit_evidence, audit_blockers = _audit_evidence(audit)
    rollup_evidence, rollup_blockers = _rollup_evidence(rollup)
    health_evidence, health_blockers = _health_evidence(health)
    performance_evidence, performance_blocker = _performance_evidence(performance)
    visual_evidence, visual_blockers = _visual_review_evidence(visual_review)
    send_coverage, send_coverage_blocker = _send_coverage_evidence()
    preflight, variants, preflight_blockers = _preflight_evidence()
    required_verification, required_verification_blockers = _required_verification_evidence(
        verification_evidence,
        expected_commit=git_commit,
    )

    blockers = [
        *([smoke_blocker] if smoke_blocker else []),
        *audit_blockers,
        *rollup_blockers,
        *health_blockers,
        *([performance_blocker] if performance_blocker else []),
        *visual_blockers,
        *([send_coverage_blocker] if send_coverage_blocker else []),
        *preflight_blockers,
        *required_verification_blockers,
    ]
    unique_blockers = sorted(set(blockers))
    ready = not unique_blockers
    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "generatedAt": _now(),
        "gitCommit": git_commit,
        "readyForFirstOpen": ready,
        "status": "ready" if ready else "blocked",
        "blockers": unique_blockers,
        "evidence": {
            "providerSmoke": smoke,
            "counterAudit": audit_evidence,
            "rollup": rollup_evidence,
            "health": health_evidence,
            "referencePerformance": performance_evidence,
            "visualReview": visual_evidence,
            "providerSendCoverage": send_coverage,
            "firstLaunchPreflight": preflight,
            "requiredVerification": required_verification,
            "configuredVariants": variants,
        },
    }


def _render_report(report: dict[str, object]) -> str:
    ready = report["readyForFirstOpen"] is True
    blockers = report["blockers"]
    assert isinstance(blockers, list)
    lines = [
        "---",
        f"schema_version: {REPORT_SCHEMA_VERSION}",
        f"generated_at: {report['generatedAt']}",
        f"git_commit: {report['gitCommit'] or 'unavailable'}",
        f"ready_for_first_open: {'true' if ready else 'false'}",
        f"status: {report['status']}",
        "blockers:",
        *(f"  - {item}" for item in blockers),
        "---",
        "",
        "# 模型用量首发门禁报告",
        "",
        "本报告由 `generate_model_usage_launch_report.py` 自动生成。它只汇总机器读取的安全证据字段和哈希，不复制 Provider 请求、响应、媒体地址、凭据或用户内容。",
        "",
        "当前机器判定：`%s`。" % ("可开放" if ready else "blocked，不能首次对外开放"),
        "",
        "## 机器可读证据",
        "",
        "```json",
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True),
        "```",
        "",
    ]
    return "\n".join(lines)


def _write_report(output: Path, content: str, *, force: bool) -> None:
    if (output.exists() or output.is_symlink()) and not force:
        raise ValueError("launch_report_output_already_exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    try:
        temporary.write_text(content, encoding="utf-8")
        temporary.replace(output)
    finally:
        if temporary.exists():
            temporary.unlink()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate a fail-closed model-usage first-launch report")
    parser.add_argument("--provider-smoke", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--rollup", type=Path, required=True)
    parser.add_argument("--health", type=Path, required=True)
    parser.add_argument("--visual-review", type=Path, required=True)
    parser.add_argument("--performance", type=Path)
    parser.add_argument("--verification-evidence", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--force", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        report = build_launch_report(
            provider_smoke=args.provider_smoke,
            audit=args.audit,
            rollup=args.rollup,
            health=args.health,
            visual_review=args.visual_review,
            performance=args.performance,
            verification_evidence=args.verification_evidence,
        )
        _write_report(args.output, _render_report(report), force=args.force)
    except (OSError, ValueError):
        print("model_usage_launch_report_generation_failed", file=sys.stderr)
        return 2
    if report["readyForFirstOpen"] is True:
        print("model_usage_first_launch_ready")
        return 0
    print("model_usage_first_launch_blocked", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

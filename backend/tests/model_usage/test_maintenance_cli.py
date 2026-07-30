from __future__ import annotations

import json
from contextlib import nullcontext
from types import SimpleNamespace

from scripts.maintain_model_usage import build_parser, main


def test_cli_lists_all_required_commands() -> None:
    parser = build_parser()
    help_text = parser.format_help()
    for command in (
        "health",
        "reconcile",
        "audit",
        "rollup",
        "prune",
        "adjustment",
        "incident",
    ):
        assert command in help_text


def test_prune_modes_and_adjustment_subcommands_parse() -> None:
    parser = build_parser()
    prune = parser.parse_args(
        ["prune", "--family", "family-1", "--period", "2025-01", "--dry-run"]
    )
    assert prune.family_id == "family-1"
    assert prune.dry_run is True
    preview = parser.parse_args(["adjustment", "preview", "--file", "command.json"])
    apply = parser.parse_args(["adjustment", "apply", "--file", "command.json"])
    audit = parser.parse_args(["audit", "--verify-only", "--json"])
    rollup = parser.parse_args(
        ["rollup", "--family", "family-1", "--period", "2026-07", "--json"]
    )
    assert preview.adjustment_command == "preview"
    assert apply.adjustment_command == "apply"
    assert audit.verify_only is True
    assert audit.json is True
    assert rollup.json is True


def test_unhealthy_health_json_exits_nonzero(
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setattr(
        "scripts.maintain_model_usage._preflight_health_payload",
        lambda: (
            False,
            {
                "healthy": False,
                "priceCoverage": {"missing": ["tts"]},
            },
        ),
    )

    exit_code = main(["health", "--json"])

    assert exit_code == 2
    assert json.loads(capsys.readouterr().out) == {
        "exitCode": 2,
        "healthy": False,
        "priceCoverage": {"missing": ["tts"]},
    }


def test_health_json_remains_machine_readable_when_dependencies_are_unavailable(
    monkeypatch,
    capsys,
) -> None:
    class EmptySession:
        def __enter__(self):
            return self

        def __exit__(self, *_args) -> None:
            return None

        def scalar(self, _statement):
            return None

    def unavailable():
        raise RuntimeError("database unavailable")

    monkeypatch.setattr("scripts.maintain_model_usage.check_price_coverage_batch", unavailable)
    monkeypatch.setattr("scripts.maintain_model_usage.SessionLocal", EmptySession)

    exit_code = main(["health", "--json"])

    payload = json.loads(capsys.readouterr().out)
    assert exit_code == 2
    assert payload["exitCode"] == 2
    assert payload["healthy"] is False
    assert payload["priceCoverage"]["error"] == "unavailable"


def test_audit_json_includes_exit_code_for_launch_report_artifacts(
    monkeypatch,
    capsys,
) -> None:
    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args) -> None:
            return None

        def begin(self):
            return nullcontext()

    monkeypatch.setattr("scripts.maintain_model_usage.SessionLocal", FakeSession)
    monkeypatch.setattr(
        "scripts.maintain_model_usage.audit_counters_batch",
        lambda *_args, **_kwargs: SimpleNamespace(healthy=True, reports=(), errors=()),
    )

    exit_code = main(["audit", "--verify-only", "--json"])

    assert exit_code == 0
    assert json.loads(capsys.readouterr().out) == {
        "errors": [],
        "exitCode": 0,
        "healthy": True,
        "repaired": 0,
        "reports": 0,
    }


def test_audit_verify_only_disables_persistent_verification_metadata(
    monkeypatch,
    capsys,
) -> None:
    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args) -> None:
            return None

        def begin(self):
            return nullcontext()

    captured: dict[str, object] = {}

    def audit(*_args, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(healthy=True, reports=(), errors=())

    monkeypatch.setattr("scripts.maintain_model_usage.SessionLocal", FakeSession)
    monkeypatch.setattr("scripts.maintain_model_usage.audit_counters_batch", audit)

    exit_code = main(["audit", "--verify-only", "--json"])

    assert exit_code == 0
    assert captured["repair"] is False
    assert captured["record_verification"] is False
    assert json.loads(capsys.readouterr().out)["exitCode"] == 0


def test_rollup_json_includes_exit_code_for_launch_report_artifacts(
    monkeypatch,
    capsys,
) -> None:
    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args) -> None:
            return None

        def begin(self):
            return nullcontext()

    monkeypatch.setattr("scripts.maintain_model_usage.SessionLocal", FakeSession)
    monkeypatch.setattr(
        "scripts.maintain_model_usage.rebuild_monthly_rollups",
        lambda *_args, **_kwargs: SimpleNamespace(revision=4, rows=(object(), object())),
    )

    exit_code = main(
        ["rollup", "--family", "family-model-usage-smoke", "--period", "2026-07", "--json"]
    )

    assert exit_code == 0
    assert json.loads(capsys.readouterr().out) == {
        "exitCode": 0,
        "revision": 4,
        "rows": 2,
    }

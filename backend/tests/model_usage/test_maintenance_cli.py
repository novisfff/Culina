from __future__ import annotations

import json

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
    assert preview.adjustment_command == "preview"
    assert apply.adjustment_command == "apply"


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
    assert payload["healthy"] is False
    assert payload["priceCoverage"]["error"] == "unavailable"

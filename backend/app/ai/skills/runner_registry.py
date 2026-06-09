from __future__ import annotations

from collections.abc import Callable
from importlib import import_module
from pathlib import Path

from app.ai.skills.base import BaseSkill, SkillManifest


SkillRunnerFactory = Callable[[SkillManifest, Path], BaseSkill]

_RUNNER_FACTORIES: dict[str, SkillRunnerFactory] = {}
_BUILTINS_REGISTERED = False


def register_skill_runner(name: str, factory: SkillRunnerFactory) -> None:
    key = name.strip()
    if not key:
        raise ValueError("Skill runner name cannot be empty")
    existing = _RUNNER_FACTORIES.get(key)
    if existing is not None and existing is not factory:
        raise ValueError(f"Duplicate skill runner registration: {key}")
    _RUNNER_FACTORIES[key] = factory


def get_skill_runner(name: str) -> SkillRunnerFactory:
    ensure_builtin_skill_runners_registered()
    try:
        return _RUNNER_FACTORIES[name]
    except KeyError as exc:
        available = ", ".join(sorted(_RUNNER_FACTORIES))
        raise ValueError(f"Unknown skill runner {name!r}; available runners: {available}") from exc


def list_skill_runners() -> list[str]:
    ensure_builtin_skill_runners_registered()
    return sorted(_RUNNER_FACTORIES)


def ensure_builtin_skill_runners_registered() -> None:
    global _BUILTINS_REGISTERED
    if _BUILTINS_REGISTERED:
        return
    # Imported for registration side effects. Individual runner modules own
    # their runner keys, so the central runtime is not a per-skill switchboard.
    import_module("app.ai.skills.document")
    import_module("app.ai.skills.markdown")
    _BUILTINS_REGISTERED = True

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
from typing import Iterable, Mapping, Sequence


BACKEND_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = BACKEND_ROOT / "ci-test-groups.json"
DEFAULT_TESTS_ROOT = BACKEND_ROOT / "tests"
DIRECTORY_NAME_PATTERN = re.compile(r"^[a-z0-9_]+$")


class CiTestGroupConfigurationError(ValueError):
    """Raised when the CI pytest partition is incomplete or ambiguous."""


def discover_test_directories(tests_root: Path) -> set[str]:
    if not tests_root.is_dir():
        raise CiTestGroupConfigurationError(f"tests directory does not exist: {tests_root}")
    return {
        child.name
        for child in tests_root.iterdir()
        if child.is_dir() and any(child.rglob("test_*.py"))
    }


def load_test_groups(manifest_path: Path) -> dict[str, tuple[str, ...]]:
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise CiTestGroupConfigurationError(f"CI test group manifest not found: {manifest_path}") from exc
    except json.JSONDecodeError as exc:
        raise CiTestGroupConfigurationError(f"CI test group manifest is not valid JSON: {exc}") from exc

    if not isinstance(raw, dict):
        raise CiTestGroupConfigurationError("CI test group manifest root must be an object")
    if raw.get("version") != 1:
        raise CiTestGroupConfigurationError("CI test group manifest version must be 1")
    raw_groups = raw.get("groups")
    if not isinstance(raw_groups, dict) or not raw_groups:
        raise CiTestGroupConfigurationError("CI test group manifest groups must be a non-empty object")

    groups: dict[str, tuple[str, ...]] = {}
    for group_name, directories in raw_groups.items():
        if not isinstance(group_name, str) or not DIRECTORY_NAME_PATTERN.fullmatch(group_name):
            raise CiTestGroupConfigurationError(f"invalid CI test group name: {group_name!r}")
        if not isinstance(directories, list) or not directories:
            raise CiTestGroupConfigurationError(
                f"CI test group {group_name} must contain a non-empty directory list"
            )
        if any(
            not isinstance(directory, str) or not DIRECTORY_NAME_PATTERN.fullmatch(directory)
            for directory in directories
        ):
            raise CiTestGroupConfigurationError(
                f"CI test group {group_name} contains an invalid test directory"
            )
        groups[group_name] = tuple(directories)
    return groups


def validate_test_groups(
    groups: Mapping[str, Sequence[str]],
    discovered_directories: Iterable[str],
) -> None:
    discovered = set(discovered_directories)
    assignments: dict[str, list[str]] = {}
    for group_name, directories in groups.items():
        for directory in directories:
            assignments.setdefault(directory, []).append(group_name)

    assigned = set(assignments)
    missing = sorted(discovered - assigned)
    unknown = sorted(assigned - discovered)
    duplicates = {
        directory: sorted(group_names)
        for directory, group_names in assignments.items()
        if len(group_names) > 1
    }

    errors: list[str] = []
    if missing:
        errors.append(f"missing assignments: {', '.join(missing)}")
    if duplicates:
        formatted = "; ".join(
            f"{directory} ({', '.join(group_names)})"
            for directory, group_names in sorted(duplicates.items())
        )
        errors.append(f"duplicate assignments: {formatted}")
    if unknown:
        errors.append(f"unknown assignments: {', '.join(unknown)}")
    if errors:
        raise CiTestGroupConfigurationError("; ".join(errors))


def build_pytest_command(
    group_name: str,
    groups: Mapping[str, Sequence[str]],
    pytest_arguments: Sequence[str],
    *,
    python_executable: str = sys.executable,
) -> list[str]:
    directories = groups.get(group_name)
    if directories is None:
        raise CiTestGroupConfigurationError(f"unknown CI test group: {group_name}")
    extra_arguments = list(pytest_arguments)
    if extra_arguments[:1] == ["--"]:
        extra_arguments = extra_arguments[1:]
    return [
        python_executable,
        "-m",
        "pytest",
        *(f"tests/{directory}" for directory in directories),
        *extra_arguments,
    ]


def parse_args(argv: Sequence[str] | None = None) -> tuple[argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(description="Validate and run a Culina backend CI pytest group.")
    parser.add_argument("group", nargs="?", help="Group name from ci-test-groups.json")
    parser.add_argument("--check", action="store_true", help="Validate coverage without running pytest")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    return parser.parse_known_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args, pytest_arguments = parse_args(argv)
    try:
        groups = load_test_groups(args.manifest)
        discovered = discover_test_directories(DEFAULT_TESTS_ROOT)
        validate_test_groups(groups, discovered)
        if args.check:
            print(
                f"CI backend test groups cover {len(discovered)} directories "
                f"across {len(groups)} groups."
            )
            return 0
        if not args.group:
            raise CiTestGroupConfigurationError("a CI test group is required unless --check is used")
        command = build_pytest_command(args.group, groups, pytest_arguments)
    except CiTestGroupConfigurationError as exc:
        print(f"CI test group configuration error: {exc}", file=sys.stderr)
        return 2

    os.execv(command[0], command)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

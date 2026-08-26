from __future__ import annotations

from pathlib import Path

import pytest

from scripts.check_alembic_migrations import (
    MigrationSmokeError,
    assert_database_heads_match,
    assert_safe_smoke_database_url,
    assert_single_declared_head,
    load_declared_heads,
)


BACKEND_ROOT = Path(__file__).resolve().parents[2]


def test_repository_has_exactly_one_alembic_head() -> None:
    heads = load_declared_heads(BACKEND_ROOT)

    assert assert_single_declared_head(heads) == "7c8d9e0f1a2b"


@pytest.mark.parametrize("heads", [(), ("head-a", "head-b")])
def test_single_head_check_rejects_zero_or_multiple_heads(heads: tuple[str, ...]) -> None:
    with pytest.raises(MigrationSmokeError, match="exactly one Alembic head"):
        assert_single_declared_head(heads)


def test_database_revision_must_equal_the_declared_head() -> None:
    assert_database_heads_match(("head-a",), "head-a")

    with pytest.raises(MigrationSmokeError, match="database heads .* do not match"):
        assert_database_heads_match(("head-old",), "head-a")


@pytest.mark.parametrize(
    "database_url",
    [
        "mysql+pymysql://root:root@127.0.0.1/culina_migration_smoke",
        "mysql+pymysql://root:root@127.0.0.1/culina_ci_test",
    ],
)
def test_migration_smoke_accepts_disposable_database_names(database_url: str) -> None:
    assert_safe_smoke_database_url(database_url)


def test_migration_smoke_rejects_non_disposable_database_name() -> None:
    with pytest.raises(MigrationSmokeError, match="must end with _smoke or _test"):
        assert_safe_smoke_database_url("mysql+pymysql://root:root@127.0.0.1/culina")

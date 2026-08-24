from __future__ import annotations

from pathlib import Path
import sys
from typing import Sequence

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from app.core.config import get_settings


BACKEND_ROOT = Path(__file__).resolve().parents[1]


class MigrationSmokeError(RuntimeError):
    """Raised when the Alembic graph or migrated database is not smoke-safe."""


def build_alembic_config(backend_root: Path = BACKEND_ROOT) -> Config:
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "alembic"))
    return config


def load_declared_heads(backend_root: Path = BACKEND_ROOT) -> tuple[str, ...]:
    script = ScriptDirectory.from_config(build_alembic_config(backend_root))
    return tuple(script.get_heads())


def assert_single_declared_head(heads: Sequence[str]) -> str:
    if len(heads) != 1:
        rendered = ", ".join(heads) if heads else "none"
        raise MigrationSmokeError(
            f"expected exactly one Alembic head, found {len(heads)}: {rendered}"
        )
    return heads[0]


def assert_safe_smoke_database_url(database_url: str) -> None:
    database = make_url(database_url).database or ""
    if not database.endswith(("_smoke", "_test")):
        raise MigrationSmokeError(
            "migration smoke database name must end with _smoke or _test"
        )


def read_database_heads(database_url: str) -> tuple[str, ...]:
    engine = create_engine(database_url, pool_pre_ping=True, future=True)
    try:
        with engine.connect() as connection:
            context = MigrationContext.configure(connection)
            return tuple(context.get_current_heads())
    finally:
        engine.dispose()


def assert_database_heads_match(database_heads: Sequence[str], declared_head: str) -> None:
    if tuple(database_heads) != (declared_head,):
        rendered = ", ".join(database_heads) if database_heads else "none"
        raise MigrationSmokeError(
            f"database heads ({rendered}) do not match declared head ({declared_head})"
        )


def run_migration_smoke() -> str:
    database_url = get_settings().database_url
    assert_safe_smoke_database_url(database_url)
    declared_head = assert_single_declared_head(load_declared_heads())
    config = build_alembic_config()

    command.upgrade(config, "head")
    command.upgrade(config, "head")
    database_heads = read_database_heads(database_url)
    assert_database_heads_match(database_heads, declared_head)
    return declared_head


def main() -> int:
    try:
        head = run_migration_smoke()
    except (MigrationSmokeError, OSError, RuntimeError) as exc:
        print(f"Alembic migration smoke failed: {exc}", file=sys.stderr)
        return 1
    print(f"Alembic migration smoke passed at head {head}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

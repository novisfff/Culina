from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType


MIGRATION_PATH = (
    Path(__file__).resolve().parents[2]
    / "alembic"
    / "versions"
    / "0b1c2d3e4f5a_remove_recipe_favorites.py"
)


def _load_migration_module() -> ModuleType:
    spec = spec_from_file_location("remove_recipe_favorites_migration", MIGRATION_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_upgrade_drops_recipe_favorites_without_dropping_fk_indexes(monkeypatch) -> None:
    migration = _load_migration_module()
    dropped_indexes: list[tuple[str, str | None]] = []
    dropped_tables: list[str] = []

    monkeypatch.setattr(migration.op, "execute", lambda _statement: None)
    monkeypatch.setattr(
        migration.op,
        "drop_index",
        lambda name, table_name=None: dropped_indexes.append((name, table_name)),
    )
    monkeypatch.setattr(migration.op, "drop_table", dropped_tables.append)

    migration.upgrade()

    assert dropped_indexes == []
    assert dropped_tables == ["recipe_favorites"]

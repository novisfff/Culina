from __future__ import annotations

from collections.abc import Iterator

import pytest

from tests.model_usage.test_migration_mysql import (
    MySqlAlembicDatabase,
    require_model_usage_mysql_url,
)


@pytest.fixture()
def mysql_alembic_database() -> Iterator[MySqlAlembicDatabase]:
    database = MySqlAlembicDatabase.from_test_url(require_model_usage_mysql_url())
    database.recreate()
    try:
        yield database
    finally:
        database.dispose()


def test_family_model_migration_keeps_families_unconfigured(
    mysql_alembic_database: MySqlAlembicDatabase,
) -> None:
    database = mysql_alembic_database
    database.upgrade("5f6a7b8c9d0e")
    database.seed_existing_families()

    database.upgrade("6a7b8c9d0e1f")

    assert database.rows(
        """
        SELECT active_config_revision_id, active_price_version_id, active_search_profile_id
        FROM family_model_settings
        ORDER BY family_id
        """
    ) == [(None, None, None), (None, None, None)]
    assert database.scalar(
        "SELECT purpose FROM model_usage_price_versions ORDER BY id LIMIT 1"
    ) in {None, "legacy_global"}
    for revision_id, family_id in (
        ("family-model-revision-a", "family-a"),
        ("family-model-revision-b", "family-b"),
    ):
        database.execute(
            """
            INSERT INTO family_model_config_revisions (
                id, family_id, version_number, config_checksum, status,
                change_note, published_at
            ) VALUES (
                :revision_id, :family_id, 1, 'same-checksum', 'published',
                '', UTC_TIMESTAMP()
            )
            """,
            {"revision_id": revision_id, "family_id": family_id},
        )
    assert database.scalar(
        "SELECT COUNT(*) FROM family_model_config_revisions "
        "WHERE config_checksum = 'same-checksum'"
    ) == 2
    assert database.current_revision() == "6a7b8c9d0e1f"

    database.downgrade("5f6a7b8c9d0e")
    database.upgrade("6a7b8c9d0e1f")
    assert database.current_revision() == "6a7b8c9d0e1f"

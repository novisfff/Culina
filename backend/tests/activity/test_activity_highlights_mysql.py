from __future__ import annotations

import os
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.core.enums import ActivityAction, ActivityHighlightKind
from app.models.domain import ActivityLog, Family
from app.services.activity_highlights import list_activity_highlights


def _mysql_test_url() -> str:
    value = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not value:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    database = make_url(value).database or ""
    if not database.endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return value


def test_mysql_shanghai_week_boundary_matches_naive_utc_contract() -> None:
    engine = create_engine(_mysql_test_url(), future=True)
    connection = engine.connect()
    transaction = connection.begin()
    db = Session(bind=connection, expire_on_commit=False)
    try:
        db.add(Family(id="family-highlight-mysql", name="MySQL 高亮家庭", motto="", location=""))
        for activity_id, created_at in [
            ("activity-before-week", datetime(2026, 7, 12, 15, 59, 59)),
            ("activity-week-start", datetime(2026, 7, 12, 16, 0, 0)),
            ("activity-future", datetime(2026, 7, 12, 16, 31, 0)),
        ]:
            db.add(
                ActivityLog(
                    id=activity_id,
                    family_id="family-highlight-mysql",
                    actor_id="missing-member",
                    action=ActivityAction.UPDATE,
                    entity_type="InventoryOperation",
                    entity_id=activity_id,
                    summary="MySQL 边界审计",
                    highlight_kind=ActivityHighlightKind.INVENTORY,
                    highlight_summary="完成库存盘点",
                    created_at=created_at,
                )
            )
        db.flush()
        result = list_activity_highlights(
            db,
            family_id="family-highlight-mysql",
            limit=20,
            at=datetime(2026, 7, 13, 0, 30, tzinfo=ZoneInfo("Asia/Shanghai")),
        )
        assert result["week_highlight_count"] == 1
        assert {item["id"] for item in result["items"]} == {
            "activity-before-week",
            "activity-week-start",
            "activity-future",
        }
    finally:
        db.close()
        if transaction.is_active:
            transaction.rollback()
        connection.close()
        engine.dispose()

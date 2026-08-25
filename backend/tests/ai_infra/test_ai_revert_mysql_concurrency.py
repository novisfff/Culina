from __future__ import annotations

import os
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Barrier, Lock
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from . import _support as _ai_infra_support  # noqa: F401 - initialize the AI test app graph

from app.core.enums import (
    AIConversationVisibility,
    AiMode,
    FoodType,
    MembershipStatus,
    UserRole,
)
from app.db.base import Base
from app.models.domain import (
    ActivityLog,
    AIConversation,
    AIMessage,
    AIOperation,
    AITaskDraft,
    Family,
    Food,
    Membership,
    User,
)
from app.services.ai_operations.result_projection import (
    build_operation_result_card,
    operation_result_artifacts,
    project_ai_operation_result,
    upsert_message_operation_result,
)
from app.services.ai_revert.coordinator import AIRevertCoordinator
from app.services.ai_revert.errors import AIRevertError
from app.services.ai_revert.registry import AIRevertAdapterRegistry
from app.services.ai_revert.types import AIRevertContext, AIRevertResult


NOW = datetime(2026, 8, 24, 10, 0, tzinfo=UTC)
FAMILY_ID = "family-ai-revert-mysql"
SHARED_REQUEST_ID = "request-ai-revert-mysql-race"


def _mysql_url() -> URL:
    value = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not value:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    url = make_url(value)
    if not (url.database or "").endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return url


def _drop_all_test_tables(engine) -> None:
    with engine.begin() as connection:
        connection.exec_driver_sql("SET FOREIGN_KEY_CHECKS=0")
        try:
            for table in reversed(tuple(Base.metadata.tables.values())):
                table.drop(connection, checkfirst=True)
        finally:
            connection.exec_driver_sql("SET FOREIGN_KEY_CHECKS=1")


def _ensure_test_database(url: URL) -> None:
    database = url.database or ""
    if re.fullmatch(r"[A-Za-z0-9_]+", database) is None:
        pytest.fail("CULINA_TEST_MYSQL_URL database name contains unsafe characters")
    probe_engine = create_engine(url, poolclass=NullPool)
    try:
        with probe_engine.connect():
            return
    except OperationalError:
        pass
    finally:
        probe_engine.dispose()
    admin_url = URL.create(
        drivername=url.drivername,
        username=url.username,
        password=url.password,
        host=url.host,
        port=url.port,
        database=None,
        query=url.query,
    )
    admin_engine = create_engine(admin_url, isolation_level="AUTOCOMMIT", poolclass=NullPool)
    try:
        with admin_engine.connect() as connection:
            connection.execute(
                text(
                    f"CREATE DATABASE IF NOT EXISTS `{database}` "
                    "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                )
            )
    finally:
        admin_engine.dispose()


class BarrierRevertAdapter:
    key = "test.mysql-barrier.v1"
    schema_version = 1

    def __init__(self, barrier: Barrier) -> None:
        self.barrier = barrier
        self.call_counts: Counter[str] = Counter()
        self._lock = Lock()

    def revert(self, context: AIRevertContext) -> AIRevertResult:
        target_id = str((context.operation.revert_context_json or {}).get("target_id") or "")
        target = context.db.get(Food, target_id)
        assert target is not None
        target.notes = f"compensated:{context.operation.id}"
        with self._lock:
            self.call_counts[context.operation.id] += 1
        self.barrier.wait(timeout=20)
        return AIRevertResult(
            result_json={"restored": target_id},
            entities=({"id": target.id, "label": target.name, "operation": "revert"},),
            cache_scopes=("food", "ai_conversation"),
        )


@dataclass(frozen=True, slots=True)
class MysqlRevertContext:
    SessionLocal: sessionmaker[Session]
    adapter: BarrierRevertAdapter
    operation_ids: tuple[str, str]
    draft_ids: dict[str, str]
    message_ids: dict[str, str]
    food_ids: dict[str, str]
    actor_ids: dict[str, str]


def _seed_operation(
    db: Session,
    *,
    suffix: str,
    actor_id: str,
    conversation_id: str,
) -> tuple[str, str, str, str]:
    food_id = f"food-ai-revert-mysql-{suffix}"
    message_id = f"message-ai-revert-mysql-{suffix}"
    draft_id = f"draft-ai-revert-mysql-{suffix}"
    operation_id = f"operation-ai-revert-mysql-{suffix}"
    food = Food(
        id=food_id,
        family_id=FAMILY_ID,
        name=f"并发食物-{suffix}",
        type=FoodType.SELF_MADE,
        category="家常",
        flavor_tags=[],
        scene_tags=[],
        suitable_meal_types=[],
        source_name="",
        purchase_source="",
        scene="",
        notes=f"initial:{suffix}",
        routine_note="",
        stock_unit="",
        favorite=True,
        created_by=actor_id,
        updated_by=actor_id,
    )
    message = AIMessage(
        id=message_id,
        family_id=FAMILY_ID,
        conversation_id=conversation_id,
        role="assistant",
        content="",
        parts=[],
        status="completed",
        message_metadata={},
        created_by=actor_id,
    )
    db.add_all([food, message])
    db.flush()
    draft = AITaskDraft(
        id=draft_id,
        family_id=FAMILY_ID,
        conversation_id=conversation_id,
        message_id=message_id,
        draft_type="food_profile",
        payload={"targetId": food_id},
        preview_summary="设置收藏",
        status="executed",
        version=1,
        schema_version="food_profile_operation.v1",
        validation_errors=[],
        ai_metadata={},
        payload_hash=suffix[0] * 64,
        execution_route="policy_auto",
        idempotency_key=f"draft-idempotency-ai-revert-mysql-{suffix}",
        created_by=actor_id,
        updated_by=actor_id,
    )
    db.add(draft)
    db.flush()
    operation = AIOperation(
        id=operation_id,
        family_id=FAMILY_ID,
        draft_id=draft_id,
        actor_user_id=actor_id,
        operation_type="food_profile.set_favorite",
        status="succeeded",
        execution_mode="policy_auto",
        authorization_source="member_preference",
        authorization_snapshot_json={},
        committed_payload_json={},
        result_json={
            "business_entity": {"id": food_id, "name": food.name},
            "entity_ids": [food_id],
            "cache_scopes": ["food", "ai_conversation"],
        },
        business_entity_type="food",
        business_entity_ids=[food_id],
        idempotency_key=f"operation-idempotency-ai-revert-mysql-{suffix}",
        completed_at=NOW - timedelta(minutes=1),
        revert_adapter_key=BarrierRevertAdapter.key,
        revert_context_json={"schema_version": 1, "target_id": food_id},
        revertible_until=NOW + timedelta(minutes=5),
    )
    db.add(operation)
    db.flush()
    projection = project_ai_operation_result(
        draft=draft,
        operation=operation,
        entities=({"id": food.id, "label": food.name, "operation": "update"},),
        cache_scopes=("food", "ai_conversation"),
        server_now=NOW - timedelta(minutes=1),
    )
    card = build_operation_result_card(
        projection,
        title="已收藏食物",
        workspace_label="食物",
    )
    upsert_message_operation_result(
        db,
        message_id=message_id,
        projection=projection,
        card=card,
        artifacts=operation_result_artifacts(projection, card=card),
    )
    return operation_id, draft_id, message_id, food_id


@pytest.fixture()
def mysql_revert_context() -> MysqlRevertContext:
    url = _mysql_url()
    _ensure_test_database(url)
    engine = create_engine(
        url,
        poolclass=NullPool,
        pool_pre_ping=True,
        future=True,
    )
    _drop_all_test_tables(engine)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
        class_=Session,
    )
    actor_ids = {"left": "user-ai-revert-mysql-left", "right": "user-ai-revert-mysql-right"}
    operation_ids: list[str] = []
    draft_ids: dict[str, str] = {}
    message_ids: dict[str, str] = {}
    food_ids: dict[str, str] = {}
    with SessionLocal() as db:
        family = Family(id=FAMILY_ID, name="AI 撤销并发家庭", motto="", location="")
        users = [
            User(
                id=actor_id,
                username=actor_id,
                display_name=suffix,
                avatar_seed=suffix,
            )
            for suffix, actor_id in actor_ids.items()
        ]
        conversation = AIConversation(
            id="conversation-ai-revert-mysql",
            family_id=FAMILY_ID,
            owner_user_id=actor_ids["left"],
            visibility=AIConversationVisibility.FAMILY,
            mode=AiMode.FOOD_QA,
            prompt="",
            response="",
            context={},
            title="并发撤销",
            created_by=actor_ids["left"],
        )
        db.add(family)
        db.add_all(users)
        db.flush()
        db.add_all(
            [
                Membership(
                    id=f"membership-ai-revert-mysql-{suffix}",
                    family_id=FAMILY_ID,
                    user_id=actor_id,
                    role=UserRole.MEMBER,
                    status=MembershipStatus.ACTIVE,
                    created_by=actor_id,
                    updated_by=actor_id,
                )
                for suffix, actor_id in actor_ids.items()
            ]
        )
        db.add(conversation)
        db.flush()
        for suffix, actor_id in actor_ids.items():
            operation_id, draft_id, message_id, food_id = _seed_operation(
                db,
                suffix=suffix,
                actor_id=actor_id,
                conversation_id=conversation.id,
            )
            operation_ids.append(operation_id)
            draft_ids[operation_id] = draft_id
            message_ids[operation_id] = message_id
            food_ids[operation_id] = food_id
        db.commit()

    adapter = BarrierRevertAdapter(Barrier(2, timeout=20))
    registry = AIRevertAdapterRegistry()
    registry.register(adapter)
    registry_patcher = patch.object(AIRevertCoordinator, "registry", registry)
    registry_patcher.start()
    try:
        yield MysqlRevertContext(
            SessionLocal=SessionLocal,
            adapter=adapter,
            operation_ids=(operation_ids[0], operation_ids[1]),
            draft_ids=draft_ids,
            message_ids=message_ids,
            food_ids=food_ids,
            actor_ids={operation_ids[index]: actor_ids[suffix] for index, suffix in enumerate(actor_ids)},
        )
    finally:
        registry_patcher.stop()
        _drop_all_test_tables(engine)
        engine.dispose()


def test_global_request_id_race_has_one_winner_and_clean_typed_loser(
    mysql_revert_context: MysqlRevertContext,
) -> None:
    ctx = mysql_revert_context

    def worker(operation_id: str) -> dict[str, object]:
        with ctx.SessionLocal() as db:
            try:
                response = AIRevertCoordinator.revert(
                    db,
                    family_id=FAMILY_ID,
                    actor_user_id=ctx.actor_ids[operation_id],
                    actor_role=UserRole.MEMBER,
                    operation_id=operation_id,
                    client_request_id=SHARED_REQUEST_ID,
                    now=NOW,
                )
                db.commit()
                return {"operation_id": operation_id, "response": response, "error": None}
            except AIRevertError as exc:
                db.rollback()
                return {"operation_id": operation_id, "response": None, "error": exc}

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(worker, ctx.operation_ids))

    winners = [outcome for outcome in outcomes if outcome["response"] is not None]
    losers = [outcome for outcome in outcomes if outcome["error"] is not None]
    assert len(winners) == 1, outcomes
    assert len(losers) == 1, outcomes
    winner_id = str(winners[0]["operation_id"])
    loser_id = str(losers[0]["operation_id"])
    loser_error = losers[0]["error"]
    assert isinstance(loser_error, AIRevertError)
    assert loser_error.code == "revert_request_id_reused"
    assert loser_error.response is None

    with ctx.SessionLocal() as db:
        winner = db.get(AIOperation, winner_id)
        loser = db.get(AIOperation, loser_id)
        winner_draft = db.get(AITaskDraft, ctx.draft_ids[winner_id])
        loser_draft = db.get(AITaskDraft, ctx.draft_ids[loser_id])
        winner_food = db.get(Food, ctx.food_ids[winner_id])
        loser_food = db.get(Food, ctx.food_ids[loser_id])
        winner_message = db.get(AIMessage, ctx.message_ids[winner_id])
        loser_message = db.get(AIMessage, ctx.message_ids[loser_id])
        assert all(
            value is not None
            for value in (
                winner,
                loser,
                winner_draft,
                loser_draft,
                winner_food,
                loser_food,
                winner_message,
                loser_message,
            )
        )
        assert winner.status == "reverted"
        assert winner.revert_request_id == SHARED_REQUEST_ID
        assert winner.revert_result_json["status"] == "reverted"
        assert winner_draft.status == "reverted"
        assert winner_food.notes == f"compensated:{winner_id}"
        assert winner_message.parts[0]["card"]["data"]["result_status"] == "reverted"
        assert winner_message.message_metadata["artifacts"][0]["status"] == "reverted"

        assert loser.status == "succeeded"
        assert loser.revert_request_id is None
        assert loser.reverted_at is None
        assert loser.reverted_by is None
        assert loser.revert_result_json is None
        assert loser.revert_blocked_at is None
        assert loser.revert_blocked_code is None
        assert loser_draft.status == "executed"
        assert loser_food.notes == f"initial:{loser_id.rsplit('-', 1)[-1]}"
        assert loser_message.parts[0]["card"]["data"]["result_status"] == "completed"
        assert loser_message.message_metadata["artifacts"][0]["status"] == "completed"

        activities = list(
            db.scalars(
                select(ActivityLog).where(ActivityLog.entity_type == "ai_operation")
            )
        )
        assert [activity.entity_id for activity in activities] == [winner_id]
        request_claim_count = int(
            db.scalar(
                select(func.count())
                .select_from(AIOperation)
                .where(AIOperation.revert_request_id == SHARED_REQUEST_ID)
            )
            or 0
        )
        assert request_claim_count == 1

    assert ctx.adapter.call_counts[winner_id] == 1
    assert ctx.adapter.call_counts[loser_id] == 1

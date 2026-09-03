from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
from unittest.mock import patch

from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError

from ._support import AIAgentInfraTestCase

from app.core.enums import ActivityAction, MembershipStatus, UserRole
from app.models.domain import (
    ActivityLog,
    AIMessage,
    AIOperation,
    AITaskDraft,
    Food,
    Membership,
)
from app.services.ai_operations.result_projection import (
    build_operation_result_card,
    hydrate_operation_result_server_now,
    operation_result_artifacts,
    project_ai_operation_result,
    serialize_ai_operation_result_projection,
    upsert_message_operation_result,
)
from app.services.ai_revert.coordinator import AIRevertCoordinator
from app.services.ai_revert.errors import (
    AIRevertDependencyExists,
    AIRevertError,
    AIRevertTargetChanged,
)
from app.services.ai_revert.registry import AIRevertAdapterRegistry
from app.services.ai_revert.types import AIRevertContext, AIRevertResult


NOW = datetime(2026, 8, 24, 10, 0, tzinfo=UTC)


class FakeRevertAdapter:
    key = "test.fake.v1"
    schema_version = 1

    def __init__(self) -> None:
        self.call_count = 0

    def revert(self, context: AIRevertContext) -> AIRevertResult:
        self.call_count += 1
        target = context.db.get(Food, "food-tomato")
        assert target is not None
        target.notes = "fake compensation applied"
        mode = str((context.operation.revert_context_json or {}).get("mode") or "success")
        if mode == "target_changed":
            raise AIRevertTargetChanged()
        if mode == "dependency_exists":
            raise AIRevertDependencyExists()
        if mode == "transient":
            raise OperationalError("UPDATE foods", {}, RuntimeError("temporary database outage"))
        return AIRevertResult(
            result_json={"restored": True},
            entities=({"id": target.id, "label": target.name, "operation": "revert"},),
            cache_scopes=("food", "ai_conversation"),
        )


class AIRevertCoordinatorTest(AIAgentInfraTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.adapter = FakeRevertAdapter()
        self.registry = AIRevertAdapterRegistry()
        self.registry.register(self.adapter)
        self.registry_patcher = patch.object(AIRevertCoordinator, "registry", self.registry)
        self.registry_patcher.start()

    def tearDown(self) -> None:
        self.registry_patcher.stop()
        super().tearDown()

    def test_registry_rejects_duplicate_key_and_missing_adapter_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate AI revert adapter"):
            self.registry.register(FakeRevertAdapter())
        with self.assertRaises(AIRevertError) as missing:
            self.registry.require("missing.adapter.v1")
        self.assertEqual(missing.exception.code, "operation_not_revertible")

    def _seed_operation(
        self,
        db,
        *,
        suffix: str,
        actor_user_id: str | None = None,
        family_id: str | None = None,
        deadline: datetime = NOW,
        adapter_key: str = FakeRevertAdapter.key,
        context: dict | None = None,
        blocked_code: str | None = None,
        blocked_request_id: str | None = None,
    ) -> tuple[AITaskDraft, AIOperation]:
        family_id = family_id or self.family.id
        actor_user_id = actor_user_id or self.user.id
        food = db.get(Food, "food-tomato")
        assert food is not None
        service, draft, _approval = self._create_ai_approval_for_test(
            db,
            draft_type="food_profile",
            payload={
                "draftType": "food_profile",
                "schemaVersion": "food_profile_operation.v1",
                "action": "set_favorite",
                "targetId": "food-tomato",
                "baseUpdatedAt": food.updated_at.isoformat(),
                "before": {"favorite": bool(food.favorite)},
                "payload": {"favorite": True},
            },
            suffix=suffix,
        )
        del service
        draft.status = "executed"
        operation = AIOperation(
            id=f"operation-{suffix}",
            family_id=family_id,
            draft_id=draft.id,
            actor_user_id=actor_user_id,
            operation_type="food_profile.set_favorite",
            status="completed",
            execution_mode="policy_auto",
            authorization_source="member_preference",
            authorization_snapshot_json={},
            committed_payload_json={},
            result_json={
                "business_entity": {"id": "food-tomato", "name": "番茄小炒"},
                "entity_ids": ["food-tomato"],
                "cache_scopes": ["food", "ai_conversation"],
            },
            business_entity_type="food",
            business_entity_ids=["food-tomato"],
            idempotency_key=f"idempotency-{suffix}",
            completed_at=NOW - timedelta(minutes=1),
            revert_adapter_key=adapter_key,
            revert_context_json=context or {"schema_version": 1, "mode": "success"},
            revertible_until=deadline,
            revert_request_id=blocked_request_id,
            revert_blocked_at=NOW if blocked_code else None,
            revert_blocked_code=blocked_code,
        )
        db.add(operation)
        db.flush()
        projection = project_ai_operation_result(
            draft=draft,
            operation=operation,
            entities=({"id": "food-tomato", "label": "番茄小炒", "operation": "update"},),
            cache_scopes=("food", "ai_conversation"),
            server_now=NOW - timedelta(minutes=1),
        )
        card = build_operation_result_card(projection, title="已收藏食物", workspace_label="食物")
        upsert_message_operation_result(
            db,
            message_id=draft.message_id,
            projection=projection,
            card=card,
            artifacts=operation_result_artifacts(projection, card=card),
        )
        db.commit()
        return draft, operation

    def _revert(
        self,
        db,
        operation_id: str,
        request_id: str,
        *,
        actor_user_id: str | None = None,
        actor_role: UserRole = UserRole.OWNER,
        family_id: str | None = None,
        now: datetime = NOW,
    ):
        return AIRevertCoordinator.revert(
            db,
            family_id=family_id or self.family.id,
            actor_user_id=actor_user_id or self.user.id,
            actor_role=actor_role,
            operation_id=operation_id,
            client_request_id=request_id,
            now=now,
        )

    def test_revert_deadline_is_inclusive_and_persists_all_public_side_effects(self) -> None:
        with self.SessionLocal() as db:
            draft, operation = self._seed_operation(db, suffix="inclusive")
            response = self._revert(db, operation.id, "request-inclusive")
            db.commit()

            db.expire_all()
            stored_operation = db.get(AIOperation, operation.id)
            stored_draft = db.get(AITaskDraft, draft.id)
            message = db.get(AIMessage, draft.message_id)
            activity = db.scalar(
                select(ActivityLog).where(
                    ActivityLog.entity_type == "ai_operation",
                    ActivityLog.entity_id == operation.id,
                )
            )
            assert stored_operation is not None and stored_draft is not None and message is not None
            self.assertEqual(response.projection.result_status, "reverted")
            self.assertEqual(stored_operation.status, "reverted")
            self.assertEqual(stored_operation.revert_request_id, "request-inclusive")
            self.assertEqual(stored_draft.status, "reverted")
            self.assertEqual(activity.action, ActivityAction.REVERT)
            result_parts = [part for part in message.parts if part.get("type") == "result_card"]
            self.assertEqual(len(result_parts), 1)
            self.assertEqual(result_parts[0]["card"]["data"]["result_status"], "reverted")
            artifacts = (message.message_metadata or {}).get("artifacts") or []
            self.assertEqual([item["id"] for item in artifacts], [f"ai_operation_result:{draft.id}"])
            self.assertNotIn(
                "revert_context_json",
                json.dumps({"card": response.result_card, "artifacts": artifacts}),
            )

    def test_same_request_replays_without_second_adapter_call(self) -> None:
        with self.SessionLocal() as db:
            _draft, operation = self._seed_operation(db, suffix="replay")
            first = self._revert(db, operation.id, "request-replay")
            db.commit()
            second = self._revert(db, operation.id, "request-replay", now=NOW + timedelta(seconds=1))

            self.assertFalse(first.replayed)
            self.assertTrue(second.replayed)
            self.assertEqual(second.result_card["data"]["result_status"], "reverted")
            self.assertEqual(self.adapter.call_count, 1)

    def test_same_request_replays_stored_public_response_without_message_writes(self) -> None:
        with self.SessionLocal() as db:
            draft, operation = self._seed_operation(db, suffix="stored-replay")
            first = self._revert(db, operation.id, "request-stored-replay")
            db.commit()

            stored = db.get(AIOperation, operation.id)
            message = db.get(AIMessage, draft.message_id)
            assert stored is not None and message is not None
            stored_public_response = json.loads(
                json.dumps(stored.revert_result_json["public_response"])
            )
            message.parts = [
                {
                    "id": f"operation-result-part:{draft.id}",
                    "type": "result_card",
                    "card": {
                        "id": f"operation-result:{draft.id}",
                        "type": "operation_result",
                        "title": "PRIVATE_SENTINEL",
                        "data": {"draftId": draft.id, "entities": [{"raw": "PRIVATE_SENTINEL"}]},
                    },
                }
            ]
            message.message_metadata = {
                "artifacts": [{"raw": "PRIVATE_SENTINEL"}],
            }
            db.commit()

            statements: list[str] = []

            def record_statement(_conn, _cursor, statement, _parameters, _context, _many) -> None:
                statements.append(statement)

            event.listen(self.engine, "before_cursor_execute", record_statement)
            try:
                replay_now = NOW + timedelta(seconds=1)
                second = self._revert(
                    db,
                    operation.id,
                    "request-stored-replay",
                    now=replay_now,
                )
            finally:
                event.remove(self.engine, "before_cursor_execute", record_statement)

            expected_card = hydrate_operation_result_server_now(
                stored_public_response["result_card"],
                replay_now,
            )
            expected_projection = dict(stored_public_response["projection"])
            expected_projection["server_now"] = replay_now.isoformat()
            self.assertEqual(
                serialize_ai_operation_result_projection(second.projection),
                expected_projection,
            )
            self.assertEqual(second.result_card, expected_card)
            self.assertEqual(second.cache_scopes, tuple(stored_public_response["cache_scopes"]))
            self.assertEqual(second.server_now, replay_now)
            self.assertTrue(second.replayed)
            self.assertNotIn("PRIVATE_SENTINEL", json.dumps(second.result_card))
            self.assertEqual(self.adapter.call_count, 1)
            self.assertFalse(db.dirty)
            self.assertFalse(any(statement.lstrip().upper().startswith("UPDATE") for statement in statements))
            self.assertFalse(first.replayed)

    def test_request_id_cannot_move_between_operations(self) -> None:
        with self.SessionLocal() as db:
            _draft1, operation1 = self._seed_operation(db, suffix="request-one")
            _draft2, operation2 = self._seed_operation(db, suffix="request-two")
            self._revert(db, operation1.id, "global-request")
            db.commit()

            with self.assertRaisesRegex(AIRevertError, "revert_request_id_reused"):
                self._revert(db, operation2.id, "global-request")
            self.assertEqual(self.adapter.call_count, 1)

    def test_permanent_conflict_is_recorded_and_compensation_is_rolled_back(self) -> None:
        with self.SessionLocal() as db:
            _draft, operation = self._seed_operation(
                db,
                suffix="permanent",
                context={"schema_version": 1, "mode": "target_changed"},
            )
            original_notes = db.get(Food, "food-tomato").notes

            with self.assertRaises(AIRevertTargetChanged) as raised:
                self._revert(db, operation.id, "request-permanent")
            db.commit()

            db.expire_all()
            stored = db.get(AIOperation, operation.id)
            self.assertEqual(stored.revert_blocked_code, "revert_target_changed")
            self.assertEqual(stored.revert_request_id, "request-permanent")
            self.assertEqual(db.get(Food, "food-tomato").notes, original_notes)
            self.assertEqual(raised.exception.response.projection.revert_availability, "blocked")

    def test_transient_error_does_not_consume_request_or_persist_projection(self) -> None:
        with self.SessionLocal() as db:
            draft, operation = self._seed_operation(
                db,
                suffix="transient",
                context={"schema_version": 1, "mode": "transient"},
            )
            original_message = list(db.get(AIMessage, draft.message_id).parts)
            original_notes = db.get(Food, "food-tomato").notes

            with self.assertRaises(OperationalError):
                self._revert(db, operation.id, "request-transient")
            db.rollback()

            stored = db.get(AIOperation, operation.id)
            self.assertIsNone(stored.revert_request_id)
            self.assertIsNone(stored.revert_blocked_code)
            self.assertEqual(db.get(Food, "food-tomato").notes, original_notes)
            self.assertEqual(db.get(AIMessage, draft.message_id).parts, original_message)

    def test_missing_result_message_rolls_back_compensation_and_request_claim(self) -> None:
        with self.SessionLocal() as db:
            draft, operation = self._seed_operation(db, suffix="missing-message")
            original_notes = db.get(Food, "food-tomato").notes
            draft.message_id = None
            db.commit()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation.id, "request-missing-message")
            db.rollback()

            self.assertEqual(raised.exception.code, "operation_not_revertible")
            self.assertEqual(db.get(Food, "food-tomato").notes, original_notes)
            stored = db.get(AIOperation, operation.id)
            self.assertEqual(stored.status, "completed")
            self.assertIsNone(stored.revert_request_id)

    def test_permission_and_family_checks_happen_before_request_replay(self) -> None:
        member, membership = self.create_family_member(user_id="user-revert-member")
        outsider, outsider_membership = self.create_family_member(user_id="user-revert-outsider")
        with self.SessionLocal() as db:
            _draft, operation = self._seed_operation(
                db,
                suffix="permission-replay",
                actor_user_id=member.id,
            )
            self._revert(
                db,
                operation.id,
                "request-private-replay",
                actor_user_id=member.id,
                actor_role=UserRole.MEMBER,
            )
            db.commit()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(
                    db,
                    operation.id,
                    "request-private-replay",
                    actor_user_id=outsider.id,
                    actor_role=UserRole.MEMBER,
                )
            self.assertEqual(raised.exception.code, "revert_forbidden")
            self.assertIsNone(raised.exception.response)

            with self.assertRaises(AIRevertError) as hidden:
                self._revert(
                    db,
                    operation.id,
                    "request-private-replay",
                    family_id=self.other_family.id,
                    actor_user_id=outsider.id,
                    actor_role=UserRole.MEMBER,
                )
            self.assertEqual(hidden.exception.status_code, 404)
        del membership, outsider_membership

    def test_original_actor_current_owner_other_member_and_left_actor(self) -> None:
        member, membership = self.create_family_member(user_id="user-revert-actor")
        other, _other_membership = self.create_family_member(user_id="user-revert-other")
        with self.SessionLocal() as db:
            _draft1, actor_operation = self._seed_operation(
                db, suffix="actor-allowed", actor_user_id=member.id
            )
            response = self._revert(
                db,
                actor_operation.id,
                "request-actor",
                actor_user_id=member.id,
                actor_role=UserRole.MEMBER,
            )
            self.assertEqual(response.projection.result_status, "reverted")
            db.commit()

            _draft2, owner_operation = self._seed_operation(
                db, suffix="owner-allowed", actor_user_id=member.id
            )
            owner_response = self._revert(db, owner_operation.id, "request-owner")
            self.assertEqual(owner_response.projection.result_status, "reverted")
            db.commit()

            _draft3, forbidden_operation = self._seed_operation(
                db, suffix="other-forbidden", actor_user_id=member.id
            )
            with self.assertRaises(AIRevertError) as forbidden:
                self._revert(
                    db,
                    forbidden_operation.id,
                    "request-other",
                    actor_user_id=other.id,
                    actor_role=UserRole.MEMBER,
                )
            self.assertEqual(forbidden.exception.code, "revert_forbidden")

            membership_row = db.get(type(membership), membership.id)
            membership_row.status = MembershipStatus.INVITED
            db.commit()
            _draft4, left_operation = self._seed_operation(
                db, suffix="left-forbidden", actor_user_id=member.id
            )
            with self.assertRaises(AIRevertError) as left:
                self._revert(
                    db,
                    left_operation.id,
                    "request-left",
                    actor_user_id=member.id,
                    actor_role=UserRole.MEMBER,
                )
            self.assertEqual(left.exception.code, "revert_forbidden")

    def test_cached_owner_role_is_refreshed_before_permission_and_request_lookup(self) -> None:
        original_actor, _actor_membership = self.create_family_member(
            user_id="user-stale-owner-original-actor"
        )
        with self.SessionLocal() as auth_session, self.SessionLocal() as role_session:
            _replayed_draft, replayed_operation = self._seed_operation(
                auth_session,
                suffix="stale-owner-request-owner",
            )
            self._revert(auth_session, replayed_operation.id, "request-stale-owner-secret")
            auth_session.commit()
            self.adapter.call_count = 0

            _target_draft, target_operation = self._seed_operation(
                auth_session,
                suffix="stale-owner-target",
                actor_user_id=original_actor.id,
            )
            cached_membership = auth_session.get(Membership, self.membership.id)
            assert cached_membership is not None
            self.assertEqual(cached_membership.role, UserRole.OWNER)

            current_membership = role_session.get(Membership, self.membership.id)
            assert current_membership is not None
            current_membership.role = UserRole.MEMBER
            role_session.commit()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(
                    auth_session,
                    target_operation.id,
                    "request-stale-owner-secret",
                    actor_role=UserRole.OWNER,
                )
            auth_session.rollback()

            self.assertEqual(raised.exception.code, "revert_forbidden")
            self.assertIsNone(raised.exception.response)
            self.assertEqual(self.adapter.call_count, 0)
            stored = auth_session.get(AIOperation, target_operation.id)
            self.assertIsNone(stored.revert_request_id)

    def test_expired_missing_adapter_schema_and_already_blocked_fail_closed(self) -> None:
        with self.SessionLocal() as db:
            _draft1, expired = self._seed_operation(db, suffix="expired")
            _draft2, missing = self._seed_operation(
                db, suffix="missing", adapter_key="missing.adapter.v1"
            )
            _draft3, schema = self._seed_operation(
                db,
                suffix="schema",
                context={"schema_version": 2, "mode": "success"},
            )
            _draft4, blocked = self._seed_operation(
                db,
                suffix="blocked",
                blocked_code="revert_dependency_exists",
                blocked_request_id="old-block-request",
            )

            cases = (
                (expired, NOW + timedelta(microseconds=1), "revert_expired"),
                (missing, NOW, "operation_not_revertible"),
                (blocked, NOW, "operation_not_revertible"),
            )
            for operation, now, code in cases:
                with self.subTest(code=code):
                    with self.assertRaises(AIRevertError) as raised:
                        self._revert(db, operation.id, f"request-{operation.id}", now=now)
                    self.assertEqual(raised.exception.code, code)

            with self.assertRaises(AIRevertError) as unsupported:
                self._revert(db, schema.id, "request-schema")
            self.assertEqual(unsupported.exception.code, "revert_adapter_version_unsupported")
            db.commit()
            self.assertEqual(
                db.get(AIOperation, schema.id).revert_blocked_code,
                "revert_adapter_version_unsupported",
            )

    def test_boolean_context_schema_version_is_not_accepted_as_integer_one(self) -> None:
        with self.SessionLocal() as db:
            _draft, operation = self._seed_operation(
                db,
                suffix="boolean-schema",
                context={"schema_version": True, "mode": "success"},
            )

            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation.id, "request-boolean-schema")

            self.assertEqual(raised.exception.code, "revert_adapter_version_unsupported")
            self.assertEqual(self.adapter.call_count, 0)

    def test_permanent_conflict_replays_without_adapter_and_forbidden_user_gets_no_payload(self) -> None:
        member, _membership = self.create_family_member(user_id="user-block-owner")
        other, _other_membership = self.create_family_member(user_id="user-block-other")
        with self.SessionLocal() as db:
            _draft, operation = self._seed_operation(
                db,
                suffix="blocked-replay",
                actor_user_id=member.id,
                context={"schema_version": 1, "mode": "dependency_exists"},
            )
            with self.assertRaises(AIRevertDependencyExists):
                self._revert(
                    db,
                    operation.id,
                    "request-blocked-replay",
                    actor_user_id=member.id,
                    actor_role=UserRole.MEMBER,
                )
            db.commit()
            with self.assertRaises(AIRevertDependencyExists) as replay:
                self._revert(
                    db,
                    operation.id,
                    "request-blocked-replay",
                    actor_user_id=member.id,
                    actor_role=UserRole.MEMBER,
                    now=NOW + timedelta(seconds=1),
                )
            self.assertTrue(replay.exception.response.replayed)
            self.assertEqual(self.adapter.call_count, 1)

            with self.assertRaises(AIRevertError) as forbidden:
                self._revert(
                    db,
                    operation.id,
                    "request-blocked-replay",
                    actor_user_id=other.id,
                    actor_role=UserRole.MEMBER,
                )
            self.assertEqual(forbidden.exception.code, "revert_forbidden")
            self.assertIsNone(forbidden.exception.response)

    def test_permanent_conflict_replays_stored_response_after_message_tampering(self) -> None:
        with self.SessionLocal() as db:
            draft, operation = self._seed_operation(
                db,
                suffix="blocked-stored-replay",
                context={"schema_version": 1, "mode": "dependency_exists"},
            )
            with self.assertRaises(AIRevertDependencyExists) as first:
                self._revert(db, operation.id, "request-blocked-stored-replay")
            db.commit()
            first_response = first.exception.response
            assert first_response is not None

            message = db.get(AIMessage, draft.message_id)
            assert message is not None
            message.parts = [{"type": "result_card", "card": {"raw": "PRIVATE_SENTINEL"}}]
            message.message_metadata = {"artifacts": [{"raw": "PRIVATE_SENTINEL"}]}
            db.commit()

            with self.assertRaises(AIRevertDependencyExists) as replay:
                self._revert(
                    db,
                    operation.id,
                    "request-blocked-stored-replay",
                    now=NOW + timedelta(seconds=1),
                )

            replay_response = replay.exception.response
            assert replay_response is not None
            self.assertTrue(replay_response.replayed)
            self.assertEqual(replay_response.projection.entities, first_response.projection.entities)
            self.assertEqual(replay_response.result_card["title"], first_response.result_card["title"])
            self.assertNotIn("PRIVATE_SENTINEL", json.dumps(replay_response.result_card))
            self.assertEqual(self.adapter.call_count, 1)
            self.assertFalse(db.dirty)

    def test_malformed_stored_public_response_fails_closed_without_replay_payload(self) -> None:
        mutations = {
            "private_projection_field": lambda response: response["projection"].update(
                {"raw": "PRIVATE_SENTINEL"}
            ),
            "draft_identity_mismatch": lambda response: response["result_card"]["data"].update(
                {"draftId": "other-draft"}
            ),
            "cache_scope_mismatch": lambda response: response.update(
                {"cache_scopes": ["inventory", "ai_conversation"]}
            ),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name), self.SessionLocal() as db:
                _draft, operation = self._seed_operation(db, suffix=f"malformed-{name}")
                self._revert(db, operation.id, f"request-malformed-{name}")
                db.commit()

                stored = db.get(AIOperation, operation.id)
                assert stored is not None
                stored_result = json.loads(json.dumps(stored.revert_result_json))
                mutate(stored_result["public_response"])
                stored.revert_result_json = stored_result
                db.commit()

                with self.assertRaises(AIRevertError) as raised:
                    self._revert(db, operation.id, f"request-malformed-{name}")

                self.assertEqual(raised.exception.code, "operation_not_revertible")
                self.assertIsNone(raised.exception.response)
                self.assertFalse(db.dirty)


class AIRevertAPITest(AIRevertCoordinatorTest):
    def test_post_revert_commits_then_returns_fresh_public_response_without_sse(self) -> None:
        with self.SessionLocal() as db:
            draft, operation = self._seed_operation(db, suffix="http-success")
        response_now = NOW + timedelta(seconds=5)

        from app.api import ai_auto_execution as api_module

        replay_now = response_now + timedelta(seconds=1)
        with (
            patch.object(api_module, "utcnow", side_effect=[NOW, response_now, NOW, replay_now]),
        ):
            response = self.client.post(
                f"/api/ai/operations/{operation.id}/revert",
                json={"client_request_id": "request-http-success"},
            )
            replay = self.client.post(
                f"/api/ai/operations/{operation.id}/revert",
                json={"client_request_id": "request-http-success"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["projection"]["result_status"], "reverted")
        self.assertEqual(payload["result_card"]["data"]["result_status"], "reverted")
        self.assertEqual(payload["server_now"], "2026-08-24T10:00:05Z")
        self.assertEqual(payload["projection"]["server_now"], "2026-08-24T10:00:05Z")
        self.assertEqual(payload["cache_scopes"], ["food", "ai_conversation"])
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertTrue(replay.json()["replayed"])
        self.assertEqual(self.adapter.call_count, 1)
        with self.SessionLocal() as db:
            message = db.get(AIMessage, draft.message_id)
            self.assertEqual(message.parts[-1]["card"]["data"]["result_status"], "reverted")

    def test_permanent_http_conflict_commits_strict_detail_and_replays(self) -> None:
        with self.SessionLocal() as db:
            _draft, operation = self._seed_operation(
                db,
                suffix="http-blocked",
                context={"schema_version": 1, "mode": "target_changed"},
            )

        with patch("app.api.ai_auto_execution.utcnow", side_effect=[NOW, NOW, NOW, NOW]):
            first = self.client.post(
                f"/api/ai/operations/{operation.id}/revert",
                json={"client_request_id": "request-http-blocked"},
            )
            second = self.client.post(
                f"/api/ai/operations/{operation.id}/revert",
                json={"client_request_id": "request-http-blocked"},
            )

        self.assertEqual(first.status_code, 409, first.text)
        self.assertEqual(second.status_code, 409, second.text)
        expected_fields = {
            "code",
            "message",
            "projection",
            "result_card",
            "cache_scopes",
            "server_now",
            "replayed",
        }
        self.assertEqual(set(first.json()["detail"]), expected_fields)
        self.assertEqual(first.json()["detail"]["code"], "revert_target_changed")
        self.assertFalse(first.json()["detail"]["replayed"])
        self.assertTrue(second.json()["detail"]["replayed"])
        with self.SessionLocal() as db:
            stored = db.get(AIOperation, operation.id)
            self.assertEqual(stored.revert_blocked_code, "revert_target_changed")

        other, other_membership = self.create_family_member(user_id="user-http-blocked-other")
        self.authenticate_as(other.id, other_membership.id)
        forbidden = self.client.post(
            f"/api/ai/operations/{operation.id}/revert",
            json={"client_request_id": "request-http-blocked"},
        )
        self.assertEqual(forbidden.status_code, 403)
        self.assertEqual(set(forbidden.json()["detail"]), {"code", "message"})

    def test_transient_http_failure_rolls_back_without_consuming_request(self) -> None:
        with self.SessionLocal() as db:
            draft, operation = self._seed_operation(
                db,
                suffix="http-transient",
                context={"schema_version": 1, "mode": "transient"},
            )
            original_parts = list(db.get(AIMessage, draft.message_id).parts)
            original_notes = db.get(Food, "food-tomato").notes

        with (
            patch("app.api.ai_auto_execution.utcnow", return_value=NOW),
            self.assertRaises(OperationalError),
        ):
            self.client.post(
                f"/api/ai/operations/{operation.id}/revert",
                json={"client_request_id": "request-http-transient"},
            )

        with self.SessionLocal() as db:
            stored = db.get(AIOperation, operation.id)
            self.assertIsNone(stored.revert_request_id)
            self.assertIsNone(stored.revert_blocked_code)
            self.assertEqual(stored.status, "completed")
            self.assertEqual(db.get(Food, "food-tomato").notes, original_notes)
            self.assertEqual(db.get(AIMessage, draft.message_id).parts, original_parts)

    def test_http_auth_family_and_request_schema_do_not_expose_replay_data(self) -> None:
        actor, actor_membership = self.create_family_member(user_id="user-http-actor")
        other, other_membership = self.create_family_member(user_id="user-http-other")
        with self.SessionLocal() as db:
            _draft, operation = self._seed_operation(
                db, suffix="http-permission", actor_user_id=actor.id
            )
            self._revert(
                db,
                operation.id,
                "request-http-private",
                actor_user_id=actor.id,
                actor_role=UserRole.MEMBER,
            )
            db.commit()

        self.authenticate_as(other.id, other_membership.id)
        forbidden = self.client.post(
            f"/api/ai/operations/{operation.id}/revert",
            json={"client_request_id": "request-http-private"},
        )
        self.assertEqual(forbidden.status_code, 403)
        self.assertEqual(set(forbidden.json()["detail"]), {"code", "message"})

        invalid = self.client.post(
            f"/api/ai/operations/{operation.id}/revert",
            json={"client_request_id": "new", "family_id": self.family.id},
        )
        self.assertEqual(invalid.status_code, 422)

        self.authenticate_as(actor.id, actor_membership.id)
        hidden = self.client.post(
            "/api/ai/operations/operation-does-not-exist/revert",
            json={"client_request_id": "request-http-private"},
        )
        self.assertEqual(hidden.status_code, 404)

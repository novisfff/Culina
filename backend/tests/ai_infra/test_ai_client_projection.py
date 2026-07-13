from __future__ import annotations

import copy
import json
from datetime import date
from typing import Any
from unittest.mock import patch

from ._support import *

from app.ai.draft_contracts import (
    AI_DRAFT_CONTRACTS_HEADER,
    RECIPE_COOK_V1,
    RECIPE_COOK_V2,
    ClientContractUpgradeRequired,
    DraftContractCapabilities,
)
from fastapi.encoders import jsonable_encoder
from app.core.enums import AIConversationVisibility, AiMode, Difficulty, FoodType, MealType
from app.models.domain import (
    AIApprovalRequest,
    AIConversation,
    AIMessage,
    AIOperation,
    AITaskDraft,
    Food,
    FoodPlanItem,
    Recipe,
    RecipeIngredient,
)
from app.services.ai_client_projection import (
    UPGRADE_TEXT,
    artifact_contains_v2_command,
    project_ai_chat_response,
    project_ai_conversation,
    project_ai_decision_response,
    project_ai_message,
    project_ai_run_event,
    project_ai_sse_event,
    require_viewer_contract,
)
from app.services.serializers import (
    serialize_ai_approval_request,
    serialize_ai_conversation,
    serialize_ai_message,
    serialize_ai_task_draft,
)


def old_capabilities() -> DraftContractCapabilities:
    return DraftContractCapabilities(values=frozenset())


def new_capabilities() -> DraftContractCapabilities:
    return DraftContractCapabilities(values=frozenset({RECIPE_COOK_V1, RECIPE_COOK_V2}))


def v1_capabilities() -> DraftContractCapabilities:
    return DraftContractCapabilities(values=frozenset({RECIPE_COOK_V1}))


def _v2_cook_payload(*, recipe_id: str = "recipe-projection-cook") -> dict[str, Any]:
    return {
        "draftType": "recipe_cook",
        "schemaVersion": RECIPE_COOK_V2,
        "recipeId": recipe_id,
        "title": "投影番茄炒蛋",
        "servings": 2,
        "date": date.today().isoformat(),
        "mealType": "dinner",
        "participantUserIds": ["user-1"],
        "notes": "v2 command",
        "resultNote": "",
        "adjustments": "",
        "previewItems": [],
        "shortages": [],
        "inventoryBoundaries": {},
    }


class AIClientProjectionUnitTestCase(unittest.TestCase):
    def test_old_viewer_gets_upgrade_part_and_canonical_message_is_unchanged(self) -> None:
        parts = [
            {
                "id": "draft-part-1",
                "type": "draft",
                "draft": {
                    "id": "draft-1",
                    "conversation_id": "c1",
                    "message_id": "m1",
                    "run_id": None,
                    "draft_type": "recipe_cook",
                    "payload": _v2_cook_payload(),
                    "preview_summary": "做菜",
                    "status": "pending",
                    "version": 1,
                    "schema_version": RECIPE_COOK_V2,
                    "validation_errors": [],
                    "expires_at": None,
                    "created_at": "2026-07-12T00:00:00+00:00",
                    "updated_at": "2026-07-12T00:00:00+00:00",
                },
            }
        ]
        message = SimpleNamespace(
            id="m1",
            conversation_id="c1",
            role="assistant",
            content="",
            content_type="parts",
            parts=parts,
            run_id=None,
            status="completed",
            message_metadata={"unrelatedMetric": 7, "artifacts": []},
            client_message_id=None,
            created_at=None,
        )
        canonical = copy.deepcopy(message.parts)
        projected = project_ai_message(serialize_ai_message(message), old_capabilities())
        self.assertEqual(projected["parts"][0]["type"], "error_recovery")
        self.assertIsNone(projected["parts"][0].get("draft"))
        self.assertIsNone(projected["parts"][0].get("approval"))
        self.assertEqual(projected["parts"][0]["text"], UPGRADE_TEXT)
        self.assertEqual(message.parts, canonical)

    def test_conversation_context_is_public_allowlist_for_every_viewer(self) -> None:
        conversation = SimpleNamespace(
            id="c1",
            family_id="f1",
            owner_user_id="u1",
            visibility="private",
            mode="chat",
            prompt="hello",
            response=None,
            created_at=None,
            created_by="u1",
            context={
                "activeRunId": "run-1",
                "fastApprovalDecisions": {"approval-1": {"draft": _v2_cook_payload()}},
                "internal": "secret",
            },
            title="t",
            summary=None,
            status="active",
            last_message_at=None,
            last_run_status=None,
        )
        projected = project_ai_conversation(
            serialize_ai_conversation(conversation, owner_display_name="Owner", current_user_id="u1"),
            new_capabilities(),
        )
        self.assertEqual(projected["context"], {"activeRunId": "run-1"})
        projected_old = project_ai_conversation(
            serialize_ai_conversation(conversation, owner_display_name="Owner", current_user_id="u1"),
            old_capabilities(),
        )
        self.assertEqual(projected_old["context"], {"activeRunId": "run-1"})
        self.assertIn("fastApprovalDecisions", conversation.context)

    def test_old_viewer_metadata_drops_nested_v2_command_only(self) -> None:
        message = SimpleNamespace(
            id="m1",
            conversation_id="c1",
            role="assistant",
            content="",
            content_type="parts",
            parts=[{"id": "text-1", "type": "text", "text": "ok"}],
            run_id=None,
            status="completed",
            message_metadata={
                "unrelatedMetric": 7,
                "artifacts": [
                    {
                        "id": "human_in_loop:a1",
                        "type": "approval_decision",
                        "payload": {
                            "approval": {"draft_schema_version": RECIPE_COOK_V2},
                            "draft": {
                                "schema_version": RECIPE_COOK_V2,
                                "payload": _v2_cook_payload(),
                            },
                            "operation": {"id": "op-1"},
                        },
                    },
                    {
                        "id": "entity:food-1",
                        "type": "meal_plan",
                        "payload": {"id": "food-1", "title": "番茄"},
                    },
                ],
            },
            client_message_id=None,
            created_at=None,
        )
        projected = project_ai_message(serialize_ai_message(message), old_capabilities())
        self.assertTrue(
            all(not artifact_contains_v2_command(item) for item in projected["metadata"]["artifacts"])
        )
        self.assertEqual(len(projected["metadata"]["artifacts"]), 1)
        self.assertEqual(projected["metadata"]["artifacts"][0]["id"], "entity:food-1")
        self.assertEqual(message.message_metadata["unrelatedMetric"], 7)
        self.assertEqual(len(message.message_metadata["artifacts"]), 2)

    def test_new_viewer_keeps_v2_draft_and_approval(self) -> None:
        draft = {
            "id": "draft-1",
            "conversation_id": "c1",
            "message_id": "m1",
            "run_id": None,
            "draft_type": "recipe_cook",
            "payload": _v2_cook_payload(),
            "preview_summary": "做菜",
            "status": "pending",
            "version": 1,
            "schema_version": RECIPE_COOK_V2,
            "validation_errors": [],
            "expires_at": None,
            "created_at": "2026-07-12T00:00:00+00:00",
            "updated_at": "2026-07-12T00:00:00+00:00",
        }
        approval = {
            "id": "approval-1",
            "conversation_id": "c1",
            "message_id": "m1",
            "run_id": None,
            "draft_id": "draft-1",
            "draft_version": 1,
            "draft_schema_version": RECIPE_COOK_V2,
            "approval_type": "recipe.cook",
            "status": "pending",
            "title": "确认做菜",
            "instruction": "确认后会自动记录餐食",
            "approve_label": "确认",
            "reject_label": "拒绝",
            "require_reject_comment": False,
            "failure_summary": None,
            "field_schema": [{"name": "draft", "label": "草稿", "type": "object", "widget": "textarea", "required": True}],
            "initial_values": {"draft": _v2_cook_payload()},
            "submitted_values": {},
            "decision": None,
            "comment": None,
            "resolved_at": None,
            "expires_at": None,
            "created_at": "2026-07-12T00:00:00+00:00",
        }
        chat = {
            "conversation_id": "c1",
            "message": {
                "id": "m1",
                "conversation_id": "c1",
                "role": "assistant",
                "content": "",
                "content_type": "parts",
                "parts": [
                    {"id": "draft-part-1", "type": "draft", "draft": draft},
                    {"id": "approval-part-1", "type": "approval_request", "approval": approval},
                ],
                "run_id": "run-1",
                "status": "waiting_approval",
                "metadata": {},
                "client_message_id": None,
                "created_at": None,
            },
            "run": {"id": "run-1"},
            "events": [],
            "included": {"result_cards": [{"id": "card-1", "type": "ui_actions", "title": "x", "data": {}}], "drafts": [draft], "approvals": [approval]},
        }
        projected = project_ai_chat_response(chat, new_capabilities())
        self.assertEqual(projected["message"]["parts"][0]["type"], "draft")
        self.assertEqual(projected["message"]["parts"][0]["draft"]["schema_version"], RECIPE_COOK_V2)
        self.assertEqual(projected["included"]["drafts"][0]["schema_version"], RECIPE_COOK_V2)
        self.assertEqual(projected["included"]["approvals"][0]["draft_schema_version"], RECIPE_COOK_V2)
        self.assertEqual(len(projected["included"]["result_cards"]), 1)
        # input not mutated
        self.assertEqual(chat["message"]["parts"][0]["type"], "draft")

    def test_old_viewer_chat_response_filters_included_v2(self) -> None:
        draft = {
            "id": "draft-1",
            "schema_version": RECIPE_COOK_V2,
            "draft_type": "recipe_cook",
            "payload": _v2_cook_payload(),
        }
        v1_draft = {
            "id": "draft-v1",
            "schema_version": RECIPE_COOK_V1,
            "draft_type": "recipe_cook",
            "payload": {**_v2_cook_payload(), "schemaVersion": RECIPE_COOK_V1, "createMealLog": True},
        }
        approval = {
            "id": "approval-1",
            "draft_schema_version": RECIPE_COOK_V2,
            "initial_values": {"draft": _v2_cook_payload()},
        }
        chat = {
            "conversation_id": "c1",
            "message": {
                "id": "m1",
                "conversation_id": "c1",
                "role": "assistant",
                "content": "",
                "content_type": "parts",
                "parts": [
                    {"id": "draft-part-1", "type": "draft", "draft": draft},
                    {"id": "text-1", "type": "text", "text": "hello"},
                ],
                "run_id": "run-1",
                "status": "completed",
                "metadata": {},
                "client_message_id": None,
                "created_at": None,
            },
            "run": {"id": "run-1"},
            "events": [],
            "included": {
                "result_cards": [{"id": "card-1", "type": "ui_actions", "title": "x", "data": {}}],
                "drafts": [draft, v1_draft],
                "approvals": [approval],
            },
        }
        projected = project_ai_chat_response(chat, old_capabilities())
        self.assertEqual(projected["message"]["parts"][0]["type"], "error_recovery")
        self.assertEqual(projected["message"]["parts"][1]["type"], "text")
        self.assertEqual([item["id"] for item in projected["included"]["drafts"]], ["draft-v1"])
        self.assertEqual(projected["included"]["approvals"], [])
        self.assertEqual(len(projected["included"]["result_cards"]), 1)

    def test_project_ai_sse_event_projects_progressive_and_final(self) -> None:
        part = {
            "id": "draft-part-1",
            "type": "draft",
            "draft": {
                "id": "draft-1",
                "schema_version": RECIPE_COOK_V2,
                "payload": _v2_cook_payload(),
            },
        }
        event_name, progressive = project_ai_sse_event(
            "message_part",
            {"part": part, "message_id": "m1"},
            viewer_capabilities=old_capabilities(),
        )
        self.assertEqual(event_name, "message_part")
        self.assertEqual(progressive["part"]["type"], "error_recovery")
        self.assertIsNone(progressive["part"].get("draft"))

        chat = {
            "conversation_id": "c1",
            "message": {
                "id": "m1",
                "conversation_id": "c1",
                "role": "assistant",
                "content": "",
                "content_type": "parts",
                "parts": [part],
                "run_id": "run-1",
                "status": "waiting_approval",
                "metadata": {},
                "client_message_id": None,
                "created_at": None,
            },
            "run": {"id": "run-1"},
            "events": [],
            "included": {"drafts": [part["draft"]], "approvals": []},
        }
        event_name, final = project_ai_sse_event("response", chat, viewer_capabilities=old_capabilities())
        self.assertEqual(event_name, "response")
        self.assertEqual(final["message"]["parts"][0]["type"], "error_recovery")
        self.assertEqual(final["included"]["drafts"], [])

    def test_require_viewer_contract_gates_v2(self) -> None:
        require_viewer_contract(RECIPE_COOK_V1, old_capabilities())
        require_viewer_contract(None, old_capabilities())
        with self.assertRaises(ClientContractUpgradeRequired) as raised:
            require_viewer_contract(RECIPE_COOK_V2, old_capabilities())
        self.assertEqual(raised.exception.code, "client_contract_upgrade_required")
        require_viewer_contract(RECIPE_COOK_V2, new_capabilities())

    def test_project_ai_decision_response_and_run_event_are_deep_copies(self) -> None:
        decision = {
            "approval": {
                "id": "a1",
                "draft_schema_version": RECIPE_COOK_V2,
                "initial_values": {"draft": _v2_cook_payload()},
            },
            "draft": {
                "id": "d1",
                "schema_version": RECIPE_COOK_V2,
                "payload": _v2_cook_payload(),
            },
            "operation": {"id": "op-1"},
        }
        projected = project_ai_decision_response(decision, old_capabilities())
        self.assertEqual(projected["approval"]["initial_values"], {})
        self.assertEqual(projected["draft"]["payload"], {})
        self.assertEqual(decision["approval"]["initial_values"]["draft"]["schemaVersion"], RECIPE_COOK_V2)

        event = {
            "id": "e1",
            "part": {
                "id": "draft-part-1",
                "type": "draft",
                "draft": {"id": "d1", "schema_version": RECIPE_COOK_V2, "payload": _v2_cook_payload()},
            },
        }
        projected_event = project_ai_run_event(event, old_capabilities())
        self.assertEqual(projected_event["part"]["type"], "error_recovery")
        self.assertEqual(event["part"]["type"], "draft")


class AIClientProjectionRouteTestCase(AIAgentInfraTestCase):
    def _seed_v2_cook_graph(self, db, *, conversation_id: str = "conversation-projection-v2") -> SimpleNamespace:
        recipe = Recipe(
            id="recipe-projection-cook",
            family_id=self.family.id,
            title="投影番茄炒蛋",
            servings=2,
            prep_minutes=10,
            difficulty=Difficulty.EASY,
            tips="",
            scene_tags=["家常菜"],
            created_by=self.user.id,
            updated_by=self.user.id,
        )
        db.add(recipe)
        db.flush()
        db.add(
            RecipeIngredient(
                id="recipe-projection-ingredient",
                recipe_id=recipe.id,
                ingredient_id="ingredient-tomato",
                ingredient_name="番茄",
                quantity=1,
                unit="个",
                note="",
                sort_order=0,
            )
        )
        food = Food(
            id="food-projection-cook",
            family_id=self.family.id,
            name="投影番茄炒蛋",
            type=FoodType.SELF_MADE,
            category="家常菜",
            flavor_tags=[],
            scene_tags=["家常菜"],
            suitable_meal_types=["dinner"],
            source_name="自家菜谱",
            purchase_source="",
            scene="晚餐",
            notes="",
            routine_note="",
            recipe_id=recipe.id,
            created_by=self.user.id,
            updated_by=self.user.id,
        )
        db.add(food)
        db.flush()
        plan_item = FoodPlanItem(
            id="plan-projection-cook",
            family_id=self.family.id,
            user_id=self.user.id,
            food_id=food.id,
            plan_date=date.today(),
            meal_type=MealType.DINNER,
            note="",
            status="planned",
            created_by=self.user.id,
            updated_by=self.user.id,
        )
        db.add(plan_item)
        conversation = AIConversation(
            id=conversation_id,
            family_id=self.family.id,
            owner_user_id=self.user.id,
            visibility=AIConversationVisibility.PRIVATE,
            mode=AiMode.RECOMMENDATION,
            prompt="做菜",
            response="",
            created_by=self.user.id,
            context={
                "activeRunId": "run-projection-v2",
                "fastApprovalDecisions": {"approval-projection-v2": {"draft": _v2_cook_payload()}},
                "internal": "secret",
            },
            title="投影会话",
            summary="",
            status="active",
        )
        db.add(conversation)
        db.flush()
        message = AIMessage(
            id="message-projection-v2",
            family_id=self.family.id,
            conversation_id=conversation.id,
            role="assistant",
            content="",
            content_type="parts",
            parts=[],
            status="waiting_approval",
            message_metadata={
                "unrelatedMetric": 7,
                "artifacts": [
                    {
                        "id": "human_in_loop:approval-projection-v2",
                        "type": "approval_decision",
                        "payload": {
                            "draft": {
                                "schema_version": RECIPE_COOK_V2,
                                "payload": _v2_cook_payload(recipe_id=recipe.id),
                            }
                        },
                    },
                    {"id": "entity:keep", "type": "meal_plan", "payload": {"id": "keep"}},
                ],
            },
            created_by=self.user.id,
        )
        db.add(message)
        db.flush()
        service = AIApplicationService(db, provider=FakeChatProvider())
        draft, approval = service._create_draft_approval(
            family_id=self.family.id,
            user_id=self.user.id,
            conversation_id=conversation.id,
            message_id=message.id,
            run_id=None,
            draft_payload={
                "draft_type": "recipe_cook",
                "schema_version": RECIPE_COOK_V2,
                "payload": {
                    "draftType": "recipe_cook",
                    "schemaVersion": RECIPE_COOK_V2,
                    "recipeId": recipe.id,
                    "servings": 1,
                    "date": date.today().isoformat(),
                    "mealType": "dinner",
                    "planItemId": plan_item.id,
                    "notes": "projection",
                    "resultNote": "",
                    "adjustments": "",
                },
            },
        )
        message.parts = [
            {
                "id": f"draft-part-{draft.id}",
                "type": "draft",
                "draft": jsonable_encoder(serialize_ai_task_draft(draft)),
            },
            {
                "id": f"approval-part-{approval.id}",
                "type": "approval_request",
                "approval": jsonable_encoder(serialize_ai_approval_request(approval)),
            },
        ]
        db.flush()
        db.commit()
        return SimpleNamespace(
            conversation=conversation,
            message=message,
            draft=draft,
            approval=approval,
            recipe=recipe,
            plan_item=plan_item,
        )

    def test_conversation_list_and_visibility_project_public_context(self) -> None:
        with self.SessionLocal() as db:
            seeded = self._seed_v2_cook_graph(db)
            conversation_id = seeded.conversation.id

        listed = self.client.get("/api/ai/conversations")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.headers.get("Cache-Control"), "private, no-store")
        self.assertEqual(listed.headers.get("Vary"), AI_DRAFT_CONTRACTS_HEADER)
        row = next(item for item in listed.json() if item["id"] == conversation_id)
        self.assertEqual(row["context"], {"activeRunId": "run-projection-v2"})
        self.assertNotIn("fastApprovalDecisions", row["context"])

        visibility = self.client.patch(
            f"/api/ai/conversations/{conversation_id}/visibility",
            json={"visibility": "family"},
        )
        self.assertEqual(visibility.status_code, 200, visibility.text)
        self.assertEqual(visibility.headers.get("Cache-Control"), "private, no-store")
        self.assertEqual(visibility.json()["context"], {"activeRunId": "run-projection-v2"})

        with self.SessionLocal() as db:
            conversation = db.get(AIConversation, conversation_id)
            assert conversation is not None
            self.assertIn("fastApprovalDecisions", conversation.context)

    def test_history_projects_old_viewer_parts_and_metadata(self) -> None:
        with self.SessionLocal() as db:
            seeded = self._seed_v2_cook_graph(db)
            conversation_id = seeded.conversation.id
            message_id = seeded.message.id
            canonical_parts = copy.deepcopy(seeded.message.parts)
            canonical_metadata = copy.deepcopy(seeded.message.message_metadata)

        history = self.client.get(f"/api/ai/conversations/{conversation_id}/messages")
        self.assertEqual(history.status_code, 200, history.text)
        self.assertEqual(history.headers.get("Cache-Control"), "private, no-store")
        message = next(item for item in history.json() if item["id"] == message_id)
        self.assertTrue(all(part.get("type") == "error_recovery" for part in message["parts"]))
        self.assertTrue(all(part.get("draft") is None for part in message["parts"]))
        self.assertTrue(all(not artifact_contains_v2_command(item) for item in message["metadata"]["artifacts"]))
        self.assertEqual(message["metadata"]["unrelatedMetric"], 7)

        capable = self.client.get(
            f"/api/ai/conversations/{conversation_id}/messages",
            headers={AI_DRAFT_CONTRACTS_HEADER: f"{RECIPE_COOK_V1},{RECIPE_COOK_V2}"},
        )
        self.assertEqual(capable.status_code, 200, capable.text)
        capable_message = next(item for item in capable.json() if item["id"] == message_id)
        self.assertEqual(capable_message["parts"][0]["type"], "draft")
        self.assertEqual(capable_message["parts"][0]["draft"]["schema_version"], RECIPE_COOK_V2)

        with self.SessionLocal() as db:
            message_row = db.get(AIMessage, message_id)
            assert message_row is not None
            self.assertEqual(message_row.parts, canonical_parts)
            self.assertEqual(message_row.message_metadata, canonical_metadata)

    def test_pending_and_decision_reject_old_viewer_without_mutation(self) -> None:
        with self.SessionLocal() as db:
            seeded = self._seed_v2_cook_graph(db)
            conversation_id = seeded.conversation.id
            approval_id = seeded.approval.id
            draft_id = seeded.draft.id
            draft_version = seeded.draft.version
            approval_status = seeded.approval.status
            draft_status = seeded.draft.status
            draft_payload = copy.deepcopy(seeded.draft.payload)

        pending = self.client.get(f"/api/ai/conversations/{conversation_id}/approvals/pending")
        self.assertEqual(pending.status_code, 409, pending.text)
        self.assertEqual(pending.json()["detail"]["code"], "client_contract_upgrade_required")

        decision = self.client.post(
            f"/api/ai/conversations/{conversation_id}/approvals/{approval_id}/decision",
            json={"decision": "approved", "draft_version": draft_version, "values": {}},
        )
        self.assertEqual(decision.status_code, 409, decision.text)
        self.assertEqual(decision.json()["detail"]["code"], "client_contract_upgrade_required")

        with self.client.stream(
            "POST",
            f"/api/ai/conversations/{conversation_id}/approvals/{approval_id}/decision/stream",
            json={"decision": "approved", "draft_version": draft_version, "values": {}},
        ) as stream:
            body = "".join(stream.iter_text())
            self.assertEqual(stream.status_code, 200)
            self.assertIn("client_contract_upgrade_required", body)

        with self.SessionLocal() as db:
            approval = db.get(AIApprovalRequest, approval_id)
            draft = db.get(AITaskDraft, draft_id)
            assert approval is not None and draft is not None
            self.assertEqual(approval.status, approval_status)
            self.assertEqual(draft.status, draft_status)
            self.assertEqual(draft.payload, draft_payload)
            self.assertEqual(db.scalar(select(func.count()).select_from(AIOperation)), 0)

        capable_pending = self.client.get(
            f"/api/ai/conversations/{conversation_id}/approvals/pending",
            headers={AI_DRAFT_CONTRACTS_HEADER: f"{RECIPE_COOK_V1},{RECIPE_COOK_V2}"},
        )
        self.assertEqual(capable_pending.status_code, 200, capable_pending.text)
        self.assertEqual(capable_pending.json()[0]["draft_schema_version"], RECIPE_COOK_V2)
        self.assertEqual(capable_pending.headers.get("Cache-Control"), "private, no-store")

    def test_chat_response_projection_filters_included_v2(self) -> None:
        draft = {
            "id": "draft-chat-v2",
            "conversation_id": "c-chat",
            "message_id": "m-chat",
            "run_id": "run-chat",
            "draft_type": "recipe_cook",
            "payload": _v2_cook_payload(),
            "preview_summary": "做菜",
            "status": "pending",
            "version": 1,
            "schema_version": RECIPE_COOK_V2,
            "validation_errors": [],
            "expires_at": None,
            "created_at": "2026-07-12T00:00:00+00:00",
            "updated_at": "2026-07-12T00:00:00+00:00",
        }
        approval = {
            "id": "approval-chat-v2",
            "conversation_id": "c-chat",
            "message_id": "m-chat",
            "run_id": "run-chat",
            "draft_id": "draft-chat-v2",
            "draft_version": 1,
            "draft_schema_version": RECIPE_COOK_V2,
            "approval_type": "recipe.cook",
            "status": "pending",
            "title": "确认做菜",
            "instruction": "x",
            "approve_label": "确认",
            "reject_label": "拒绝",
            "require_reject_comment": False,
            "failure_summary": None,
            "field_schema": [],
            "initial_values": {"draft": _v2_cook_payload()},
            "submitted_values": {},
            "decision": None,
            "comment": None,
            "resolved_at": None,
            "expires_at": None,
            "created_at": "2026-07-12T00:00:00+00:00",
        }
        chat_payload = {
            "conversation_id": "c-chat",
            "message": {
                "id": "m-chat",
                "conversation_id": "c-chat",
                "role": "assistant",
                "content": "ok",
                "content_type": "parts",
                "parts": [
                    {"id": "draft-part-chat", "type": "draft", "draft": draft},
                    {"id": "approval-part-chat", "type": "approval_request", "approval": approval},
                ],
                "run_id": "run-chat",
                "status": "waiting_approval",
                "metadata": {},
                "client_message_id": None,
                "created_at": "2026-07-12T00:00:00+00:00",
            },
            "run": {
                "id": "run-chat",
                "agent_key": "workspace",
                "intent": "chat",
                "status": "waiting_approval",
                "model": "fake",
                "created_at": "2026-07-12T00:00:00+00:00",
            },
            "events": [],
            "included": {"result_cards": [], "drafts": [draft], "approvals": [approval]},
        }

        with patch.object(AIApplicationService, "chat", return_value=copy.deepcopy(chat_payload)):
            old = self.client.post("/api/ai/chat", json={"message": "做菜"})
        self.assertEqual(old.status_code, 200, old.text)
        body = old.json()
        self.assertTrue(all(part["type"] == "error_recovery" for part in body["message"]["parts"]))
        self.assertEqual(body["included"]["drafts"], [])
        self.assertEqual(body["included"]["approvals"], [])
        self.assertEqual(old.headers.get("Cache-Control"), "private, no-store")

        with patch.object(AIApplicationService, "chat", return_value=copy.deepcopy(chat_payload)):
            new = self.client.post(
                "/api/ai/chat",
                json={"message": "做菜"},
                headers={AI_DRAFT_CONTRACTS_HEADER: f"{RECIPE_COOK_V1},{RECIPE_COOK_V2}"},
            )
        self.assertEqual(new.status_code, 200, new.text)
        new_body = new.json()
        self.assertEqual(new_body["included"]["drafts"][0]["schema_version"], RECIPE_COOK_V2)
        self.assertEqual(new_body["message"]["parts"][0]["type"], "draft")

    def test_stream_projects_progressive_message_part(self) -> None:
        part = {
            "id": "draft-part-stream",
            "type": "draft",
            "draft": {
                "id": "draft-stream",
                "schema_version": RECIPE_COOK_V2,
                "payload": _v2_cook_payload(),
                "draft_type": "recipe_cook",
                "preview_summary": "x",
                "status": "pending",
                "version": 1,
                "validation_errors": [],
                "conversation_id": "c",
                "message_id": "m",
                "run_id": "r",
                "expires_at": None,
                "created_at": "2026-07-12T00:00:00+00:00",
                "updated_at": "2026-07-12T00:00:00+00:00",
            },
        }
        final = {
            "conversation_id": "c",
            "message": {
                "id": "m",
                "conversation_id": "c",
                "role": "assistant",
                "content": "",
                "content_type": "parts",
                "parts": [part],
                "run_id": "r",
                "status": "waiting_approval",
                "metadata": {},
                "client_message_id": None,
                "created_at": "2026-07-12T00:00:00+00:00",
            },
            "run": {
                "id": "r",
                "agent_key": "workspace",
                "intent": "chat",
                "status": "waiting_approval",
                "model": "fake",
                "created_at": "2026-07-12T00:00:00+00:00",
            },
            "events": [],
            "included": {"result_cards": [], "drafts": [part["draft"]], "approvals": []},
        }

        def fake_stream(**kwargs):
            yield ("message_part", {"part": part, "message_id": "m"})
            yield ("response", final)

        with patch.object(AIApplicationService, "stream_chat", side_effect=lambda **kwargs: fake_stream(**kwargs)):
            with self.client.stream("POST", "/api/ai/chat/stream", json={"message": "做菜"}) as response:
                body = "".join(response.iter_text())
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers.get("Vary"), AI_DRAFT_CONTRACTS_HEADER)

        self.assertIn("error_recovery", body)
        self.assertNotIn(RECIPE_COOK_V2, body)
        # final response also projected
        events = [chunk for chunk in body.split("\n\n") if chunk.strip()]
        self.assertTrue(any("event: message_part" in chunk for chunk in events))
        self.assertTrue(any("event: response" in chunk for chunk in events))
        for chunk in events:
            if "event: message_part" in chunk or "event: response" in chunk:
                payload = json.loads(chunk.split("data: ", 1)[1])
                serialized = json.dumps(payload, ensure_ascii=False)
                self.assertNotIn(RECIPE_COOK_V2, serialized)

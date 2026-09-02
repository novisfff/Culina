from __future__ import annotations

import copy
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any, cast

from fastapi.encoders import jsonable_encoder
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.enums import ActivityAction, MembershipStatus, UserRole
from app.models.domain import AIOperation, AITaskDraft, Membership
from app.schemas.ai import AIPublicOperationResultCardDTO
from app.schemas.ai_auto_execution import AIRevertResponseDTO
from app.repos.ai_operations import (
    find_ai_operation_by_revert_request_id,
    find_ai_operation_by_revert_request_id_for_update,
    get_family_ai_operation_for_update,
)
from app.services.activity import log_activity
from app.services.ai_auto_execution.policy_types import (
    AICacheScope,
    AIOperationResultProjection,
)
from app.services.ai_operations.messages import find_message_operation_result_card
from app.services.ai_operations.result_projection import (
    build_operation_result_card,
    hydrate_operation_result_server_now,
    operation_result_artifacts,
    project_ai_operation_result,
    serialize_ai_operation_result_projection,
    upsert_message_operation_result,
)
from app.services.ai_operations.status import DRAFT_REVERTED, is_operation_completed
from app.services.ai_revert.errors import AIRevertError, ai_revert_error
from app.services.ai_revert.registry import (
    AIRevertAdapterRegistry,
    ai_revert_adapter_registry,
)
from app.services.ai_revert.types import (
    AIRevertContext,
    AIRevertResponse,
    AIRevertResult,
)


VALID_CACHE_SCOPES = frozenset(
    {"food", "meal_log", "meal_plan", "shopping_list", "inventory", "ai_conversation"}
)
PERMANENT_REVERT_CODES = frozenset(
    {
        "revert_target_changed",
        "revert_dependency_exists",
        "revert_adapter_version_unsupported",
    }
)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _normalize_cache_scopes(values: object) -> tuple[AICacheScope, ...]:
    if not isinstance(values, (tuple, list)):
        return ("ai_conversation",)
    normalized: list[AICacheScope] = []
    for value in values:
        if value not in VALID_CACHE_SCOPES or value in normalized:
            continue
        normalized.append(cast(AICacheScope, value))
    if "ai_conversation" not in normalized:
        normalized.append("ai_conversation")
    return tuple(normalized)


class AIRevertCoordinator:
    registry: AIRevertAdapterRegistry = ai_revert_adapter_registry

    @classmethod
    def revert(
        cls,
        db: Session,
        *,
        family_id: str,
        actor_user_id: str,
        actor_role: UserRole,
        operation_id: str,
        client_request_id: str,
        now: datetime,
    ) -> AIRevertResponse:
        del actor_role  # The locked Membership row is the authorization authority.
        operation = get_family_ai_operation_for_update(
            db,
            family_id=family_id,
            operation_id=operation_id,
        )
        if operation is None:
            raise ai_revert_error(
                "operation_not_revertible",
                status_code=404,
                message="未找到该操作",
            )

        current_actor_role = cls._authorize_current_actor(
            db,
            operation=operation,
            family_id=family_id,
            actor_user_id=actor_user_id,
        )

        # A locking miss on MySQL takes a gap lock. Two concurrent misses can
        # then deadlock while claiming the same unique request ID. The unique
        # constraint is the write authority; only the post-conflict current
        # read below needs FOR UPDATE.
        request_owner = find_ai_operation_by_revert_request_id(
            db,
            client_request_id=client_request_id,
        )
        if request_owner is not None and request_owner.id != operation.id:
            raise ai_revert_error("revert_request_id_reused")

        if operation.revert_request_id == client_request_id:
            return cls._replay_existing_result(
                operation=operation,
                now=now,
            )

        cls._validate_revertible_state(operation)
        if operation.revertible_until is None or _as_utc(now) > _as_utc(operation.revertible_until):
            raise ai_revert_error("revert_expired")

        adapter = cls.registry.require(str(operation.revert_adapter_key or ""))
        revert_context = operation.revert_context_json
        if not isinstance(revert_context, dict):
            raise ai_revert_error("operation_not_revertible")
        context_schema_version = revert_context.get("schema_version")
        if (
            type(context_schema_version) is not int
            or context_schema_version != adapter.schema_version
        ):
            error = ai_revert_error("revert_adapter_version_unsupported")
            cls._record_permanent_conflict(
                db,
                operation=operation,
                client_request_id=client_request_id,
                now=now,
                code=error.code,
            )
            response = cls._build_public_response(
                db,
                operation=operation,
                entities=cls._existing_public_entities(db, operation=operation),
                cache_scopes=cls._stored_cache_scopes(operation),
                now=now,
                replayed=False,
            )
            operation.revert_result_json = cls._blocked_result_json(error.code, response=response)
            db.flush()
            error.response = response
            raise error

        try:
            with db.begin_nested():
                result = adapter.revert(
                    AIRevertContext(
                        db=db,
                        operation=operation,
                        family_id=family_id,
                        actor_user_id=actor_user_id,
                        actor_role=current_actor_role,
                        now=_as_utc(now),
                    )
                )
                cls._validate_adapter_result(result)
                operation.status = "reverted"
                operation.revert_request_id = client_request_id
                operation.reverted_at = _as_utc(now)
                operation.reverted_by = actor_user_id
                operation.revert_blocked_at = None
                operation.revert_blocked_code = None
                draft = cls._require_draft(db, operation=operation)
                draft.status = DRAFT_REVERTED
                draft.updated_by = actor_user_id
                response = cls._build_public_response(
                    db,
                    operation=operation,
                    entities=result.entities,
                    cache_scopes=_normalize_cache_scopes(result.cache_scopes),
                    now=now,
                    replayed=False,
                )
                operation.revert_result_json = {
                    "status": "reverted",
                    "result_json": copy.deepcopy(jsonable_encoder(result.result_json)),
                    "cache_scopes": list(response.cache_scopes),
                    "public_response": cls._serialize_public_response(response),
                }
                log_activity(
                    db,
                    family_id=operation.family_id,
                    actor_id=actor_user_id,
                    action=ActivityAction.REVERT,
                    entity_type="ai_operation",
                    entity_id=operation.id,
                    summary="撤销了 AI 操作",
                )
                db.flush()
            return response
        except IntegrityError:
            cls._raise_request_race_if_claimed(
                db,
                operation_id=operation.id,
                client_request_id=client_request_id,
            )
            raise
        except AIRevertError as error:
            if not error.permanent_block or error.code not in PERMANENT_REVERT_CODES:
                raise
            canonical = ai_revert_error(error.code)
            cls._record_permanent_conflict(
                db,
                operation=operation,
                client_request_id=client_request_id,
                now=now,
                code=canonical.code,
            )
            response = cls._build_public_response(
                db,
                operation=operation,
                entities=cls._existing_public_entities(db, operation=operation),
                cache_scopes=cls._stored_cache_scopes(operation),
                now=now,
                replayed=False,
            )
            operation.revert_result_json = cls._blocked_result_json(
                canonical.code,
                response=response,
            )
            db.flush()
            canonical.response = response
            raise canonical

    @classmethod
    def hydrate_response(
        cls,
        response: AIRevertResponse,
        *,
        server_now: datetime,
    ) -> AIRevertResponse:
        del cls
        response_now = _as_utc(server_now)
        projection = replace(response.projection, server_now=response_now)
        return AIRevertResponse(
            projection=projection,
            result_card=hydrate_operation_result_server_now(response.result_card, response_now),
            cache_scopes=response.cache_scopes,
            server_now=response_now,
            replayed=response.replayed,
        )

    @classmethod
    def _authorize_current_actor(
        cls,
        db: Session,
        *,
        operation: AIOperation,
        family_id: str,
        actor_user_id: str,
    ) -> UserRole:
        del cls
        membership = db.scalar(
            select(Membership).where(
                Membership.family_id == family_id,
                Membership.user_id == actor_user_id,
                Membership.status == MembershipStatus.ACTIVE,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
        if membership is None:
            raise ai_revert_error("revert_forbidden")
        if operation.actor_user_id != actor_user_id and membership.role != UserRole.OWNER:
            raise ai_revert_error("revert_forbidden")
        return membership.role

    @classmethod
    def _validate_revertible_state(cls, operation: AIOperation) -> None:
        del cls
        if not is_operation_completed(operation.status):
            raise ai_revert_error("operation_not_revertible")
        if operation.revert_blocked_code:
            raise ai_revert_error("operation_not_revertible")
        if (
            not operation.revert_adapter_key
            or not isinstance(operation.revert_context_json, dict)
            or not operation.revert_context_json
            or operation.revertible_until is None
        ):
            raise ai_revert_error("operation_not_revertible")

    @classmethod
    def _validate_adapter_result(cls, result: AIRevertResult) -> None:
        del cls
        if not isinstance(result, AIRevertResult):
            raise TypeError("AI revert adapter must return AIRevertResult")
        if any(scope not in VALID_CACHE_SCOPES for scope in result.cache_scopes):
            raise ValueError("AI revert adapter returned an invalid cache scope")

    @classmethod
    def _require_draft(cls, db: Session, *, operation: AIOperation) -> AITaskDraft:
        del cls
        draft = db.get(AITaskDraft, operation.draft_id)
        if draft is None or draft.family_id != operation.family_id:
            raise ai_revert_error("operation_not_revertible")
        return draft

    @classmethod
    def _record_permanent_conflict(
        cls,
        db: Session,
        *,
        operation: AIOperation,
        client_request_id: str,
        now: datetime,
        code: str,
    ) -> None:
        del cls
        try:
            with db.begin_nested():
                operation.revert_request_id = client_request_id
                operation.revert_blocked_at = _as_utc(now)
                operation.revert_blocked_code = code
                operation.reverted_by = None
                db.flush()
        except IntegrityError:
            AIRevertCoordinator._raise_request_race_if_claimed(
                db,
                operation_id=operation.id,
                client_request_id=client_request_id,
            )
            raise

    @classmethod
    def _raise_request_race_if_claimed(
        cls,
        db: Session,
        *,
        operation_id: str,
        client_request_id: str,
    ) -> None:
        del cls
        claimed = find_ai_operation_by_revert_request_id_for_update(
            db,
            client_request_id=client_request_id,
        )
        if claimed is not None and claimed.id != operation_id:
            raise ai_revert_error("revert_request_id_reused")

    @classmethod
    def _replay_existing_result(
        cls,
        *,
        operation: AIOperation,
        now: datetime,
    ) -> AIRevertResponse:
        response = cls.hydrate_response(
            cls._load_stored_public_response(operation=operation),
            server_now=now,
        )
        if operation.status == "reverted" and not operation.revert_blocked_code:
            return response
        if operation.revert_blocked_code in PERMANENT_REVERT_CODES:
            error = ai_revert_error(operation.revert_blocked_code, response=response)
            raise error
        raise ai_revert_error("operation_not_revertible")

    @classmethod
    def _load_stored_public_response(
        cls,
        *,
        operation: AIOperation,
    ) -> AIRevertResponse:
        stored_result = operation.revert_result_json
        if not isinstance(stored_result, dict):
            raise ai_revert_error("operation_not_revertible")
        raw_response = stored_result.get("public_response")
        if not isinstance(raw_response, dict):
            raise ai_revert_error("operation_not_revertible")
        try:
            parsed = AIRevertResponseDTO.model_validate(raw_response)
            parsed_card = AIPublicOperationResultCardDTO.model_validate(parsed.result_card)
        except ValidationError as exc:
            raise ai_revert_error("operation_not_revertible") from exc

        projection = parsed.projection
        card_data = parsed_card.data
        expected_card_id = f"operation-result:{operation.draft_id}"
        projection_fields = tuple(type(projection).model_fields)
        card_projection = card_data.model_dump(
            mode="python",
            include=set(projection_fields),
        )
        card_projection["entities"] = [
            entity.model_dump(mode="python", exclude_none=True)
            for entity in card_data.entities
        ]
        if (
            parsed.replayed is not False
            or projection.draft_id != operation.draft_id
            or projection.operation_id != operation.id
            or parsed_card.id != expected_card_id
            or card_data.draft_id != operation.draft_id
            or card_data.draftId != operation.draft_id
            or card_data.operation_id != operation.id
            or card_data.operationId != operation.id
            or card_projection != projection.model_dump(mode="python")
            or parsed.cache_scopes != projection.cache_scopes
            or parsed.cache_scopes != card_data.cache_scopes
            or parsed.server_now != projection.server_now
            or parsed.server_now != card_data.server_now
            or parsed.server_now.tzinfo is None
            or stored_result.get("cache_scopes") != parsed.cache_scopes
        ):
            raise ai_revert_error("operation_not_revertible")

        if operation.status == "reverted" and not operation.revert_blocked_code:
            valid_terminal_state = (
                stored_result.get("status") == "reverted"
                and stored_result.get("code") is None
                and projection.result_status == "reverted"
                and projection.operation_status == "reverted"
                and projection.revert_availability == "reverted"
                and projection.revert_blocked_code is None
            )
        elif is_operation_completed(operation.status) and (
            operation.revert_blocked_code in PERMANENT_REVERT_CODES
        ):
            valid_terminal_state = (
                stored_result.get("status") == "blocked"
                and stored_result.get("code") == operation.revert_blocked_code
                and projection.result_status == "completed"
                and projection.operation_status == "completed"
                and projection.revert_availability == "blocked"
                and projection.revert_blocked_code == operation.revert_blocked_code
            )
        else:
            valid_terminal_state = False
        if not valid_terminal_state:
            raise ai_revert_error("operation_not_revertible")

        response_projection = AIOperationResultProjection(
            draft_id=projection.draft_id,
            operation_id=projection.operation_id,
            result_status=projection.result_status,
            execution_mode=projection.execution_mode,
            operation_status=projection.operation_status,
            execution_explanation=projection.execution_explanation,
            revert_availability=projection.revert_availability,
            revertible_until=projection.revertible_until,
            revert_blocked_code=projection.revert_blocked_code,
            server_now=_as_utc(projection.server_now),
            entities=tuple(copy.deepcopy(projection.entities)),
            cache_scopes=tuple(parsed.cache_scopes),
        )
        return AIRevertResponse(
            projection=response_projection,
            result_card=copy.deepcopy(raw_response["result_card"]),
            cache_scopes=tuple(parsed.cache_scopes),
            server_now=_as_utc(parsed.server_now),
            replayed=True,
        )

    @classmethod
    def _build_public_response(
        cls,
        db: Session,
        *,
        operation: AIOperation,
        entities: tuple[dict[str, Any], ...],
        cache_scopes: tuple[AICacheScope, ...],
        now: datetime,
        replayed: bool,
    ) -> AIRevertResponse:
        draft = cls._require_draft(db, operation=operation)
        current_card = find_message_operation_result_card(
            db,
            message_id=draft.message_id,
            draft_id=draft.id,
            family_id=draft.family_id,
        ) or {}
        current_data = current_card.get("data") if isinstance(current_card.get("data"), dict) else {}
        projection = project_ai_operation_result(
            draft=draft,
            operation=operation,
            entities=entities,
            cache_scopes=cache_scopes,
            server_now=now,
        )
        card = build_operation_result_card(
            projection,
            title=str(current_card.get("title") or "AI 操作结果"),
            workspace_label=str(current_data.get("workspaceLabel") or "相关页面"),
            approval_id=(
                str(current_data.get("approvalId"))
                if current_data.get("approvalId")
                else None
            ),
            workspace_hint=(
                str(current_data.get("workspaceHint"))
                if current_data.get("workspaceHint")
                else None
            ),
        )
        result_part = upsert_message_operation_result(
            db,
            message_id=draft.message_id,
            projection=projection,
            card=card,
            artifacts=operation_result_artifacts(projection, card=card),
            approval_id=operation.approval_request_id,
        )
        if not result_part:
            raise ai_revert_error("operation_not_revertible")
        return AIRevertResponse(
            projection=projection,
            result_card=card,
            cache_scopes=cache_scopes,
            server_now=_as_utc(now),
            replayed=replayed,
        )

    @classmethod
    def _stored_cache_scopes(cls, operation: AIOperation) -> tuple[AICacheScope, ...]:
        del cls
        result = operation.result_json if isinstance(operation.result_json, dict) else {}
        return _normalize_cache_scopes(result.get("cache_scopes"))

    @classmethod
    def _existing_public_entities(
        cls,
        db: Session,
        *,
        operation: AIOperation,
    ) -> tuple[dict[str, Any], ...]:
        draft = cls._require_draft(db, operation=operation)
        card = find_message_operation_result_card(
            db,
            message_id=draft.message_id,
            draft_id=draft.id,
            family_id=draft.family_id,
        ) or {}
        data = card.get("data") if isinstance(card.get("data"), dict) else {}
        values = data.get("entities") if isinstance(data.get("entities"), list) else []
        return tuple(copy.deepcopy(value) for value in values if isinstance(value, dict))

    @classmethod
    def _blocked_result_json(
        cls,
        code: str,
        *,
        response: AIRevertResponse,
    ) -> dict[str, Any]:
        del cls
        return {
            "status": "blocked",
            "code": code,
            "cache_scopes": list(response.cache_scopes),
            "public_response": AIRevertCoordinator._serialize_public_response(response),
        }

    @classmethod
    def _serialize_public_response(cls, response: AIRevertResponse) -> dict[str, Any]:
        del cls
        return {
            "projection": serialize_ai_operation_result_projection(response.projection),
            "result_card": copy.deepcopy(jsonable_encoder(response.result_card)),
            "cache_scopes": list(response.cache_scopes),
            "server_now": jsonable_encoder(response.server_now),
            "replayed": response.replayed,
        }

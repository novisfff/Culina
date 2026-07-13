from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import MealType
from app.core.utils import create_id
from app.models.domain import RecipeCookLog
from app.schemas.recipes import CookRecipeResponse

COMPLETION_RESULT_VERSION = 1
IDEMPOTENCY_KEY_REUSED_CODE = "idempotency_key_reused"
IDEMPOTENCY_KEY_REUSED_MESSAGE = "相同请求标识已用于不同内容，请使用新的请求标识"
COMPLETION_RESULT_VERSION_UNSUPPORTED_CODE = "completion_result_version_unsupported"
COMPLETION_RESULT_VERSION_UNSUPPORTED_MESSAGE = "完成结果版本不受支持，无法安全重放"


@dataclass(frozen=True, slots=True)
class RecipeCookInventoryExpectation:
    ingredient_boundaries: tuple[dict[str, Any], ...]
    preview_items: tuple[dict[str, Any], ...]
    shortages: tuple[dict[str, Any], ...]


@dataclass(frozen=True, slots=True)
class RecipeCookCompletionCommand:
    completion_request_id: str
    family_id: str
    actor_user_id: str
    recipe_id: str
    cook_date: date
    meal_type: MealType
    servings: Decimal
    participant_user_ids: tuple[str, ...]
    notes: str
    food_plan_item_id: str | None
    food_plan_item_base_updated_at: datetime | None
    result_note: str
    adjustments: str
    rating: int | None
    allow_partial_inventory_deduction: bool
    inventory_expectation: RecipeCookInventoryExpectation | None = None


class CompletionConflict(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _decimal_string(value: Decimal) -> str:
    normalized = value.normalize()
    return "0" if normalized == 0 else format(normalized, "f")


def canonicalize_completion_command(command: RecipeCookCompletionCommand) -> dict[str, Any]:
    """Build the stable business payload used for completion request hashing.

    Intentionally excludes completion_request_id, replayed, and other
    transport-only fields so retries with the same business intent hash equal.
    """
    return {
        "family_id": command.family_id,
        "actor_user_id": command.actor_user_id,
        "recipe_id": command.recipe_id,
        "cook_date": command.cook_date.isoformat(),
        "meal_type": command.meal_type.value,
        "servings": _decimal_string(command.servings),
        "participant_user_ids": sorted(set(command.participant_user_ids)),
        "notes": command.notes,
        "food_plan_item_id": command.food_plan_item_id,
        "food_plan_item_base_updated_at": (
            command.food_plan_item_base_updated_at.isoformat()
            if command.food_plan_item_base_updated_at
            else None
        ),
        "result_note": command.result_note,
        "adjustments": command.adjustments,
        "rating": command.rating,
        "allow_partial_inventory_deduction": command.allow_partial_inventory_deduction,
        "inventory_expectation": jsonable_encoder(command.inventory_expectation),
    }


def hash_completion_command(command: RecipeCookCompletionCommand) -> str:
    encoded = json.dumps(
        canonicalize_completion_command(command),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def encode_completion_result(response: CookRecipeResponse) -> dict[str, Any]:
    payload = response.model_dump(mode="json")
    payload.pop("replayed", None)
    return {"version": COMPLETION_RESULT_VERSION, "response": payload}


def load_completion_replay_if_present(
    db: Session,
    *,
    family_id: str,
    completion_request_id: str,
    request_hash: str,
) -> CookRecipeResponse | None:
    """Return a replayed response when a claim already exists.

    Returns None only when no claim row is present. An existing claim with a
    mismatched hash, missing result, or unsupported envelope raises
    CompletionConflict and never re-executes the cook path.
    """
    claim = db.scalar(
        select(RecipeCookLog).where(
            RecipeCookLog.family_id == family_id,
            RecipeCookLog.completion_request_id == completion_request_id,
        )
    )
    if claim is None:
        return None
    if claim.completion_request_hash != request_hash:
        raise CompletionConflict(IDEMPOTENCY_KEY_REUSED_CODE, IDEMPOTENCY_KEY_REUSED_MESSAGE)

    envelope = claim.completion_result_json
    if not isinstance(envelope, dict):
        raise CompletionConflict(
            COMPLETION_RESULT_VERSION_UNSUPPORTED_CODE,
            COMPLETION_RESULT_VERSION_UNSUPPORTED_MESSAGE,
        )
    if envelope.get("version") != COMPLETION_RESULT_VERSION:
        raise CompletionConflict(
            COMPLETION_RESULT_VERSION_UNSUPPORTED_CODE,
            COMPLETION_RESULT_VERSION_UNSUPPORTED_MESSAGE,
        )
    response_payload = envelope.get("response")
    if not isinstance(response_payload, dict):
        raise CompletionConflict(
            COMPLETION_RESULT_VERSION_UNSUPPORTED_CODE,
            COMPLETION_RESULT_VERSION_UNSUPPORTED_MESSAGE,
        )

    try:
        response = CookRecipeResponse.model_validate(response_payload)
    except Exception as exc:  # pydantic ValidationError and similar
        raise CompletionConflict(
            COMPLETION_RESULT_VERSION_UNSUPPORTED_CODE,
            COMPLETION_RESULT_VERSION_UNSUPPORTED_MESSAGE,
        ) from exc
    return response.model_copy(update={"replayed": True})


def claim_completion(
    db: Session,
    *,
    command: RecipeCookCompletionCommand,
    request_hash: str,
) -> RecipeCookLog:
    """Insert the first-write completion claim row and flush.

    Called after read locks and before inventory/MealLog/plan/activity writes.
    On unique conflict the IntegrityError propagates so the caller can roll back
    and load the winner through load_completion_replay_if_present.
    """
    cook_log = RecipeCookLog(
        id=create_id("recipe-cook"),
        family_id=command.family_id,
        recipe_id=command.recipe_id,
        meal_log_id=None,
        cook_date=command.cook_date,
        meal_type=command.meal_type,
        servings=command.servings,
        result_note=command.result_note,
        adjustments=command.adjustments,
        rating=command.rating,
        completion_request_id=command.completion_request_id,
        completion_request_hash=request_hash,
        completion_result_json=None,
        created_by=command.actor_user_id,
        updated_by=command.actor_user_id,
    )
    db.add(cook_log)
    db.flush()
    return cook_log

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
import json

import pytest

from app.ai.tools.schemas import INTENT_EVIDENCE_SCHEMA
from app.ai.tools.validation import validate_json_value
from app.services.ai_auto_execution.intent_evidence import (
    intent_evidence_validation_record,
    trusted_sources_from_current_ui_subject,
    trusted_sources_from_tool_output,
    validate_intent_evidence,
)
from app.services.ai_auto_execution.policy_types import (
    CriticalEvidenceRequirement,
    TrustedResolutionSource,
)
from app.services.clock import today_for_family


def _evidence(
    *,
    clarity: str = "explicit_complete",
    quotes: list[dict] | None = None,
    sources: list[dict] | None = None,
    ambiguity_codes: list[str] | None = None,
    defaulted_fields: list[str] | None = None,
) -> dict:
    return {
        "intentClarity": clarity,
        "sourceQuotes": quotes or [],
        "resolutionSources": sources or [],
        "ambiguityCodes": ambiguity_codes or [],
        "defaultedFields": defaulted_fields or [],
    }


def test_explicit_context_resolution_requires_trusted_call_and_version() -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(
            clarity="explicit_context_resolved",
            quotes=[{"fields": ["action"], "text": "收藏这个"}],
            sources=[
                {
                    "fields": ["targetId"],
                    "kind": "tool_result",
                    "referenceId": "call-food-1",
                    "entityId": "food-tomato",
                    "rowVersion": 3,
                }
            ],
        ),
        current_message="  收藏这个  ",
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("action", "set_favorite:true", "explicit_action"),
            CriticalEvidenceRequirement("targetId", "food-tomato", "entity_id"),
        ),
        trusted_sources={
            "call-food-1": TrustedResolutionSource(
                kind="tool_result",
                reference_id="call-food-1",
                family_id="family-ai",
                entity_versions={"food-tomato": 3},
            )
        },
    )

    assert validation.clarity == "explicit_context_resolved"
    assert validation.verified_fields == frozenset({"action", "targetId"})
    assert validation.verified_values["targetId"] == "food-tomato"
    assert validation.reason_codes == ()


def test_model_declared_empty_defaults_does_not_prove_critical_fields() -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(),
        current_message="收藏这个",
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("action", "set_favorite:true", "explicit_action"),
            CriticalEvidenceRequirement("targetId", "food-tomato", "entity_id"),
        ),
        trusted_sources={},
    )

    assert "intent_evidence_missing" in validation.reason_codes
    assert validation.verified_fields == frozenset()


@pytest.mark.parametrize(
    "clarity",
    ["explicit_complete", "explicit_context_resolved", "explicit_incomplete", "inferred"],
)
def test_validator_preserves_all_model_clarity_levels_without_upgrading(clarity: str) -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(
            clarity=clarity,
            quotes=[{"fields": ["action"], "text": "收藏这个"}],
        ),
        current_message="收藏这个",
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("action", "set_favorite:true", "explicit_action"),),
        trusted_sources={},
    )

    assert validation.clarity == clarity
    assert validation.verified_fields == frozenset({"action"})


def test_source_quote_match_normalizes_nfc_and_all_unicode_whitespace() -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(
            quotes=[{"fields": ["action"], "text": "Caf\u00e9\t收藏这个"}],
        ),
        current_message="请把 Cafe\u0301\u3000 \n收藏这个",
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("action", "set_favorite:true", "explicit_action"),),
        trusted_sources={},
    )

    assert validation.reason_codes == ()
    assert validation.verified_values == {"action": "set_favorite:true"}


def test_source_quote_must_be_contained_in_current_message() -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(quotes=[{"fields": ["action"], "text": "取消收藏"}]),
        current_message="收藏这个",
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("action", "set_favorite:false", "explicit_action"),),
        trusted_sources={},
    )

    assert "source_quote_mismatch" in validation.reason_codes
    assert validation.verified_fields == frozenset()


@pytest.mark.parametrize(
    ("trusted_source", "declared_entity", "declared_version", "expected_reason"),
    [
        (None, "food-tomato", 3, "resolution_source_untrusted"),
        (
            TrustedResolutionSource(
                kind="tool_result",
                reference_id="call-food-1",
                family_id="family-other",
                entity_versions={"food-tomato": 3},
            ),
            "food-tomato",
            3,
            "resolution_source_untrusted",
        ),
        (
            TrustedResolutionSource(
                kind="tool_result",
                reference_id="call-food-1",
                family_id="family-ai",
                entity_versions={"food-tomato": 4},
            ),
            "food-tomato",
            3,
            "resolution_source_untrusted",
        ),
        (
            TrustedResolutionSource(
                kind="tool_result",
                reference_id="call-food-1",
                family_id="family-ai",
                entity_versions={"food-other": 3},
            ),
            "food-other",
            3,
            "source_value_mismatch",
        ),
    ],
)
def test_resolution_source_rejects_untrusted_cross_family_stale_or_wrong_entity(
    trusted_source: TrustedResolutionSource | None,
    declared_entity: str,
    declared_version: int,
    expected_reason: str,
) -> None:
    trusted_sources = {"call-food-1": trusted_source} if trusted_source is not None else {}
    validation = validate_intent_evidence(
        evidence=_evidence(
            clarity="explicit_context_resolved",
            sources=[
                {
                    "fields": ["targetId"],
                    "kind": "tool_result",
                    "referenceId": "call-food-1",
                    "entityId": declared_entity,
                    "rowVersion": declared_version,
                }
            ],
        ),
        current_message="收藏这个",
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("targetId", "food-tomato", "entity_id"),),
        trusted_sources=trusted_sources,
    )

    assert expected_reason in validation.reason_codes
    assert validation.verified_fields == frozenset()


def test_versioned_resolution_source_cannot_omit_the_server_version() -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(
            clarity="explicit_context_resolved",
            sources=[
                {
                    "fields": ["targetId"],
                    "kind": "tool_result",
                    "referenceId": "call-food-1",
                    "entityId": "food-tomato",
                }
            ],
        ),
        current_message="收藏这个",
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("targetId", "food-tomato", "entity_id"),),
        trusted_sources={
            "call-food-1": TrustedResolutionSource(
                kind="tool_result",
                reference_id="call-food-1",
                family_id="family-ai",
                entity_versions={"food-tomato": 3},
            )
        },
    )

    assert validation.reason_codes == ("resolution_source_untrusted",)
    assert validation.verified_fields == frozenset()


@pytest.mark.parametrize(
    ("message", "field", "expected_value", "matcher_key"),
    [
        ("给番茄炒蛋打 4 分", "payload.foodEntryRatings[0].rating", 5, "rating"),
        ("买 1 盒牛奶", "quantity", 10, "quantity"),
        ("取消收藏这个", "payload.favorite", True, "boolean_direction"),
        ("2026-08-26 晚餐记录一下", "date", "2026-08-25", "date"),
        ("2026-08-26 晚餐记录一下", "mealType", "lunch", "meal_type"),
    ],
)
def test_quote_canonical_value_mismatch_never_verifies_payload(
    message: str,
    field: str,
    expected_value: object,
    matcher_key: str,
) -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(quotes=[{"fields": [field], "text": message}]),
        current_message=message,
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement(field, expected_value, matcher_key),),
        trusted_sources={},
    )

    assert "source_value_mismatch" in validation.reason_codes
    assert field not in validation.verified_fields


@pytest.mark.parametrize(
    "message",
    [
        "给它打 15 分",
        "给它打 55 分",
        "给它打 5.5 分",
        "给它打 4.5.0 分",
        "给它打 4 分还是 5 分",
    ],
)
def test_rating_action_and_value_reject_non_unique_or_invalid_complete_number_tokens(
    message: str,
) -> None:
    rating_field = "payload.foodEntryRatings[0].rating"
    validation = validate_intent_evidence(
        evidence=_evidence(
            quotes=[{"fields": ["action", rating_field], "text": message}],
        ),
        current_message=message,
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("action", "meal_log.rate_food", "explicit_action"),
            CriticalEvidenceRequirement(rating_field, 5, "rating"),
        ),
        trusted_sources={},
    )

    assert "source_value_unverifiable" in validation.reason_codes
    assert validation.verified_fields == frozenset()


@pytest.mark.parametrize(
    ("message", "normalized_rating"),
    [
        ("给它打 -1 分", 1),
        ("给它打 +6 分", 5),
        ("给它打 －1 分", 1),
        ("给它打 ＋6 分", 5),
        ("给它打 ﹣1 分", 1),
        ("给它打 −1 分", 1),
        ("给它打 4-5 分", 5),
    ],
)
def test_rating_action_and_value_reject_signed_or_hyphen_adjacent_number_tokens(
    message: str,
    normalized_rating: int,
) -> None:
    rating_field = "payload.foodEntryRatings[0].rating"
    validation = validate_intent_evidence(
        evidence=_evidence(
            quotes=[{"fields": ["action", rating_field], "text": message}],
        ),
        current_message=message,
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("action", "meal_log.rate_food", "explicit_action"),
            CriticalEvidenceRequirement(rating_field, normalized_rating, "rating"),
        ),
        trusted_sources={},
    )

    assert "source_value_unverifiable" in validation.reason_codes
    assert validation.verified_fields == frozenset()


@pytest.mark.parametrize(
    ("message", "expected_rating"),
    [
        ("给它打 1 分", Decimal("1")),
        ("给它打 5 分", Decimal("5")),
        ("给它打 4.5 分", Decimal("4.5")),
    ],
)
def test_rating_action_and_value_share_one_valid_complete_number_token(
    message: str,
    expected_rating: Decimal,
) -> None:
    rating_field = "payload.foodEntryRatings[0].rating"
    validation = validate_intent_evidence(
        evidence=_evidence(
            quotes=[{"fields": ["action", rating_field], "text": message}],
        ),
        current_message=message,
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("action", "meal_log.rate_food", "explicit_action"),
            CriticalEvidenceRequirement(rating_field, expected_rating, "rating"),
        ),
        trusted_sources={},
    )

    assert validation.reason_codes == ()
    assert validation.verified_values == {
        "action": "meal_log.rate_food",
        rating_field: expected_rating,
    }


def test_explicit_rating_cancellation_verifies_action_and_null_value() -> None:
    rating_field = "payload.foodEntryRatings[0].rating"
    validation = validate_intent_evidence(
        evidence=_evidence(
            quotes=[{"fields": ["action", rating_field], "text": "取消这道菜的评分"}],
        ),
        current_message="取消这道菜的评分",
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("action", "meal_log.rate_food", "explicit_action"),
            CriticalEvidenceRequirement(rating_field, None, "rating"),
        ),
        trusted_sources={},
    )

    assert validation.reason_codes == ()
    assert validation.verified_fields == frozenset({"action", rating_field})
    assert validation.verified_values[rating_field] is None


@pytest.mark.parametrize(
    "message",
    [
        "取消评分，改成 5 分",
        "取消评分 5 分",
        "取消评分然后评分为 5 分",
    ],
)
def test_rating_cancellation_with_new_value_or_conflicting_direction_fails_closed(message: str) -> None:
    rating_field = "payload.foodEntryRatings[0].rating"
    validation = validate_intent_evidence(
        evidence=_evidence(
            quotes=[{"fields": ["action", rating_field], "text": message}],
        ),
        current_message=message,
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("action", "meal_log.rate_food", "explicit_action"),
            CriticalEvidenceRequirement(rating_field, None, "rating"),
        ),
        trusted_sources={},
    )

    assert validation.verified_fields == frozenset()
    assert "source_value_unverifiable" in validation.reason_codes


def test_cancelled_rating_keeps_value_but_never_proves_positive_action_direction() -> None:
    message = "取消给它打 5 分"
    rating_field = "payload.foodEntryRatings[0].rating"
    validation = validate_intent_evidence(
        evidence=_evidence(
            quotes=[{"fields": ["action", rating_field], "text": message}],
        ),
        current_message=message,
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("action", "meal_log.rate_food", "explicit_action"),
            CriticalEvidenceRequirement(rating_field, 5, "rating"),
        ),
        trusted_sources={},
    )

    assert validation.reason_codes == ("source_value_unverifiable",)
    assert validation.verified_fields == frozenset({rating_field})


@pytest.mark.parametrize(
    ("message", "expected_action", "expected_reason"),
    [
        ("不收藏这个", "set_favorite:true", "source_value_mismatch"),
        ("取消收藏这个", "set_favorite:true", "source_value_mismatch"),
        ("不要给番茄炒蛋打 5 分", "meal_log.rate_food", "source_value_unverifiable"),
        ("取消给番茄炒蛋打 5 分", "meal_log.rate_food", "source_value_unverifiable"),
        ("别买牛奶", "shopping_list.create", "source_value_unverifiable"),
        ("取消购买牛奶", "shopping_list.create", "source_value_unverifiable"),
        ("不要记录这餐", "meal_log.simple_create", "source_value_unverifiable"),
        ("取消记录这餐", "meal_log.simple_create", "source_value_unverifiable"),
        ("别安排这餐", "meal_plan.simple_create", "source_value_unverifiable"),
        ("取消安排这餐", "meal_plan.simple_create", "source_value_unverifiable"),
    ],
)
def test_negated_or_cancelled_action_never_proves_a_positive_command(
    message: str,
    expected_action: str,
    expected_reason: str,
) -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(quotes=[{"fields": ["action"], "text": message}]),
        current_message=message,
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("action", expected_action, "explicit_action"),),
        trusted_sources={},
    )

    assert expected_reason in validation.reason_codes
    assert validation.verified_fields == frozenset()


@pytest.mark.parametrize(
    "message",
    [
        "不收藏这个",
        "不要标记完成",
        "别开启这个选项",
        "这个不要收藏，那个收藏",
    ],
)
def test_boolean_direction_rejects_negated_or_scope_ambiguous_positive_claims(message: str) -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(quotes=[{"fields": ["payload.enabled"], "text": message}]),
        current_message=message,
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("payload.enabled", True, "boolean_direction"),),
        trusted_sources={},
    )

    assert validation.reason_codes
    assert validation.verified_fields == frozenset()


def test_favorite_cancellation_verifies_only_the_false_direction() -> None:
    message = "取消收藏这个"
    validation = validate_intent_evidence(
        evidence=_evidence(quotes=[{"fields": ["action"], "text": message}]),
        current_message=message,
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("action", "set_favorite:false", "explicit_action"),),
        trusted_sources={},
    )

    assert validation.reason_codes == ()
    assert validation.verified_values == {"action": "set_favorite:false"}


@pytest.mark.parametrize(
    ("message", "expected_action"),
    [
        ("收藏这个，但不要收藏另一个", "set_favorite:true"),
        ("给番茄打 5 分，但不要给鸡蛋打 5 分", "meal_log.rate_food"),
        ("买牛奶，但别买鸡蛋", "shopping_list.create"),
        ("记录这餐，但不要记录那餐", "meal_log.simple_create"),
        ("安排这餐，但别安排那餐", "meal_plan.simple_create"),
    ],
)
def test_mixed_direction_action_quote_is_scope_ambiguous(
    message: str,
    expected_action: str,
) -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(quotes=[{"fields": ["action"], "text": message}]),
        current_message=message,
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("action", expected_action, "explicit_action"),),
        trusted_sources={},
    )

    assert validation.reason_codes == ("source_value_unverifiable",)
    assert validation.verified_fields == frozenset()


def test_quantity_matcher_ignores_numbers_from_an_explicit_date() -> None:
    message = "2026-08-26 买 1 盒牛奶"
    validation = validate_intent_evidence(
        evidence=_evidence(
            quotes=[
                {
                    "fields": ["items[0].date", "items[0].quantity", "items[0].unit"],
                    "text": message,
                }
            ],
            sources=[
                {
                    "fields": ["items[0].ingredient_id"],
                    "kind": "tool_result",
                    "referenceId": "call-milk",
                    "entityId": "ingredient-milk",
                    "rowVersion": 3,
                }
            ],
        ),
        current_message=message,
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("items[0].date", "2026-08-26", "date"),
            CriticalEvidenceRequirement("items[0].ingredient_id", "ingredient-milk", "entity_id"),
            CriticalEvidenceRequirement("items[0].quantity", 1, "quantity"),
            CriticalEvidenceRequirement("items[0].unit", "盒", "unit"),
        ),
        trusted_sources={
            "call-milk": TrustedResolutionSource(
                kind="tool_result",
                reference_id="call-milk",
                family_id="family-ai",
                entity_versions={"ingredient-milk": 3},
                entity_values={
                    "ingredient-milk": {"entity_id": "ingredient-milk", "text": "牛奶"}
                },
            )
        },
    )

    assert validation.reason_codes == ()
    assert validation.verified_fields == frozenset(
        {
            "items[0].date",
            "items[0].ingredient_id",
            "items[0].quantity",
            "items[0].unit",
        }
    )


def _shopping_item_sources(*, reversed_targets: bool) -> tuple[list[dict], dict[str, TrustedResolutionSource]]:
    item_entities = (
        ("ingredient-egg", "ingredient-milk")
        if reversed_targets
        else ("ingredient-milk", "ingredient-egg")
    )
    sources = [
        {
            "fields": [f"items[{index}].ingredient_id"],
            "kind": "tool_result",
            "referenceId": "call-shopping-items",
            "entityId": entity_id,
            "rowVersion": 3,
        }
        for index, entity_id in enumerate(item_entities)
    ]
    trusted = {
        "call-shopping-items": TrustedResolutionSource(
            kind="tool_result",
            reference_id="call-shopping-items",
            family_id="family-ai",
            entity_versions={"ingredient-milk": 3, "ingredient-egg": 3},
            entity_values={
                "ingredient-milk": {"entity_id": "ingredient-milk", "text": "牛奶"},
                "ingredient-egg": {"entity_id": "ingredient-egg", "text": "鸡蛋"},
            },
        )
    }
    return sources, trusted


def test_multi_item_quotes_bind_each_quantity_and_unit_to_its_server_resolved_entity() -> None:
    message = "买 1 盒牛奶和 2 盒鸡蛋"
    sources, trusted = _shopping_item_sources(reversed_targets=False)
    validation = validate_intent_evidence(
        evidence=_evidence(
            quotes=[
                {"fields": ["items[0].quantity", "items[0].unit"], "text": "1 盒牛奶"},
                {"fields": ["items[1].quantity", "items[1].unit"], "text": "2 盒鸡蛋"},
            ],
            sources=sources,
        ),
        current_message=message,
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("items[0].ingredient_id", "ingredient-milk", "entity_id"),
            CriticalEvidenceRequirement("items[0].quantity", 1, "quantity"),
            CriticalEvidenceRequirement("items[0].unit", "盒", "unit"),
            CriticalEvidenceRequirement("items[1].ingredient_id", "ingredient-egg", "entity_id"),
            CriticalEvidenceRequirement("items[1].quantity", 2, "quantity"),
            CriticalEvidenceRequirement("items[1].unit", "盒", "unit"),
        ),
        trusted_sources=trusted,
    )

    assert validation.reason_codes == ()
    assert validation.verified_fields == frozenset(
        {
            "items[0].ingredient_id",
            "items[0].quantity",
            "items[0].unit",
            "items[1].ingredient_id",
            "items[1].quantity",
            "items[1].unit",
        }
    )


def test_multi_item_quotes_cannot_rebind_quantities_to_different_resolved_entities() -> None:
    message = "买 1 盒牛奶和 2 盒鸡蛋"
    sources, trusted = _shopping_item_sources(reversed_targets=True)
    validation = validate_intent_evidence(
        evidence=_evidence(
            quotes=[
                {"fields": ["items[0].quantity", "items[0].unit"], "text": "1 盒牛奶"},
                {"fields": ["items[1].quantity", "items[1].unit"], "text": "2 盒鸡蛋"},
            ],
            sources=sources,
        ),
        current_message=message,
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("items[0].ingredient_id", "ingredient-egg", "entity_id"),
            CriticalEvidenceRequirement("items[0].quantity", 1, "quantity"),
            CriticalEvidenceRequirement("items[0].unit", "盒", "unit"),
            CriticalEvidenceRequirement("items[1].ingredient_id", "ingredient-milk", "entity_id"),
            CriticalEvidenceRequirement("items[1].quantity", 2, "quantity"),
            CriticalEvidenceRequirement("items[1].unit", "盒", "unit"),
        ),
        trusted_sources=trusted,
    )

    assert "source_value_unverifiable" in validation.reason_codes
    assert validation.verified_fields == frozenset(
        {"items[0].ingredient_id", "items[1].ingredient_id"}
    )


def test_multi_item_short_value_quotes_cannot_bypass_entity_tuple_binding() -> None:
    message = "买 1 盒牛奶和 2 盒鸡蛋"
    sources, trusted = _shopping_item_sources(reversed_targets=True)
    validation = validate_intent_evidence(
        evidence=_evidence(
            quotes=[
                {"fields": ["items[0].quantity", "items[0].unit"], "text": "1 盒"},
                {"fields": ["items[1].quantity", "items[1].unit"], "text": "2 盒"},
            ],
            sources=sources,
        ),
        current_message=message,
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("items[0].ingredient_id", "ingredient-egg", "entity_id"),
            CriticalEvidenceRequirement("items[0].quantity", 1, "quantity"),
            CriticalEvidenceRequirement("items[0].unit", "盒", "unit"),
            CriticalEvidenceRequirement("items[1].ingredient_id", "ingredient-milk", "entity_id"),
            CriticalEvidenceRequirement("items[1].quantity", 2, "quantity"),
            CriticalEvidenceRequirement("items[1].unit", "盒", "unit"),
        ),
        trusted_sources=trusted,
    )

    assert "source_value_unverifiable" in validation.reason_codes
    assert validation.verified_fields == frozenset(
        {"items[0].ingredient_id", "items[1].ingredient_id"}
    )


def test_item_tuple_rejects_a_name_shared_by_multiple_trusted_entity_candidates() -> None:
    message = "买 1 盒牛奶"
    validation = validate_intent_evidence(
        evidence=_evidence(
            quotes=[
                {"fields": ["items[0].quantity", "items[0].unit"], "text": message},
            ],
            sources=[
                {
                    "fields": ["items[0].ingredient_id"],
                    "kind": "tool_result",
                    "referenceId": "call-ambiguous-milk",
                    "entityId": "ingredient-milk-a",
                }
            ],
        ),
        current_message=message,
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("items[0].ingredient_id", "ingredient-milk-a", "entity_id"),
            CriticalEvidenceRequirement("items[0].quantity", 1, "quantity"),
            CriticalEvidenceRequirement("items[0].unit", "盒", "unit"),
        ),
        trusted_sources={
            "call-ambiguous-milk": TrustedResolutionSource(
                kind="tool_result",
                reference_id="call-ambiguous-milk",
                family_id="family-ai",
                entity_versions={"ingredient-milk-a": None, "ingredient-milk-b": None},
                entity_values={
                    "ingredient-milk-a": {
                        "entity_id": "ingredient-milk-a",
                        "text": "牛奶",
                    },
                    "ingredient-milk-b": {
                        "entity_id": "ingredient-milk-b",
                        "text": "牛奶",
                    },
                },
            )
        },
    )

    assert "source_value_unverifiable" in validation.reason_codes
    assert validation.verified_fields == frozenset({"items[0].ingredient_id"})


def test_server_matcher_does_not_accept_one_value_from_an_ambiguous_meal_type_quote() -> None:
    message = "明天午餐或晚餐安排番茄小炒"
    validation = validate_intent_evidence(
        evidence=_evidence(quotes=[{"fields": ["items[0].mealType"], "text": message}]),
        current_message=message,
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("items[0].mealType", "lunch", "meal_type"),),
        trusted_sources={},
    )

    assert validation.reason_codes == ("source_value_unverifiable",)
    assert validation.verified_fields == frozenset()


def test_artifact_allowlisted_quantity_and_unit_must_match_the_draft() -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(
            clarity="explicit_context_resolved",
            sources=[
                {
                    "fields": ["items[0].quantity", "items[0].unit"],
                    "kind": "conversation_artifact",
                    "referenceId": "ai-draft-source",
                    "entityId": "ingredient-tomato",
                    "rowVersion": 2,
                }
            ],
        ),
        current_message="按之前的清单买",
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("items[0].quantity", 10, "quantity"),
            CriticalEvidenceRequirement("items[0].unit", "袋", "unit"),
        ),
        trusted_sources={
            "ai-draft-source": TrustedResolutionSource(
                kind="conversation_artifact",
                reference_id="ai-draft-source",
                family_id="family-ai",
                entity_versions={"ingredient-tomato": 2},
                entity_values={
                    "ingredient-tomato": {
                        "items[0].quantity": 1,
                        "items[0].unit": "盒",
                    },
                },
            )
        },
    )

    assert "source_value_mismatch" in validation.reason_codes
    assert validation.verified_fields == frozenset()


@pytest.mark.parametrize(
    ("message", "requirements", "quotes", "sources"),
    [
        (
            "今天午餐吃了 1 份番茄小炒",
            (
                CriticalEvidenceRequirement("action", "meal_log.simple_create", "explicit_action"),
                CriticalEvidenceRequirement("date", today_for_family("family-ai").isoformat(), "date"),
                CriticalEvidenceRequirement("mealType", "lunch", "meal_type"),
                CriticalEvidenceRequirement("foods[0].foodId", "food-tomato", "entity_id"),
                CriticalEvidenceRequirement("foods[0].servings", 1, "servings"),
            ),
            [
                {
                    "fields": ["date", "mealType", "foods[0].servings"],
                    "text": "今天午餐吃了 1 份番茄小炒",
                }
            ],
            [
                {
                    "fields": ["foods[0].foodId"],
                    "kind": "tool_result",
                    "referenceId": "call-food",
                    "entityId": "food-tomato",
                    "rowVersion": 1,
                }
            ],
        ),
        (
            "明晚吃番茄小炒",
            (
                CriticalEvidenceRequirement("action", "meal_plan.simple_create", "explicit_action"),
                CriticalEvidenceRequirement(
                    "items[0].date",
                    (today_for_family("family-ai") + timedelta(days=1)).isoformat(),
                    "date",
                ),
                CriticalEvidenceRequirement("items[0].mealType", "dinner", "meal_type"),
                CriticalEvidenceRequirement("items[0].foodId", "food-tomato", "entity_id"),
            ),
            [
                {
                    "fields": ["items[0].date", "items[0].mealType"],
                    "text": "明晚吃番茄小炒",
                }
            ],
            [
                {
                    "fields": ["items[0].foodId"],
                    "kind": "tool_result",
                    "referenceId": "call-food",
                    "entityId": "food-tomato",
                    "rowVersion": 1,
                }
            ],
        ),
    ],
)
def test_complete_meal_statement_without_semantic_action_remains_manual_only(
    message: str,
    requirements: tuple[CriticalEvidenceRequirement, ...],
    quotes: list[dict],
    sources: list[dict],
) -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(quotes=quotes, sources=sources),
        current_message=message,
        family_id="family-ai",
        requirements=requirements,
        trusted_sources={
            "call-food": TrustedResolutionSource(
                kind="tool_result",
                reference_id="call-food",
                family_id="family-ai",
                entity_versions={"food-tomato": 1},
            )
        },
    )

    assert "intent_evidence_missing" in validation.reason_codes
    assert "action" not in validation.verified_fields


@pytest.mark.parametrize(
    ("message", "expected_action"),
    [
        ("记录今晚的番茄小炒", "meal_log.simple_create"),
        ("安排明天晚餐吃番茄小炒", "meal_plan.simple_create"),
    ],
)
def test_simple_meal_and_plan_require_explicit_product_action_phrases(
    message: str,
    expected_action: str,
) -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(quotes=[{"fields": ["action"], "text": message}]),
        current_message=message,
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("action", expected_action, "explicit_action"),),
        trusted_sources={},
    )

    assert validation.reason_codes == ()
    assert validation.verified_values == {"action": expected_action}


def test_defaulted_critical_field_and_ambiguity_are_stable_manual_reasons() -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(
            quotes=[{"fields": ["date"], "text": "今天"}],
            ambiguity_codes=["which_meal"],
            defaulted_fields=["date"],
        ),
        current_message="今天",
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("date", today_for_family("family-ai").isoformat(), "date"),),
        trusted_sources={},
    )

    assert validation.reason_codes == ("critical_default_used", "ambiguity_present")
    assert validation.verified_fields == frozenset()


def test_evidence_omission_falls_back_to_manual_eligibility() -> None:
    validation = validate_intent_evidence(
        evidence=None,
        current_message="收藏这个",
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("action", "set_favorite:true", "explicit_action"),),
        trusted_sources={},
    )

    assert validation.clarity == "inferred"
    assert validation.normalized_evidence == {}
    assert validation.reason_codes == ("intent_evidence_missing",)


def test_evidence_schema_accepts_twenty_paths_and_rejects_twenty_five() -> None:
    valid = _evidence(
        quotes=[
            {
                "fields": [f"operations[{index}].payload.quantity" for index in range(20)],
                "text": "买这些",
            }
        ]
    )
    validate_json_value(valid, INTENT_EVIDENCE_SCHEMA, location="intentEvidence")

    invalid = _evidence(
        quotes=[
            {
                "fields": [f"operations[{index}].payload.quantity" for index in range(25)],
                "text": "买这些",
            }
        ]
    )
    with pytest.raises(ValueError):
        validate_json_value(invalid, INTENT_EVIDENCE_SCHEMA, location="intentEvidence")


@pytest.mark.parametrize(
    "evidence",
    [
        _evidence(quotes=[{"fields": ["action"], "text": "x"}] * 13),
        _evidence(quotes=[{"fields": ["action"], "text": "x" * 241}]),
        _evidence(quotes=[{"fields": ["x" * 81], "text": "x"}]),
        _evidence(defaulted_fields=[f"field-{index}" for index in range(25)]),
    ],
)
def test_evidence_schema_rejects_over_limit_arrays_and_text(evidence: dict) -> None:
    with pytest.raises(ValueError):
        validate_json_value(evidence, INTENT_EVIDENCE_SCHEMA, location="intentEvidence")


def test_purchasable_resolution_candidate_becomes_allowlisted_trusted_identity() -> None:
    sources = trusted_sources_from_tool_output(
        tool_name="purchasable.resolve_candidates",
        tool_call_id="call-purchasable-1",
        family_id="family-ai",
        output={
            "results": [
                {
                    "clientKey": "tomato",
                    "name": "番茄",
                    "status": "exact",
                    "candidates": [
                        {
                            "id": "ingredient-tomato",
                            "name": "番茄",
                            "targetType": "ingredient",
                            "matchType": "exact",
                            "matchReason": ["名称完全匹配"],
                            "defaultUnit": "个",
                            "quantityTrackingMode": "track_quantity",
                        }
                    ],
                }
            ]
        },
    )

    assert sources["call-purchasable-1"].entity_versions == {"ingredient-tomato": None}
    assert sources["call-purchasable-1"].entity_values == {
        "ingredient-tomato": {"entity_id": "ingredient-tomato", "text": "番茄"}
    }


def test_current_ui_source_uses_only_server_normalized_subject_ids() -> None:
    sources = trusted_sources_from_current_ui_subject(
        family_id="family-ai",
        subject={
            "source": "food_page",
            "food_id": "food-tomato",
            "ingredient_ids": ["ingredient-tomato"],
            "extra": {"modelRepeatedId": "food-untrusted"},
        },
    )

    source = sources["current-ui-context"]
    assert source.entity_versions == {"food-tomato": None, "ingredient-tomato": None}
    assert "food-untrusted" not in source.entity_versions


def test_successful_artifact_read_copies_only_allowlisted_canonical_facts() -> None:
    sources = trusted_sources_from_tool_output(
        tool_name="workspace.read_artifact",
        tool_call_id="call-artifact-1",
        family_id="family-ai",
        output={
            "artifact": {
                "kind": "draft",
                "id": "ai-draft-shopping",
                "version": 4,
                "payload": {
                    "draftType": "shopping_list",
                    "schemaVersion": "shopping_list.v1",
                    "items": [
                        {
                            "ingredient_id": "ingredient-tomato",
                            "quantity": 2,
                            "unit": "个",
                            "title": "番茄",
                            "untrustedDocument": {"quantity": 999},
                        }
                    ],
                    "arbitrarySecret": "must-not-copy",
                },
            }
        },
    )

    source = sources["ai-draft-shopping"]
    assert source.entity_versions == {"ingredient-tomato": 4}
    assert source.entity_values["ingredient-tomato"] == {
        "entity_id": "ingredient-tomato",
        "quantity": 2,
        "unit": "个",
        "text": "番茄",
        "items[0].quantity": 2,
        "items[0].unit": "个",
        "items[0].title": "番茄",
        "items[0].ingredient_id": "ingredient-tomato",
    }
    assert sources["call-artifact-1"].entity_values == source.entity_values


def test_artifact_facts_keep_concrete_array_paths_for_repeated_entities() -> None:
    sources = trusted_sources_from_tool_output(
        tool_name="workspace.read_artifact",
        tool_call_id="call-artifact-repeat",
        family_id="family-ai",
        output={
            "artifact": {
                "kind": "draft",
                "id": "ai-draft-repeat",
                "version": 2,
                "payload": {
                    "draftType": "shopping_list",
                    "schemaVersion": "shopping_list.v1",
                    "items": [
                        {"ingredient_id": "ingredient-tomato", "quantity": 1, "unit": "个"},
                        {"ingredient_id": "ingredient-tomato", "quantity": 2, "unit": "个"},
                    ],
                },
            }
        },
    )
    evidence = _evidence(
        clarity="explicit_context_resolved",
        sources=[
            {
                "fields": ["items[0].quantity", "items[1].quantity"],
                "kind": "conversation_artifact",
                "referenceId": "ai-draft-repeat",
                "entityId": "ingredient-tomato",
                "rowVersion": 2,
            }
        ],
    )

    validation = validate_intent_evidence(
        evidence=evidence,
        current_message="按之前的两项加入",
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("items[0].quantity", 1, "quantity"),
            CriticalEvidenceRequirement("items[1].quantity", 2, "quantity"),
        ),
        trusted_sources=sources,
    )

    assert validation.reason_codes == ()
    assert validation.verified_fields == frozenset({"items[0].quantity", "items[1].quantity"})


def test_artifact_generic_fact_cannot_prove_a_different_concrete_array_path() -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(
            clarity="explicit_context_resolved",
            sources=[
                {
                    "fields": ["items[1].quantity"],
                    "kind": "conversation_artifact",
                    "referenceId": "ai-draft-one-item",
                    "entityId": "ingredient-tomato",
                    "rowVersion": 2,
                }
            ],
        ),
        current_message="按之前的清单加入第二项",
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("items[1].quantity", 1, "quantity"),),
        trusted_sources={
            "ai-draft-one-item": TrustedResolutionSource(
                kind="conversation_artifact",
                reference_id="ai-draft-one-item",
                family_id="family-ai",
                entity_versions={"ingredient-tomato": 2},
                entity_values={
                    "ingredient-tomato": {
                        "quantity": 1,
                        "items[0].quantity": 1,
                    }
                },
            )
        },
    )

    assert validation.reason_codes == ("source_value_unverifiable",)
    assert validation.verified_fields == frozenset()


def test_artifact_entity_identity_cannot_move_to_a_different_concrete_array_path() -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(
            clarity="explicit_context_resolved",
            sources=[
                {
                    "fields": ["items[1].ingredient_id"],
                    "kind": "conversation_artifact",
                    "referenceId": "ai-draft-one-identity",
                    "entityId": "ingredient-tomato",
                    "rowVersion": 2,
                }
            ],
        ),
        current_message="按之前的清单加入第二项",
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement(
                "items[1].ingredient_id",
                "ingredient-tomato",
                "entity_id",
            ),
        ),
        trusted_sources={
            "ai-draft-one-identity": TrustedResolutionSource(
                kind="conversation_artifact",
                reference_id="ai-draft-one-identity",
                family_id="family-ai",
                entity_versions={"ingredient-tomato": 2},
                entity_values={
                    "ingredient-tomato": {
                        "entity_id": "ingredient-tomato",
                        "items[0].ingredient_id": "ingredient-tomato",
                    }
                },
            )
        },
    )

    assert validation.reason_codes == ("source_value_unverifiable",)
    assert validation.verified_fields == frozenset()


@pytest.mark.parametrize(
    ("message", "expected_text", "expected_reason"),
    [
        ("买牛奶", "牛", "source_value_mismatch"),
        ("买牛奶", "牛奶", None),
        ("买牛奶和鸡蛋", "牛奶", "source_value_unverifiable"),
        ("买牛奶和牛奶", "牛奶", "source_value_unverifiable"),
    ],
)
def test_text_matcher_requires_one_complete_canonical_mention(
    message: str,
    expected_text: str,
    expected_reason: str | None,
) -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(quotes=[{"fields": ["items[0].title"], "text": message}]),
        current_message=message,
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("items[0].title", expected_text, "text"),),
        trusted_sources={},
    )

    if expected_reason is None:
        assert validation.reason_codes == ()
        assert validation.verified_values == {"items[0].title": expected_text}
    else:
        assert expected_reason in validation.reason_codes
        assert validation.verified_fields == frozenset()


def test_persisted_validation_record_is_json_safe_for_decimal_expected_values() -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(quotes=[{"fields": ["quantity"], "text": "买 1.5 盒"}]),
        current_message="买 1.5 盒",
        family_id="family-ai",
        requirements=(CriticalEvidenceRequirement("quantity", Decimal("1.5"), "quantity"),),
        trusted_sources={},
    )

    record = intent_evidence_validation_record(validation)
    assert json.loads(json.dumps(record, ensure_ascii=False))["verified_values"] == {
        "quantity": "1.5"
    }


def test_server_owned_record_uses_normalized_clarity_not_an_invalid_model_label() -> None:
    validation = validate_intent_evidence(
        evidence=_evidence(clarity="model_says_authorized"),
        current_message="收藏这个",
        family_id="family-ai",
        requirements=(),
        trusted_sources={},
    )

    assert validation.clarity == "inferred"
    assert intent_evidence_validation_record(validation)["clarity"] == "inferred"

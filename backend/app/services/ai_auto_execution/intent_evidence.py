from __future__ import annotations

from copy import deepcopy
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
import re
import unicodedata
from typing import Any

from fastapi.encoders import jsonable_encoder

from app.services.ai_auto_execution.policy_types import (
    CriticalEvidenceRequirement,
    IntentClarity,
    IntentEvidenceValidation,
    TrustedResolutionSource,
)
from app.services.clock import today_for_family


_CLARITY_VALUES = {
    "explicit_complete",
    "explicit_context_resolved",
    "explicit_incomplete",
    "inferred",
}
_READ_TOOL_NAMES = {
    "food.search",
    "food.read_by_id",
    "ingredient.search",
    "ingredient.read_by_id",
    "inventory.read_available_items",
    "inventory.read_low_stock_items",
    "meal_log.read_recent",
    "meal_log.read_by_id",
    "meal_plan.read_existing",
    "meal_plan.read_by_id",
    "shopping.read_pending",
    "shopping.read_by_id",
}
_RESOLUTION_TOOL_NAMES = {"ingredient.resolve_candidates", "purchasable.resolve_candidates"}
_IDENTITY_ONLY_TOOL_NAMES = {"inventory.read_available_items", "inventory.read_low_stock_items"}
_NEGATIVE_FAVORITE_PHRASES = ("取消收藏", "移出收藏", "不再收藏", "不要收藏")
_MEAL_LOG_ACTION_PHRASES = ("记录这餐", "记录一下", "记下这餐", "记一笔", "新增餐食记录", "添加餐食记录")
_MEAL_PLAN_ACTION_PHRASES = ("安排到计划", "加入计划", "加到计划", "添加到计划", "制定计划", "安排这餐")
_UNIT_ALIASES = {
    "公斤": "kg",
    "千克": "kg",
    "kg": "kg",
    "克": "g",
    "g": "g",
    "毫升": "ml",
    "ml": "ml",
    "升": "l",
    "l": "l",
}
_UNIT_PATTERN = re.compile(
    r"(公斤|千克|毫升|kg|ml|盒|个|袋|瓶|包|斤|克|升|份|碗|罐|条|棵|颗|块|片)",
    re.IGNORECASE,
)


def normalize_intent_text(value: Any) -> str:
    text = unicodedata.normalize("NFC", str(value or ""))
    return " ".join(text.split())


def validate_intent_evidence(
    *,
    evidence: dict[str, Any] | None,
    current_message: str,
    family_id: str,
    requirements: tuple[CriticalEvidenceRequirement, ...],
    trusted_sources: dict[str, TrustedResolutionSource],
) -> IntentEvidenceValidation:
    normalized_evidence = deepcopy(evidence) if isinstance(evidence, dict) else {}
    raw_clarity = str(normalized_evidence.get("intentClarity") or "")
    clarity: IntentClarity = raw_clarity if raw_clarity in _CLARITY_VALUES else "inferred"  # type: ignore[assignment]
    if not normalized_evidence:
        return IntentEvidenceValidation(
            clarity=clarity,
            normalized_evidence={},
            verified_fields=frozenset(),
            verified_values={},
            reason_codes=("intent_evidence_missing",),
        )

    reason_codes: list[str] = []
    message = normalize_intent_text(current_message)
    quotes = [item for item in normalized_evidence.get("sourceQuotes") or [] if isinstance(item, dict)]
    sources = [item for item in normalized_evidence.get("resolutionSources") or [] if isinstance(item, dict)]
    defaulted_fields = {
        str(item)
        for item in normalized_evidence.get("defaultedFields") or []
        if isinstance(item, str) and item
    }

    quote_containment: dict[int, bool] = {}
    for quote in quotes:
        quote_text = normalize_intent_text(quote.get("text"))
        matched = bool(quote_text) and quote_text in message
        quote_containment[id(quote)] = matched
        if not matched:
            _append_reason(reason_codes, "source_quote_mismatch")

    source_trust: dict[int, TrustedResolutionSource | None] = {}
    for source in sources:
        trusted = _resolve_trusted_source(
            source=source,
            family_id=family_id,
            trusted_sources=trusted_sources,
        )
        source_trust[id(source)] = trusted
        if trusted is None:
            _append_reason(reason_codes, "resolution_source_untrusted")

    verified_values: dict[str, Any] = {}
    for requirement in requirements:
        if requirement.field in defaulted_fields:
            _append_reason(reason_codes, "critical_default_used")
            continue

        claimed_quotes = [quote for quote in quotes if requirement.field in _claimed_fields(quote)]
        claimed_sources = [source for source in sources if requirement.field in _claimed_fields(source)]
        if not claimed_quotes and not claimed_sources:
            _append_reason(reason_codes, "intent_evidence_missing")
            continue

        verified = False
        for quote in claimed_quotes:
            if not quote_containment.get(id(quote), False):
                continue
            canonical = _canonical_from_quote(
                matcher_key=requirement.matcher_key,
                expected_value=requirement.expected_value,
                quote=normalize_intent_text(quote.get("text")),
                family_id=family_id,
            )
            if canonical is _UNVERIFIABLE:
                _append_reason(reason_codes, "source_value_unverifiable")
                continue
            if not _canonical_values_equal(requirement.matcher_key, canonical, requirement.expected_value):
                _append_reason(reason_codes, "source_value_mismatch")
                continue
            verified = True

        for source in claimed_sources:
            trusted = source_trust.get(id(source))
            if trusted is None:
                continue
            canonical = _canonical_from_resolution_source(
                matcher_key=requirement.matcher_key,
                field=requirement.field,
                source=source,
                trusted=trusted,
            )
            if canonical is _UNVERIFIABLE:
                _append_reason(reason_codes, "source_value_unverifiable")
                continue
            if not _canonical_values_equal(requirement.matcher_key, canonical, requirement.expected_value):
                _append_reason(reason_codes, "source_value_mismatch")
                continue
            verified = True

        if verified:
            verified_values[requirement.field] = requirement.expected_value

    if normalized_evidence.get("ambiguityCodes"):
        _append_reason(reason_codes, "ambiguity_present")

    return IntentEvidenceValidation(
        clarity=clarity,
        normalized_evidence=normalized_evidence,
        verified_fields=frozenset(verified_values),
        verified_values=verified_values,
        reason_codes=tuple(reason_codes),
    )


def intent_evidence_validation_record(validation: IntentEvidenceValidation) -> dict[str, Any]:
    return jsonable_encoder(
        {
            "clarity": validation.clarity,
            "normalized_evidence": deepcopy(validation.normalized_evidence),
            "verified_fields": sorted(validation.verified_fields),
            "verified_values": deepcopy(validation.verified_values),
            "reason_codes": list(validation.reason_codes),
        },
        custom_encoder={Decimal: str},
    )


def trusted_sources_from_current_ui_subject(
    *,
    subject: dict[str, Any],
    family_id: str,
) -> dict[str, TrustedResolutionSource]:
    entity_ids: list[str] = []
    for key in ("food_id", "recipe_id"):
        value = str(subject.get(key) or "").strip()
        if value:
            entity_ids.append(value)
    ingredient_ids = subject.get("ingredient_ids")
    if isinstance(ingredient_ids, list):
        entity_ids.extend(str(item).strip() for item in ingredient_ids if str(item).strip())
    entity_ids = list(dict.fromkeys(entity_ids))
    if not entity_ids:
        return {}
    reference_id = "current-ui-context"
    return {
        reference_id: TrustedResolutionSource(
            kind="current_ui_context",
            reference_id=reference_id,
            family_id=family_id,
            entity_versions={entity_id: None for entity_id in entity_ids},
            entity_values={entity_id: {"entity_id": entity_id} for entity_id in entity_ids},
        )
    }


def trusted_sources_from_tool_output(
    *,
    tool_name: str,
    tool_call_id: str | None,
    output: dict[str, Any],
    family_id: str,
) -> dict[str, TrustedResolutionSource]:
    if tool_name == "workspace.read_artifact":
        artifact = output.get("artifact") if isinstance(output.get("artifact"), dict) else None
        if artifact is None:
            return {}
        reference_ids = [str(artifact.get("id") or "").strip()]
        if tool_call_id:
            reference_ids.append(str(tool_call_id))
        reference_ids = list(dict.fromkeys(item for item in reference_ids if item))
        versions, values = _artifact_facts(artifact)
        if not reference_ids or not versions:
            return {}
        return {
            reference_id: TrustedResolutionSource(
                kind="conversation_artifact",
                reference_id=reference_id,
                family_id=family_id,
                entity_versions=deepcopy(versions),
                entity_values=deepcopy(values),
            )
            for reference_id in reference_ids
        }

    if not tool_call_id:
        return {}
    if tool_name in _RESOLUTION_TOOL_NAMES:
        versions: dict[str, int | str | None] = {}
        values: dict[str, dict[str, Any]] = {}
        for result in output.get("results") or []:
            if not isinstance(result, dict):
                continue
            for candidate in result.get("candidates") or []:
                if not isinstance(candidate, dict):
                    continue
                entity_id = str(candidate.get("id") or "").strip()
                if entity_id:
                    versions[entity_id] = None
                    values[entity_id] = {"entity_id": entity_id}
        return _trusted_tool_source(
            reference_id=str(tool_call_id),
            family_id=family_id,
            versions=versions,
            values=values,
        )
    if tool_name not in _READ_TOOL_NAMES:
        return {}
    items: list[dict[str, Any]] = []
    if isinstance(output.get("item"), dict):
        items.append(output["item"])
    if isinstance(output.get("items"), list):
        items.extend(item for item in output["items"] if isinstance(item, dict))
    versions: dict[str, int | str | None] = {}
    values: dict[str, dict[str, Any]] = {}
    for item in items:
        _collect_tool_item_facts(
            item,
            versions=versions,
            values=values,
            identity_only=tool_name in _IDENTITY_ONLY_TOOL_NAMES,
        )
    return _trusted_tool_source(
        reference_id=str(tool_call_id),
        family_id=family_id,
        versions=versions,
        values=values,
    )


def _resolve_trusted_source(
    *,
    source: dict[str, Any],
    family_id: str,
    trusted_sources: dict[str, TrustedResolutionSource],
) -> TrustedResolutionSource | None:
    reference_id = str(source.get("referenceId") or "")
    entity_id = str(source.get("entityId") or "")
    trusted = trusted_sources.get(reference_id)
    if trusted is None:
        return None
    if trusted.reference_id != reference_id or trusted.family_id != family_id:
        return None
    if trusted.kind != source.get("kind") or entity_id not in trusted.entity_versions:
        return None
    trusted_version = trusted.entity_versions.get(entity_id)
    if trusted_version is not None and source.get("rowVersion") != trusted_version:
        return None
    if trusted_version is None and "rowVersion" in source and source.get("rowVersion") is not None:
        return None
    return trusted


def _canonical_from_resolution_source(
    *,
    matcher_key: str,
    field: str,
    source: dict[str, Any],
    trusted: TrustedResolutionSource,
) -> Any:
    entity_id = str(source.get("entityId") or "")
    if matcher_key == "entity_id":
        return entity_id
    if matcher_key == "explicit_action":
        return _UNVERIFIABLE
    facts = trusted.entity_values.get(entity_id) or {}
    if field in facts:
        return facts[field]
    if matcher_key in facts:
        return facts[matcher_key]
    field_name = _field_leaf(field)
    return facts.get(field_name, _UNVERIFIABLE)


def _canonical_from_quote(
    *,
    matcher_key: str,
    expected_value: Any,
    quote: str,
    family_id: str,
) -> Any:
    if matcher_key == "explicit_action":
        return _explicit_action_value(quote, str(expected_value))
    if matcher_key == "entity_id":
        return _UNVERIFIABLE
    if matcher_key == "boolean_direction":
        negative_phrases = (*_NEGATIVE_FAVORITE_PHRASES, "取消完成", "恢复未完成", "设为未完成", "关闭")
        negative = any(phrase in quote for phrase in negative_phrases)
        positive_text = quote
        for phrase in negative_phrases:
            positive_text = positive_text.replace(phrase, "")
        positive = "收藏" in positive_text or any(
            phrase in positive_text for phrase in ("设为完成", "标记完成", "开启")
        )
        if negative and positive:
            return _UNVERIFIABLE
        if negative:
            return False
        if positive:
            return True
        return _UNVERIFIABLE
    if matcher_key == "rating":
        matches = {
            _decimal_number(value)
            for value in re.findall(r"(?:打|评分(?:为)?|评为)?\s*([0-5](?:\.\d+)?)\s*分", quote)
        }
        return next(iter(matches)) if len(matches) == 1 else _UNVERIFIABLE
    if matcher_key == "quantity":
        number = _quantity_value(quote)
        return number if number is not None else _UNVERIFIABLE
    if matcher_key == "unit":
        matches = {
            _UNIT_ALIASES.get(value.strip().lower(), value.strip().lower())
            for value in _UNIT_PATTERN.findall(quote)
        }
        return next(iter(matches)) if len(matches) == 1 else _UNVERIFIABLE
    if matcher_key == "date":
        return _date_value(quote, family_id=family_id)
    if matcher_key == "meal_type":
        return _meal_type_value(quote)
    if matcher_key == "servings":
        matches = {
            _number_value(value)
            for value in re.findall(r"([0-9]+(?:\.\d+)?|[零〇一二两三四五六七八九十半]+)\s*(?:人?份)", quote)
        }
        return next(iter(matches)) if len(matches) == 1 else _UNVERIFIABLE
    if matcher_key == "text":
        return quote
    return _UNVERIFIABLE


def _explicit_action_value(quote: str, expected: str) -> Any:
    if expected.startswith("set_favorite:"):
        negative = any(phrase in quote for phrase in _NEGATIVE_FAVORITE_PHRASES)
        positive_text = quote
        for phrase in _NEGATIVE_FAVORITE_PHRASES:
            positive_text = positive_text.replace(phrase, "")
        positive = "收藏" in positive_text
        if negative and positive:
            return _UNVERIFIABLE
        if negative:
            return "set_favorite:false"
        if positive:
            return "set_favorite:true"
        return _UNVERIFIABLE
    if expected == "meal_log.simple_create":
        explicit = any(phrase in quote for phrase in _MEAL_LOG_ACTION_PHRASES) or bool(
            re.search(r"^(?:请|帮我|给我)?\s*(?:记录|记下|记一笔|记一下)", quote)
            or re.search(r"把.{1,24}(?:记录下来|记下来|记下)", quote)
        )
        return expected if explicit else _UNVERIFIABLE
    if expected == "meal_plan.simple_create":
        explicit = any(phrase in quote for phrase in _MEAL_PLAN_ACTION_PHRASES) or bool(
            re.search(r"^(?:请|帮我|给我)?\s*(?:安排|制定)", quote)
        )
        return expected if explicit else _UNVERIFIABLE
    if expected in {"rate_food", "meal_log.rate_food"}:
        return expected if re.search(r"(?:打|评分|评为).{0,12}[0-5](?:\.\d+)?\s*分", quote) else _UNVERIFIABLE
    if expected in {"create", "shopping_list.create"}:
        return expected if any(phrase in quote for phrase in ("买", "加入购物清单", "添加到购物清单")) else _UNVERIFIABLE
    if expected == "update":
        return expected if any(phrase in quote for phrase in ("修改", "改成", "调整")) else _UNVERIFIABLE
    if expected in {"set_done:false", "restore"}:
        return expected if any(phrase in quote for phrase in ("恢复", "取消完成", "重新加入")) else _UNVERIFIABLE
    return _UNVERIFIABLE


def _date_value(quote: str, *, family_id: str) -> Any:
    candidates: set[str] = set()
    for direct in re.findall(r"\b(\d{4}-\d{2}-\d{2})\b", quote):
        try:
            candidates.add(date.fromisoformat(direct).isoformat())
        except ValueError:
            return _UNVERIFIABLE
    today = today_for_family(family_id)
    if "后天" in quote:
        candidates.add((today + timedelta(days=2)).isoformat())
    if "明天" in quote or "明晚" in quote:
        candidates.add((today + timedelta(days=1)).isoformat())
    if any(token in quote for token in ("昨天", "昨晚")):
        candidates.add((today - timedelta(days=1)).isoformat())
    if any(token in quote for token in ("今天", "今日", "今晚")):
        candidates.add(today.isoformat())
    return next(iter(candidates)) if len(candidates) == 1 else _UNVERIFIABLE


def _meal_type_value(quote: str) -> Any:
    candidates: set[str] = set()
    if any(token in quote for token in ("夜宵", "加餐", "下午茶")):
        candidates.add("snack")
    if any(token in quote for token in ("早餐", "早饭", "早上")):
        candidates.add("breakfast")
    if any(token in quote for token in ("午餐", "午饭", "中午")):
        candidates.add("lunch")
    if any(token in quote for token in ("晚餐", "晚饭", "晚上", "今晚", "明晚", "昨晚")):
        candidates.add("dinner")
    return next(iter(candidates)) if len(candidates) == 1 else _UNVERIFIABLE


def _canonical_values_equal(matcher_key: str, actual: Any, expected: Any) -> bool:
    if matcher_key in {"rating", "quantity", "servings"}:
        try:
            return Decimal(str(actual)) == Decimal(str(expected))
        except InvalidOperation:
            return False
    if matcher_key == "unit":
        actual_unit = _UNIT_ALIASES.get(str(actual).strip().lower(), str(actual).strip().lower())
        expected_unit = _UNIT_ALIASES.get(str(expected).strip().lower(), str(expected).strip().lower())
        return actual_unit == expected_unit
    if matcher_key == "text":
        return normalize_intent_text(expected) in normalize_intent_text(actual)
    return actual == expected


def _collect_tool_item_facts(
    item: dict[str, Any],
    *,
    versions: dict[str, int | str | None],
    values: dict[str, dict[str, Any]],
    identity_only: bool = False,
) -> None:
    entity_id = str(item.get("id") or "").strip()
    version = item.get("rowVersion") if "rowVersion" in item else item.get("updatedAt")
    if entity_id:
        versions[entity_id] = version
        values[entity_id] = (
            {"entity_id": entity_id}
            if identity_only
            else _allowlisted_facts(item, entity_id=entity_id)
        )
    for linked_key in ("foodId", "ingredientId", "recipeId"):
        linked_id = str(item.get(linked_key) or "").strip()
        if linked_id:
            versions.setdefault(linked_id, None)
            values.setdefault(linked_id, {"entity_id": linked_id})
    for collection_key in ("foods", "foodEntries"):
        if identity_only:
            break
        collection = item.get(collection_key)
        if not isinstance(collection, list):
            continue
        for entry in collection:
            if not isinstance(entry, dict):
                continue
            entry_id = str(entry.get("id") or "").strip()
            food_id = str(entry.get("foodId") or "").strip()
            if entry_id:
                versions[entry_id] = version
                values[entry_id] = _allowlisted_facts(entry, entity_id=entry_id)
            if food_id:
                versions.setdefault(food_id, None)
                food_values = values.setdefault(food_id, {"entity_id": food_id})
                for key in ("rating", "servings"):
                    if key in entry:
                        food_values[key] = entry[key]


def _trusted_tool_source(
    *,
    reference_id: str,
    family_id: str,
    versions: dict[str, int | str | None],
    values: dict[str, dict[str, Any]],
) -> dict[str, TrustedResolutionSource]:
    if not versions:
        return {}
    return {
        reference_id: TrustedResolutionSource(
            kind="tool_result",
            reference_id=reference_id,
            family_id=family_id,
            entity_versions=versions,
            entity_values=values,
        )
    }


def _artifact_facts(artifact: dict[str, Any]) -> tuple[dict[str, int | str | None], dict[str, dict[str, Any]]]:
    artifact_version = artifact.get("version") or artifact.get("draftVersion")
    payload = artifact.get("payload")
    if not isinstance(payload, dict):
        initial_values = artifact.get("initialValues")
        if isinstance(initial_values, dict):
            payload_candidates = [item for item in initial_values.values() if isinstance(item, dict)]
            payload = payload_candidates[0] if payload_candidates else None
    if not isinstance(payload, dict):
        return {}, {}
    versions: dict[str, int | str | None] = {}
    values: dict[str, dict[str, Any]] = {}

    def add(entity_id: Any, record: dict[str, Any], *, path_prefix: str | None = None) -> None:
        normalized_id = str(entity_id or "").strip()
        if not normalized_id:
            return
        versions[normalized_id] = artifact_version
        path_facts = _allowlisted_path_facts(record, path_prefix=path_prefix) if path_prefix else {}
        values[normalized_id] = {
            **values.get(normalized_id, {}),
            **_allowlisted_facts(record, entity_id=normalized_id),
            **path_facts,
        }

    add(
        payload.get("targetId"),
        payload.get("payload") if isinstance(payload.get("payload"), dict) else payload,
        path_prefix="payload",
    )
    for index, item in enumerate(payload.get("foods") or []):
        if isinstance(item, dict):
            add(item.get("foodId"), item, path_prefix=f"foods[{index}]")
    for index, item in enumerate(payload.get("items") or []):
        if isinstance(item, dict):
            add(
                item.get("foodId") or item.get("ingredient_id") or item.get("ingredientId"),
                item,
                path_prefix=f"items[{index}]",
            )
    nested_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    for index, item in enumerate(nested_payload.get("foodEntryRatings") or []):
        if isinstance(item, dict):
            add(item.get("id"), item, path_prefix=f"payload.foodEntryRatings[{index}]")
    for index, operation in enumerate(payload.get("operations") or []):
        if not isinstance(operation, dict):
            continue
        operation_payload = operation.get("payload") if isinstance(operation.get("payload"), dict) else {}
        add(
            operation.get("targetId")
            or operation_payload.get("food_id")
            or operation_payload.get("foodId")
            or operation_payload.get("ingredient_id")
            or operation_payload.get("ingredientId"),
            operation_payload,
            path_prefix=f"operations[{index}].payload",
        )
    return versions, values


def _allowlisted_facts(record: dict[str, Any], *, entity_id: str) -> dict[str, Any]:
    facts: dict[str, Any] = {"entity_id": entity_id}
    aliases = {
        "quantity": ("quantity",),
        "unit": ("unit", "stockUnit"),
        "date": ("date",),
        "meal_type": ("mealType", "meal_type"),
        "rating": ("rating",),
        "servings": ("servings",),
        "boolean_direction": ("favorite", "done"),
        "text": ("title", "name", "foodName"),
    }
    for fact_key, record_keys in aliases.items():
        for record_key in record_keys:
            if record_key in record and record[record_key] is not None:
                facts[fact_key] = record[record_key]
                break
    return facts


def _allowlisted_path_facts(record: dict[str, Any], *, path_prefix: str) -> dict[str, Any]:
    facts: dict[str, Any] = {}
    for field_name in (
        "quantity",
        "unit",
        "date",
        "mealType",
        "rating",
        "servings",
        "favorite",
        "done",
        "title",
        "name",
    ):
        if field_name in record and record[field_name] is not None:
            facts[f"{path_prefix}.{field_name}"] = record[field_name]
    return facts


def _claimed_fields(record: dict[str, Any]) -> set[str]:
    return {str(item) for item in record.get("fields") or [] if isinstance(item, str)}


def _field_leaf(field: str) -> str:
    return field.rsplit(".", 1)[-1]


def _append_reason(reason_codes: list[str], reason: str) -> None:
    if reason not in reason_codes:
        reason_codes.append(reason)


def _quantity_value(text: str) -> Decimal | None:
    number_pattern = r"([0-9]+(?:\.\d+)?|[零〇一二两三四五六七八九十半]+)"
    unit_pattern = r"(?:公斤|千克|毫升|kg|ml|盒|个|袋|瓶|包|斤|克|升|份|碗|罐|条|棵|颗|块|片)"
    matches = {
        _number_value(value)
        for value in re.findall(rf"{number_pattern}\s*{unit_pattern}", text, re.IGNORECASE)
    }
    if not matches:
        matches = {
            _number_value(value)
            for value in re.findall(rf"(?:数量|买|改成|调整为)\s*{number_pattern}(?![\d-])", text)
        }
    return next(iter(matches)) if len(matches) == 1 else None


def _number_value(text: str) -> Decimal:
    if re.fullmatch(r"[0-9]+(?:\.\d+)?", text):
        return Decimal(text)
    if text == "半":
        return Decimal("0.5")
    digits = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    if text == "十":
        return Decimal(10)
    if "十" in text:
        left, right = text.split("十", 1)
        return Decimal((digits.get(left, 1) * 10) + digits.get(right, 0))
    value = 0
    for character in text:
        value = value * 10 + digits[character]
    return Decimal(value)


def _decimal_number(text: str) -> Decimal:
    return Decimal(text)


class _Unverifiable:
    pass


_UNVERIFIABLE = _Unverifiable()

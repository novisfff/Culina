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
_NEGATIVE_FAVORITE_PATTERNS = (
    r"(?:取消|不要|别|不再|不)\s*收藏",
    r"移出收藏",
    r"从.{0,8}收藏.{0,8}移出",
)
_MEAL_LOG_ACTION_PHRASES = ("记录这餐", "记录一下", "记下这餐", "记一笔", "新增餐食记录", "添加餐食记录")
_MEAL_PLAN_ACTION_PHRASES = ("安排到计划", "加入计划", "加到计划", "添加到计划", "制定计划", "安排这餐")
_NEGATION_PREFIX_PATTERN = re.compile(
    r"(?:不要|别|无需|不用|取消|撤销|停止|放弃|不再|不想|不必|不应|不能|不可|不该)"
    r"(?:再|要)?(?:给|把)?[^，,。；;]{0,24}$|不\s*$"
)
_CLAUSE_SPLIT_PATTERN = re.compile(r"(?:但是|不过|然后|但)|[，,。；;]")
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
_RATING_TOKEN_PATTERN = re.compile(
    r"(?<![0-9.+\-＋－﹣−])(?P<number>[0-9]+(?:\.[0-9]+)?)"
    r"(?![0-9.+\-＋－﹣−])\s*分(?![0-9.+\-＋－﹣−])"
)
_RATING_ACTION_PATTERN = re.compile(r"(?:打|评分(?:为)?|评为)")
_RATING_CANCELLATION_PATTERNS = (
    r"(?:取消|清除|删除|去掉).{0,12}(?:评分|打分)",
    r"(?:评分|打分).{0,8}(?:清空|取消|删除)",
)
_ACTION_REQUEST_PREFIX_PATTERN = re.compile(
    r"^(?:请帮(?:我|忙)|请(?:你|您)?|帮(?:我|忙)|麻烦(?:你|您)?|劳驾|给我)\s*"
)
_ACTION_QUESTION_PATTERN = re.compile(
    r"[?？]|请问|为什么|为何|凭什么|干嘛|怎么|怎样|如何|是否|有没有|"
    r"能否|可否|能不能|可不可以|要不要|是不是|什么|谁|哪(?:个|些|里|儿)?|"
    r"几(?:个|次|分)?|吗|呢"
)
_ACTION_INTENT_DESCRIPTION_PATTERN = re.compile(
    r"打算|准备|可能|也许|或许|考虑|希望|(?:我|我们)想(?:要)?|"
    r"计划(?:以后|之后|将来|稍后|晚点)|(?:以后|之后|将来|稍后|晚点|回头)再"
)
_ACTION_STATE_DESCRIPTION_PATTERN = re.compile(
    r"已经|早已|本来就|原本就|目前|当前|刚刚|刚才|早就|仍然|依然|"
    r"现在(?:是|已经|还|仍|处于)"
)
_COMPLETED_ACTION_DESCRIPTION_PATTERN = re.compile(
    r"^(?:(?:收藏|取消收藏|买|购买|记录|记下|安排|制定|修改|调整|恢复|"
    r"取消完成|重新加入)|给.{0,24}打|(?:取消|清除|删除|去掉).{0,12}(?:评分|打分)|"
    r"(?:评分|打分).{0,8}(?:清空|取消|删除))"
    r".{0,32}(?:了|过|着)(?:吧|啊|呀)?$"
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
                field=requirement.field,
                expected_value=requirement.expected_value,
                quote=normalize_intent_text(quote.get("text")),
                current_message=message,
                family_id=family_id,
                requirements=requirements,
                sources=sources,
                source_trust=source_trust,
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
                    candidate_name = normalize_intent_text(candidate.get("name"))
                    values[entity_id] = {
                        "entity_id": entity_id,
                        **({"text": candidate_name} if candidate_name else {}),
                    }
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
    facts = trusted.entity_values.get(entity_id) or {}
    if matcher_key == "entity_id":
        if trusted.kind == "conversation_artifact":
            return facts.get(field, _UNVERIFIABLE)
        return entity_id
    if matcher_key == "explicit_action":
        return _UNVERIFIABLE
    if field in facts:
        return facts[field]
    if trusted.kind != "tool_result" or "." in field or "[" in field:
        return _UNVERIFIABLE
    if matcher_key in facts:
        return facts[matcher_key]
    field_name = _field_leaf(field)
    return facts.get(field_name, _UNVERIFIABLE)


def _canonical_from_quote(
    *,
    matcher_key: str,
    field: str,
    expected_value: Any,
    quote: str,
    current_message: str,
    family_id: str,
    requirements: tuple[CriticalEvidenceRequirement, ...],
    sources: list[dict[str, Any]],
    source_trust: dict[int, TrustedResolutionSource | None],
) -> Any:
    if matcher_key == "explicit_action":
        return _explicit_action_value(
            quote,
            str(expected_value),
            request_context=current_message,
        )
    if matcher_key == "entity_id":
        return _UNVERIFIABLE
    if matcher_key == "boolean_direction":
        polarity = _command_polarity(
            quote,
            positive_patterns=(r"收藏", r"设为完成", r"标记完成", r"开启"),
            negative_patterns=(
                *_NEGATIVE_FAVORITE_PATTERNS,
                r"取消完成",
                r"恢复未完成",
                r"设为未完成",
                r"关闭",
            ),
        )
        if polarity == "negative":
            return False
        if polarity == "positive":
            return True
        return _UNVERIFIABLE
    if matcher_key == "rating":
        if expected_value is None:
            return (
                None
                if _is_explicit_rating_cancellation(quote, request_context=current_message)
                else _UNVERIFIABLE
            )
        parsed_rating = _parse_rating_token(quote)
        return parsed_rating[0] if parsed_rating is not None else _UNVERIFIABLE
    if matcher_key == "quantity":
        if _concrete_item_scope(field) is not None:
            return _canonical_from_bound_item_tuple(
                field=field,
                matcher_key=matcher_key,
                quote=quote,
                requirements=requirements,
                sources=sources,
                source_trust=source_trust,
            )
        number = _quantity_value(quote)
        return number if number is not None else _UNVERIFIABLE
    if matcher_key == "unit":
        if _concrete_item_scope(field) is not None:
            return _canonical_from_bound_item_tuple(
                field=field,
                matcher_key=matcher_key,
                quote=quote,
                requirements=requirements,
                sources=sources,
                source_trust=source_trust,
            )
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
        return _text_value(quote)
    return _UNVERIFIABLE


def _canonical_from_bound_item_tuple(
    *,
    field: str,
    matcher_key: str,
    quote: str,
    requirements: tuple[CriticalEvidenceRequirement, ...],
    sources: list[dict[str, Any]],
    source_trust: dict[int, TrustedResolutionSource | None],
) -> Any:
    scope = _concrete_item_scope(field)
    identity_requirements = [
        requirement
        for requirement in requirements
        if requirement.matcher_key == "entity_id" and _concrete_item_scope(requirement.field) == scope
    ]
    entity_ids = {str(requirement.expected_value) for requirement in identity_requirements}
    if scope is None or len(identity_requirements) != 1 or len(entity_ids) != 1:
        return _UNVERIFIABLE

    identity_field = identity_requirements[0].field
    entity_id = next(iter(entity_ids))
    canonical_names: set[str] = set()
    for source in sources:
        if identity_field not in _claimed_fields(source) or str(source.get("entityId") or "") != entity_id:
            continue
        trusted = source_trust.get(id(source))
        if trusted is None:
            continue
        name = normalize_intent_text((trusted.entity_values.get(entity_id) or {}).get("text"))
        if name:
            canonical_names.add(name)
    if len(canonical_names) != 1:
        return _UNVERIFIABLE

    canonical_name = next(iter(canonical_names))
    matching_entity_ids = {
        candidate_id
        for trusted in source_trust.values()
        if trusted is not None
        for candidate_id, facts in trusted.entity_values.items()
        if normalize_intent_text(facts.get("text")) == canonical_name
    }
    if matching_entity_ids != {entity_id}:
        return _UNVERIFIABLE

    item_tuples = _item_tuples_for_name(quote, name=canonical_name)
    if len(item_tuples) != 1:
        return _UNVERIFIABLE
    quantity, unit = item_tuples[0]
    return quantity if matcher_key == "quantity" else unit


def _concrete_item_scope(field: str) -> str | None:
    match = re.search(r"^(.*?\[\d+\])(?:\.|$)", field)
    return match.group(1) if match is not None else None


def _item_tuples_for_name(quote: str, *, name: str) -> list[tuple[Decimal, str]]:
    number_pattern = r"[0-9]+(?:\.\d+)?|[零〇一二两三四五六七八九十半]+"
    unit_pattern = _UNIT_PATTERN.pattern[1:-1]
    escaped_name = re.escape(name)
    trailing_boundary = r"(?=$|[\s和与及、,，。；;])"
    patterns = (
        re.compile(
            rf"(?P<number>{number_pattern})\s*(?P<unit>{unit_pattern})\s*"
            rf"{escaped_name}{trailing_boundary}",
            re.IGNORECASE,
        ),
        re.compile(
            rf"(?:^|[\s和与及、,，。；;]|买|购买|添加|加入)\s*{escaped_name}\s*"
            rf"(?P<number>{number_pattern})\s*(?P<unit>{unit_pattern}){trailing_boundary}",
            re.IGNORECASE,
        ),
    )
    matches: dict[tuple[int, int], tuple[Decimal, str]] = {}
    for pattern in patterns:
        for match in pattern.finditer(quote):
            unit = match.group("unit").strip().lower()
            matches[match.span()] = (
                _number_value(match.group("number")),
                _UNIT_ALIASES.get(unit, unit),
            )
    return list(matches.values())


def _explicit_action_value(
    quote: str,
    expected: str,
    *,
    request_context: str,
) -> Any:
    if expected.startswith("set_favorite:"):
        if not _is_explicit_action_request(
            quote,
            request_context=request_context,
            imperative_patterns=(
                r"收藏",
                r"(?:取消|不要|别|不再|不)\s*收藏",
                r"移出收藏",
                r"从.{0,8}收藏.{0,8}移出",
                r"(?:把|将).{1,24}(?:收藏|移出收藏)",
            ),
        ):
            return _UNVERIFIABLE
        polarity = _command_polarity(
            quote,
            positive_patterns=(r"收藏",),
            negative_patterns=_NEGATIVE_FAVORITE_PATTERNS,
        )
        if polarity == "negative":
            return "set_favorite:false"
        if polarity == "positive":
            return "set_favorite:true"
        return _UNVERIFIABLE
    if expected == "meal_log.simple_create":
        if not _is_explicit_action_request(
            quote,
            request_context=request_context,
            imperative_patterns=(
                r"(?:记录|记下|记一笔|记一下)",
                r"(?:把|将).{1,24}(?:记录下来|记下来|记下)",
            ),
        ):
            return _UNVERIFIABLE
        polarity = _command_polarity(
            quote,
            positive_patterns=(
                *(re.escape(phrase) for phrase in _MEAL_LOG_ACTION_PHRASES),
                r"^(?:请|帮我|给我)?\s*(?:记录|记下|记一笔|记一下)",
                r"把.{1,24}(?:记录下来|记下来|记下)",
            ),
            negative_patterns=(
                r"(?:取消|撤销|删除)(?:餐食)?记录",
                r"(?:不要|别|无需|不用|停止|放弃|不再)\s*(?:记录|记下|记一笔|记一下)",
            ),
        )
        return expected if polarity == "positive" else _UNVERIFIABLE
    if expected == "meal_plan.simple_create":
        if not _is_explicit_action_request(
            quote,
            request_context=request_context,
            imperative_patterns=(
                r"(?:安排|制定)",
                r"(?:把|将).{1,24}(?:安排到计划|加入计划|加到计划|添加到计划)",
            ),
        ):
            return _UNVERIFIABLE
        polarity = _command_polarity(
            quote,
            positive_patterns=(
                *(re.escape(phrase) for phrase in _MEAL_PLAN_ACTION_PHRASES),
                r"^(?:请|帮我|给我)?\s*(?:安排|制定)",
            ),
            negative_patterns=(
                r"(?:取消|撤销)(?:安排|计划)",
                r"(?:不要|别|无需|不用|停止|放弃|不再)\s*(?:安排|制定|加入计划|添加到计划)",
            ),
        )
        return expected if polarity == "positive" else _UNVERIFIABLE
    if expected in {"rate_food", "meal_log.rate_food"}:
        if not _is_explicit_action_request(
            quote,
            request_context=request_context,
            imperative_patterns=(
                r"给.{1,24}(?:打|评分|评为)",
                r"(?:打分|评分|评为)",
                *_RATING_CANCELLATION_PATTERNS,
            ),
        ):
            return _UNVERIFIABLE
        if _is_explicit_rating_cancellation(quote, request_context=request_context):
            return expected
        parsed_rating = _parse_rating_token(quote)
        if parsed_rating is None:
            return _UNVERIFIABLE
        action_span = _rating_action_span(quote, rating_span=parsed_rating[1])
        if action_span is None:
            return _UNVERIFIABLE
        polarity = _command_polarity(
            quote,
            positive_patterns=(re.escape(quote[action_span[0] : action_span[1]]),),
            negative_patterns=(r"(?:取消|撤销)(?:评分|打分)",),
        )
        return expected if polarity == "positive" else _UNVERIFIABLE
    if expected in {"create", "shopping_list.create"}:
        if not _is_explicit_action_request(
            quote,
            request_context=request_context,
            imperative_patterns=(
                r"(?:买|购买|加入购物清单|添加到购物清单)",
                r"(?:把|将).{1,24}(?:加入购物清单|添加到购物清单)",
            ),
        ):
            return _UNVERIFIABLE
        polarity = _command_polarity(
            quote,
            positive_patterns=(r"加入购物清单", r"添加到购物清单", r"购买", r"买"),
            negative_patterns=(r"(?:取消|撤销)(?:购买|买|加入购物清单|添加到购物清单)",),
        )
        return expected if polarity == "positive" else _UNVERIFIABLE
    if expected == "update":
        if not _is_explicit_action_request(
            quote,
            request_context=request_context,
            imperative_patterns=(
                r"(?:修改|调整|改成)",
                r"(?:把|将).{1,24}(?:修改|调整|改成)",
            ),
        ):
            return _UNVERIFIABLE
        polarity = _command_polarity(
            quote,
            positive_patterns=(r"修改", r"改成", r"调整"),
            negative_patterns=(r"(?:取消|撤销)(?:修改|调整)",),
        )
        return expected if polarity == "positive" else _UNVERIFIABLE
    if expected in {"set_done:false", "restore"}:
        if not _is_explicit_action_request(
            quote,
            request_context=request_context,
            imperative_patterns=(
                r"(?:恢复|取消完成|重新加入)",
                r"(?:把|将).{1,24}(?:恢复|取消完成|重新加入)",
            ),
        ):
            return _UNVERIFIABLE
        polarity = _command_polarity(
            quote,
            positive_patterns=(r"恢复", r"取消完成", r"重新加入"),
        )
        return expected if polarity == "positive" else _UNVERIFIABLE
    return _UNVERIFIABLE


def _is_explicit_action_request(
    quote: str,
    *,
    request_context: str | None = None,
    imperative_patterns: tuple[str, ...],
) -> bool:
    text = (request_context or quote).strip()
    if not text:
        return False
    if _ACTION_QUESTION_PATTERN.search(text):
        return False
    if _ACTION_INTENT_DESCRIPTION_PATTERN.search(text):
        return False
    if _ACTION_STATE_DESCRIPTION_PATTERN.search(text):
        return False

    request_body = text
    while prefix_match := _ACTION_REQUEST_PREFIX_PATTERN.match(request_body):
        request_body = request_body[prefix_match.end() :].lstrip("：:，,")
    if _COMPLETED_ACTION_DESCRIPTION_PATTERN.match(request_body):
        return False
    return any(re.match(pattern, request_body) is not None for pattern in imperative_patterns)


def _command_polarity(
    quote: str,
    *,
    positive_patterns: tuple[str, ...],
    negative_patterns: tuple[str, ...] = (),
) -> str | None:
    polarities: set[str] = set()
    for clause in (part.strip() for part in _CLAUSE_SPLIT_PATTERN.split(quote)):
        if not clause:
            continue
        negative_spans = [
            match.span()
            for pattern in negative_patterns
            for match in re.finditer(pattern, clause)
        ]
        if negative_spans:
            polarities.add("negative")
        for pattern in positive_patterns:
            for match in re.finditer(pattern, clause):
                if any(_spans_overlap(match.span(), negative_span) for negative_span in negative_spans):
                    continue
                prefix = clause[: match.start()]
                polarities.add("negative" if _NEGATION_PREFIX_PATTERN.search(prefix) else "positive")
    if len(polarities) != 1:
        return None
    return next(iter(polarities))


def _spans_overlap(left: tuple[int, int], right: tuple[int, int]) -> bool:
    return left[0] < right[1] and right[0] < left[1]


def _parse_rating_token(quote: str) -> tuple[Decimal, tuple[int, int]] | None:
    matches = list(_RATING_TOKEN_PATTERN.finditer(quote))
    if len(matches) != 1:
        return None
    match = matches[0]
    value = Decimal(match.group("number"))
    if value < Decimal("0") or value > Decimal("5"):
        return None
    return value, match.span()


def _is_explicit_rating_cancellation(
    quote: str,
    *,
    request_context: str | None = None,
) -> bool:
    if not _is_explicit_action_request(
        quote,
        request_context=request_context,
        imperative_patterns=_RATING_CANCELLATION_PATTERNS,
    ):
        return False
    if _RATING_TOKEN_PATTERN.search(quote):
        return False
    cancellation_spans = [
        match.span()
        for pattern in _RATING_CANCELLATION_PATTERNS
        for match in re.finditer(pattern, quote)
    ]
    if not cancellation_spans:
        return False
    polarity = _command_polarity(
        quote,
        positive_patterns=_RATING_CANCELLATION_PATTERNS,
    )
    if polarity != "positive":
        return False
    return not any(
        not any(_spans_overlap(action_match.span(), cancellation_span) for cancellation_span in cancellation_spans)
        for action_match in _RATING_ACTION_PATTERN.finditer(quote)
    )


def _rating_action_span(quote: str, *, rating_span: tuple[int, int]) -> tuple[int, int] | None:
    prefix = quote[: rating_span[0]]
    for action_match in reversed(list(_RATING_ACTION_PATTERN.finditer(prefix))):
        between = prefix[action_match.end() :]
        if len(between) <= 12 and not re.search(r"[，,。；;]", between):
            return action_match.start(), rating_span[1]
    return None


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
        if matcher_key == "rating" and actual is None and expected is None:
            return True
        try:
            return Decimal(str(actual)) == Decimal(str(expected))
        except InvalidOperation:
            return False
    if matcher_key == "unit":
        actual_unit = _UNIT_ALIASES.get(str(actual).strip().lower(), str(actual).strip().lower())
        expected_unit = _UNIT_ALIASES.get(str(expected).strip().lower(), str(expected).strip().lower())
        return actual_unit == expected_unit
    if matcher_key == "text":
        return normalize_intent_text(actual) == normalize_intent_text(expected)
    return actual == expected


def _text_value(quote: str) -> Any:
    normalized = normalize_intent_text(quote)
    quoted_mentions = [
        normalize_intent_text(value)
        for value in re.findall(r"[「“\"]([^」”\"]+)[」”\"]", normalized)
        if normalize_intent_text(value)
    ]
    if quoted_mentions:
        return next(iter(quoted_mentions)) if len(quoted_mentions) == 1 else _UNVERIFIABLE

    content = normalized
    action_match = re.fullmatch(
        r"(?:请|帮我|给我|麻烦)?\s*(?:买|购买|加入购物清单|添加到购物清单)\s*(.+)",
        content,
    )
    field_match = re.fullmatch(
        r"(?:请|帮我|给我|麻烦)?\s*(?:把)?(?:名称|标题|备注|原因)"
        r"(?:修改为|改成|改为|调整为|设为|是|为)\s*(.+)",
        content,
    )
    if action_match is not None:
        content = action_match.group(1)
    elif field_match is not None:
        content = field_match.group(1)
    elif re.search(r"(?:买|购买|加入购物清单|添加到购物清单|修改为|改成|调整为)", content):
        return _UNVERIFIABLE

    candidates = [
        _strip_quantity_unit_prefix(part)
        for part in re.split(r"(?:以及|还有|或者|和|与|或|、|，|,|；|;)", content)
        if _strip_quantity_unit_prefix(part)
    ]
    return next(iter(candidates)) if len(candidates) == 1 else _UNVERIFIABLE


def _strip_quantity_unit_prefix(value: str) -> str:
    number_pattern = r"[0-9]+(?:\.\d+)?|[零〇一二两三四五六七八九十半]+"
    unit_pattern = _UNIT_PATTERN.pattern[1:-1]
    stripped = re.sub(
        rf"^\s*(?:{number_pattern})\s*(?:{unit_pattern})\s*",
        "",
        normalize_intent_text(value),
        count=1,
        flags=re.IGNORECASE,
    )
    return stripped.strip(" \t\r\n。.!！?？")


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

    def add(
        entity_id: Any,
        record: dict[str, Any],
        *,
        path_prefix: str | None = None,
        identity_path: str | None = None,
    ) -> None:
        normalized_id = str(entity_id or "").strip()
        if not normalized_id:
            return
        versions[normalized_id] = artifact_version
        path_facts = _allowlisted_path_facts(record, path_prefix=path_prefix) if path_prefix else {}
        if identity_path:
            path_facts[identity_path] = normalized_id
        values[normalized_id] = {
            **values.get(normalized_id, {}),
            **_allowlisted_facts(record, entity_id=normalized_id),
            **path_facts,
        }

    add(
        payload.get("targetId"),
        payload.get("payload") if isinstance(payload.get("payload"), dict) else payload,
        path_prefix="payload",
        identity_path="targetId",
    )
    for index, item in enumerate(payload.get("foods") or []):
        if isinstance(item, dict):
            add(
                item.get("foodId"),
                item,
                path_prefix=f"foods[{index}]",
                identity_path=f"foods[{index}].foodId",
            )
    for index, item in enumerate(payload.get("items") or []):
        if isinstance(item, dict):
            identity_key = next(
                (
                    key
                    for key in ("foodId", "ingredient_id", "ingredientId")
                    if item.get(key)
                ),
                None,
            )
            add(
                item.get(identity_key) if identity_key else None,
                item,
                path_prefix=f"items[{index}]",
                identity_path=f"items[{index}].{identity_key}" if identity_key else None,
            )
    nested_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    for index, item in enumerate(nested_payload.get("foodEntryRatings") or []):
        if isinstance(item, dict):
            add(
                item.get("id"),
                item,
                path_prefix=f"payload.foodEntryRatings[{index}]",
                identity_path=f"payload.foodEntryRatings[{index}].id",
            )
    for index, operation in enumerate(payload.get("operations") or []):
        if not isinstance(operation, dict):
            continue
        operation_payload = operation.get("payload") if isinstance(operation.get("payload"), dict) else {}
        operation_identity_key = next(
            (
                key
                for key in ("food_id", "foodId", "ingredient_id", "ingredientId")
                if operation_payload.get(key)
            ),
            None,
        )
        operation_target_id = operation.get("targetId")
        add(
            operation_target_id
            or (operation_payload.get(operation_identity_key) if operation_identity_key else None),
            operation_payload,
            path_prefix=f"operations[{index}].payload",
            identity_path=(
                f"operations[{index}].targetId"
                if operation_target_id
                else (
                    f"operations[{index}].payload.{operation_identity_key}"
                    if operation_identity_key
                    else None
                )
            ),
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


class _Unverifiable:
    pass


_UNVERIFIABLE = _Unverifiable()

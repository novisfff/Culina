from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy.orm import Session


AssertUpdatedAt = Callable[..., None]
DraftNormalizePhase = Literal["proposal", "approval"]


@dataclass(frozen=True, slots=True)
class DraftNormalizeContext:
    db: Session
    draft_type: str
    family_id: str
    user_id: str
    conversation_id: str
    payload: dict[str, Any]
    phase: DraftNormalizePhase = "proposal"


@dataclass(frozen=True, slots=True)
class DraftExecuteContext:
    db: Session
    draft_type: str
    family_id: str
    user_id: str
    payload: dict[str, Any]
    assert_updated_at_matches: AssertUpdatedAt


@dataclass(frozen=True, slots=True)
class DraftPostExecuteContext:
    db: Session
    draft_type: str
    family_id: str
    user_id: str
    message_id: str
    business_entity: dict[str, Any]


NormalizeDraft = Callable[[DraftNormalizeContext], dict[str, Any]]
ExecuteDraft = Callable[[DraftExecuteContext], tuple[dict[str, Any], list[str]]]
PostExecuteHook = Callable[[DraftPostExecuteContext], None]
ApprovalConfigBuilder = Callable[[dict[str, Any]], dict[str, str]]
PreviewSummaryBuilder = Callable[[dict[str, Any]], str]
ApprovalValueValidator = Callable[[Any, Any], None]
RecoveryCurrentValueLoader = Callable[..., dict[str, Any] | None]
BusinessEntityRecordsExtractor = Callable[[Any, str], list[dict[str, Any]]]


DEFAULT_OPERATION_LABELS: dict[str, str] = {
    "create": "新增",
    "update": "更新",
    "delete": "删除",
    "set_status": "状态变更",
    "set_done": "状态变更",
    "set_favorite": "收藏",
    "update_details": "补充详情",
    "rate_food": "评分",
    "cook": "做菜",
    "restock": "补货",
    "consume": "消耗",
    "dispose": "销毁",
    "inventory_operation": "库存处理",
}

APPROVAL_TYPE_DEFAULT_ACTION_SUFFIXES: tuple[tuple[str, str], ...] = (
    (".create", "create"),
    (".update", "update"),
    (".delete", "delete"),
    (".favorite", "set_favorite"),
    (".rate_food", "rate_food"),
    (".cook", "cook"),
)


def _allow_any_approval_value(original: Any, submitted: Any) -> None:
    del original, submitted


@dataclass(frozen=True, slots=True)
class DraftResultMetadata:
    workspace_label: str = "对应页面"
    count_noun: str = "个实体"
    fallback_label: str = "业务记录"
    default_action: str = ""
    action_labels: dict[str, str] = field(default_factory=dict)
    recovery_hint: str = "可以根据当前业务值调整草稿后重试；如果变更范围已经不适合当前草稿，建议重新生成。"

    def count_label(self, count: int) -> str:
        return f"{count} {self.count_noun}"


DEFAULT_DRAFT_RESULT_METADATA = DraftResultMetadata()


@dataclass(frozen=True, slots=True)
class DraftOperationSpec:
    draft_type: str
    normalize: NormalizeDraft
    execute: ExecuteDraft
    after_success: PostExecuteHook | None
    approval_config: ApprovalConfigBuilder
    preview_summary: PreviewSummaryBuilder
    validate_approval_value: ApprovalValueValidator = _allow_any_approval_value
    result_metadata: DraftResultMetadata = DEFAULT_DRAFT_RESULT_METADATA
    business_entity_records: BusinessEntityRecordsExtractor | None = None
    load_current_value: RecoveryCurrentValueLoader | None = None


class DraftOperationRegistry:
    def __init__(self, specs: list[DraftOperationSpec]) -> None:
        draft_type_counts = Counter(spec.draft_type for spec in specs)
        duplicate_types = sorted(draft_type for draft_type, count in draft_type_counts.items() if count > 1)
        if duplicate_types:
            raise ValueError(f"Duplicate draft operation types registered: {', '.join(duplicate_types)}")
        self._specs = {spec.draft_type: spec for spec in specs}

    def get(self, draft_type: str) -> DraftOperationSpec:
        try:
            return self._specs[draft_type]
        except KeyError as exc:
            raise ValueError("暂不支持的草稿类型") from exc

    def keys(self) -> list[str]:
        return sorted(self._specs)

    def supports(self, draft_type: str) -> bool:
        return draft_type in self._specs

    def normalize(self, context: DraftNormalizeContext) -> dict[str, Any]:
        return self.get(context.draft_type).normalize(context)

    def execute(self, context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
        return self.get(context.draft_type).execute(context)

    def after_success(self, context: DraftPostExecuteContext) -> None:
        hook = self.get(context.draft_type).after_success
        if hook is not None:
            hook(context)

    def approval_config_for_payload(self, draft_type: str, payload: dict[str, Any]) -> dict[str, str]:
        return self.get(draft_type).approval_config(payload)

    def preview_summary(self, draft_type: str, payload: dict[str, Any]) -> str:
        return self.get(draft_type).preview_summary(payload)

    def validate_approval_value(self, draft_type: str, original: Any, submitted: Any) -> None:
        self.get(draft_type).validate_approval_value(original, submitted)

    def result_metadata(self, draft_type: str) -> DraftResultMetadata:
        try:
            return self.get(draft_type).result_metadata
        except ValueError:
            return DEFAULT_DRAFT_RESULT_METADATA

    def workspace_label(self, draft_type: str) -> str:
        return self.result_metadata(draft_type).workspace_label

    def count_label(self, draft_type: str, count: int) -> str:
        return self.result_metadata(draft_type).count_label(count)

    def fallback_label(self, draft_type: str) -> str:
        metadata = self.result_metadata(draft_type)
        if metadata is not DEFAULT_DRAFT_RESULT_METADATA:
            return metadata.fallback_label
        return draft_type or metadata.fallback_label

    def default_action(self, draft_type: str) -> str:
        return self.result_metadata(draft_type).default_action

    def result_default_action(
        self,
        draft_type: str,
        *,
        approval_type: str,
        draft_payload: dict[str, Any],
    ) -> str:
        action = str(draft_payload.get("action") or "")
        if action:
            return action
        registry_default = self.default_action(draft_type)
        if registry_default:
            return registry_default
        for suffix, default_action in APPROVAL_TYPE_DEFAULT_ACTION_SUFFIXES:
            if approval_type.endswith(suffix):
                return default_action
        return ""

    def operation_label(self, draft_type: str, action: str) -> str:
        metadata = self.result_metadata(draft_type)
        return metadata.action_labels.get(action) or DEFAULT_OPERATION_LABELS.get(action, action or "已处理")

    def recovery_hint(self, draft_type: str) -> str:
        return self.result_metadata(draft_type).recovery_hint

    def business_entity_records(
        self,
        draft_type: str,
        entity_payload: Any,
        *,
        entity_type: str,
    ) -> list[dict[str, Any]]:
        try:
            extractor = self.get(draft_type).business_entity_records
        except ValueError:
            extractor = None
        if extractor is None:
            return default_business_entity_records(entity_payload, entity_type)
        return extractor(entity_payload, entity_type)

    def load_current_value(
        self,
        db: Session,
        *,
        family_id: str,
        draft_type: str,
        target_id: str,
    ) -> dict[str, Any] | None:
        if not target_id:
            return None
        try:
            spec = self.get(draft_type)
        except ValueError:
            return None
        if spec.load_current_value is None:
            return None
        return spec.load_current_value(db, family_id=family_id, target_id=target_id)




def default_business_entity_records(entity_payload: Any, entity_type: str) -> list[dict[str, Any]]:
    if not isinstance(entity_payload, dict):
        return []
    if entity_type == "Recipe":
        return [entity_payload]
    if isinstance(entity_payload.get("operations"), list):
        records: list[dict[str, Any]] = []
        for item in entity_payload.get("operations") or []:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("item"), dict):
                records.append(
                    {**item["item"], "_operation": item.get("action"), "_operationId": item.get("operationId")}
                )
                continue
            if isinstance(item.get("inventory_item"), dict):
                records.append(
                    {
                        **item["inventory_item"],
                        "_operation": item.get("operation"),
                        "_operationId": item.get("operationId"),
                    }
                )
                continue
            records.append(item)
        return records
    if isinstance(entity_payload.get("steps"), list):
        records = []
        for step in entity_payload.get("steps") or []:
            if not isinstance(step, dict):
                continue
            payload = step.get("payload") if isinstance(step.get("payload"), dict) else {}
            if isinstance(payload.get("operations"), list):
                for item in payload.get("operations") or []:
                    if isinstance(item, dict):
                        records.append({**item, "_operation": step.get("domain"), "_stepId": step.get("stepId")})
                continue
            records.append(step)
        return records
    if isinstance(entity_payload.get("items"), list):
        return [item for item in entity_payload.get("items") or [] if isinstance(item, dict)]
    return [entity_payload]

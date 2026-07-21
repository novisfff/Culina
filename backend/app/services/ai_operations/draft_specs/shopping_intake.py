from __future__ import annotations

from app.services.ai_operations.draft_specs.common import _spec
from app.services.ai_operations.registry_types import DraftOperationSpec, DraftResultMetadata
from app.services.ai_operations.shopping_intake import (
    execute_shopping_intake_draft,
    normalize_shopping_intake_draft,
    validate_shopping_intake_approval_value,
)


def _preview(payload: dict) -> str:
    items = payload.get("items") or []
    unmatched = payload.get("unmatchedCandidates") or []
    suffix = f" · {len(unmatched)} 项额外购买候选" if unmatched else ""
    return f"{len(items)} 项采购完成与入库{suffix}"


def shopping_intake_operation_specs() -> list[DraftOperationSpec]:
    return [
        _spec(
            "shopping_intake",
            normalize=normalize_shopping_intake_draft,
            execute=execute_shopping_intake_draft,
            preview_summary=_preview,
            validate_approval_value=validate_shopping_intake_approval_value,
            result_metadata=DraftResultMetadata(
                workspace_label="购物与库存",
                count_noun="项采购",
                fallback_label="采购入库",
                default_action="shopping_intake",
                recovery_hint="请按冲突行刷新真实购物项和库存目标后重新生成整份草稿；本次不会部分提交。",
            ),
        )
    ]

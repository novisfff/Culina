from __future__ import annotations

from app.services.ai_operations.draft_specs.common import _spec
from app.services.ai_operations.inventory_intake import (
    execute_inventory_intake_draft,
    normalize_inventory_intake_draft,
    validate_inventory_intake_approval_value,
)
from app.services.ai_operations.registry_types import DraftOperationSpec, DraftResultMetadata


def _preview(payload: dict) -> str:
    items = payload.get("items") or []
    ignored = payload.get("ignoredItems") or []
    executable = [
        item
        for item in items
        if isinstance(item, dict) and str(item.get("action") or "") != "skip"
    ]
    suffix = f" · {len(ignored)} 项已忽略" if ignored else ""
    return f"{len(executable)} 项统一入库{suffix}"


def inventory_intake_operation_specs() -> list[DraftOperationSpec]:
    return [
        _spec(
            "inventory_intake",
            normalize=normalize_inventory_intake_draft,
            execute=execute_inventory_intake_draft,
            preview_summary=_preview,
            validate_approval_value=validate_inventory_intake_approval_value,
            result_metadata=DraftResultMetadata(
                workspace_label="库存",
                count_noun="项入库",
                fallback_label="统一入库",
                default_action="inventory_intake",
                action_labels={
                    "stock_and_fulfill": "入库并完成采购项",
                    "fulfill_without_stock": "仅完成采购项",
                    "stock_only": "直接入库",
                },
                recovery_hint="请按冲突行刷新真实采购项和库存目标后重新生成整份草稿；本次不会部分提交。",
            ),
        )
    ]

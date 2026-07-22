from __future__ import annotations

from typing import Any

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import INVENTORY_INTAKE_DRAFT_SCHEMA, draft_input_schema, draft_output_schema
from app.services.ai_operations.inventory_intake import normalize_inventory_intake_draft
from app.services.ai_operations.registry_types import DraftNormalizeContext


def inventory_create_intake_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    normalized = normalize_inventory_intake_draft(
        DraftNormalizeContext(
            db=context.db,
            draft_type="inventory_intake",
            family_id=context.family_id,
            user_id=context.user_id,
            conversation_id=context.conversation_id,
            payload=draft,
        )
    )
    return {"draft": normalized, "itemCount": len(normalized.get("items") or [])}


def register_inventory_intake_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="inventory.create_intake_draft",
        display_name="统一入库确认表单",
        description="为已解决的采购关联行、直接入库行和只读忽略行生成一份正式 inventory_intake 草稿，不写入业务表。",
        side_effect="draft",
        handler=inventory_create_intake_draft,
        input_schema=draft_input_schema(INVENTORY_INTAKE_DRAFT_SCHEMA),
        output_schema=draft_output_schema(INVENTORY_INTAKE_DRAFT_SCHEMA),
        draft_types=["inventory_intake"],
    )

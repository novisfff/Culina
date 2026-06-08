from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.ai.skills.base import BaseSkill, SkillContext, SkillManifest, SkillResult
from app.ai.skills.shared import artifact_by_id, conversation_artifacts, json_object, model_name


class ShoppingListSkill(BaseSkill):
    def run(self, context: SkillContext) -> SkillResult:
        pending = context.tool_executor.call("shopping.read_pending", {"limit": 50})
        inventory = context.tool_executor.call("inventory.read_available_items", {"limit": 80})
        decision = self._decide_with_model(context=context, pending=pending, inventory=inventory)
        if decision is None:
            return SkillResult(text="购物清单模型没有返回有效结果，请重试。", status="failed", model=model_name(context), error="invalid shopping list model response")

        operation = str(decision.get("operation") or "")
        if operation == "clarify":
            return SkillResult(text=str(decision.get("clarification") or "请说明购物清单要基于哪个计划。"), model=model_name(context), operation="clarify", requires_clarification=True)

        source_artifact_id = str(decision.get("sourceArtifactId") or "")
        if operation in {"derive", "modify"}:
            expected_type = "meal_plan" if operation == "derive" else "shopping_list"
            if artifact_by_id(context, source_artifact_id, expected_type) is None:
                return SkillResult(
                    text="没有找到购物清单所引用的有效草稿。",
                    status="failed",
                    model=model_name(context),
                    error=f"invalid {expected_type} source artifact",
                    operation=operation,
                    source_artifact_id=source_artifact_id or None,
                )

        draft_items = self._normalize_model_items(decision.get("items"))
        if not draft_items:
            return SkillResult(text="当前没有需要加入购物清单的项目。", context_summary={"inventoryItemCount": inventory.get("count", 0), "pendingShoppingCount": pending.get("count", 0)}, model=model_name(context), operation=operation, source_artifact_id=source_artifact_id or None)

        pending_titles = {item.get("title") for item in pending.get("items", [])}
        for item in draft_items:
            item["alreadyPending"] = item["title"] in pending_titles

        draft = {"draftType": "shopping_list", "schemaVersion": "shopping_list.v1", "items": draft_items, "sourceDraftId": source_artifact_id or None}
        context.tool_executor.call("shopping.create_draft", {"draft": draft})
        card = {
            "id": "shopping-list-draft",
            "type": "shopping_list_draft",
            "title": "购物清单草稿",
            "data": {
                "draft": draft,
                "items": draft_items,
                "summary": f"{len(draft_items)} 个待确认采购项",
                "sourceSummary": {
                    "plannedMealCount": sum(len((artifact.get("payload") or {}).get("items", [])) for artifact in conversation_artifacts(context, "meal_plan")),
                    "inventoryCount": inventory.get("count", 0),
                    "pendingShoppingCount": pending.get("count", 0),
                },
            },
        }
        return SkillResult(
            text=f"我根据餐食计划里的缺失食材合并了 {len(draft_items)} 个购物清单草稿项，并标注了每项来源。",
            cards=[card],
            drafts=[{"draft_type": "shopping_list", "payload": draft, "schema_version": "shopping_list.v1"}],
            events=[
                {"type": "tool", "message": "已读取待采购项和当前可用库存"},
                {"type": "draft", "message": "已按餐食计划缺口合并购物清单草稿"},
            ],
            context_summary={"inventoryItemCount": inventory.get("count", 0), "pendingShoppingCount": pending.get("count", 0), "draftType": "shopping_list"},
            state_patch={"activeTask": "shopping_list", "activeDraftType": "shopping_list", "lastSkillResults": [{"skillKey": "shopping_list", "draftType": "shopping_list"}]},
            model=model_name(context),
            operation=operation,
            source_artifact_id=source_artifact_id or None,
        )

    def _decide_with_model(self, *, context: SkillContext, pending: dict[str, Any], inventory: dict[str, Any]) -> dict[str, Any] | None:
        if context.provider is None or self.skill_dir is None:
            return None
        system = (self.skill_dir / "prompts" / "system.md").read_text(encoding="utf-8").strip()
        schema = json.loads((self.skill_dir / "schemas" / "decision.schema.json").read_text(encoding="utf-8"))
        result = context.provider.generate(
            system=system,
            user=json.dumps(
                {
                    "conversation": context.conversation,
                    "currentMessage": context.current_message,
                    "availableArtifacts": conversation_artifacts(context),
                    "availableInventory": inventory.get("items", [])[:80],
                    "pendingShopping": pending.get("items", [])[:50],
                },
                ensure_ascii=False,
                default=str,
            ),
            response_schema=schema,
        )
        return json_object(result.text) if result.text else None

    def _normalize_model_items(self, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        merged: dict[tuple[str, str], dict[str, Any]] = {}
        for item in value:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "").strip()
            unit = str(item.get("unit") or "份").strip()
            if not title:
                continue
            key = (title, unit)
            if key not in merged:
                merged[key] = {"title": title, "quantity": 0.0, "unit": unit, "reason": str(item.get("reason") or ""), "sourceMeals": []}
            merged[key]["quantity"] = round(float(merged[key]["quantity"]) + max(float(item.get("quantity") or 1), 0.1), 2)
            for source in item.get("sourceMeals") or []:
                source_text = str(source)
                if source_text and source_text not in merged[key]["sourceMeals"]:
                    merged[key]["sourceMeals"].append(source_text)
        items = list(merged.values())
        for item in items:
            if not item["reason"] and item["sourceMeals"]:
                item["reason"] = f"用于 {'；'.join(item['sourceMeals'][:3])}"
        return items


def create_skill(manifest: SkillManifest, skill_dir: Path) -> BaseSkill:
    return ShoppingListSkill(manifest, skill_dir)

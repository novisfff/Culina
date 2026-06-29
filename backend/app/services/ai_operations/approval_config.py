from __future__ import annotations

from collections import Counter
from typing import Any


DRAFT_APPROVAL_CONFIG: dict[str, dict[str, str]] = {
    "recipe": {
        "value_key": "recipe",
        "widget": "recipe_draft_editor",
        "approval_type": "recipe.create",
        "operation_type": "recipe.create",
        "business_entity_type": "Recipe",
        "title": "确认创建菜谱",
        "instruction": "确认后会创建菜谱，并自动同步一个家常菜食物资料。",
        "approve_label": "创建菜谱",
        "reject_label": "暂不创建",
    },
    "recipe_cook": {
        "value_key": "draft",
        "widget": "textarea",
        "approval_type": "recipe.cook",
        "operation_type": "recipe.cook",
        "business_entity_type": "RecipeCookLog",
        "title": "确认完成做菜",
        "instruction": "确认后会按当前预览扣减库存，并按选择创建餐食记录或完成关联计划。",
        "approve_label": "确认做菜",
        "reject_label": "暂不执行",
    },
    "shopping_list": {
        "value_key": "draft",
        "widget": "textarea",
        "approval_type": "shopping_list.create",
        "operation_type": "shopping_list.create",
        "business_entity_type": "ShoppingListItem",
        "title": "确认创建购物清单",
        "instruction": "确认后会把这些项目加入购物清单。",
        "approve_label": "加入购物清单",
        "reject_label": "暂不加入",
    },
    "meal_plan": {
        "value_key": "draft",
        "widget": "textarea",
        "approval_type": "meal_plan.create",
        "operation_type": "meal_plan.create",
        "business_entity_type": "FoodPlanItem",
        "title": "确认创建餐食计划",
        "instruction": "确认后会把计划项写入菜单计划。未关联食物的条目会先创建可编辑的食物资料。",
        "approve_label": "写入菜单计划",
        "reject_label": "暂不写入",
    },
    "meal_log": {
        "value_key": "draft",
        "widget": "textarea",
        "approval_type": "meal_log.create",
        "operation_type": "meal_log.create",
        "business_entity_type": "MealLog",
        "title": "确认创建餐食记录",
        "instruction": "确认后会创建餐食记录。未关联食物的条目会先创建可编辑的食物资料。",
        "approve_label": "记录餐食",
        "reject_label": "暂不记录",
    },
    "food_profile": {
        "value_key": "draft",
        "widget": "textarea",
        "approval_type": "food_profile.create",
        "operation_type": "food_profile.create",
        "business_entity_type": "Food",
        "title": "确认创建食物资料",
        "instruction": "确认后会把这份资料写入食物库。",
        "approve_label": "创建食物",
        "reject_label": "暂不创建",
    },
    "ingredient_profile": {
        "value_key": "draft",
        "widget": "textarea",
        "approval_type": "ingredient_profile.create",
        "operation_type": "ingredient_profile.create",
        "business_entity_type": "Ingredient",
        "title": "确认整理食材档案",
        "instruction": "确认后会创建或更新当前家庭的食材档案。",
        "approve_label": "确认写入食材",
        "reject_label": "暂不写入",
    },
    "inventory_operation": {
        "value_key": "draft",
        "widget": "textarea",
        "approval_type": "inventory.operation",
        "operation_type": "inventory.operation",
        "business_entity_type": "InventoryItem",
        "title": "确认处理库存",
        "instruction": "请核对食材、批次和数量。确认后会正式修改家庭库存。",
        "approve_label": "确认处理库存",
        "reject_label": "暂不处理",
    },
    "composite_operation": {
        "value_key": "draft",
        "widget": "textarea",
        "approval_type": "composite_operation.apply",
        "operation_type": "composite_operation.apply",
        "business_entity_type": "CompositeOperation",
        "title": "确认执行复合操作",
        "instruction": "请核对每一步影响。确认后会按顺序执行，并在任一步失败时回滚已完成步骤。",
        "approve_label": "执行复合操作",
        "reject_label": "暂不执行",
    },
}


def _operation_action_counter(payload: dict[str, Any]) -> Counter[str]:
    return Counter(
        str(operation.get("action") or "")
        for operation in payload.get("operations") or []
        if isinstance(operation, dict) and str(operation.get("action") or "")
    )


def _is_update_like_action(action: str) -> bool:
    return action in {"update", "set_status", "set_done"}


def _build_operation_copy(
    *,
    create_title: str,
    update_title: str,
    apply_title: str,
    mixed_noun: str,
    create_instruction: str,
    update_instruction: str,
    apply_instruction: str,
    create_approve_label: str,
    update_approve_label: str,
    apply_approve_label: str,
    payload: dict[str, Any],
) -> dict[str, str]:
    counts = _operation_action_counter(payload)
    total = sum(counts.values())
    if total <= 0:
        return {
            "title": apply_title,
            "instruction": apply_instruction,
            "approve_label": apply_approve_label,
            "reject_label": "暂不应用",
        }
    action_keys = set(counts)
    if action_keys == {"create"}:
        return {
            "title": create_title,
            "instruction": create_instruction,
            "approve_label": create_approve_label,
            "reject_label": "暂不添加",
        }
    if action_keys and all(_is_update_like_action(action) for action in action_keys):
        return {
            "title": update_title,
            "instruction": update_instruction,
            "approve_label": update_approve_label,
            "reject_label": "暂不修改",
        }
    if total > 1:
        return {
            "title": f"确认应用 {total} 项{mixed_noun}",
            "instruction": apply_instruction,
            "approve_label": apply_approve_label,
            "reject_label": "暂不应用",
        }
    return {
        "title": apply_title,
        "instruction": apply_instruction,
        "approve_label": apply_approve_label,
        "reject_label": "暂不应用",
    }


def approval_config_for_payload(draft_type: str, payload: dict[str, Any]) -> dict[str, str]:
    config = dict(DRAFT_APPROVAL_CONFIG[draft_type])
    if draft_type == "meal_plan" and isinstance(payload.get("operations"), list):
        config.update(
            {
                "approval_type": "meal_plan.apply",
                "operation_type": "meal_plan.apply",
                **_build_operation_copy(
                    create_title="确认添加餐食计划",
                    update_title="确认修改餐食计划",
                    apply_title="确认应用餐食计划变更",
                    mixed_noun="计划调整",
                    create_instruction="确认后会把这些计划项加入你的菜单计划。未关联食物的条目会先创建可编辑的食物资料。",
                    update_instruction="确认后会按草稿修改你的菜单计划状态、日期或内容。",
                    apply_instruction="确认后会按草稿创建、修改或删除你的餐食计划。",
                    create_approve_label="添加计划",
                    update_approve_label="修改计划",
                    apply_approve_label="应用计划变更",
                    payload=payload,
                ),
            }
        )
    elif draft_type == "shopping_list" and isinstance(payload.get("operations"), list):
        config.update(
            {
                "approval_type": "shopping_list.apply",
                "operation_type": "shopping_list.apply",
                **_build_operation_copy(
                    create_title="确认添加购物清单",
                    update_title="确认修改购物清单",
                    apply_title="确认应用购物清单变更",
                    mixed_noun="清单调整",
                    create_instruction="确认后会把这些项目加入购物清单。",
                    update_instruction="确认后会按草稿修改待买数量、备注或完成状态。",
                    apply_instruction="确认后会按草稿创建、修改或删除购物清单项目。",
                    create_approve_label="添加清单",
                    update_approve_label="修改清单",
                    apply_approve_label="应用清单变更",
                    payload=payload,
                ),
            }
        )
    elif draft_type == "ingredient_profile":
        operations = payload.get("operations")
        if isinstance(operations, list):
            total = len(operations)
            config.update(
                {
                    "approval_type": "ingredient.create",
                    "operation_type": "ingredient.create",
                    "title": f"确认创建 {total} 个食材档案",
                    "instruction": "确认后会批量创建当前家庭的食材档案，不会登记库存数量。",
                    "approve_label": "创建食材",
                    "reject_label": "暂不创建",
                }
            )
            return config
        action = str(payload.get("action") or "create")
        if action == "update":
            config.update(
                {
                    "approval_type": "ingredient.update",
                    "operation_type": "ingredient.update",
                    "title": "确认更新食材档案",
                    "instruction": "确认后会更新当前家庭的食材档案。",
                    "approve_label": "更新食材",
                    "reject_label": "暂不更新",
                }
            )
        else:
            config.update(
                {
                    "approval_type": "ingredient.create",
                    "operation_type": "ingredient.create",
                    "title": "确认创建食材档案",
                    "instruction": "确认后会创建当前家庭的食材档案。",
                    "approve_label": "创建食材",
                    "reject_label": "暂不创建",
                }
            )
    elif draft_type == "food_profile":
        action = str(payload.get("action") or "create")
        if action == "update":
            config.update(
                {
                    "approval_type": "food.update",
                    "operation_type": "food.update",
                    "title": "确认更新食物资料",
                    "instruction": "确认后会更新当前家庭的食物资料。",
                    "approve_label": "更新食物",
                    "reject_label": "暂不更新",
                }
            )
        elif action == "set_favorite":
            favorite = bool((payload.get("payload") or {}).get("favorite"))
            config.update(
                {
                    "approval_type": "food.favorite",
                    "operation_type": "food.favorite",
                    "title": "确认更新收藏状态",
                    "instruction": f"确认后会将该食物{'加入' if favorite else '移出'}收藏。",
                    "approve_label": "确认更新收藏",
                    "reject_label": "暂不更新",
                }
            )
    elif draft_type == "meal_log":
        action = str(payload.get("action") or "create")
        if action == "update_details":
            config.update(
                {
                    "approval_type": "meal_log.update",
                    "operation_type": "meal_log.update",
                    "title": "确认补充餐食记录",
                    "instruction": "确认后会更新参与人、备注、心情和媒体。",
                    "approve_label": "更新记录",
                    "reject_label": "暂不更新",
                }
            )
        elif action == "rate_food":
            config.update(
                {
                    "approval_type": "meal_log.rate_food",
                    "operation_type": "meal_log.rate_food",
                    "title": "确认更新食物评分",
                    "instruction": "确认后会更新这条餐食记录里的食物评分。",
                    "approve_label": "更新评分",
                    "reject_label": "暂不更新",
                }
            )
    elif draft_type == "recipe":
        action = str(payload.get("action") or "create")
        if action == "update":
            config.update(
                {
                    "value_key": "draft",
                    "widget": "textarea",
                    "approval_type": "recipe.update",
                    "operation_type": "recipe.update",
                    "title": "确认更新菜谱",
                    "instruction": "确认后会更新当前家庭的菜谱资料，并同步关联家常菜。",
                    "approve_label": "更新菜谱",
                    "reject_label": "暂不更新",
                }
            )
        elif action == "delete":
            config.update(
                {
                    "value_key": "draft",
                    "widget": "textarea",
                    "approval_type": "recipe.delete",
                    "operation_type": "recipe.delete",
                    "title": "确认删除菜谱",
                    "instruction": "确认后会删除菜谱，并按现有业务规则处理同步食物和媒体绑定。",
                    "approve_label": "删除菜谱",
                    "reject_label": "暂不删除",
                }
            )
        elif action == "set_favorite":
            favorite = bool((payload.get("payload") or {}).get("favorite"))
            config.update(
                {
                    "value_key": "draft",
                    "widget": "textarea",
                    "approval_type": "recipe.favorite",
                    "operation_type": "recipe.favorite",
                    "title": "确认更新菜谱收藏状态",
                    "instruction": f"确认后会将该菜谱{'加入' if favorite else '移出'}收藏。",
                    "approve_label": "确认更新收藏",
                    "reject_label": "暂不更新",
                }
            )
    return config

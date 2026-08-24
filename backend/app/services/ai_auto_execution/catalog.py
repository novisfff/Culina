from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping


CATALOG_VERSION = "auto-execution.v1"
CONSENT_NOTICE_VERSION = "auto-execution-consent.v1"


@dataclass(frozen=True, slots=True)
class AutoExecutionActionDefinition:
    key: str
    label: str
    description: str
    exclusions: str
    member_opt_in_required: bool
    family_policy_required: bool
    limits: Mapping[str, int]


def _definition(
    key: str,
    label: str,
    description: str,
    exclusions: str,
    member_opt_in_required: bool,
    family_policy_required: bool,
    limits: dict[str, int],
) -> AutoExecutionActionDefinition:
    return AutoExecutionActionDefinition(
        key=key,
        label=label,
        description=description,
        exclusions=exclusions,
        member_opt_in_required=member_opt_in_required,
        family_policy_required=family_policy_required,
        limits=MappingProxyType(limits),
    )


AUTO_EXECUTION_CATALOG = MappingProxyType({
    item.key: item
    for item in (
        _definition("food.set_favorite", "收藏状态", "收藏或取消收藏一个已有食物", "不修改食物资料或图片", True, False, {}),
        _definition("meal_log.rate_food", "餐食评分", "一次评分或取消评分最多 5 个食物项", "不修改餐食组成、参与人或图片", True, False, {"items": 5}),
        _definition("shopping_list.safe_write", "购物清单安全操作", "新增/恢复最多 5 项，修改最多 1 项", "不删除、不标记买到、不入库", True, True, {"add_or_restore_items": 5, "update_items": 1}),
        _definition("meal_log.simple_create", "简单餐食记录", "使用最多 5 个已有食物新增一餐", "不扣库存、不关联计划、不添加图片", True, False, {"foods": 5}),
        _definition("meal_plan.simple_create", "简单餐食计划", "使用最多 5 个已有食物新增计划", "不更新状态、不联动购物清单", True, False, {"items": 5}),
    )
})

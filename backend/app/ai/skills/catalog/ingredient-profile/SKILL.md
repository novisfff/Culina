---
name: ingredient-profile
key: ingredient_profile
display_name: 食材档案
description: 查询、创建和更新当前家庭的食材档案，为库存、菜谱和购物清单提供真实食材基础资料。
allowed_tools:
  - ingredient.search
  - ingredient.read_by_id
  - intent.request_clarification
  - ingredient_profile.create_draft
context_policy:
  - ingredients
output_types:
  - clarification_request
draft_types:
  - ingredient_profile
approval_policy: draft_then_confirm
can_continue_from:
  - ingredient_profile
intent: ingredient_profile
agent_key: ingredient_profile_agent
examples:
  - 新增鸡胸肉食材，默认单位克，冷冻保存。
  - 把番茄默认保质期改成 7 天。
  - 查询鸡蛋支持哪些单位。
---

# 食材档案 Skill

## 适用范围

- 用户要查询、创建或更新当前家庭的食材档案。
- 适合作为库存入库、菜谱补食材和购物清单确认前的上游能力。
- 不直接处理库存数量、菜谱步骤或购物项写入。

## 执行规则

- 搜索时优先使用 `ingredient.search`，需要确定目标时改用 `ingredient.read_by_id`。
- 同名或近似名称结果不能自动猜测为唯一目标，必须基于真实结果确认。
- 需要用户补充数量、目标或同名候选时，调用 `intent.request_clarification`，并带上候选摘要与问题类型。
- 创建和更新都只能通过 `ingredient_profile.create_draft` 生成可确认草稿。
- 更新时必须引用真实 `targetId` 和 `baseUpdatedAt`，不能只靠名称修改。
- 已有库存时不得把主单位改成其他单位；该限制由后端再次校验。
- 媒体、单位换算、保质期和库存提醒都必须使用真实字段，不编造业务 ID。
- 用户明确要求把上次确认的单位换算保存为副单位时，必须先读取真实食材详情，再调用 `ingredient_profile.create_draft` 生成单独更新审批；不要假装已保存。
- 用户确认前不得写入正式 `Ingredient`。

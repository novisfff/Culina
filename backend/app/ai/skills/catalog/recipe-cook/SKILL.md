---
name: recipe-cook
description: 按已有菜谱实际做一次菜，预览缺料和库存扣减，并在可做时生成做菜执行草稿，可关联计划和可选记录餐食；不新建/编辑菜谱、不做普通餐食记录或未来餐食安排。
---

# 菜谱做菜 Skill

## 用户目标

- 按当前家庭已有菜谱实际做一次菜，预览份数、缺料和库存扣减。
- 可选关联同一菜谱的真实餐食计划项，并在用户明确要求时创建餐食记录。
- 库存充足后生成一个待确认的 `recipe_cook` 草稿。

## 不适用范围

- 新建、编辑、删除或收藏菜谱交给 `recipe_draft`；菜谱不存在时先创建菜谱。
- 做菜页内步骤问答、计时器和页面动作交给 `cooking_assistant`。
- 没有做菜扣库存语义的普通用餐记录交给 `meal_log`，未来安排交给 `meal_plan`。

## 工作模式

- `preview`：锁定唯一真实菜谱，按需查计划，调用 `recipe.preview_cook` 返回扣减预览和缺料。
- `execute`：只有 preview 的 `shortages` 为空时，调用 `recipe.create_cook_draft` 生成执行草稿。
- 用户只说“做这道菜并扣库存”时 `createMealLog=false`；明确说“记录餐食/吃了/完成计划并记录”时才为 `true`。
- `mealType` 只能是 `breakfast`、`lunch`、`dinner`、`snack`；评分为 1 到 5 的整数，没有明确评分时留空。

## 前置条件

- 先用 `recipe.search` 或 `recipe.read_by_id` 锁定唯一 `recipeId`；目标不存在或不唯一时不得生成执行草稿。
- 只有用户明确要求关联计划时才调用 `meal_plan.read_existing`，并传入当前 `recipeId`，按需附带 `planDate`、`mealType`。
- `planItemId` 只能来自本次按 `recipeId` 过滤后的返回项，不能来自历史摘要、旧草稿、未过滤列表或旧字段名。
- 历史 artifact 只有摘要和 ID；需要完整内容时先调用 `workspace.read_artifact`。

## 候选处理

- 多个菜谱候选时调用 `human.request_input`，候选必须来自 `recipe.search`。
- 多个计划项时展示日期、餐别、标题和状态让用户选择；没有匹配计划项时让用户选择不关联或补充正确计划。
- preview 返回 `planItemWarning` 时丢弃该 `planItemId`，重新按当前菜谱查询或在用户同意后不关联继续。
- 预览中有 `shortages` 时，不生成 `recipe_cook` 草稿，说明缺少项目并让用户在补库存、调整份量、换菜谱之间选择。

## Handoff

- 本 Skill 不声明 typed continuation handoff。
- 菜谱不存在或需要修改菜谱时，说明应进入 `recipe_draft`；缺料需要补库存时交回 Orchestrator 按用户选择路由，不在当前草稿中嵌入自由后续动作。

## 审批规则

- 仅通过 `recipe.create_cook_draft` 生成 `recipe_cook` 草稿，遵循 `preview -> draft -> approval -> commit`。
- 草稿的 `recipeId`、`baseUpdatedAt`、计划项版本、`previewItems` 和 `shortages` 来自本次工具结果。
- 确认前不扣库存、不写做菜日志、不写 MealLog、不完成计划；确认时库存若已变化为缺料，后端必须拒绝并要求刷新预览。

## 用户反馈

- preview 后清楚说明份数、可扣减库存、缺料和计划关联情况。
- 草稿前说明确认后会发生的库存扣减、计划状态和可选 MealLog，不提前承诺完成。
- 需要澄清时只展示真实候选与影响，不编造计划项、成员或库存批次。

---
name: food-profile
key: food_profile
display_name: 食物资料
description: 把自然语言食物描述整理为可编辑、可确认的食物资料草稿。
allowed_tools:
  - food.search
  - food.read_by_id
  - intent.request_clarification
  - food_profile.create_draft
context_policy:
  - foods
output_types:
  - clarification_request
draft_types:
  - food_profile
approval_policy: draft_then_confirm
can_continue_from:
  - food_profile
intent: food_profile
agent_key: food_profile_agent
examples:
  - 整理食物资料 蓝莓酸奶。
  - 新增食物资料。
---

# 食物资料 Skill

## 适用范围

- 用户要新增、整理或补全食物资料。
- 用户要更新食物资料或设置收藏状态。
- 不用于创建菜谱、记录用餐或安排餐食计划。

## 执行规则

- 先调用 `food.search`，需要确认唯一目标时使用 `food.read_by_id`。
- 创建食物资料时，`name`、`type`、`category` 是 `food_profile.create_draft` 的必填字段，禁止提交空 payload 或只提交 `draftType/schemaVersion`。
- 用户原话已经给出或可稳定推断时，必须先填入草稿，不要直接追问。例如“盒装牛奶，类型是即食，适合早餐”应生成 `name=盒装牛奶`、`type=readyMade`、`category=饮品`、`suitable_meal_types=["breakfast"]`。
- 类型映射：自制/家常菜=`selfMade`，外卖=`takeout`，堂食/外食=`diningOut`，即食/现成/盒装/瓶装=`readyMade`，速食/方便食品=`instant`。
- 分类可以根据食物名称给可编辑默认值，例如牛奶/酸奶/豆浆/咖啡/果汁=`饮品`，面包/吐司/饭团=`主食`，鸡胸/肉/鱼/蛋=`蛋白质`。
- 只有名称、类型等关键信息在用户原话和上下文里都无法判断时，才调用 `intent.request_clarification`，并提供候选摘要。
- 如果设置 `recipe_id`，必须来自当前家庭真实菜谱；名称必须与所选菜谱一致。
- 不编造品牌、价格、评分、库存、过期日期或业务 ID。
- 品牌、价格、评分、库存、过期日期等没有明确证据时留空，不要编造。
- 更新和收藏必须引用真实 `targetId` 与 `baseUpdatedAt`，不能只靠名称定位。
- 收藏和取消收藏也必须走草稿审批，不直接在 Skill 中提交正式写入。
- 仅通过 `food_profile.create_draft` 生成 `food_profile` 草稿。
- 草稿需要用户确认；确认前不得写入正式 Food。

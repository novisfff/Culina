---
name: food-profile
description: 查询、创建、更新或收藏当前家庭的食物资料，适用于食物库里的菜品、成品/速食、外卖/外食记录对象和外卖安排晚餐前置建档，也处理成品/速食/包装食品库存字段；不直接创建菜谱、餐食计划或已吃餐食记录。
---

# 食物资料 Skill

## 用户目标

- 查询、创建、补全、更新或收藏当前家庭的 Food 资料。
- 管理成品、速食、包装食品的剩余数量、单位、到期日期、存放位置和购买渠道；这些是 Food 字段，不是食材库存批次。
- 用户要把不存在的外卖、外食或成品安排为今天晚餐时，先建立真实 Food，再通过 typed `continuation` 交给餐食计划。

## 不适用范围

- 原料、调料及食材单位资料交给 `ingredient_profile`；食材库存批次操作交给 `inventory_analysis`。
- 不直接创建菜谱、餐食计划或用餐记录，也不伪造 `recipe_id`、计划项或家庭外资源 ID。
- 已存在 Food 的未来安排直接交给 `meal_plan`；已经发生的用餐记录交给 `meal_log`。

## 工作模式

- `query`：先调用 `food.search`，需要唯一详情时调用 `food.read_by_id`；只读取和摘要，不生成草稿。
- `create`：`name`、`type`、`category` 必须齐全；用户原话可稳定推断时直接写入可编辑草稿，不重复追问。
- `update`：先读取真实详情，使用真实 `targetId` 与 `baseUpdatedAt`；在现有详情上合成完整可编辑 payload。收藏使用 `action=set_favorite`，payload 只含 `favorite`。
- 收藏和取消收藏使用 `action=set_favorite`，payload 只提供 `favorite=true/false`，不要混入 Food 资料更新字段。
- `type` 只能是 `selfMade`、`takeout`、`diningOut`、`readyMade`、`instant`、`packaged`；手动资料优先使用后五类，`selfMade` 只用于真实菜谱关联。
- `suitable_meal_types` 只能是 `breakfast`、`lunch`、`dinner`、`snack`；`rating` 为 1 到 5 的整数，价格和库存数量不能为负。
- `storage_location` 只用于成品、速食、包装食品，优先 `冷藏`、`冷冻`、`常温`；无证据时留空或追问，不默认常温。

## 前置条件

- 创建前搜索同名或近似 Food；更新、收藏前读取真实详情。
- `recipe_id` 必须来自当前家庭真实菜谱，且 Food 名称与菜谱一致；无法确认时转菜谱管理流程。
- 当前消息图片只有在用户明确要求绑定为资料图或参考图时，才把 `currentAttachments` 中真实 `mediaId` 写入 `media_ids`；不得引用历史消息或其他家庭媒体。
- `media_ids` 会在确认后绑定原图，并可作为 AI 主图参考；它不是图片识别结果，也不表示删除或替换原图。

## 候选处理

- `food.search` 只是候选召回。目标不唯一、更新对象不明确或关键字段无法推断时，调用 `human.request_input` 提供候选摘要。
- 类型映射：外卖=`takeout`，堂食/外食=`diningOut`，成品/即食/盒装/瓶装=`readyMade`，方便食品=`instant`，包装食品=`packaged`。
- 分类优先使用 `主食`、`饮品`、`早餐`、`便当`、`零食`、`甜品`、`汤粥`、`小吃`、`外卖`、`速食` 等短标签；品牌、价格、评分、库存、过期日期没有证据时留空。
- 图片只是对话上下文或归属不明时不绑定 `media_ids`，先说明判断或请求澄清。

## Handoff

- `plan_after_create`：Food 不存在且用户要求“安排为今天晚餐/放到今晚菜单”时，创建 `food_profile` 草稿并携带 typed `continuation`：`nextSkillKey=meal_plan`、`resumeSkillKey=meal_plan`、`requiredDraftType=meal_plan`、`stateSchema=food_to_meal_plan.v1`。
- continuation state 只保留 `targetDate`、`mealType` 和简短 `instruction`，不复制 Food 或餐食计划完整 payload。
- 用户要求“安排并记录”时，instruction 必须保留完整目标：Food 确认后先生成餐食计划草稿；计划确认后再由后续流程生成 `meal_log`，尽量关联真实计划项。
- 只有 Food 审批成功后才恢复目标 Skill；本 Skill 不自动生成或提交下一个草稿。

## 审批规则

- 创建、更新、收藏都只能调用 `food_profile.create_draft`，遵循 `draft -> approval -> commit`。
- 确认前不得写入正式 Food；更新 payload 不是局部补丁，至少保留 `name`、`type`、`category`。
- 没有明确换图、删图或替换媒体要求时，不用空数组表达保留图片。

## 用户反馈

- 生成草稿前说明要创建或修改什么，以及哪些字段来自用户原话、现有详情或可编辑默认值。
- 查询时摘要真实资料；候选不唯一时说明差异并让用户选择。
- handoff 前说明会先确认 Food，再继续安排餐食；不能声称下一个草稿已经生成或正式写入已经完成。

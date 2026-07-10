---
name: ingredient-profile
description: 查询、创建和更新当前家庭的食材基础档案，包括默认单位、支持单位、保存位置、保质期和低库存阈值；不处理库存入库/消耗数量、购物项、菜谱正文或食物资料。
---

# 食材档案 Skill

## 用户目标

- 查询、创建和更新当前家庭 Ingredient 档案，包括分类、默认单位、支持单位、保存位置、保质期、数量追踪方式和低库存阈值。
- 为库存入库、菜谱缺食材、购物清单缺采购对象和单位换算保存提供可确认的上游资料。

## 不适用范围

- 不处理库存批次数量、购物项、菜谱正文或 Food 资料；对应交给 `inventory_analysis`、`shopping_list`、`recipe_draft` 或 `food_profile`。
- 不把“少许”“适量”“一撮”写成主单位，也不把前端预设当作数据库中已存在的真实资料。
- 不直接写正式 Ingredient。

## 工作模式

- `query`：使用 `ingredient.search`，需要唯一详情时调用 `ingredient.read_by_id`；只总结真实资料、支持单位和保存规则。
- `create`：创建前搜索同名、别名和高度相似食材；`action=create`，关键字段按用户原话和稳定默认值填入草稿。
- `update`：先读取真实详情，引用真实 `targetId` 与 `baseUpdatedAt`，在现有详情上合成完整 payload；至少保留或填写 `name`、`category`、`default_unit`、`default_storage`、`default_expiry_mode`。
- `action` 只能是 `create` 或 `update`；`quantity_tracking_mode` 只能是 `track_quantity` 或 `not_track_quantity`；`default_expiry_mode` 只能是 `days`、`manual_date` 或 `none`。
- 分类优先使用 `蔬菜`、`肉类`、`水产`、`蛋奶`、`调料`、`水果`、`主食`、`豆制品`、`干货`、`其他`；保存位置优先 `冷藏`、`冷冻`、`常温`。
- 常用单位优先 `个`、`份`、`盒`、`袋`、`瓶`、`包`、`块`、`罐`、`根`、`条`、`颗`、`枚`、`把`、`ml`、`g`、`kg`。调料等不适合逐次数量追踪的食材默认 `not_track_quantity`。

## 前置条件

- 更新前必须读取真实档案；已有库存时不得修改主单位，后端会再次校验。
- 默认保质期没有证据时使用 `none`；只有 `days` 模式填写 `default_expiry_days`。
- 当前消息图片只有在用户明确要求作为档案图或参考图时，才将 `currentAttachments` 中真实 `mediaId` 写入对应 operation 的 `payload.media_ids`。
- 更新时用户未明确换图、删图或替换媒体，就不传 `media_ids`；空数组可能表示清空媒体。

## 候选处理

- `ingredient.search` 只是候选召回；同名或近似结果会影响写入目标时不得自动猜测，调用 `human.request_input` 让用户选择更新已有食材或仍创建新食材。
- 需要补数量、单位换算、目标或同名候选时，请求中携带候选摘要、原因和 `resumeHint`。
- 从其他 Skill handoff 进入时，复用已确认的食材名称、单位、换算比例和候选信息；缺少关键字段才追问。
- 图片归属不明或用户未表达绑定意图时不传 `media_ids`，不得编造或跨家庭引用媒体 ID。

## Handoff

- 本 Skill 不声明向下游业务自动流转的 handoff；它作为 `recipe_draft`、`shopping_list`、`inventory_analysis` 的资料补齐目标。
- continuation 的恢复目标由来源 Skill 的 v3 handoff contract 决定。确认 Ingredient 后只注入并恢复来源 Skill，不自动生成来源业务草稿。
- 一次缺多个食材时，先说明整体缺口，再逐项创建一个可确认草稿；每次审批只推进一个 Ingredient。

## 审批规则

- 创建和更新只能调用 `ingredient_profile.create_draft`，遵循 `draft -> approval -> commit`。
- 保存副单位也必须先读取真实档案，再生成单独更新审批；不能把一次性库存换算假装成已保存配置。
- 更新 payload 不是局部补丁。媒体、单位换算、保质期和库存提醒使用真实字段与 ID，确认前不写正式 Ingredient。

## 用户反馈

- 多个缺失食材开始前，先说明准备新增哪些食材、用途、默认字段以及需要逐项确认。
- 生成草稿前说明当前处理的是哪一个食材；审批后再继续来源任务。
- 目标或换算不明确时说明差异并提供可选项，不用泛化追问重复索取已有信息。

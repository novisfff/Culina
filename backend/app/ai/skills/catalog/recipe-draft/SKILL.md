---
name: recipe-draft
description: 创建、补全、更新、删除或收藏菜谱正文和结构化配方草稿，包括食材、步骤、份数、耗时和难度；不执行做菜扣库存、不记录餐食、不安排餐食计划。
---

# 菜谱管理 Skill

## 自主决策空间

- 生成开放式新菜谱时，可以先根据用户口味、份数和已有食材自由设计结构；需要绑定真实食材 ID 或复用家庭食材资料时再调用 `ingredient.search`。
- 步骤、技巧、口味标签和可编辑备注可以合理补全；份数、耗时、难度、核心食材和更新/删除目标不明确时必须澄清。
- 创建或更新菜谱草稿前，可调用 `script.lint_recipe_draft` 检查标题、份数、耗时、食材和步骤是否完整。

## 执行规则

- 生成前按需调用 `ingredient.search` 获取当前家庭食材资料；没有匹配食材时可以保留名称，不要为了形式化流程做无效搜索。
- 更新、删除和收藏前先通过 `recipe.search` 或 `recipe.read_by_id` 确认真实目标。
- 多个相似菜谱、删除存在影响、或用户没有说明份数/目标时，调用 `human.request_input`，并给出候选摘要或影响摘要。
- `ingredient_items[].ingredient_id` 只能使用工具返回的真实 ID。
- 没有匹配食材时可以保留名称并将 `ingredient_id` 设为 `null`。
- 填写 `ingredient_id` 时，食材名称必须与该 ID 对应的名称一致。
- 新增可以生成结构化菜谱草稿。
- 更新、删除和收藏必须生成带 `action`、`targetId` 和 `baseUpdatedAt` 的操作草稿。
- `action=update` 的 payload 不是局部补丁；必须先读取真实菜谱详情，在现有菜谱基础上合成完整菜谱结构，再叠加用户要求的变化。payload 至少包含 `title`、`servings`、`prep_minutes`、`difficulty`、`ingredient_items` 和 `steps`。
- `action=set_favorite` 的 payload 只提供 `favorite=true/false`；`action=delete` 可以只提供删除原因，不要提交完整菜谱 payload。
- 删除审批必须展示删除影响，包括同步食物、计划项、烹饪记录和媒体处理。
- 仅通过 `recipe.create_draft` 生成 `recipe` 草稿，不直接写正式 `Recipe` 或收藏关系。
- 用户确认后由后端按操作类型写入，模型不参与最终写入判断。

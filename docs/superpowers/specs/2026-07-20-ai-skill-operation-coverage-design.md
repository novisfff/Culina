# AI Skill 操作覆盖修复设计

日期：2026-07-20

## 1. 背景与目标

本设计修复 Culina AI Skill catalog 中四个用户可感知的操作缺口：

1. `shopping_list` 声明支持按低库存生成购物清单，但没有获得 `inventory.read_low_stock_items`。
2. `ingredient_profile` 宣称管理数量追踪方式，但已有 Ingredient 无法通过 AI 使用专用切换流程。
3. `meal_log` 可以更新备注、心情和评分，但不能纠正餐食组成。
4. 购物项“已买到”和库存入库被拆成逐项、两次审批，不能复用已有原子 `shopping_intake` 事务。

目标是让用户可以通过自然语言完成上述操作，同时继续满足以下系统不变量：

- 模型只能调用已注入 Skill 白名单中的 read、draft 和 control Tool。
- 模型不能调用正式 write Tool。
- 所有正式写入必须经过 `draft -> approval -> service commit`。
- 所有实体、批量 ID、版本和媒体都按当前 `family_id` 校验。
- 高竞争写入在 service 中按既有稳定顺序锁定，锁后复核版本、状态和归属。
- stale、冲突、拒绝和失败不自动改写用户草稿或推进下一份审批。
- 本设计不新增数据库字段或 migration。

## 2. 非目标

本设计不包含：

- MealLog 删除或作废能力。
- 自动根据 MealLog 组成差异补回或追加历史库存扣减。
- 将小票中没有对应待买项的商品静默创建为购物项或库存。
- 将一次性包装换算保存为 Ingredient 长期副单位或 Food 长期包装规则。
- 库存操作撤销、盘点、到期日纠正和临期提醒维护。
- 将通用 `composite_operation` 开放给模型。
- 无明确范围时默认完成当前家庭全部待买项。

## 3. 总体架构

四项修复采用三个合同策略：

- 低库存修复只扩展 `shopping_list` 的 read Tool 权限与 Skill 指令，不新增草稿类型。
- Ingredient 追踪模式切换扩展现有 `ingredient_profile` 草稿，新增专用 action。
- MealLog 组成纠错扩展现有 `meal_log` 草稿，新增专用 action。
- 采购完成与库存入库新增独立 `shopping_intake` 草稿类型和专用 draft Tool，正式执行复用现有 `apply_shopping_intake()`。

不选择以下替代方案：

- 不把 `shopping_intake` 塞进普通 `shopping_list` action，因为它同时影响购物项、库存、InventoryOperation、撤销和幂等语义。
- 不使用 `composite_operation`，因为现有 `apply_shopping_intake()` 已经提供一个原子业务事务，拆分后再组合会重复事务和撤销规则。
- 不为 Ingredient 切换和 MealLog 组成单独新增顶层 draft type，因为它们仍是现有业务实体的单目标更新。

## 4. 低库存生成购物清单

### 4.1 Skill 权限

`shopping_list.allowed_tools` 增加：

```text
inventory.read_low_stock_items
```

completion policy 增加对应 follow-up 规则：读取低库存后，模型必须总结真实缺口、请求用户确认或生成 `shopping_list` 草稿。

### 4.2 Skill 行为

`shopping-list/SKILL.md` 明确：

- “低库存”“需要补货”“把库存不足的加入购物清单”必须调用 `inventory.read_low_stock_items`。
- `inventory.read_available_items` 只用于判断某个明确待购对象当前是否已有足够库存，不得用它替代完整低库存集合。
- 生成草稿前继续读取 pending 购物项并去重。
- 低库存工具返回的 `ingredientId` 是采购目标；`inventoryItemId` 不能当作购物绑定 ID。

### 4.3 Eval 场景

增加两个确定性 eval：

1. 食材仍有少量剩余但已低于阈值。
2. 食材没有任何可用批次，但 Ingredient 配置了默认低库存阈值。

两个场景都要求工具序列包含：

```text
inventory.read_low_stock_items
→ shopping.read_pending
→ shopping.create_draft
```

最终草稿必须绑定当前家庭真实 `ingredientId`，并跳过已有等价 pending 项。

## 5. Ingredient 数量追踪模式切换

### 5.1 草稿合同

继续使用：

```text
draftType=ingredient_profile
schemaVersion=ingredient_profile_operation.v1
```

新增 action：

```text
transition_tracking_mode
```

模型可见输入示例：

```json
{
  "draftType": "ingredient_profile",
  "schemaVersion": "ingredient_profile_operation.v1",
  "action": "transition_tracking_mode",
  "targetId": "ingredient_xxx",
  "baseUpdatedAt": "2026-07-20T08:00:00Z",
  "payload": {
    "target_mode": "not_track_quantity",
    "presence_resolution": {
      "availability_level": "sufficient",
      "inventory_status": "fresh",
      "storage_location": "冷藏",
      "mark_inventory_confirmed": false
    }
  }
}
```

模型不填写 Ingredient/state/batch row version。Draft normalizer 重新读取当前家庭实体并固化：

- `expected_ingredient_row_version`
- `expected_state_row_version`
- `observed_batches`
- 更新前 tracking mode 和库存摘要

### 5.2 Ingredient 详情输出

`ingredient.read_by_id` 的详情输出新增 `trackingTransitionContext`，搜索摘要不增加该字段。

该上下文包含：

- 当前 `rowVersion`
- 当前 `quantityTrackingMode`
- 当前 presence state 的 ID、row version 和实际字段
- 当前所有有剩余量的物理批次 ID、row version、数量、单位、日期和位置
- Ingredient 默认单位、默认存放位置和支持单位
- 当前允许的目标模式

详情查询继续按当前 `family_id` 过滤，不允许通过全局 ID 读取其他家庭的状态或批次。

### 5.3 两种转换方向

精确数量转只记有无时，审批必须提供 `presence_resolution`：

- `availability_level`
- `inventory_status`
- `purchase_date`
- `expiry_date`
- `storage_location`
- `notes`
- `mark_inventory_confirmed`

当 availability 为 absent 时，日期和存放位置必须为空；非 absent 时必须提供存放位置。

只记有无转精确数量时，审批必须提供 `exact_resolution`：

- `confirm_absent=true`；或
- 大于 0 的初始数量、单位、状态、采购日、可选到期日、存放位置和备注。

### 5.4 正式执行

`execute_ingredient_profile_draft()` 对 `transition_tracking_mode` 分支构造 `IngredientTrackingModeTransitionRequest`，然后只调用现有：

```python
transition_ingredient_tracking_mode(...)
```

AI 层不复制转换、锁定或库存处置规则。现有 service 继续负责：

- Ingredient/state/batch 稳定锁顺序
- tracking mode 复核
- row version 和批次集合边界
- presence/exact resolution 校验
- 状态迁移和库存历史保留
- Ingredient collection version
- 活动日志

AI executor 在 service 成功后补齐搜索索引刷新和标准 Ingredient 序列化。

### 5.5 审批编辑边界

审批表单允许编辑 resolution 业务字段，但以下字段不可修改：

- `targetId`
- `target_mode`
- Ingredient/state/batch ID 和 row version
- `observed_batches`

如果用户要改变目标方向，必须拒绝或取消当前审批，重新读取并生成新草稿。

## 6. MealLog 餐食组成纠错

### 6.1 草稿合同

继续使用：

```text
draftType=meal_log
schemaVersion=meal_log_operation.v1
```

新增 action：

```text
update_composition
```

归一化草稿示例：

```json
{
  "draftType": "meal_log",
  "schemaVersion": "meal_log_operation.v1",
  "action": "update_composition",
  "targetId": "meal_log_xxx",
  "baseUpdatedAt": "2026-07-20T08:00:00Z",
  "expectedRowVersion": 3,
  "before": {},
  "payload": {
    "foods": [
      {
        "entryId": "meal_log_food_xxx",
        "foodId": "food_xxx",
        "name": "面包",
        "servings": 0.5,
        "note": ""
      }
    ],
    "inventoryAdjustment": "none"
  }
}
```

规则：

- 现有条目必须使用真实 `entryId`，且不能更换该 entry 的 Food。
- 新增 Food 没有 `entryId`，但 `foodId` 必须来自当前家庭 `food.search/read_by_id`。
- `name` 由后端按真实 Food 重写。
- 至少保留一个 Food，同一 MealLog 不能重复 Food。
- `servings` 必须大于 0。
- `expectedRowVersion`、`before` 和 `inventoryAdjustment` 由后端生成。
- `inventoryAdjustment` 固定为 `none`，模型和审批提交都不能改成其他值。

### 6.2 库存与计划语义

组成纠错只修改 MealLog 结构，不执行以下操作：

- 不补回删除 Food 对应的历史成品库存扣减。
- 不为新增 Food 追加库存扣减。
- 不重新计算历史 `recipe_cook` 或 MealLog 库存事实。
- 不改变关联 FoodPlanItem 的完成状态。

审批必须固定展示：

> 此次只纠正餐食记录内容，不会补回、追加或重新计算历史库存扣减，也不会改变关联餐食计划的完成事实。

### 6.3 正式执行

Executor 将归一化 foods 转换为现有 `UpdateMealCompositionRequest`，然后只调用：

```python
update_meal_composition(...)
```

现有 service 继续负责 Food → MealLog 锁顺序、row version、家庭 Food 校验、entry ID 校验、完整组成 diff、原 entry 评分和 created_at 保留、MealLog 版本递增和活动日志。

### 6.4 审批编辑边界

审批允许：

- 修改已解析 Food 的 servings 和 note。
- 删除某个 Food，但最终至少保留一项。
- 保留或移除模型已经解析的新 Food。

审批不提供任意 Food 搜索。需要加入尚未解析的 Food 时，用户回到对话，由模型重新执行 `food.search/read_by_id` 并生成新草稿。

## 7. 原子购物完成与入库

### 7.1 新草稿类型

新增稳定草稿类型：

```text
shopping_intake
```

`shopping_list` Skill 同时声明：

- `shopping_list`：创建、修改、删除和恢复待买。
- `shopping_intake`：单项或批量采购完成、部分采购、仅完成和库存入库。

新增 draft Tool：

```text
shopping.create_intake_draft
```

新增只读候选 Tool：

```text
shopping.preview_intake_candidates
```

### 7.2 所有新“已买到”请求统一入口

以下请求都生成 `shopping_intake`：

- 单个购物项完成并入库。
- 多个购物项完成并入库。
- 仅完成购物项、不登记库存。
- 部分采购。
- 小票批量匹配与入库。

`shopping.create_draft` 继续处理：

- create
- update
- delete
- `set_done(done=false)` 恢复待买

模型通过 `shopping.create_draft` 新生成 `set_done(done=true)` 时，Tool handler 必须拒绝并提示改用 `shopping.create_intake_draft`。

底层 shopping normalizer/executor 继续支持旧 `done=true`，以便部署前已经持久化的待审批草稿和 continuation 可以完成。新 Skill 指令、Tool 和 eval 不再产生旧两阶段路径。

### 7.3 作用域规则

`shopping_intake` 只能处理明确范围内的当前家庭 pending 项：

- 有小票：小票匹配到的待买项。
- 有当前卡片选择或 artifact：已选择的真实购物项。
- 消息明确列名：逐项查询并唯一定位的购物项。
- 只有“这些都买到了”且没有真实范围：调用 `shopping.read_pending` 后，通过 `human.request_input` 多选目标。

不得默认选择当前家庭全部 pending 项。

### 7.4 小票与候选匹配

视觉模型从当前消息附件读取商品文字、数量、单位和规格；图片本身不绑定到购物项或库存实体。

`shopping.preview_intake_candidates` 接收结构化识别行，按当前家庭查询 pending ShoppingListItem 和真实 Ingredient/Food，输出四组：

- `confirmedMatches`
- `suggestedMatches`
- `ambiguousMatches`
- `unmatchedCandidates`

匹配分级：

1. confirmed：购物项真实目标一致，或名称、别名和规格证据唯一且强。
2. suggested：标题不完全一致但只有一个语义合理候选；自动预选，审批展示依据，整份批准即接受。
3. ambiguous：多个合理候选、Ingredient/Food 类型冲突或单位规格无法解释；必须选择后才能提交。
4. unmatched：没有现有待买项；不进入当前事务。

每个匹配结果返回真实购物项/目标 ID、计划数量单位、当前版本、匹配等级和 `matchReason`。模型不能只根据文字自行编造匹配 ID。

### 7.5 额外购买候选

小票中没有现有待买项的行进入只读 `unmatchedCandidates`，审批展示但 executor 永远忽略。

建议动作：

- 可匹配现有 Ingredient/Food：建议后续单独登记库存。
- 缺少 Ingredient：建议进入 `ingredient_profile`。
- 缺少 ready-like Food：建议进入 `food_profile`。
- 多候选：建议先选择真实目标。

候选建议不自动创建档案、不自动入库，也不在当前审批中添加隐藏 operation。

### 7.6 草稿结构

归一化草稿包含：

```json
{
  "draftType": "shopping_intake",
  "schemaVersion": "shopping_intake.v1",
  "clientRequestId": "server-generated",
  "purchaseDate": "2026-07-20",
  "items": [],
  "unmatchedCandidates": []
}
```

每个正式 item 包含：

- shopping item ID、标题和 expected row version
- match level 和 match reason
- action：`stock_and_fulfill` 或 `complete_without_inventory`
- target kind：`exact_ingredient`、`presence_ingredient`、`food` 或 `none`
- target ID 和对应 expected row version
- presence state ID/version（适用时）
- planned quantity/unit
- entered quantity/unit
- 一次性 conversion 证据（适用时）
- canonical actual quantity/unit
- inventory status、expiry date、storage location 和 notes（适用时）

模型不填写 `clientRequestId`、任何 expected version、state ID 或最终 canonical 数量。Draft normalizer 重新读取并固化这些字段。

### 7.7 缺失实际数量

小票或用户没有可靠提供实际数量时：

- 匹配行保留在草稿中。
- `enteredQuantity` 和 `actualQuantity` 保持为空。
- Draft 结构仍可持久化为 pending approval。
- 审批表单自动展开该行并阻止批准，直到用户填写有效数量。
- 不使用 planned quantity 作为 AI 小票模式的默认实际数量。

Draft Tool 负责身份和结构验证；approval submitted-value validator 负责最终业务字段完整性。字段仍不完整时，审批保持 pending 并返回按购物项定位的字段错误。

### 7.8 一次性包装换算

小票或用户明确给出包装关系时，草稿可以保存一次性 conversion：

- entered quantity
- entered unit
- ratio
- target stock unit
- evidence

审批展示完整公式，例如：

```text
1 箱 × 12 盒/箱 = 入库 12 盒
```

用户可以修改倍率。没有小票证据或用户明确输入时倍率保持为空并阻止提交。

一次性 conversion 不写回 Ingredient `unit_conversions` 或 Food 资料。提交前由 normalizer 计算 canonical actual quantity；`ShoppingIntakeRequest` 只接收 service 可执行的最终数量和单位。

### 7.9 每行动作

每个匹配行可以选择：

- `stock_and_fulfill`：完成或部分完成购物项，并登记实际库存。
- `complete_without_inventory`：只完成购物项，不登记库存。

绑定真实 Ingredient/ready-like Food 的行默认 `stock_and_fulfill`，但用户可在审批中改为 `complete_without_inventory`。

### 7.10 数量结果

对精确 Ingredient 和 Food：

- actual < planned：实际数量全部入库，购物项 quantity 更新为剩余计划量，`done=false`。
- actual = planned：实际数量入库，购物项 `done=true`。
- actual > planned：实际数量全部入库，购物项 `done=true`，审批和结果提示超额数量。

Presence Ingredient 采购后更新为非 absent 状态并完成购物项。

### 7.11 原子提交、幂等和撤销

Approval executor 将最终草稿转换为现有 `ShoppingIntakeRequest`，然后只调用：

```python
apply_shopping_intake(...)
```

AI 层不复制部分采购、Food intake、presence state、锁定、operation history 或撤销规则。

任一行出现验证、stale、目标失效或单位冲突时，整份事务回滚，不允许 partial success。错误按 `shopping_item_id` 和字段定位，刷新后重建版本边界并要求重新确认。

`clientRequestId` 由后端生成并固化：

- 同一次审批相同 submitted payload 重试为幂等重放。
- 同 ID 不同 payload 返回结构化 `idempotency_key_reused` 冲突。
- stale 刷新后生成新草稿和新 request ID。

成功结果继续返回 InventoryOperation ID、摘要、可撤销截止时间和逐项结果。

## 8. 前端审批设计

### 8.1 共享现有购物入库能力

现有前端已经包含：

- `frontend/src/features/inventory/shoppingIntakeModel.ts`
- `frontend/src/features/inventory/ShoppingIntakeDialog.tsx`

实现时提取共享的纯展示/编辑组件 `ShoppingIntakeReviewForm`，由以下入口复用：

- 普通库存工作区 `ShoppingIntakeDialog`
- AI 工作台 `AiShoppingIntakeApproval`

共享内容：

- 项目摘要
- 异常行识别和展开
- actual quantity/unit
- 一次性包装换算
- presence availability
- storage/expiry/notes
- 部分/完整/超额数量摘要
- 行级字段错误和焦点恢复

入口分别保留自身的选择步骤、批准/拒绝、结果页和撤销行为。

### 8.2 初始化策略

现有人工 ShoppingIntakeDialog 可以继续使用计划数量作为人工登记默认值。共享 model 增加显式策略：

```text
planned_default
evidence_only
```

AI 小票和自然语言 intake 使用 `evidence_only`；只有小票或用户明确提供数量时才预填 actual quantity。

### 8.3 渐进披露

已确认的 V2 布局规则：

- 单列、移动优先。
- 顶部只展示采购日期和可提交/需补充数量。
- 正常项目折叠为一行结果摘要。
- 建议匹配、数量缺失、一次性换算、ambiguous 和字段错误行自动展开。
- storage、expiry、status 和 notes 默认收在高级信息中，只有缺失或错误时自动展开。
- unmatched candidates 独立放在正式提交区域之后，并明确“不随本次提交”。
- 底部统一汇总完成、入库、部分采购和保留待买数量。

### 8.4 MealLog 与 Ingredient 审批

MealLog update composition 显示完整前后组成差异和固定库存提示。

Ingredient transition 显示两个方向的专用 resolution 表单，不复用普通档案字段更新表单，也不允许编辑版本边界。

## 9. Approval 与恢复合同

新增或修改的 approval type：

- `ingredient.transition_tracking_mode`
- `meal_log.update_composition`
- `shopping_intake.apply`

审批 submitted value 继续经过服务端重新归一化与不可变字段校验。用户可编辑字段之外的 target、action、版本和边界发生变化时拒绝提交。

stale 或冲突返回：

- `currentValue`
- `recoveryHint`
- 机器可读 code
- 行级 `field_errors` 或 `conflicts`

系统不在失败后静默重建、自动批准或继续下一份草稿。

## 10. 稳定接口与文档同步

新增 `shopping_intake` draft type 时同步更新：

- `docs/ai-assistant-standards.md`
- 后端 draft registry/spec/capability
- `frontend/src/api/types.ts` 的 `AiTaskDraftType`
- AI workspace viewer contract
- approval panel dispatch
- cache invalidation
- operation result 和 artifact 测试

Ingredient 和 MealLog 只增加 action，不增加顶层 draft type。

## 11. 测试策略

### 11.1 低库存购物

- Skill manifest 包含 `inventory.read_low_stock_items`。
- completion policy 包含对应 follow-up。
- 少量剩余低库存。
- 零库存但配置默认阈值。
- 低库存转购物 eval 工具顺序和真实 ID。

### 11.2 Ingredient transition

- exact → presence 正常提交。
- presence → exact 有库存。
- presence → exact 确认 absent。
- Ingredient/state/batch stale version。
- 当前批次集合变化。
- tracking mode 已变化。
- 跨家庭目标拒绝。
- 审批不可篡改 target/mode/version/batch refs。
- 活动日志和搜索索引。
- 前端两个方向的字段和校验。

### 11.3 MealLog composition

- 新增 Food。
- 删除 Food。
- 修改 servings 和 note。
- 保留原 entry rating 和 created_at。
- 空组成、重复 Food、错误 entry ID、entry/Food 不匹配。
- 跨家庭或已删除 Food。
- stale row version。
- 修改后 Food stock、库存 operation 和计划事实不变。
- 活动日志、结果 artifact 和前端固定提示。

### 11.4 Shopping intake

- 单项 Ingredient 完成并入库。
- 批量 exact Ingredient、presence Ingredient 和 Food。
- `complete_without_inventory`。
- 部分采购。
- 超额采购。
- 一次性包装换算。
- 缺失 actual quantity 时审批阻止提交。
- confirmed、suggested、ambiguous 和 unmatched 匹配。
- unmatched 不产生业务写入。
- 裸“这些”必须先多选范围。
- 任一行 stale 时整批回滚。
- 同 request ID 同 payload 幂等重放。
- 同 request ID 不同 payload 冲突。
- 旧 `done=true` 审批继续可执行。
- 新 Tool 拒绝生成 `done=true`。
- 跨家庭 ShoppingItem/Ingredient/Food/state 拒绝。
- operation result 和撤销。
- 单项审批不展示无关批量噪音。
- AI `evidence_only` 不回填 planned quantity。
- 前端渐进披露、异常展开、字段定位和摘要。
- scripted eval 覆盖单项采购入库与小票批量采购。

### 11.5 验证命令

实现完成后至少执行：

```bash
npm run backend:test:ai
npm run backend:test:ai-evals
npm run backend:check:ai-evals
npm --prefix frontend test -- src/components/ai/AiApprovalPanel.test.tsx
npm --prefix frontend test -- src/lib/aiWorkspaceContracts.test.ts
npm --prefix frontend test -- src/features/inventory/shoppingIntakeModel.test.ts
npm --prefix frontend test -- src/features/inventory/ShoppingIntakeDialog.test.tsx
npm run frontend:quality
npm run frontend:build
npm run backend:quality
```

库存并发和幂等代码有实质变更时，还需运行相关 MySQL concurrency tests；如果只复用既有 `apply_shopping_intake()` 而不修改其事务逻辑，仍需运行其现有定向 service/API tests。

## 12. 验收标准

满足以下条件才算完成：

1. 用户能把完整低库存集合生成去重购物草稿，包括库存为 0 的 Ingredient。
2. 用户能通过一次 Ingredient 审批安全切换 tracking mode，并明确处置 presence/exact 状态。
3. 用户能通过一次 MealLog 审批纠正餐食组成，且历史库存和计划事实保持不变。
4. 单项和批量“已买到”都通过一份 `shopping_intake` 审批原子更新购物清单与库存。
5. 部分和超额采购按实际数量正确处理。
6. 小票缺少可靠数量或换算时不会猜测，审批明确阻止提交并定位字段。
7. 建议匹配可预选并显示依据，真正歧义必须选择，未匹配行不写业务数据。
8. 任一批量行失败时所有购物和库存变化回滚。
9. 新 run 不再生成 `set_done(done=true)` 两阶段入库流程，历史审批仍可完成。
10. 所有新增 Skill、Tool、draft、approval、前端和 eval 合同通过定向与全量验证。

# “记一餐”弹窗重设计规格

日期：2026-07-16

状态：视觉与核心行为已确认，待规格复核

## 目标

把现有横向过宽、左侧拥挤且存在大面积空白的“记一餐”弹窗，改成专注完成任务的两步式快速记录流程：先确认日期和餐次，再确认或补充食物。所选时段已经计划的食物自动加入；成功提交后，仍被选中的计划食物与餐食记录在同一事务内完成。

本次保留现有搜索、新建食物、份量、候选餐合并、busy 关闭保护、错误保留、焦点管理与提交幂等能力，不改变“正式记录前由用户确认”的边界。

## 已确认的产品规则

### 默认日期与餐次

日期和餐次按 `Asia/Shanghai` 计算。每次创建新草稿时使用当时的北京时间，不复用组件首次挂载时的旧时间。

- 04:00–10:59：早餐。
- 11:00–14:59：午餐。
- 15:00–16:59：加餐。
- 17:00–21:59：晚餐。
- 22:00–次日 03:59：加餐。

日期默认当天。历史入口显式提供日期或餐次时，入口参数优先于时间推导。

### 计划食物预填

弹窗根据当前选择的日期与餐次，读取当前用户有权完成且状态为 `planned` 的 `FoodPlanItem`。对应食物自动加入已选列表，并显示“本餐计划”标签。

- 同一食物对应多个有效计划项时，食物只显示和记录一次，标签显示计划数量；提交时完成所有仍与该食物关联的有效计划项。
- 自动加入的食物默认份量为 1 份，用户可继续调整。
- 用户通过右侧 × 移除食物后，该食物对应的计划项不随本次提交完成，仍保持 `planned`。
- 用户移除后又从搜索结果重新加入同一食物，重新恢复该时段与食物匹配的计划关联；提交时完成对应计划。
- 用户切换日期或餐次时，只替换由旧时段计划自动带入的食物；用户手动添加的普通食物继续保留。若新时段计划与手动食物重复，合并为一个已选食物并恢复计划关联。
- 计划加载期间显示明确状态并暂时禁止提交；加载失败时保留用户已选食物，显示重试入口，不把“没有加载到计划”当作“没有计划”。

### 计划完成语义

点击“记下这餐”后，餐食记录与仍被选中的计划项必须原子完成：要么全部成功，要么全部回滚。

- 每个计划引用包含 `food_plan_item_id` 与用户打开或刷新弹窗时看到的 `base_updated_at`。
- 后端在写入前重新校验家庭与用户边界、`planned` 状态、日期、餐次、食物关联和 base version。
- 计划项对应食物必须仍存在于本次餐食 entries 中。
- 成功后计划项写入 `status=cooked`、`completed_at`、`meal_log_id` 和审计字段。
- 任一计划被修改、删除、完成或不再匹配当前时段时，整次提交返回可恢复的冲突；弹窗保留草稿，刷新计划后要求用户重新确认。

## 交互与视觉结构

### 弹层

- 桌面使用 medium modal，宽度固定为 `min(680px, 100vw - 96px)`，不再因为候选餐存在与否切换到 960px。
- 平板使用 `min(520px, 100vw - 64px)` 的快速操作弹窗。
- 手机使用 bottom sheet，宽度 100%，最大高度遵循现有 overlay 规范，顶部圆角 24px，并处理底部安全区。
- header、唯一滚动 body、固定 footer 三层保留；busy 时禁止关闭、Escape、backdrop 与下拉拖拽关闭。
- 标题为“记一餐”，说明改为“确认时间，补上这餐吃了什么”。

### 第一步：确认时间

- 区块头显示序号“1”、标题“确认时间”和当前摘要，例如“今天 · 晚餐”。
- 日期使用 7 项紧凑日期带，范围仍为过去 6 天至今天，不开放未来日期。
- 桌面 7 项同排；手机保持 56px 日期项并允许明确的横向滚动，不压缩触控目标。
- 餐次使用 4 项分段选择。选中项使用 `--accent-soft / --accent-strong / --accent-line`，不用实心主按钮样式。
- 日期和餐次按钮使用真实 button 与正确的 listbox/radiogroup 状态；选中信息不能只依赖颜色。

### 第二步：添加食物

- 区块头显示序号“2”、标题“添加食物”和“已选 N 项”。
- 搜索框复用当前 `SearchField` 和 `MealFoodCombobox`，保留搜索现有食物、按名称新建、类型选择、键盘导航与搜索状态。
- 已选食物使用单层列表行：44px 方形图片、名称、来源标签、份量控件和右侧移除按钮。
- 自动计划食物使用 `--info-soft / --info / --info-line` 的“本餐计划”标签；手动选择不显示计划标签。
- × 图标视觉为 20px，按钮命中区固定 44×44px，`aria-label` 为“移除{食物名}”。busy 时禁用。
- 空状态写“还没有添加食物”，并说明可搜索或直接输入菜名；提交保持禁用。
- 列表下方显示克制说明：“列表中的计划食物会同时标记为已完成。”

### 候选餐与提交

现有候选餐合并能力保留，并在第二步已选食物下方按需展开；没有候选餐时不渲染占位栏。候选餐仍由服务端权威结果决定，加载、错误、stale version 和重新确认行为不变。

footer 保留唯一 primary“记下这餐”和 secondary“取消”。手机端按钮高度 48px，主按钮获得更大的布局份额；提交中显示“正在记下…”，保持宽度并禁止重复提交。

## 前端状态与数据流

### 数据来源

`EatFreeMealComposerBody` 把当前工作区已经获取的 `foodPlanItems` 或按当前日期/餐次精确查询的计划结果传入 meal composer 数据层。计划查询必须包含当前家庭、当前用户、日期与餐次隔离维度；query key 使用 `queryKeys.ts`，成功失效集中在 `cacheInvalidation.ts`。

### 草稿来源标记

`MealComposerFood` 的业务草稿需要表达食物来源，但不把完整计划对象塞进 View：

- 普通手动食物没有计划引用。
- 计划食物携带一个或多个最小引用 `{ id, baseUpdatedAt }`。
- UI 根据引用数量派生“本餐计划”标签；payload model 从最终 foods 派生去重后的计划完成引用。

日期或餐次变化触发计划刷新和自动食物重算。使用请求 key 或 React Query 取消机制防止旧时段响应覆盖新选择。

### 提交契约

在 `RecordMealPayload` 增加可选字段：

```ts
plan_item_completions?: Array<{
  food_plan_item_id: string;
  food_plan_item_base_updated_at: string;
}>;
```

没有计划食物时省略或发送空数组，保持旧调用方兼容。后端 schema 使用 `extra="forbid"` 并限制计划引用唯一；请求规范化哈希包含该字段，因此同一 `client_request_id` 不能携带不同计划集合重放。

响应增加 `completed_plan_item_ids: string[]`，用于精确提示、缓存失效和测试，不要求前端依赖本地乐观状态表达成功。

## 后端事务、锁与撤销

### 原子记录

扩展 `record_meal` 服务，不由 route 或前端串联多个提交。服务在同一 route-owned transaction 内：

1. 领取或重放 record operation。
2. 发现并排序本次涉及的 Food、目标 MealLog 和 FoodPlanItem。
3. 按项目既有锁顺序锁定 Food，再锁定可选目标 MealLog，最后按 ID 锁定计划项。
4. 重新校验餐食 entries、目标餐食版本、计划归属、计划 base version、状态、时段和食物引用。
5. 创建或追加 MealLog entries。
6. 将匹配计划项标记为 cooked，并写入同一个 MealLog。
7. 保存 operation 结果与活动日志，由 route 统一 commit。

锁实现复用现有 inventory、meal log 与 food plan locking helper；如现有 helper 只能完成单计划项，应提取共享的校验与状态更新函数，不在 service 中复制权限和冲突码。

### 幂等与重放

`client_request_id` 的 canonical hash 包含计划引用。相同请求重放直接返回第一次保存的 `RecordMealResponse`，不再次更新计划或追加 entries。相同 id 携带不同计划集合继续返回现有的幂等键冲突。

### 撤销

record operation 记录本次从 `planned` 转为 `cooked` 的计划项 ID 和完成前必要快照。撤销时与餐食 entries 使用同一事务：

- 只有计划项仍为 cooked、仍指向本 operation 的 MealLog，且未发生后续不兼容修改时，才能恢复为 planned。
- 恢复时清空本次写入的 `completed_at` 和 `meal_log_id`，维护 `updated_by` 与活动日志。
- 任一计划项已被后续修改时，撤销返回冲突并整体不写，不能只撤销餐食 entries。
- 重放撤销保持现有幂等语义。

## 错误与恢复

- 计划查询失败：在第二步显示错误和“重新加载”，保留当前草稿，禁止提交。
- 计划 stale/not found/already completed：提示“这餐计划刚被家人更新，请刷新后重新确认”，保留手动食物与份量。
- 餐食候选 stale：沿用现有候选餐重新确认流程。
- 食物不存在或跨家庭：沿用现有安全错误，不泄露其他家庭对象。
- 提交失败：不清空日期、餐次、搜索词、已选食物或请求 identity；用户可修复后重试。
- 成功：关闭任务、刷新 meal logs、food plans、home summary 和相关 food views；提示实际记录与完成的计划数量。

## 代码范围

预计触及：

- `frontend/src/features/meals/MealComposer.tsx`
- `frontend/src/features/meals/MealComposerModel.ts`
- `frontend/src/features/meals/useMealComposerState.ts`
- `frontend/src/features/meals/useMealComposerData.ts`
- `frontend/src/features/meals/useMealComposerActions.ts`
- `frontend/src/features/eat/EatTaskBodies.tsx`
- `frontend/src/api/types.ts`、`mealLogsApi.ts`、`queryKeys.ts`、`cacheInvalidation.ts`
- `frontend/src/styles/13-meal-composer.css`
- 对应前端测试
- `backend/app/schemas/meal_recording.py`
- `backend/app/services/meal_recording.py`
- record operation model 与迁移（如当前 JSON 字段无法安全保存计划恢复信息）
- `backend/app/services/meal_record_reversion.py` 或当前撤销实现
- 对应 route/serializer 与后端测试

不修改通用 overlay 视觉规范，不重做快速记录以外的食物计划页面，不改变正式 FoodPlanItem 完成接口的现有调用方。

## 测试与验收

### 纯逻辑与组件测试

- 北京时间边界：03:59、04:00、10:59、11:00、14:59、15:00、16:59、17:00、21:59、22:00。
- 新草稿打开时重新计算当前日期与餐次；显式入口参数优先。
- 计划食物预填、多个计划同食物去重、移除、重新添加、切换时段、乱序响应和加载失败。
- × 按钮名称、44px 交互结构、键盘操作、disabled/busy 与食物计数。
- payload 只包含最终已选食物关联的计划引用。

### 后端测试

- 新建餐食并完成一个或多个计划项。
- 追加到已有餐食并完成计划项。
- 无计划引用的旧请求行为不变。
- 跨家庭、跨用户、日期/餐次不匹配、计划食物未在 entries、重复计划 ID、stale base version、非 planned 状态全部拒绝。
- 多计划中任一冲突时餐食和所有计划全部回滚。
- 幂等重放不重复追加或完成。
- 撤销恢复餐食与计划；后续修改导致撤销整体冲突。
- MySQL 锁顺序与并发完成覆盖。

### 命令与视口

- 定向 Vitest 与 pytest。
- `npm run frontend:quality`
- `npm run frontend:build`
- `npm --prefix frontend run check:style-tokens`，人工审阅新增命中。
- `npm run frontend:smoke`
- 按后端风险运行定向 meal log/food plan 测试，再运行 `npm run backend:quality`。
- 如新增 migration，检查 `alembic heads` 并在可用本地库执行 `npm run backend:migrate`。
- 视觉检查：375×812、390×844、430×932、768×1024、1024×768、1440×900。

验收时同时覆盖无计划、单计划、多计划、重复食物计划、已有候选餐、计划加载失败、计划 stale、提交中、提交失败和长食物名称。

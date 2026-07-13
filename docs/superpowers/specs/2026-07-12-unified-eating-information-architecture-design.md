# Culina P0.4 统一“吃什么”信息架构与烹饪自动记录设计规格

> 日期：2026-07-12
>
> 状态：设计已完成交互确认与两轮独立审计修订，待用户复核
>
> 产品语境：移动优先的中国家庭厨房工具
>
> 对应产品问题：`docs/plans/2026-07-11-family-kitchen-product-assessment.md` P0 第四点——“食物、菜谱、记录、计划”的概念边界对新成员仍然复杂
>
> 实施前置：PR 72、PR 73 修复并合并后的最新 `main`

## 1. 结论

本期不合并 Food、Recipe、FoodPlanItem 和 MealLog 的底层模型，而是统一家庭成员看到的信息架构和动作语言。

目标一级导航统一为：

1. 首页；
2. 吃什么；
3. 食材；
4. AI；
5. 家庭。

“吃什么”内部包含：

- 发现：今天或以后可以吃什么；
- 菜单：已经明确安排的未来餐食；
- 吃过的：已经发生的餐食记录。

Recipe 不再承担一级入口，而是 selfMade Food 的“做法”能力。MealLog 不再承担一级“记录中心”，而是“吃过的”历史。桌面和手机共享同一业务信息架构，只保留布局差异。

本期同时确立四个业务不变量：

1. 只有用户明确执行“加入菜单”时才创建 FoodPlanItem，直接“开始做”不再隐式制造计划项。
2. 每次成功完成烹饪都由后端在同一事务中创建最小 MealLog；前端、REST API 和 AI recipe cook 都不能绕过。
3. 同一个稳定的 completion request 最多产生一次库存扣减和一组 MealLog、RecipeCookLog、FoodPlanItem 更新；安全重放返回第一次结果。
4. Recipe/Food 已被计划、餐食或 CookLog 引用时不得物理删除并级联破坏历史。

“完成烹饪后自动进入记录”的产品含义是：

- 服务端自动把这次烹饪写入 MealLog；
- 成功态提供“查看这餐”或“补充这餐”；
- 不强制用户做完饭后立即进入复杂编辑器；
- 缺少照片、评分或备注不代表这条记录未完成。

## 2. 已确认的核心产品决策

以下决策已在设计讨论中逐项确认：

1. 采用完整收敛目标，按阶段实施，不只修改导航文案。
2. 桌面和手机使用相同的五个一级入口及相同顺序。
3. 内部一级导航 key 从 `foods / recipes / logs` 收敛为 `eat`。
4. “吃什么”内部使用“发现 / 菜单 / 吃过的”三个稳定子视图。
5. Food detail、Recipe detail/editor、Cook Mode、Meal detail/create 都是“吃什么”内部任务，不是一级入口。
6. 本期不引入 React Router，不建立任意深度的 URL 路由栈。
7. 新增集中、可测试的导航 model 和轻量 EatWorkspace 组合层，不把三个旧大工作区直接拼成一个更大的组件。
8. 导航状态只保存实体 ID，不保存 Food、Recipe、FoodPlanItem 或 MealLog 快照。
9. 旧 `culina-active-tab` 必须迁移到版本化 `culina-navigation-v2`，未知或损坏值安全回到首页。
10. Recipe 搜索结果在桌面和手机都通过关联 selfMade Food 打开做法，不再按视口分叉。
11. 第一版不为了 Recipe 导航扩大全部 Recipe API；EatWorkspace 在 Foods 和 Recipes 查询就绪后解析关联。
12. Recipe 关联 Food 异常时显示可恢复错误，不白屏、不任选关系，也不在 GET 时隐式修复数据库。
13. Food、Recipe、FoodPlanItem、MealLog 继续保持独立底层职责。
14. Recipe 与 selfMade Food 的现有同步机制继续作为正常数据不变量。
15. 所有菜单写入从 Food 发起；旧 Recipe plan 兼容 API 暂不随首发删除。
16. 直接开始做不创建 FoodPlanItem；只有从已有计划项进入时才携带 `food_plan_item_id`。
17. 成功完成烹饪必须创建 MealLog、MealLogFood 和 RecipeCookLog；有计划来源时同时更新该计划项。
18. 库存扣减、MealLog、CookLog、计划项和活动日志必须处于同一事务。
19. `create_meal_log` 在首个兼容版本保留但废弃，服务端不再根据 `false` 跳过 MealLog。
20. 普通 API 的旧 `create_meal_log=false` 不再能绕过完成语义。
21. 已经待审批且明确为 `createMealLog=false` 的 AI v1 草稿不能静默改变写入含义，必须要求重新确认。
22. AI recipe cook 升级到新草稿语义：预览只预览，完成必定记录一餐。
23. Cook Finish UI 不再询问“是否同步餐食记录”，只允许核对日期、餐次、份量和可选反馈。
24. 自动生成但没有照片、评分或备注的 MealLog 是有效记录，不进入任务化“待补充”欠账。
25. 新 Cook Session 持有稳定 `completionRequestId`；REST 与 AI 最终进入同一幂等 completion service。
26. 本期允许一份 additive migration，只为 RecipeCookLog 增加 nullable 幂等字段和家庭级唯一约束；不回填历史无 MealLog 的 CookLog。
27. 新增按 ID、家庭和当前用户约束的 FoodPlanItem detail API，计划详情导航不再依赖目标恰好位于已加载周。
28. Recipe/Food 已被 MealLogFood、FoodPlanItem 或 RecipeCookLog 引用时，首发禁止物理删除；删除与所有引用创建、替换及 FoodPlanItem `food_id` 改绑路径必须共用父实体行锁协议，不能只做一次无锁预查；archive 另行设计。
29. 普通 MealLog、quick-add、Cook completion 与 AI 写入共用 Food 和 participant 家庭边界校验；participant 同时要求 active Membership 和 active User。
30. `recipe_cook_operation.v2` 删除 `createMealLog`，不保留“强制 true”这一第二实现分支。
31. 首个兼容前端删除记录开关，但仍固定发送 `create_meal_log=true`；停止发送字段只能进入兼容清理阶段。
32. 本期不实现 URL 深链接、历史记录回填、同餐次自动合并或跨设备 Cook Session 同步。
33. P0 第三点继续负责首页内容聚焦；本期只负责首页动作的统一导航目标和“开始做”语义。
34. P0 第四点以 PR 72、PR 73 全部合并且基线绿色为实施前置。
35. Cook Session v3 与 active descriptor 使用 `user_id + family_id` 命名空间和独立 v3 key；旧 v2 bundle 不读取、不覆盖、也不删除 v3 状态。
36. AI v2 按“reader/normalizer/executor、generation gate 与覆盖全部公共 DTO/REST/SSE/history 的 projector 先作为不可拆分的 B1 下限全量发布，兼容前端再发布，generator 最后切换”实施；任何实例开始生成 v2 前，所有可承接审批执行的实例都必须同时接受 v1 与 v2，旧客户端不能从任何投影出口拿到可编辑 v2 payload。

## 3. 问题背景与仓库现状

### 3.1 产品问题

当前系统同时向普通家庭成员暴露“食物、菜谱、记录、计划”四个概念，但各概念在不同端的层级和动作不一致：

- 桌面将食物、菜谱、记录都放在一级导航；
- 手机底部只有食物，菜谱和记录通过内部入口进入；
- 菜单数据已经迁移到 Food，但用户仍看到独立 Recipe 一级心智；
- “开始做”可能先创建计划，“完成做菜”又可能不创建记录；
- 同一 Recipe 搜索结果在桌面和手机落到不同页面。

用户因此需要先理解内部数据模型，才能完成“想吃、准备吃、正在做、已经吃过”这些本应自然的家庭动作。

### 3.2 当前一级导航不一致

当前 `frontend/src/app/AppShell.tsx` 的 TabKey 为：

```ts
type TabKey =
  | 'home'
  | 'foods'
  | 'recipes'
  | 'ingredients'
  | 'logs'
  | 'ai'
  | 'family';
```

桌面一级导航包含：

- 首页；
- 食物；
- 菜谱；
- 食材；
- 记录；
- AI；
- 我的家庭。

手机底部导航包含：

- 首页；
- 食物；
- AI；
- 食材；
- 家庭。

这不是布局差异，而是两套业务信息架构。

### 3.3 FoodWorkspace 已经接近“吃什么”

当前 FoodWorkspace 和 FoodMobileView 已包含：

- 今日推荐；
- 家常菜、外卖、外食、成品和速食；
- 可做和缺料；
- 场景探索；
- 食物库；
- 菜单计划；
- Food 详情；
- 新增外卖和成品；
- selfMade Food 的 Recipe 查看与编辑；
- 快速记录；
- 开始做。

因此目标不是重新发明一个 feed，而是把已有 Food 决策能力提升为统一用户入口，并收敛其内部导航与任务边界。

### 3.4 底层已经支持“Food 是用户对象，Recipe 是做法能力”

当前后端保留独立 Recipe 与 Food 模型，同时通过以下约束维护关系：

- `Food.recipe_id` 是唯一外键；
- Recipe 创建或更新时调用 `ensure_food_for_recipe(...)`；
- 每份 Recipe 自动创建或修复一个 `type=selfMade` 的 Food；
- 后端测试已覆盖一份 Recipe 始终只有一个对应 selfMade Food。

因此移除 Recipe 一级入口不会删除 Recipe，也不会丢失自做菜。用户从 Food 进入，Recipe 继续保存做法、食材和 CookLog。

### 3.5 菜单计划已经迁移到 Food

当前 FoodPlanItem 持有 `food_id`，菜单 UI 和主要写入也已经在 Food 侧。

独立 RecipeWorkspace 中的 plan props 已经被空数组和抛错回调替代，错误文案为“菜单计划已迁移到食物页”。后端仍保留旧 recipe plan 兼容端点并适配到 FoodPlanItem。

这说明当前主要矛盾不是数据没有迁移，而是一级导航和用户语言没有跟上。

### 3.6 直接开始做仍会隐式创建计划

当前 HomeDashboard 和 FoodWorkspace 的直接“开始做”流程会：

1. 创建 FoodPlanItem；
2. 取回 plan item ID；
3. 进入 Recipe Cook Mode；
4. 完成后把计划项标为 cooked。

用户没有执行“加入菜单”，系统却制造了一条计划记录，导致“计划”和“执行”继续耦合。

### 3.7 完成烹饪还不是可靠记录契约

当前前端 Cook Session 默认 `createMealLog=true`，但 RecipeCookFinishDialog：

- 提供“同步生成餐食记录”复选框；
- 允许跳过 meal step；
- 跳过时把 `createMealLog` 改为 false。

后端 CookRecipeRequest 默认：

```py
create_meal_log: bool = False
```

普通 REST 路径和 AI recipe cook operation 都只在该值为 true 时创建 MealLog。

因此当前“做完饭后进入记录”只是一个前端默认值，不是跨入口业务不变量。

### 3.8 AI 仍明确支持“只扣库存不记录”

当前 AI recipe-cook Skill 和草稿 schema 把 `createMealLog` 作为用户决策：

- 只说做菜并扣库存时设置 false；
- 明确说记录餐食时才设置 true。

如果只修改普通前端，AI 仍会产生无 MealLog 的成功 CookLog，产品语义继续分裂。

### 3.9 全局搜索按设备分叉

当前 `useAppGlobalSearchNavigation.ts` 对 Recipe 的处理为：

- 手机：从已加载 Foods 查找关联 Food，跳到 foods；
- 桌面：跳到 recipes；
- 手机查不到已加载 Food 时仍切换 tab，但不会打开目标详情。

这既造成跨端心智不一致，也把导航正确性绑定到点击前的数据加载状态。

### 3.10 旧本地缓存存在白屏风险

当前 App 直接读取 `culina-active-tab` 并恢复为 TabKey。

如果直接删除 `recipes` 和 `logs` 而没有迁移，已有用户可能恢复到一个不再渲染的 tab，得到空白工作区。

### 3.11 MealLogWorkspace 仍强化任务心智

当前 MealLogWorkspace 以“待补充 / 已补充”为主要组织方式，没有照片、评分或备注的记录容易被表达成欠账。

自动记录上线后，如果最小 MealLog 立即进入“待补充”，用户会感受到系统又制造了一项任务。本期必须先把“记录有效性”和“可选增强”分离，但不扩大到 P1 的完整家庭回忆能力。

### 3.12 Query window 仍绑定旧 TabKey

当前 `useAppWorkspaceQueries.ts` 根据 `foods / recipes / logs` 决定是否加载：

- members；
- ingredients；
- inventory；
- recipes；
- recipe insights；
- food plan；
- foods；
- meal logs；
- food scenes。

删除旧 tab 但不重写 query scope，会造成导航成功后数据未启用、Recipe target 无法解析或 Cook Mode 缺失库存上下文。

## 4. 实施基线与相邻 P0 边界

### 4.1 PR 72、PR 73 是前置依赖

截至 2026-07-12 初始设计核验：

- PR 72 `feature/home-action-center → main` 仍为 OPEN，merge state 为 CLEAN，所有检查绿色；
- PR 73 `feature/inventory-reconciliation → feature/home-action-center` 仍为 OPEN，merge state 为 DIRTY；
- PR 73 的 Backend Service Tests 和 Backend Search Tests 失败。

上述状态可能变化，实施前必须实时重查。正式开发基线必须满足：

```text
PR 72 合并
→ PR 73 重新基于最新 main
→ 冲突与失败测试修复
→ PR 73 全部检查绿色并合并
→ 本地同步最新 main
→ 重跑基线验证
```

不能按当前 main 的文件行号机械实施，也不能把“已在 PR 中完成开发”表述成“已合入 main”。

独立审计时，本地 checkout 的 `HEAD=89d6f616b32769fcdb7547630eca8ffda84cfcb0`，`origin/main=bdc2f1a2f446bd1e4dbe4f0c75e25f0fe1d90ee2`；PR 72 快照 `f59257004f5979b61ffa3e8e9410a49a4c0c21ff` 与 PR 73 快照 `e91495c921d731501a358c9bd8c8a222c6b14541` 均尚不是该 HEAD 的祖先。该信息只说明本次审计基线，不能替代实施时对最新 GitHub 状态和合并后代码的重新核验。

PR 73 审计快照中的 `lock_inventory_targets(...)` 已把库存全局行锁顺序定义为 `Ingredient → Food → IngredientInventoryState → InventoryItem → ShoppingListItem`。本期 Cook、MealLog 与 deletion guard 必须接入并扩展这条顺序，不能先锁 Food 再调用会锁 Ingredient 的 PR 73 primitive；PR 73 合并后若顺序变化，实施前以合并代码为准统一更新本规格中的序列和并发测试。

### 4.2 与 P0 第三点的边界

P0 第三点负责：

- 首页内容优先级；
- “今天吃什么、今天必须处理什么、谁做了什么重要动作”；
- 最近记录摘要；
- 审计日志退出首页；
- 首页信息密度。

本期负责：

- 首页卡片或行动项的语义导航目标；
- 首页 direct cook 与 plan cook 的来源区分；
- 查看记录进入“吃过的”；
- 首页对象通过统一 `navigate(target)` 进入其他工作区。

两者没有功能硬依赖，但都可能修改 App 和 HomeDashboard。实施时应确定合并顺序，后开始者基于先完成者的最新 main，避免长期维护两套 Home/App props。

## 5. 目标与非目标

### 5.1 本期目标

- 桌面和手机使用同一五项一级导航；
- “吃什么”成为发现与计划入口；
- “菜谱”成为 selfMade Food 的做法详情；
- “记录一餐”统一承接已经吃过什么；
- “开始做”完成后自动形成 MealLog；
- “计划”和“直接执行”不再隐式耦合；
- Recipe 搜索在两端落到同一对象；
- 建立集中导航状态和版本化缓存迁移；
- 让计划详情和计划来源记录可以通过明确任务类型跨周解析；
- 复用现有 Food、Recipe、Plan、Meal 组件与 API；
- 保持家庭数据边界、库存事务和 AI 审批透明性；
- 保证完成请求可安全重放，计划项不能被并发重复完成；
- 保证删除 Recipe 不会把既有餐食历史变成空记录；
- 在不重做 UI 的前提下完成移动端和桌面布局适配；
- 为后续 P1 菜单弹性与家庭记忆保留清晰边界。

### 5.2 本期不包含

- 合并或删除 Food、Recipe、FoodPlanItem、MealLog 模型；
- 新建统一 feed、BFF 或聚合后端；
- 引入 React Router 或 URL 深链接；
- 重做推荐算法；
- 重做 Food 卡片、Recipe editor 或 Cook Mode 的视觉风格；
- 实现 P0 第三点的首页内容重构；
- 实现 P1 菜单弹性、剩菜、不在家、计划顺延等能力；
- 实现 P1 家庭回忆、月度故事或完整记录去任务化；
- 建立通用分布式 exactly-once 基础设施或重做全部业务操作 ledger；
- 回填历史无 MealLog 的 RecipeCookLog；
- 实现 Recipe/Food archive、删除后历史快照或恢复站；
- 自动合并同一日期和餐次的多条 MealLog；
- 首发即删除旧 recipe plan 后端兼容 API；
- 首发即删除所有旧请求字段和旧 localStorage key。

## 6. 统一用户语言与领域边界

### 6.1 用户语言

| 用户语言 | 回答的问题 | 底层主要对象 |
|---|---|---|
| 吃什么 | 现在或以后可以吃什么 | Food |
| 做法 | 这道自做菜怎么做 | Recipe |
| 菜单 | 已经明确安排以后吃什么 | FoodPlanItem |
| 开始做 | 进入一次实际烹饪 | Recipe Cook Session |
| 完成烹饪 | 本次做菜已经发生并落库 | RecipeCookLog + MealLog |
| 记录一餐 | 把已经吃过的内容写入历史 | MealLog |
| 吃过的 | 查看已经发生的餐食 | MealLog timeline |

### 6.2 Food

Food 是家庭成员选择、计划和记录的主要对象，继续支持：

- selfMade；
- takeout；
- dineOut；
- finished；
- instant；
- 项目现有其他 Food 类型。

Food 承担：

- 推荐和发现；
- 加入菜单；
- 快速记录；
- 与库存、使用历史和家庭偏好关联；
- selfMade Food 的 Recipe 入口。

### 6.3 Recipe

Recipe 只承担：

- selfMade Food 的食材与步骤；
- 做法编辑；
- 库存可做性；
- Cook Mode；
- RecipeCookLog；
- 做菜反馈。

Recipe 不再承担：

- 一级导航；
- 独立菜单计划入口；
- 与 Food 并列的“今天吃什么”内容世界。

### 6.4 FoodPlanItem

FoodPlanItem 只表示未来安排。

创建条件必须是：

- 用户明确点击“加入菜单”；
- 用户在菜单视图新建计划；
- AI 草稿明确为菜单写入并经审批。

直接开始做不得创建 FoodPlanItem。

### 6.5 MealLog

MealLog 表示已经发生的一餐。

产生方式包括：

- 非自做 Food 快速记录；
- 完整记录一餐；
- 从计划项记录已经吃过；
- 成功完成 Recipe Cook；
- AI 经审批创建餐食记录。

拥有至少一个有效 Food entry 即是一条有效记录。照片、家人、评分、心情和备注都是可选增强，不决定记录是否“完成”。

所有新建和更新入口必须共用同一组引用校验：

- `food_entries` 至少一项；
- 所有 Food 必须按当前 `family_id` 批量加载并验证；
- Food ID 缺失、未知或属于其他家庭时拒绝整个请求；
- 同一 MealLog 请求不得重复提交同一个 Food ID；
- participant user ID 去重后必须对应当前家庭的 active Membership；
- participant 对应 User 必须同时满足 `is_active=true`；Membership active 不能替代 User active；
- 创建或完成 Cook 时 participant 为空，规范化为当前操作者；
- 不允许依赖数据库外键或前端筛选替代家庭边界校验。

### 6.6 Recipe 与 Food 的删除生命周期

当前 Recipe 删除会显式删除关联 Food，而 Food、MealLogFood、FoodPlanItem 和 RecipeCookLog 的 cascade/delete-orphan 关系会继续删除餐食条目、计划和 CookLog。该行为与“吃过的历史是有效家庭记忆”冲突。

本期首发采用不扩张 archive 产品面的安全规则：

1. Recipe 删除先按当前家庭 `SELECT ... FOR UPDATE` 锁定 Recipe，再按 ID 稳定排序锁定全部关联 Food；直接物理删除 Food 的任何路径至少锁定该 Food；
2. 获得父实体锁后，在同一事务内重新检查 RecipeCookLog、关联 Food 的 MealLogFood 和 FoodPlanItem，不能使用锁前查询结果；
3. Recipe Cook completion 在新 claim 前先锁 Recipe，再把本次涉及的 Ingredient、现有关联 Food、IngredientInventoryState、InventoryItem 和 ShoppingListItem 一次性交给 PR 73 的 `lock_inventory_targets(...)`；所有创建或替换 MealLogFood 的 REST、quick-add、Cook、AI 路径至少按 Food ID 排序锁定引用 Food；所有创建 FoodPlanItem、或把既有 FoodPlanItem 的 `food_id` 改绑到另一 Food 的路径，必须在锁任何 FoodPlanItem 前先锁定本事务涉及的当前与目标 Food；
4. 本期权威全局顺序为可选 Recipe 前缀，随后严格保持 PR 73 的 `Ingredient → Food → IngredientInventoryState → InventoryItem → ShoppingListItem`，最后才是可选 FoodPlanItem；即 `Recipe → Ingredient → Food → IngredientInventoryState → InventoryItem → ShoppingListItem → FoodPlanItem`。路径可以跳过不需要的类型，但取得较后类型后不得再反向取得较前类型；Recipe 删除的 `Recipe → Food`、普通 MealLog 的 `Food`、非 Recipe plan 写入的 `Food → FoodPlanItem` 都是合法子序列；
5. 锁后发现父实体已删除、换家庭或关系变化时终止写入；数据库外键只作为最后防线，不能替代业务 guard；
6. 任一引用存在时，不执行任何媒体、搜索文档、Food 或 Recipe 删除；
7. 返回结构化 `409 recipe_has_history`；
8. 前端说明“这道菜已有餐食或菜单记录，暂时不能删除”；
9. 没有上述引用的 Recipe 仍可按现有流程物理删除；
10. REST 与 AI Recipe 删除共用同一 deletion guard 和锁 helper，不能只保护一条入口。

该协议关闭“guard 查空后，并发写入历史，再被 cascade 删除”的 TOCTOU。允许的并发结果只有两类：删除先持锁并成功后，引用创建/改绑方发现父实体不存在而失败；引用创建/改绑方先持锁并提交后，删除方重查引用并返回 `recipe_has_history`。不得出现双方都返回成功但新历史被级联清除。

Recipe/Food archive、从发现页隐藏已归档 Recipe、历史名称快照和恢复能力属于后续独立生命周期设计。如果产品要求“做过后仍可从发现页移除”，必须先完成该设计，不能恢复当前 cascade 删除。

## 7. 目标信息架构

### 7.1 一级导航

桌面和手机统一为：

```text
首页
吃什么
食材
AI
家庭
```

名称、顺序和业务含义相同。

### 7.2 “吃什么”子视图

```text
吃什么
├── 发现
│   ├── 今日推荐
│   ├── 家常菜
│   ├── 外卖 / 外食
│   ├── 成品 / 速食
│   ├── 可做 / 缺料
│   └── 场景与食物库
├── 菜单
│   ├── 本周安排
│   ├── 新增计划
│   ├── 计划项详情
│   └── 从计划开始做或记录
└── 吃过的
    ├── 餐食时间线
    ├── 餐食详情
    ├── 记录一餐
    └── 可选补充照片、评分、家人和备注
```

### 7.3 内部任务

以下内容是“吃什么”内部任务，不出现在一级或固定子导航：

```text
Food detail
Recipe detail
Recipe editor
Cook Mode
Cook Finish
Meal create
Meal detail
Meal enrichment
```

### 7.4 桌面布局

桌面可以使用：

- 左侧一级导航；
- 工作区顶部或侧部子导航；
- 列表与详情并列；
- drawer 或现有 overlay 承载任务。

桌面不得恢复独立 Recipe 或 Logs 一级入口。

### 7.5 手机布局

手机保留五项底部导航。“吃什么”内部使用紧凑分段导航或子页面，不把发现、菜单和吃过的继续塞入底部导航。

手机可以使用：

- 全屏任务页；
- 现有 overlay；
- 安全区上方固定操作；
- 与桌面相同的导航状态转换。

业务落点不能依赖 `isPhoneViewport`。

## 8. 导航状态设计

### 8.1 一级 key

```ts
type PrimaryTabKey =
  | 'home'
  | 'eat'
  | 'ingredients'
  | 'ai'
  | 'family';
```

内部使用 `eat`，不保留“显示叫吃什么、代码仍叫 foods”的长期错位。

### 8.2 基础视图

```ts
type EatBaseView =
  | 'discover'
  | 'plan'
  | 'history';
```

基础视图是可直接切换、可以持久化的稳定位置。

### 8.3 任务类型

```ts
type CookLaunchContext = {
  date: string;
  mealType: MealType;
  servings: number;
  source:
    | { kind: 'direct' }
    | {
        kind: 'plan';
        foodPlanItemId: string;
        planItemBaseUpdatedAt: string;
      };
};

type MealCreateSource =
  | { kind: 'direct' }
  | {
      kind: 'plan';
      foodPlanItemId: string;
      planItemBaseUpdatedAt: string;
    };

type EatTask =
  | {
      kind: 'food-detail';
      foodId: string;
      returnTo: EatBaseView;
    }
  | {
      kind: 'recipe-target';
      recipeId: string;
      mode: 'view' | 'edit';
      returnTo: EatBaseView;
    }
  | {
      kind: 'recipe';
      foodId: string;
      recipeId: string;
      mode: 'view' | 'edit';
      returnTo: EatBaseView;
    }
  | {
      kind: 'plan-detail';
      foodPlanItemId: string;
      returnTo: 'plan';
    }
  | {
      kind: 'cook';
      foodId: string;
      recipeId: string;
      launchContext: CookLaunchContext;
      returnTo: EatBaseView;
    }
  | {
      kind: 'meal-create';
      source: MealCreateSource;
      foodId?: string;
      date?: string;
      mealType?: MealType;
      returnTo: EatBaseView;
    }
  | {
      kind: 'meal-detail';
      mealLogId: string;
      returnTo: EatBaseView;
    };
```

`recipe-target` 是暂态解析任务。Foods 与 Recipes 查询完成后：

- 正常关系解析为 `recipe`；
- Recipe 不存在进入 not-found；
- Food 缺失进入关系异常状态。

`plan-detail` 通过 family/user scoped 的按 ID query 加载实体，不依赖当前周列表中已经存在目标。加载成功后再根据响应中的 `plan_date` 定位对应周。

`CookLaunchContext` 是一次 Cook Session 的初始化输入，不是可信服务端实体快照：

- direct 来源的日期、餐次和份量来自用户在快速弹窗中的确认；
- plan 来源的日期和餐次来自刚安全加载的计划项，份量默认来自 Recipe；
- 用户进入 Cook 后仍可调整日期、餐次和份量；
- plan 完成时服务端必须重新锁定并验证 `planItemBaseUpdatedAt`，不能信任启动上下文。

`meal-create` 的 plan source 必须携带 plan item ID 和 base updated-at，成功创建后把该计划项指向新 MealLog；direct source 不得伪造或隐式创建计划。

### 8.4 应用导航状态

```ts
type AppNavigationState = {
  primaryTab: PrimaryTabKey;
  eat: {
    baseView: EatBaseView;
    task: EatTask | null;
    discoverSection: 'all' | 'selfMade';
  };
};
```

### 8.5 导航目标

调用方不直接组合 `setActiveTab + requestId + selectedId`，而是发出语义目标：

```ts
navigate({ workspace: 'eat', view: 'discover' });
navigate({ workspace: 'eat', view: 'food', foodId });
navigate({ workspace: 'eat', view: 'plan', foodPlanItemId });
navigate({ workspace: 'eat', view: 'history', mealLogId });
navigate({
  workspace: 'eat',
  view: 'cook',
  foodId,
  recipeId,
  launchContext: {
    date,
    mealType,
    servings,
    source: { kind: 'direct' },
  },
});
```

中央 model 将目标转换为 PrimaryTab、baseView 和 task。

### 8.6 状态转换

- 切换一级 tab 时关闭当前 Eat task；
- 切换 discover/plan/history 时关闭当前 task；
- 打开 task 时保留 returnTo；
- 关闭 task 时回到 returnTo；
- direct cook 完成后默认回到来源基础视图；
- plan cook 完成后回到 plan，并展示已完成状态；
- plan-detail 加载后把周视图定位到响应中的 plan_date；
- plan-origin meal-create 完成后回到 plan，并打开或高亮已完成计划项；
- 成功态“查看这餐”显式打开 history + meal-detail；
- 刷新页面只恢复一级 tab 和 baseView，不恢复详情或 Cook task；
- 刷新后可以通过 active Cook descriptor 显式恢复未完成 Cook Session；
- 不建立任意深度的通用导航栈。

### 8.7 返回与离开

- desktop drawer 关闭、mobile 返回、Escape 使用同一个 `closeTask()`；
- Cook Mode 沿用已有未完成会话保护；
- mutation pending 时不能通过 backdrop 关闭完成弹窗；
- 搜索进入 task 后关闭搜索 overlay，再把焦点移动到 task 标题；
- task 关闭后把焦点还给触发元素或对应列表容器。

## 9. 本地持久化与旧值迁移

### 9.1 新存储

新增：

```text
culina-navigation-v2
```

结构：

```ts
type PersistedNavigationV2 = {
  version: 2;
  primaryTab: PrimaryTabKey;
  eatBaseView: EatBaseView;
  discoverSection?: 'all' | 'selfMade';
};
```

不持久化：

- foodId；
- recipeId；
- foodPlanItemId；
- mealLogId；
- Cook Session task；
- modal 或 drawer 开关。

Cook Session 继续使用独立存储。active descriptor key 必须按当前认证作用域命名空间化：

```text
culina-active-cook-v1:{userId}:{familyId}
```

```ts
type ActiveCookDescriptor = {
  version: 1;
  recipeId: string;
  foodPlanItemId: string | null;
  savedAt: string;
};
```

Cook Session v3 使用与旧 v2 完全不同、同样按作用域隔离的 key：

```text
culina-recipe-cook-session-v3:{userId}:{familyId}:{recipeId}:direct
culina-recipe-cook-session-v3:{userId}:{familyId}:{recipeId}:plan:{foodPlanItemId}
```

```ts
type PersistedRecipeCookSessionV3 = {
  version: 3;
  savedAt: string;
  source: 'direct' | 'plan';
  planItemId: string | null;
  session: RecipeCookSessionStateV3;
};
```

约束：

- key builder 只接受当前认证返回的 `user_id` 和 membership `family_id`，不接受导航 payload 自报作用域；
- 用户或家庭切换只切换当前 namespace，不读取、覆盖或清理其他 namespace；
- descriptor、session 过期或实体 404 时，只清理当前 namespace 的对应 key；
- 同一浏览器可以分别保留不同 user/family 的合法 active Cook；
- 每个 user/family namespace 同时只有一个 active descriptor；开始不同 Recipe/source 前若已有合法 descriptor，必须让用户选择“继续上次”或“放弃并开始新的”，不得静默覆盖；放弃只清理该 namespace 指向的旧 session；
- v3 key 不复用现有 `culina-recipe-cook-session:*` key，旧 v2 parser 因此不能把 v3 当未知版本删除；
- 只有在 Recipe 和可选 plan 已按当前 family/user 成功解析后，且当前作用域没有 v3 session 时，才允许把精确匹配的 legacy v1/v2 session 单向迁移到 v3；不得全局扫描并猜测归属；
- v3 一旦存在即为当前作用域的权威 session；兼容期不做 v3 → v2 双写，避免旧端保存时丢失 `completionRequestId`；
- raw v2 bundle 无法继续 v3 session，但不得删除它；回到兼容 v3 build 后必须仍可恢复。

该 descriptor 只保存恢复定位所需 ID，不保存 Recipe、Food、FoodPlanItem 或 MealLog 快照，也不自动恢复全屏 task。刷新后：

- eat/discover 顶部使用现有卡片/状态组件展示紧凑“继续做菜”入口，不做营销 hero，也不遮挡当前页面主任务；
- 用户点击后重新按 ID 解析 Recipe、Food 和可选计划项；
- Recipe/关系已删除或 session 过期时，清除 descriptor 和对应 session，并显示可恢复提示；
- direct session 保留 24 小时，plan session 保留 7 天；
- 成功完成后同时清除 descriptor 与 session；
- completion 失败时两者都保留。

成功、放弃或过期清理 descriptor 前必须再次确认其中的 Recipe/source 仍与当前 session 匹配，避免另一个标签页刚启动的新 Cook 被旧标签页误清理。

### 9.2 迁移规则

| 旧 `culina-active-tab` | 新位置 |
|---|---|
| `home` | home |
| `foods` | eat / discover / all |
| `recipes` | eat / discover / selfMade |
| `logs` | eat / history |
| `ingredients` | ingredients |
| `ai` | ai |
| `family` | family |
| 未知值 | home |
| 损坏值 | home |

### 9.3 兼容周期

- 优先读取合法 v2；
- 无 v2 时读取并迁移旧 key；
- v2 写入成功后以 v2 为准；
- 首个兼容版本不删除旧 key，便于旧前端回滚；
- 稳定观察期后再由独立清理 PR 删除旧 key；
- parser 必须把任意外部值视为不可信输入并安全校验。

## 10. 前端组件与职责边界

### 10.1 导航 model

新增：

```text
frontend/src/app/appNavigationModel.ts
frontend/src/app/useAppNavigationState.ts
```

`appNavigationModel.ts` 负责纯逻辑：

- 类型；
- target 解析；
- reducer/state transition；
- query scope 派生；
- localStorage parser 和迁移；
- fallback。

`useAppNavigationState.ts` 负责：

- 初始化；
- 持久化；
- `navigate(...)`；
- `selectEatView(...)`；
- `closeTask()`；
- 与 React 生命周期连接。

### 10.2 EatWorkspace

新增：

```text
frontend/src/features/eat/EatWorkspace.tsx
frontend/src/features/eat/EatWorkspaceViewModel.ts
```

EatWorkspace 只负责：

- 子导航；
- 基础视图组合；
- task 渲染；
- desktop/mobile 布局；
- loading/empty/error 边界；
- focus restoration。

EatWorkspace 不负责：

- 推荐算法；
- plan payload；
- Recipe 业务校验；
- 库存事务；
- MealLog serializer；
- AI draft normalization。

### 10.3 现有组件复用

| 当前能力 | 目标位置 | 原则 |
|---|---|---|
| FoodWorkspace 推荐、场景、类型、食物库 | discover | 复用 UI，逐步抽出发现视图 |
| Food plan 能力 | plan | 继续以 FoodPlanItem 为唯一数据源 |
| MealLogWorkspace | history | 复用时间线和详情，调整入口和任务化文案 |
| FoodDetailDrawer | food-detail task | 保留现有 detail UI |
| Recipe detail/editor | recipe task | 从 RecipeWorkspace 抽出任务级能力 |
| Recipe Cook Mode | cook task | 保留现有做菜 UI 与 session |
| RecipeWorkspace 独立浏览壳 | 无 | 入口迁移后删除 |
| Recipe plan UI | 无 | 证明不可达后删除 |

不得把 FoodWorkspace、RecipeWorkspace、MealLogWorkspace 无边界嵌套成一个超大 TSX。

### 10.4 App.tsx

App 继续负责跨域装配，但不继续维护大量 request ID 与 tab-specific target：

- 渲染当前 Primary workspace；
- 装配 queries 和 mutations；
- 传递统一 navigation service；
- 根据 query scope 启用查询；
- 处理顶层 auth/family 状态。

目标删除：

- `foodNavigationRequestIdRef`；
- `recipeNavigationRequestIdRef`；
- `foodPlanNavigationRequestIdRef`；
- desktop/mobile recipe target 分叉；
- `setActiveTab('logs')` 一类业务跳转；
- Recipe 独立一级 render 分支；
- Logs 独立一级 render 分支。

### 10.5 不引入新的路由框架

本期不引入 React Router，原因是：

- 当前应用以集中状态和 overlay 为主；
- P0 问题是业务信息架构，不是 URL 能力；
- 引入路由会扩大回归面；
- 深链接、浏览器 history 和 route guard 可独立设计。

## 11. 核心用户流程

### 11.1 发现自做菜并开始做

```text
吃什么 / 发现
→ 打开番茄炒蛋
→ 展开做法
→ 开始做
→ 核对日期、餐次和份量
→ Cook Mode
→ 完成烹饪
→ 原子扣减库存并生成 MealLog
→ 成功态
→ 完成并返回，或查看这餐
```

该流程不创建 FoodPlanItem。

### 11.2 加入菜单后开始做

```text
吃什么 / 发现
→ 加入菜单
→ 创建 FoodPlanItem
→ 吃什么 / 菜单
→ 打开计划项
→ 开始做
→ Cook Mode 携带 foodPlanItemId、planItemBaseUpdatedAt 和启动上下文
→ 完成烹饪
→ 创建 MealLog
→ 计划项 status=cooked
→ 计划项 meal_log_id 指向本次 MealLog
```

### 11.3 外卖、外食、成品和速食

```text
打开 Food
→ 快速记录
或
→ 完整记录一餐
→ MealLog
→ 吃过的
```

这些 Food 不需要 Recipe，也不进入 Cook Mode。

### 11.4 从吃过的补充记录

```text
吃什么 / 吃过的
→ 打开一餐
→ 查看 Food、日期和餐次
→ 可选补充家人、照片、评分和备注
→ 保存
```

未补充时原记录仍然有效。

### 11.5 搜索 Recipe

```text
全局搜索命中“番茄炒蛋做法”
→ 发出 recipe-target(recipeId)
→ 切换到 eat
→ Foods / Recipes 查询加载
→ 解析关联 selfMade Food
→ 打开 Food 详情中的做法
```

桌面和手机流程一致。

## 12. 计划与直接开始做的数据语义

### 12.1 创建计划的唯一触发

| 动作 | 创建 FoodPlanItem |
|---|---:|
| 加入菜单 | 是 |
| 菜单中新建计划 | 是 |
| AI 菜单草稿获批 | 是 |
| 发现页直接开始做 | 否 |
| Food detail 直接开始做 | 否 |
| 首页推荐直接开始做 | 否 |
| 从已有计划开始做 | 不新建，复用原计划 |

所有创建 FoodPlanItem、或把既有 FoodPlanItem 的 `food_id` 改绑到另一 Food 的 REST 与 AI 路径，都必须遵守 `Food → FoodPlanItem` 父锁顺序。覆盖入口至少包括：

- `create_food_plan_item`；
- `update_food_plan_item`；
- `create_recipe_plan_item`；
- `update_recipe_plan_item`；
- `execute_meal_plan_draft / _apply_meal_plan_operations`。

单条创建或改绑先做不加锁的候选发现：创建收集目标 Food ID，改绑同时收集计划项当前 Food ID、目标 Food ID 和计划项 ID。随后在一个事务内先按 ID 稳定排序锁定全部候选 Food，再按 ID 稳定排序锁定既有 FoodPlanItem，最后使用锁后行重新验证 `family_id`、`user_id`、原 `food_id`、目标 Food 和 AI 请求的 `baseUpdatedAt`。若锁后当前/目标集合与候选集合不一致，返回结构化 `409 food_plan_targets_changed` 并从新事务重试；不得在已经持有 FoodPlanItem 后补锁一个新 Food。

AI 批量 operations 必须在执行任何一条 operation 前预读整个批次：合并 create/update 的目标 Food、既有计划项的当前 Food 以及全部 plan item ID，分别去重并稳定排序后，一次性完成“全部 Food → 全部 FoodPlanItem”锁定。delete、set_status 与 update 混合时也不能按模型给出的 operation 顺序逐项交替取得 `plan → food → plan → food`；锁后才按已验证的 operation 顺序产生结果。这样 Recipe/Food deletion guard、Cook completion 与所有计划创建/改绑共享同一串行化边界。

### 12.2 Cook 启动上下文

前端必须显式携带：

```ts
type CookLaunchContext = {
  date: string;
  mealType: MealType;
  servings: number;
  source:
    | { kind: 'direct' }
    | {
        kind: 'plan';
        foodPlanItemId: string;
        planItemBaseUpdatedAt: string;
      };
};
```

不得用“是否偶然有 plan item ID”推断用户意图。

初始化规则：

- direct：日期、餐次、份量来自 FoodQuickMealDialog；
- plan：日期和餐次来自计划项，份量来自 Recipe 默认值；
- 新 Session 用 launch context 初始化；
- 已存在且未过期的同一 Session 优先恢复，不被新的默认值覆盖；
- plan item 在 Cook 期间发生变化时，完成请求返回冲突并要求用户刷新，而不是以旧上下文覆盖新计划。

### 12.3 FoodQuickMealDialog

用于 cook 时必须可以核对：

- 日期；
- 餐次；
- 份量。

份量优先复用 ui-kit `TouchStepperField`，默认 `recipe.servings`；用户可以直接接受默认值，不增加强制填写步骤。日期、餐次、份量和底部动作在手机/iPad 上保持至少 44px 舒适触控区。FoodQuickMealDialog 继续使用现有 `WorkspaceModal` 和业务样式前缀，不新造视觉体系或堆 inline style。cook 场景说明文案改为“确认日期、餐次和份量后开始做”，不得继续使用“点一下就完成”。

提交行为从：

```text
createFoodPlanItem → onStartRecipe(recipeId, planItem.id)
```

改为：

```text
navigate(cook direct target)
```

该 target 必须携带完整 `CookLaunchContext`。不能只传 Recipe ID，否则移除隐式 FoodPlanItem 后日期和餐次会回退为今天晚餐。

用于 eat 时继续调用 quick-add MealLog。

### 12.4 FoodPlanItem 按 ID 解析

新增：

```text
GET /api/food-plan/{food_plan_item_id}
```

要求：

- 同时约束当前 membership `family_id` 与当前 `user_id`；
- 不存在、跨家庭或跨用户统一使用项目既有不可枚举 404 风格；
- 返回现有 FoodPlanItem response shape，包括 `plan_date`、`status`、`updated_at` 与关联 Food/Recipe 所需字段；
- 前端 query key 进入 `queryKeys.ts`，失效规则进入 `cacheInvalidation.ts`；
- plan-detail、plan-origin meal-create 和 plan cook 都可复用该 query；
- 周列表仍用于菜单展示，按 ID query 只负责语义目标解析，不取代周查询。

### 12.5 非 Recipe 计划记录一餐

从没有 Recipe 的 FoodPlanItem 进入 `meal-create` 时：

- 请求携带 `food_plan_item_id` 和 `food_plan_item_base_updated_at`；
- 后端先按 family/user 读取计划候选以取得 Food ID，再锁定并验证当前家庭 Food，随后 `FOR UPDATE` 锁定计划项并重新校验 Food ID；不得先锁 plan 再反向锁 Food；
- 校验 Food 匹配、base updated-at 一致且 status 为 `planned`；
- MealLog、MealLogFood 和计划项 `cooked/completed_at/meal_log_id` 在同一事务提交；
- 已由其他请求完成时不得再创建 MealLog，返回 `409 food_plan_item_already_completed`，并在结构化错误中提供已有 `meal_log_id` 供前端打开；
- 该流程共用 MealLog 引用校验，不复制一套家庭边界逻辑。

## 13. 成功完成烹饪的后端契约

### 13.1 业务不变量

`POST /api/recipes/{recipe_id}/cook` 表示“成功完成一次烹饪”，不是库存预览或单纯库存调整。

只要请求成功完成，就必须：

1. 处理库存扣减；
2. 创建 MealLog；
3. 创建 MealLogFood；
4. 创建 RecipeCookLog；
5. 如来自计划，更新 FoodPlanItem；
6. 写 ActivityLog；
7. 持久化可重放的 completion result；
8. 在同一事务提交。

库存预览继续由 cook-preview endpoint 负责，不产生写入。

### 13.2 最小 MealLog

成功完成产生：

```text
MealLog
├── family_id = 当前 membership.family_id
├── date = 请求日期或家庭当前日期
├── meal_type = 请求餐次或 dinner
├── participant_user_ids = 请求值，空时默认当前 user
├── notes = 用户餐食备注或空字符串
├── mood = 空字符串
└── MealLogFood
    ├── food_id = Recipe 对应 selfMade Food
    ├── servings = 本次实际份数
    └── note = 空字符串
```

不再使用系统文本占用用户字段：

```text
mood = 已做菜谱
MealLogFood.note = 来自菜谱：标题
```

来源已经由 RecipeCookLog.meal_log_id、Recipe 和 Food 关系表达。

### 13.3 RecipeCookLog

继续保存：

- recipe_id；
- meal_log_id；
- cook_date；
- meal_type；
- servings；
- result_note；
- adjustments；
- rating；
- created_by / updated_by。

新成功写入的 `meal_log_id` 必须非空。历史记录仍可为空。

本期新增一份 additive Alembic migration：

```text
recipe_cook_logs.completion_request_id    VARCHAR(120) NULL
recipe_cook_logs.completion_request_hash  VARCHAR(64) NULL
recipe_cook_logs.completion_result_json   JSON NULL
UNIQUE(family_id, completion_request_id)
```

约束：

- 历史 RecipeCookLog 三个字段保持 null，不做回填；
- 新客户端每个 Cook Session 生成一个稳定 request ID，失败重试和 response-loss retry 必须复用；
- request hash 使用规范化后的业务命令生成，至少覆盖 family、actor、Recipe、日期、餐次、份量、participant、用户备注、plan source/base version、反馈和 partial deduction 选择；
- hash 算法固定为 canonical JSON 的 SHA-256：key 排序、UTF-8、日期转 ISO、Decimal 转规范化十进制字符串；participant 等业务无序 ID 集合去重后排序，用户有序内容不得擅自重排；
- deprecated `create_meal_log`、`recipe_plan_item_id` alias 和纯传输层字段不参与 hash；
- participant 在 hash 前先按共享校验规则去重和规范化；
- result JSON 使用 `{ "version": 1, "response": ... }` envelope，只保存重放 `CookRecipeResponse` 所需的业务结果，不保存 token、完整实体快照或家庭外数据；读取未知 envelope version 时不得重新执行副作用，应返回可恢复的服务端兼容错误；
- Recipe 删除保护必须保证新幂等 CookLog 不会被级联删除。

### 13.4 计划项更新

只有请求携带经验证的 food_plan_item_id 时：

- status 设为 cooked；
- completed_at 设为当前 UTC；
- meal_log_id 设为本次 MealLog ID；
- updated_by 设为当前用户。

必须验证：

- family_id；
- user_id；
- plan item ID；
- plan item Food 与当前 Recipe 的关联；
- `SELECT ... FOR UPDATE` 锁定 plan item；
- 新客户端必须提交 `food_plan_item_base_updated_at`，并与锁定行的 `updated_at` 一致；
- 当前 status 必须是 `planned`。

PR 73 只为库存目标提供锁和版本能力，没有为 REST Cook 的 FoodPlanItem 增加 row version 或锁；本期必须自行实现上述契约，不能引用不存在的“PR 73 plan lock”。

已完成语义：

- 相同 completion request 已成功时，在锁 plan 前由幂等查询直接返回原结果；
- 不同 completion request 再完成同一 plan item，返回 `409 food_plan_item_already_completed`；
- plan item 在 Cook 期间被编辑，返回 `409 food_plan_item_stale` 并要求刷新启动上下文；
- 兼容期旧调用缺少 base updated-at 时，仍必须锁行并要求 `planned → cooked`，但不声称具有乐观版本保护；PR C 才把 base updated-at 变成 plan 来源的 schema 必填。

无计划来源时不创建计划项。

### 13.5 幂等执行流程

“最多一次业务副作用”不等于声称网络或分布式系统具有抽象的 exactly-once delivery。本期保证的是：同一个稳定 completion request 最多提交一次业务事务，并且可以安全读取第一次提交结果。

执行顺序固定为：

1. 按当前家庭解析 Recipe 和 participant，规范化命令并计算 request hash；
2. 如果 `completion_request_id` 已存在：hash 相同返回已持久化结果，hash 不同返回 `409 idempotency_key_reused`；
3. 对新 request 先按当前家庭 `SELECT Recipe ... FOR UPDATE`，在 Recipe 锁内再次检查 completion ID，并基于 Recipe 与当前库存快照派生候选 Ingredient、关联 Food、presence state 和 batch ID；此时只发现 target，不提前锁 Food 或 InventoryItem；
4. 一次调用 PR 73 `lock_inventory_targets(...)`，同时传入全部候选 `ingredient_ids`、现有 `food_ids`、`state_ingredient_ids`、`inventory_item_ids` 与需要时的 `shopping_item_ids`，由该 helper 严格按 `Ingredient → Food → IngredientInventoryState → InventoryItem → ShoppingListItem` 加锁；
5. 使用锁后最新行重新验证 family、Recipe/Food 关系、库存版本并重建 consumption plan；若锁后需要的 target 集合与候选集合不同，不得在已持有后序锁时补锁新 Ingredient/Food，而是返回库存冲突并从新事务重试；不允许 partial 且存在短缺时返回无写入响应，不 claim request ID；
6. 以 RecipeCookLog 幂等唯一键作为事务的第一项写入并立即 flush；
7. 唯一键并发冲突时回滚当前事务，重新读取胜出行：hash 相同返回原结果，hash 不同返回 409；
8. 在全部 PR 73 target 已锁定后，锁定并验证可选 FoodPlanItem；
9. 只使用锁后 plan 执行库存扣减；
10. 创建/更新 Food、MealLog、MealLogFood、RecipeCookLog、FoodPlanItem 和 ActivityLog；
11. 把最终 response snapshot 写入 `completion_result_json` 后一次提交。

Recipe 与 PR 73 targets 的 `FOR UPDATE` 是 claim 前允许的只读锁；CookLog claim 仍必须是任何库存、MealLog、计划或 Activity 之前的第一项写入。缺少关联 Food 时持续持有 Recipe 锁，后续 ensure 创建该新 Food；因为该 Food 在锁前不存在且同 Recipe 创建方被 Recipe 锁串行化，这不构成取得既有 Food 行锁的反序。失败事务中的 claim row 一起回滚，不得留下永久 pending 占位。

首个兼容后端允许旧客户端不传 `completion_request_id`：服务端为该次 HTTP 请求生成一次性 legacy ID。它仍满足单事务和 plan status 锁，但 direct legacy 请求无法在 response loss 后识别重放；这是有明确观察期限的兼容例外，不得延伸到新前端、AI v2 或 PR C 之后。

### 13.6 原子事务

任意一步失败都回滚：

- 库存；
- MealLog；
- MealLogFood；
- RecipeCookLog；
- FoodPlanItem；
- ActivityLog；
- completion result。

具体失败语义：

- Recipe 不存在或跨家庭：404；
- plan item 不存在、跨家庭、跨用户或不匹配 Recipe：404/业务冲突；
- plan item stale 或已由其他请求完成：409；
- completion request ID 被不同内容复用：409；
- 已存在 completion result 的 envelope version 当前实例不支持：`409 completion_result_version_unsupported`，不重新执行；
- 库存版本冲突：409，并刷新预览；
- 锁后 consumption plan 需要未按全局顺序预锁的新 target：`409 inventory_targets_changed`，结束事务后重建，不就地追加反序锁；
- 不允许部分扣减且存在短缺：不产生完成记录；
- MealLog 或 CookLog 写入失败：库存和计划一起回滚。

### 13.7 共享 completion service

新增：

```text
backend/app/services/recipe_cook_completion.py
```

窄职责：

- 规范化 completion command、计算 hash 并 claim/replay RecipeCookLog；
- 先锁 Recipe，再以单次 PR 73 `lock_inventory_targets(...)` 遵守 Ingredient → Food → State → Item → Shopping 全局顺序，并把 plan lock 放在最后；
- ensure Recipe 对应 Food；
- 调用现有库存锁与扣减能力；
- 锁定并验证可选 plan item；
- 调用共享 MealLog 引用校验；
- 创建 MealLog；
- 创建 MealLogFood；
- 完成已 claim 的 RecipeCookLog；
- 更新可选 plan item；
- 记录完成 Activity。

REST 和 AI 调用方仍各自负责：

- 构造当前 family/actor 上下文；
- 把 REST payload 或 AI draft 转换为统一 command；
- AI 草稿版本检查；
- HTTP/AI 错误类型映射。

completion service 必须复用 PR 73 已有库存锁与版本 primitive，不在本期重写整个库存执行服务；但 REST 与 AI 不得各自再复制一套 MealLog、plan 或幂等写入。

### 13.8 MealLog 引用与参与者边界

- participant_user_ids 为空时默认当前用户；
- 显式提供时先去重，再验证每个 ID 对应当前家庭 active Membership，且关联 User `is_active=true`；
- 不允许把其他家庭 user ID 写入当前家庭 MealLog；
- Food 必须按当前 `family_id` 加载，不能只依赖 Recipe/Food 外键关系；
- 至少一个 Food entry；重复 Food ID 作为无效请求拒绝；
- created_by / updated_by 始终为当前操作者。

新增共享 service/helper，由普通 MealLog REST create/update、quick-add、Cook completion、AI MealLog 和 AI recipe cook 共用。所有引用验证必须在创建 MealLog 及其 entries 之前完成；创建或替换 entries 前按 Food ID 稳定排序取得父 Food 行锁，并在锁后重做 family 校验。

## 14. REST 请求与响应兼容

### 14.1 create_meal_log

首个兼容版本保留：

```py
create_meal_log: bool | None = Field(
    default=None,
    deprecated=True,
)
```

后端不再根据该值决定是否创建 MealLog。

兼容目的：

- 旧 PWA bundle 仍可提交该字段；
- 前后端滚动部署期间不因 extra/invalid field 直接失败；
- 新业务不变量由服务端守住。

首个兼容前端：

- 删除 checkbox 和 Session 中的业务选择；
- 构造 payload 时仍固定发送 `create_meal_log=true`；
- 不允许组件或调用方重新传入 false；
- 只有确认旧后端实例和回滚窗口全部结束后，PR C 才停止发送字段。

这样同时保护旧前端 → 新后端和新前端 → 旧后端。观察期结束后再删除后端字段。

### 14.2 completion 与 plan 并发字段

首个兼容 schema 增加：

```py
completion_request_id: str | None = Field(default=None, min_length=1, max_length=120)
food_plan_item_base_updated_at: datetime | None = None
```

规则：

- 新前端与 AI v2 必须发送稳定 `completion_request_id`；
- plan 来源的新前端与 AI 必须同时发送 `food_plan_item_base_updated_at`；
- 旧客户端缺失时使用 13.4、13.5 定义的有界兼容路径；
- PR C 在旧调用归零后把 completion request ID 设为所有完成请求必填，并把 plan base updated-at 设为 plan 来源条件必填；
- preview endpoint 不 claim completion ID，也不产生写入。

### 14.3 recipe_plan_item_id

首发继续兼容读取，但新前端与新 AI 只发送：

```text
food_plan_item_id
```

旧字段调用归零后由清理 PR 删除。

### 14.4 CookRecipeResponse

首发维持兼容形状：

```py
class CookRecipeResponse(BaseModel):
    recipe_id: str
    consumed_items: list[CookRecipeConsumedItemOut]
    shortages: list[CookRecipeShortageOut]
    meal_log_id: str | None
    cook_log_id: str | None
    replayed: bool = False
```

条件约束：

- 被库存短缺阻止的无写入响应可以返回空 ID；
- 真正成功完成的响应必须同时有 meal_log_id 和 cook_log_id；
- 同一 request 的安全重放返回相同 meal_log_id、cook_log_id 和业务结果，并设置 `replayed=true`；
- `replayed` 是本次传输状态，不参与 request hash，也不作为可变业务结果写回 snapshot；首次响应为 false，读取已存 snapshot 时在返回层置 true；
- 兼容新前端把 `replayed` 按可选字段解析，旧后端响应缺失该字段时按 `false` 处理；
- 前端不能把缺少 meal_log_id 的异常响应展示为完成成功；
- “查看这餐”必须使用响应 ID，不按日期和餐次猜测。

### 14.5 数据库兼容

本期不把 RecipeCookLog.meal_log_id 改为 NOT NULL，原因是：

- 存在历史兼容数据；
- 本期不做历史回填；
- 成功写入不变量可以由 service 和测试保证；
- 避免对历史数据做不必要回填。

本期只执行 13.3 定义的 additive nullable migration。旧应用版本会忽略新列；应用回滚不主动 downgrade 或删除这些列。

### 14.6 双向版本矩阵

| 组合 | 必须保持的行为 |
|---|---|
| 旧前端 → 新后端 | true/false 都由新后端按“成功必记录”执行 |
| 兼容新前端 → 旧后端 | 前端固定发送 true，因此旧后端仍创建 MealLog |
| 新前端 → 新后端 | 发送 true、completion ID 和可选 plan base version，完成可安全重放 |
| 新后端回滚为旧后端 | 兼容新前端仍发送 true；旧后端忽略额外字段 |
| PR C 前端 → 最终后端 | 停止发送 deprecated flag，新幂等字段已成为正式契约 |

后端必须先发布并确认全部实例健康，再发布兼容新前端。停止发送 `create_meal_log` 的版本不能与可能回滚到旧后端的窗口重叠。

该矩阵只证明请求/响应能被解析，不代表所有方向都保留 B1 的幂等、父行锁或 AI 双读正确性；真正允许的部署回滚下限以 24.6 为准。

### 14.7 Cook 本地状态版本矩阵

API 可双向兼容不代表 localStorage 可以无条件降级。固定规则：

| 组合 | 行为 |
|---|---|
| v3 build 读取当前作用域 v1/v2 | 目标实体经 family/user 验证后单向迁移到 scoped v3，并生成稳定 completion ID |
| raw v2 bundle 遇到 v3 | 因 key 完全不同而不可见；不得读取、覆盖或删除 v3 |
| v3 → 兼容回滚 build → v3 | 回滚 build 必须保留 v3 parser/key builder/payload builder，原 completion ID 可继续重放 |
| v3 → raw v2 artifact | 不支持无损继续 Cook；v3 数据必须保留，重新前滚后可恢复，但 v2 上的新提交属于 13.5 的 legacy 例外 |
| 未知未来 session version | 当前 build 不打开也不删除，等待可识别版本处理 |

因此 B2 不能直接回滚到当前只接受 `version===2` 且解析失败会删 key 的旧产物。需要回退 UI 时，必须制作保留 v3 存储和 completion payload 兼容层的 rollback build。用户设备上尚未更新的历史 v2 bundle 仍属于 13.5 已声明的 legacy 例外，但部署操作不能主动把已升级用户降回该状态，也不能把 legacy direct-cook 描述为可安全 response-loss replay。

## 15. Cook Finish UI

### 15.1 步骤

保留四段结构，但调整语义：

1. 库存核对；
2. 这餐的信息；
3. 本次反馈；
4. 确认完成。

### 15.2 这餐的信息

显示：

- 日期；
- 餐次；
- 份量；
- “完成后会自动记入吃过的”说明。

删除：

- `createMealLog` checkbox；
- “同步生成 / 不同步生成”；
- 跳过 meal step 后关闭记录的逻辑。

日期、餐次和份量使用 Cook Session 中的值，用户可修改。用户可以直接采用默认值继续，但不能关闭 MealLog。

### 15.3 可选反馈

以下保持可选：

- rating；
- adjustments；
- resultNote。

只有反馈步骤可以表达“跳过”。跳过不影响最小 MealLog。

### 15.4 Summary

固定展示：

```text
将处理 N 项库存
将生成 1 条餐食记录
本次反馈：已填写 / 未填写
```

不得根据 deprecated `create_meal_log` 兼容字段改变结果文案。

### 15.5 Cook Session 兼容

- PersistedRecipeCookSession envelope 升级到 `version: 3`，其 session state 删除 createMealLog；
- v3 session state 新增稳定 `completionRequestId`、显式 source 和可选 `planItemBaseUpdatedAt`；
- 新业务语义不再依赖 createMealLog，但首个兼容 payload builder 固定发送 `create_meal_log=true`；
- v3 使用 9.1 的新 scoped key；读取经当前 family/user 实体解析确认的旧本地 session 时忽略 `createMealLog:false`；
- 旧 v1/v2 session 只做 scoped 单向迁移，迁移时生成一次 completion request ID，并在之后的失败重试中复用；
- v3 parser 遇到未知未来版本时标记 incompatible 并保留原值，不能用“解析失败即删除”破坏未来版本的可恢复状态；
- session 恢复保留日期、餐次、份量、步骤、计时器和反馈；
- session 创建或恢复时同步写入当前 `user_id + family_id` namespace 的 active descriptor；
- mutation 失败不清理 session；
- 成功或安全重放且 meal_log_id、cook_log_id 均非空时，才清理 session 与 active descriptor。

### 15.6 成功态

推荐文案：

```text
烹饪完成
已更新库存，并把番茄炒蛋记到今天的晚餐。

[完成并返回] [查看这餐]
```

不强制打开 Meal editor。

## 16. AI recipe cook 契约

### 16.1 新语义

```text
预览做菜
→ 展示预计扣减与短缺
→ 不写数据

完成做菜
→ 扣减库存
→ 创建 MealLog
→ 创建 CookLog
→ 如有计划则完成计划
```

“只扣库存但没有完成一餐”不应调用 recipe_cook，应使用明确库存调整能力。

### 16.2 schema 版本

新草稿使用：

```text
recipe_cook_operation.v2
```

v2 从 schema、normalized draft、approval fields 和 executor command 中完全删除 `createMealLog`。不得保留“字段存在但强制 true”的第二实现分支，也不得让前端继续发送或修改该值。

最终 approval summary 必须明确“完成后会自动记录餐食”。

v2 completion request ID 从已持久化的 `AIOperation.idempotency_key` 稳定派生；同一个 approval operation 重试必须进入共享 completion service 的同一个 request ID。AI executor 不自行复制一套 RecipeCookLog、MealLog 或 plan 更新逻辑。

“当前生成版本”和“兼容执行版本”必须分开表达：生成侧在切换前只发布 v1、切换后只发布 v2；兼容 reader/normalizer/executor 在观察期同时接受 v1 与 v2，并按 16.3 分派。不能用把一个静态 enum 同时放开 v1/v2 的方式让模型随机生成任一版本。

### 16.3 v1 待审批草稿

| 草稿 | 处理 |
|---|---|
| v1 + createMealLog=true | 可按原批准语义继续执行 |
| v1 + createMealLog=false | 不静默执行，返回可恢复冲突并要求重新生成/确认 |
| v2 | 无 createMealLog 字段，按完成必记录执行 |

推荐冲突文案：

```text
做菜完成规则已更新，请刷新草稿并重新确认；完成后会自动记录餐食。
```

### 16.4 需要同步修改

- `backend/app/ai/skills/catalog/recipe-cook/SKILL.md`；
- `backend/app/ai/skills/catalog/recipe-cook/skill.yaml` 的 `draft_contract.schema_version`；
- AI recipe cook JSON schema；
- normalize_recipe_cook_draft；
- execute_recipe_cook_draft；
- draft validation；
- `backend/app/services/ai_operations/draft_specs/common.py` 的 approval base config；
- AiApprovalPanel；
- AI workspace/chat stream/history/pending/retry/regenerate/resume/approval，以及返回 `AIConversationOut` / `AIMessageDTO` 的 API client capability header；
- shared AI response projector、public conversation-context serializer、message parts/metadata serializer、progressive/final SSE writer 与 pending/decision gate；
- AI 预览与摘要文案；
- registry API snapshot 与版本断言；
- fake provider fixtures；
- recipe-cook tool output schema；
- AI eval dataset；
- AI operation tests；
- workspace approval tests；
- AI Skill Evaluation Gate；
- `docs/plans/ai-skill-optimization-notes.md` 中旧规则。

新增跨层契约测试，证明当前启用的生成版本在以下位置一致：

```text
skill.yaml manifest version
= tool output schema version
= normalized draft default version
= new approval request version
```

另行断言兼容 reader/normalizer/executor 的 accepted-version set 在观察期为 `{v1, v2}`，并逐一验证 16.3 的分派；accepted set 是生成版本的有意超集，不与 manifest 强行相等。

### 16.5 审批透明性

AI 完成做菜仍是写操作，必须保留：

- 家庭上下文；
- 草稿；
- 预览；
- 用户确认；
- 冲突检测；
- 正式提交。

自动生成 MealLog 不能绕过审批，也不能在旧 false 草稿上静默增加写入。

### 16.6 两阶段能力发布门

AI v2 不允许在一个普通滚动发布中同时首次出现 reader 和 generator。固定分两阶段：

**阶段一：兼容能力先行，仍只生成 v1**

- 所有后端实例先具备 v1/v2 persisted draft reader、normalizer、approval 展示和 executor；
- persisted-draft acceptance schema 与 generator-facing schema 必须拆开表达：前者接受 v1/v2，后者此阶段只发布 v1；
- v1 true 进入共享 completion service 并自动记录；
- v1 false 在执行前返回 16.3 的可恢复冲突，不能继续旧的“只扣库存”语义，也不能静默改成 true；
- v2 可以被读取和执行，但 skill manifest、tool generation schema 与默认 normalizer 仍只发布/生成 v1；
- approval copy 从该阶段起说明“完成后会自动记录餐食”；
- rollout probe 必须能在每个实例上断言 `accepted_versions={v1,v2}` 且 `generated_version=v1`，不能只对负载均衡入口抽样一次；
- 后端同时实现 16.7 的统一 client-aware generation/projection gate；缺少 v2 capability 的客户端在任何公共 DTO、REST、SSE 或历史消息出口都不得获得 canonical v2 draft/approval payload；
- 阶段一能力是不可拆分的部署与回滚下限：`v1/v2 reader + normalizer + executor + generation gate + REST/SSE/history/public-DTO projector` 必须出现在同一 B1 兼容基线，不能只保留 reader/executor 而回退 gate 或 projector。

**阶段二：切换生成版本**

- 先发布能正确展示 v1/v2、从 v2 UI 完全移除 createMealLog 并发送上述 capability header 的兼容前端；此时 generator 仍保持 v1；
- 只有确认所有可能承接 approval execute 的实例都完成阶段一、兼容前端验证通过后，才把 skill manifest、tool output、normalizer default、fixtures 和 eval 切到 v2；
- v2 generator 只响应声明 v2 capability 的 AI 请求；旧 bundle 请求 recipe-cook 时返回升级提示，不为它创建 v2 草稿；
- B2 多实例滚动期间，先升级的实例生成的 v2 必须能由尚未进入阶段二、但已具备阶段一能力的实例执行；
- 关闭 v2 生成或回滚 B2 时只把 generator 恢复为 v1；完整阶段一兼容下限不能随之回滚，已有 pending v2 继续可审批、拒绝或重试；
- 若无法保证所有实例已具备完整阶段一兼容下限，则不得启用 v2 generator。

阶段一和阶段二可以由显式 feature flag 分隔，也可以由两个顺序发布单元分隔；无论实现方式如何，不能只依赖负载均衡“通常会命中新实例”。

该 client gate 是必需的，因为当前旧版 AiApprovalPanel 会把缺失 `createMealLog` 的 recipe-cook draft 按 false 展示为“只扣库存不记录”，并允许用户改写该字段。Service Worker 更新率只能作为观测指标，不能代替服务端 contract gate。

### 16.7 client-aware generation 与 projection 边界

兼容前端在所有可能生成或投影 AI draft/approval 的请求中发送，包括 AI workspace、conversation list/visibility、message history、直接返回 `AIMessageDTO` 的 mutation、run resume 和 approval 请求：

```http
X-Culina-AI-Draft-Contracts: recipe_cook_operation.v1,recipe_cook_operation.v2
```

后端必须区分两种作用域，不能混用：

1. **generation capability**：从本次 chat/retry/regenerate/human-input resume/approval continuation 请求读取，写入本次 runtime state，只决定本次 generator 可以发布哪个 contract；
2. **viewer capability**：从当前读取、响应或 stream 订阅请求读取，只决定本次向这个客户端投影什么；共享会话中不能沿用最初生成者的 capability 判断另一位家庭成员的旧客户端。

所有可能首次生成或继续生成草稿的入口都必须解析并向 runtime 传播 generation capability，包括：

- `/api/ai/chat` 与 `/api/ai/chat/stream`；
- run retry；
- message part regenerate；
- human-input response 与 response stream；
- approval decision 与 decision stream 触发的 continuation；
- 后续新增的任何 orchestrator resume 入口。

所有可能把 draft/approval 传给客户端的出口都必须经过同一个 client-aware projector，不能在各 route 零散过滤：

- 普通 `AIChatResponse.message.parts`；
- `AIChatResponse.included.drafts` 与 `included.approvals`；
- chat/continuation SSE 的 progressive `message_part` 与最终 `response`；
- conversation message history 中持久化 `message.parts[].draft/approval_request` 的序列化；
- conversation list 与 visibility update 返回的 `AIConversationOut.context`，尤其是 runner 暂存的 `fastApprovalDecisions`；
- message history、recommendation-selection、inventory-operation-draft 及后续所有直接返回 `AIMessageDTO` 的 route 中，`metadata.artifacts[].payload.approval/draft` 的嵌套副本；
- pending approval list、approval detail/update/execute；
- decision 与 decision-stream 响应；
- retry、regenerate、human-input resume 的普通与流式响应；
- 任何包含 draft/approval 的 run event 或后续新增投影。

projection 规则固定为：

- canonical AITaskDraft、AIApprovalRequest、AIMessage.parts、AIMessage.message_metadata 和 AIConversation.context 在数据库中始终保存完整工作流状态，不因旧 viewer 改写、降级或补 `createMealLog`；
- 支持 v2 的 viewer 在允许公开的 draft/approval DTO 与 message artifact 位置获得完整 canonical v2 响应副本；public conversation context 不因此扩权；
- 不支持 v2 的 viewer 在 message/history/SSE 中把 v2 draft 或 approval part 投影为项目现有客户端可安全显示的纯文本/`error_recovery` 升级占位，part 内不得携带 draft、approval 或可提交 command；同时从 `included.drafts/approvals` 移除对应 v2 实体；
- `AIConversationOut.context` 使用显式 public-context allowlist；按当前前端真实依赖只投影 `activeRunId` 等已登记公开字段，内部 `fastApprovalDecisions` 对任何 viewer 都不序列化。不得把 ORM `context` 原样返回，也不得依靠针对任意 JSON 的递归删字段；
- `AIMessageDTO.metadata` 使用显式 metadata projector：支持 v2 的 viewer 可以获得 canonical v2 approval-decision artifact 响应副本；不支持 v2 的 viewer 从响应副本移除任何 `metadata.artifacts[].payload` 中携带 v2 approval/draft command 的 artifact，其他不含 command 的 metadata 保持原语义。所有直接返回 `AIMessageDTO` 的 route 必须复用同一 projector，不能只修 history；
- 当前 pending-list 响应模型只能返回 approval DTO，因此发现不兼容的 pending v2 时整个请求返回结构化 `409 client_contract_upgrade_required`，不得伪造一个旧 DTO 占位；
- approval detail/update/execute/decision/decision-stream 对不支持 v2 的客户端同样返回 `409 client_contract_upgrade_required`；
- decision/execute gate 必须在任何 approval 状态变化、AIOperation claim 或 stream 首事件之前执行；
- 不支持 v2 的客户端请求生成 recipe-cook 时在持久化 draft/approval 前返回升级提示，不创建 v2 草稿；
- projector 只做当前响应副本转换，不修改 ORM 实体、JSON 持久化值、approval hash 或 operation idempotency key。

projector 必须位于共享 serializer/response assembly 与 stream writer 边界；route 只能传入 viewer capability，不能自行决定删哪个字段。所有返回 `AIConversationOut` 或 `AIMessageDTO` 的现有与新增 route 都进入共享 serializer/projector contract test。这样普通响应、渐进 SSE、最终 SSE、conversation list/visibility、直接 message mutation 和历史恢复使用同一规则。

统一升级文案：

```text
当前应用版本不支持新的做菜确认，请刷新并更新后继续。原草稿仍会安全保留。
```

所有 client-aware 响应设置 `Cache-Control: private, no-store`，并对普通响应补 `Vary: X-Culina-AI-Draft-Contracts`；SSE 禁止中间缓存，重连时客户端必须再次发送 capability，防止支持 v2 的响应被共享缓存投影给旧客户端。

## 17. 全局入口映射

### 17.1 全局搜索

| entity_type | 目标 |
|---|---|
| ingredient | ingredients / detail |
| food | eat / food-detail |
| recipe | eat / recipe-target |
| meal_plan | eat / plan-detail，由 scoped ID query 解析 |

删除按手机或桌面选择 Recipe 目标的逻辑。

### 17.2 首页

| 首页入口 | 目标 |
|---|---|
| 推荐 Food 详情 | eat / food-detail |
| 推荐自做菜开始做 | eat / cook direct |
| 已有计划项 | eat / plan detail |
| 从计划开始做 | eat / cook plan |
| 查看记录 | eat / history |
| 完整记录一餐 | eat / meal-create |
| 自动记录后补充 | eat / meal-detail |

PR 72 新增的行动中心 target 必须逐项映射到语义目标，不继续暴露 TabKey。

### 17.3 Family

Family 中查看餐食或家庭记录的入口进入 eat/history。完整审计日志仍由 P0 第三点或家庭管理能力负责，不与 MealLog 混为一体。

### 17.4 AI

- Food card → food-detail；
- Recipe card → recipe-target；
- Meal plan card → plan detail；
- MealLog card → meal-detail；
- recipe cook success → response meal_log_id。

AI 组件不直接调用 setActiveTab。

## 18. Recipe 与 Food 关系异常

### 18.1 正常

Recipe 存在且唯一关联 selfMade Food：

```text
打开 Food detail
→ 展开做法
```

### 18.2 Recipe 不存在

显示：

```text
这份做法已经不存在
它可能已被家庭成员删除或更新。

[返回发现]
```

### 18.3 Recipe 存在但 Food 缺失

- 在 EatWorkspace 内显示只读 Recipe；
- 显示关系异常说明；
- 禁止开始做和加入菜单；
- 允许返回；
- 不在 GET 时调用 ensure_food_for_recipe 写数据库；
- 后续通过明确编辑保存或数据修复恢复关系。

### 18.4 多个 Food

数据库唯一约束正常情况下会阻止。如果异常数据存在：

- 客户端不任选；
- 禁止写操作；
- 显示关系异常；
- 交由后端修复。

## 19. Query scope 与数据新鲜度

### 19.1 Query scope model

导航状态派生：

```ts
type AppQueryScope = {
  needsMembers: boolean;
  needsIngredients: boolean;
  needsInventory: boolean;
  needsShopping: boolean;
  needsRecipes: boolean;
  needsRecipeInsights: boolean;
  needsFoodPlan: boolean;
  needsFoodPlanDetail: boolean;
  needsFoodScenes: boolean;
  needsFoods: boolean;
  needsFoodRecommendations: boolean;
  needsMealLogs: boolean;
  needsActivityLogs: boolean;
  needsAiConversations: boolean;
};
```

### 19.2 主要启用矩阵

| 目标 | 必要查询 |
|---|---|
| eat/discover | Foods、Recipes、Ingredients、Inventory、Recommendations、Scenes、MealLogs |
| eat/plan | FoodPlan、Foods、Recipes、MealLogs |
| plan-detail | FoodPlanDetail、Foods、Recipes、MealLogs |
| eat/history | MealLogs、Foods、Members、FoodPlan |
| food-detail | Foods、Recipes、MealLogs；selfMade 增加 Ingredients/Inventory |
| recipe task | Recipes、Foods、Ingredients、Inventory、MealLogs |
| direct cook | Recipes、Foods、Ingredients、Inventory |
| plan cook | Recipes、Foods、Ingredients、Inventory、FoodPlan |
| meal-create/detail | MealLogs、Foods、Members、FoodPlan |
| home | 现有首页查询 + PR 72 行动中心依赖 |
| ingredients | Ingredients、Inventory、Recipes、Shopping |
| ai | AI conversations；对象跳转后由目标工作区启用 |

### 19.3 数据解析

- nav state 只保存 ID；
- plan-detail 通过 ID query 解析，不要求目标在当前周 cache；
- entity 从 React Query cache 解析；
- mutation 后通过统一 cacheInvalidation 刷新；
- entity 正在加载时显示局部 skeleton；
- 查询成功但实体不存在时进入 not-found；
- 不复制一份长期本地实体对象。

### 19.4 Cook invalidation

现有 invalidateAfterRecipeCooked 已覆盖：

- inventory；
- inventory overview；
- recipe discovery；
- food recommendations；
- recipe stats；
- foods；
- meal logs；
- food plan；
- activity logs。

PR 72/73 合并后必须重新检查新增：

- 首页行动中心 query；
- inventory operation query；
- 采购或盘点相关 freshness；
- background task query。

Cook success 导航使用 response meal_log_id，不等待列表后猜测对象。

## 20. Loading、empty、error 状态

### 20.1 发现

- Foods 首次加载：卡片 skeleton；
- Recommendations 失败但 Foods 成功：保留 Food library，局部提示；
- Foods 为空：提供新增家常菜、外卖或成品；
- Recipes 失败：非 selfMade Food 继续可用，自做菜做法局部错误；
- Recipe relation 解析中：显示详情 resolver skeleton。

### 20.2 菜单

- FoodPlan 加载：周视图 skeleton；
- 为空：显示“这一周还没有安排”；
- 计划项已删除：关闭 detail 并提示；
- 跨周 plan-detail：先加载目标，再把周范围切到响应中的 plan_date；
- 计划项已 cooked：展示关联 MealLog；
- 计划项冲突：刷新最新版本，保留可恢复上下文。

### 20.3 吃过的

- MealLogs 加载：时间线 skeleton；
- 为空：显示“还没有记录过一餐”；
- 缺照片、评分、备注：正常记录，不显示 error/pending；
- MealLog 已删除：返回时间线并提示。

### 20.4 Cook

- Recipe/Food 不存在：禁止进入；
- preview 失败：保留 Cook Session并允许重试；
- 库存版本冲突：刷新 preview，不清空日期、餐次和反馈；
- completion mutation 失败：不关闭弹窗、不清理 session；
- 相同 completion request 安全重放：按成功处理，但不得再次展示第二次扣减或生成新的 MealLog；
- plan item stale/already completed：刷新计划详情，保留 Cook Session 并显示可恢复冲突；
- response 缺 meal_log_id：不显示成功；
- completion 成功：清理 session，并展示精确 MealLog 入口。
- 刷新后存在合法 active Cook descriptor：显示“继续做菜”；失效 descriptor 自动清理并说明原因。

## 21. “吃过的”记录有效性

### 21.1 完成判定

一条 MealLog 只要：

- 属于当前家庭；
- 有合法日期和餐次；
- 至少有一个有效 Food entry；

就已经是有效记录。

新写入还必须满足：

- Food entries 非空、无重复并全部属于当前家庭；
- participant IDs 全部属于当前家庭 active Membership，且对应 User `is_active=true`；
- 任一引用无效时整个事务失败，不创建空 MealLog。

以下不是完成必填：

- photo；
- rating；
- mood；
- notes；
- participant 扩展。

### 21.2 用户语言

使用：

- 吃过的；
- 查看这餐；
- 补充这餐；
- 添加照片；
- 记录家人反馈。

避免：

- 待处理；
- 未完成；
- 欠缺资料；
- 必须补充；
- 记录任务。

### 21.3 本期边界

本期只移除错误任务心智，不实现：

- 月度回顾；
- 家庭故事；
- 智能回忆；
- 照片时间轴重构；
- 完整 P1 记录产品升级。

## 22. 响应式与无障碍

### 22.1 同一业务状态，不同布局

- desktop 和 mobile 使用同一 navigation state；
- layout component 可不同；
- 不用媒体查询决定业务目标；
- 不把 mobile 视为 desktop 页面简单压缩。

### 22.2 最低交互要求

- 子导航使用 tab 语义；
- 当前项有文本或 aria 状态，不只依靠颜色；
- modal/drawer 保留 focus trap；
- task 关闭恢复焦点；
- success 使用 `aria-live="polite"`；
- inventory conflict、not-found、relation error 有图标或文字；
- mobile 操作区位于 safe area 之上；
- Cook Finish 不被底部导航遮挡；
- 375px 宽度下子导航不横向溢出。

### 22.3 视觉边界

本期遵循现有 Culina：

- 暖色；
- 照片驱动；
- 紧凑但不拥挤；
- 现有 card、drawer、modal、editor 和 Cook UI；
- 不新增通用 dashboard 模板或陌生视觉体系。

## 23. 安全与家庭数据边界

所有后端读取和写入必须约束：

- membership.family_id；
- 当前 user；
- Recipe.family_id；
- Food.family_id；
- FoodPlanItem.family_id 和 user_id；
- MealLog.family_id；
- participant user IDs 的当前家庭 active Membership 与 User active 状态。

普通 MealLog REST、quick-add、Cook completion、AI MealLog 和 AI recipe cook 必须调用共享引用校验与 Food 父行锁 helper，不允许仅在某一条新路径上修复。Recipe 删除的 REST/AI 路径，以及 FoodPlanItem 的 REST/AI 创建与 Food 改绑路径，必须调用共享 deletion guard/父锁协议，防止并发创建或改绑后再级联删除 MealLogFood、FoodPlanItem 或 RecipeCookLog。

不得：

- 通过前端传入 ID 绕过家庭边界；
- 在 relation fallback 时打开其他家庭 Food；
- 把未知 Recipe 绑定到任意同名 Food；
- 因自动记录而绕过 AI approval；
- 在库存、计划和 MealLog 之间产生部分提交。
- 用相同 completion request ID 执行不同 payload；
- 对已经 cooked 的 plan item 产生第二组完成副作用；
- 物理删除已经被餐食、计划或 CookLog 引用的 Recipe/Food。
- 在已锁定 FoodPlanItem 后再取得其当前或目标 Food 锁，或按 AI operation 输入顺序交替锁定 plan 与 Food；
- 跨 user/family namespace 读取或清理 Cook descriptor/session；
- 在任一 executor 尚不能读取 v2 时启用 AI v2 generator；
- 因旧客户端不支持 v2 而改写 canonical AI draft/approval，或让任一未经过 client-aware projector 的公共 DTO/REST/SSE/history payload 携带 v2 command，包括 `AIConversationOut.context` 与 `AIMessageDTO.metadata` 的嵌套副本。

跨家庭资源统一返回不可枚举的 404 或项目既有安全错误风格。

## 24. 分批实施与发布

### 24.1 PR A：统一信息架构

建议分支：

```text
feature/unified-eating-workspace
```

包含：

- navigation model；
- storage migration；
- query scope；
- AppShell 五入口；
- EatWorkspace；
- discover/plan/history；
- Recipe/Meal/plan-detail task；
- family/user scoped FoodPlanItem detail API 与 query；
- plan-origin meal-create source；
- Search/Home/Family/AI 导航；
- 旧顶层 Recipe/Logs 退出；
- MealLog 非任务化最小调整；
- frontend tests/build/smoke。

### 24.2 PR B1：完成烹饪后端兼容基础

建议分支：

```text
feature/cook-completion-contract
```

包含：

- RecipeCookLog additive migration；
- completion request claim/hash/replay；
- completion service；
- REST invariant；
- FoodPlanItem row lock、base updated-at 和 planned → cooked；
- 共享 MealLog Food/participant validator；
- Recipe/Food deletion guard、MealLog/FoodPlanItem 共享父实体行锁 helper、FoodPlanItem 创建/改绑的整批 `Food → FoodPlanItem` 锁协议，并把 Cook 纳入 PR 73 的 Ingredient → Food → State → Item → Shopping 全局锁序；
- deprecated create_meal_log 接受但忽略；
- legacy completion/base-version 有界兼容；
- response replay contract；
- AI 阶段一兼容能力：v1/v2 reader/normalizer/executor、v1 true 共享 completion、v1 false recoverable conflict；
- AI client contract gate、public conversation-context serializer、共享 REST/SSE/history/public-DTO projector 与 `client_contract_upgrade_required`，防止旧 AiApprovalPanel 从任一出口取得可编辑 v2；
- AI approval copy 更新，但 manifest/tool/default generator 继续只生成 v1；
- backend service/API/concurrency tests。

该 PR 必须可以在旧前端仍在线时先独立部署，并且在 B1-only 状态下不生成 v2。

### 24.3 PR B2：Cook 前端与 AI 语义切换

建议分支：

```text
feature/cook-completion-experience
```

包含：

- `CookLaunchContext` 与 direct/plan source；
- direct cook 不创建计划；
- FoodQuickMealDialog 日期、餐次和份量；
- Cook Finish UI；
- user/family scoped Cook Session v3、completion request ID 与 active descriptor；
- 兼容 payload 固定发送 `create_meal_log=true`；
- 新 payload 发送 completion ID 与 plan base updated-at；
- AiApprovalPanel 双版本显示兼容，并在 chat/stream/history/pending/retry/regenerate/resume/approval 全部调用发送 `X-Culina-AI-Draft-Contracts` capability；
- 在 B1 全量能力门通过后把 AI generator/manifest/tool contract 切到 v2；
- skill.yaml、generation schema、fixtures、registry 和 eval 同步；
- cache invalidation；
- frontend/AI/smoke 与 mixed-version tests。

P0 第四点只有 PR A、PR B1 与 PR B2 都完成才算落地。

### 24.4 PR C：兼容清理

建议分支：

```text
chore/unified-eating-legacy-cleanup
```

观察调用归零后删除：

- deprecated create_meal_log；
- recipe_plan_item_id；
- legacy completion request fallback；
- 缺少 plan base updated-at 的兼容分支；
- `/api/recipe-plan` 兼容端点；
- 已确认迁移完成的旧 navigation/Cook v1/v2 storage key；不得删除 scoped v3 或未知未来版本；
- Recipe plan client/type/test；
- 兼容 adapter；
- 证明无用的旧样式。

PR C 同时把 `completion_request_id` 设为完成请求必填，并把 `food_plan_item_base_updated_at` 设为 plan 来源条件必填。该清理 PR 不阻塞首发。

### 24.5 发布顺序

```text
PR 72/73 合并且绿色
→ PR A
→ 验证导航、搜索、缓存恢复和响应式
→ 合并并执行 PR B1 migration
→ 暂停 REST Recipe/Food 物理删除与 AI recipe.delete approval execute
→ 把 B1 后端发布到所有可承接 REST/approval execute 的实例，generator 保持 v1
→ 确认旧实例已排空，并验证 deletion guard、引用创建/改绑共同父锁，以及 Cook 未反转 PR 73 Ingredient → Food、计划批量写入未反转 Food → FoodPlanItem 后恢复删除能力
→ 验证旧前端 true/false、并发/回放、v1 true、v1 false conflict，并用测试夹具证明每个实例都具备完整 B1 下限，且所有公共 DTO/REST/SSE/history 出口都拒绝或安全投影无 capability 的 v2 客户端
→ 合并 PR B2，先发布可显示 v1/v2 且发送 capability 的兼容前端，generator 仍为 v1
→ 验证 Service Worker 更新和新前端 approval 行为；服务端 capability gate 始终保留
→ 再滚动发布/启用 v2 generator/manifest；混合实例期间由 B1 双读 executor 承接 v2
→ 验证 Cook、MealLog、Inventory、Plan、AI 与 active session 一致性
→ 兼容观察期
→ PR C
```

不得先发布停止发送 `create_meal_log` 的前端，也不得在仍可能回滚到旧后端时提前执行 PR C。

B1 的父锁协议不能在新旧实例混跑且删除入口仍开放时宣称生效：旧实例的 deletion/reference writer 不遵循新锁顺序。若部署平台不能同时暂停 REST 与 AI 删除，B1 后端必须使用排空旧实例的 blue/green 或维护窗口切换，不能用普通无门控滚动发布跨过该边界。

### 24.6 回滚

- 首个版本保留旧 storage key；
- 兼容字段与 endpoint 暂不删除；
- RecipeCookLog migration 只增加 nullable 列和唯一约束，应用回滚时保留，不执行破坏性 downgrade；
- 已创建 MealLog 是有效业务记录，回滚不删除；
- 旧后端可继续读取 nullable meal_log_id；
- B2 兼容前端固定发送 true，因此从纯 REST 传输角度回到旧后端仍会创建 MealLog；这不保留幂等/父锁/AI 双读，只能用于启用 v2 前的回滚或按下述门控执行的灾难恢复；
- v1 false AI 草稿不静默升级；
- v2 generator 可以回滚为 v1，但启用 v2 后的后端回滚下限是不可拆分的 `v1/v2 reader + normalizer + executor + generation gate + REST/SSE/history/public-DTO projector`；已有 pending v2 必须继续可审批、拒绝和重试；
- 存在 canonical v2 数据时若灾难性故障迫使后端跌破上述完整 B1 下限，必须关闭所有可能生成或投影 draft/approval 的 chat、stream、conversation list/visibility、message history、pending/detail/update/execute、retry/regenerate、human-input、resume 和 decision 入口，或在旧后端前保留仍具备 v2 generation gate/projector 的兼容 facade；只下线 recipe-cook approval execute 不足以保护旧客户端。operation 保持可恢复状态，不能永久标记 failed；
- 前端 UI 回退必须使用保留 scoped v3 storage、parser、completion payload builder、AI v1/v2 capability header 和 v2-safe AiApprovalPanel 的兼容回滚 build；不得直接部署会删除 v3 key 或把 v2 缺失字段解释为 false 的 raw 旧 artifact。若无法保留兼容前端，AI workspace 整体进入维护态，不能继续开放读取；
- user/family 切换和回滚只清理当前作用域，不能枚举删除其他作用域 session；
- 若 B1 回滚到不具备共同父锁协议的版本，Recipe/Food 物理删除和 AI recipe.delete 必须保持关闭，直到前滚恢复或完成等价数据保护；
- 回滚不恢复已经被证明错误的跨家庭或部分事务行为。

## 25. 测试设计

### 25.1 导航与迁移

覆盖：

- old foods → eat/discover；
- old recipes → eat/discover/selfMade；
- old logs → eat/history；
- unknown/corrupt → home；
- v2 restore；
- task 不持久化；
- active Cook descriptor 不自动恢复 task，但提供“继续做菜”；
- descriptor 的 direct/plan 过期、Recipe 删除和成功清理；
- descriptor 与 v3 session 按 user/family 隔离；同浏览器切用户、切家庭互不显示或清理；
- 同一作用域开始不同 Cook 时必须继续或显式放弃，不能静默覆盖 active descriptor；
- 两标签页竞态下，旧 session 成功/过期清理不能删除后来启动且 descriptor 不匹配的新 session；
- 当前作用域 404 只清理当前 key，不影响其他作用域；
- verified legacy v1/v2 → scoped v3 单向迁移；
- raw v2 parser 看不到也不能删除 v3 key，兼容回滚 build 保留 completion request ID；
- 未知未来 session version 保留、不误删；
- close task；
- base view 切换；
- direct/plan source；
- plan-detail 和 plan-origin meal-create task。

### 25.2 Query scope

矩阵覆盖：

- discover；
- plan；
- plan-detail by ID；
- history；
- food detail；
- recipe target；
- direct cook；
- plan cook；
- meal create/detail；
- home；
- ingredients；
- AI。

### 25.3 AppShell

覆盖：

- desktop 五入口；
- mobile 五入口；
- 名称和顺序相同；
- eat active state；
- 无 recipes/logs 一级项；
- keyboard/orientation 原有行为不退化。

### 25.4 全局搜索

覆盖：

- Food；
- Recipe；
- unloaded Foods；
- missing relation；
- Meal plan；
- 非当前周 Meal plan；
- 计划已移动或删除；
- desktop/mobile target 相同。

### 25.5 Home、Family、AI

覆盖：

- Home direct cook；
- Home direct cook 的非默认日期、餐次和份量完整进入 Session 与 request；
- Home plan cook；
- Home history；
- Family history；
- AI Recipe target；
- AI cook success MealLog target。

### 25.6 REST Cook

覆盖：

- 不传 flag 仍生成 MealLog；
- false 仍生成 MealLog；
- 兼容新前端固定 true；
- participant 默认当前 user；
- unknown/inactive Membership/inactive User/cross-family participant 拒绝；
- selfMade Food 关联；
- servings；
- CookLog/MealLog ID；
- direct 无 plan；
- plan cooked + meal_log_id；
- plan row lock + base updated-at；
- plan stale；
- plan already cooked；
- 跨家庭/跨用户 plan；
- Recipe mismatch；
- shortage blocked；
- partial completion；
- presence-only completion；
- PR 73 inventory conflict；
- 相同 completion request 顺序重放只产生一组副作用；
- response loss 后重放返回相同 MealLog/CookLog 和 `replayed=true`；
- result envelope v1 可重放；未知 envelope version 返回兼容错误且绝不重新执行库存/MealLog 副作用；
- 相同 request ID、不同 payload 返回 `idempotency_key_reused`；
- 两个并发相同 request ID 只有一个事务胜出；
- 两个不同 request ID 并发完成同一 plan 只有一个事务胜出；
- completion 与相同 Recipe 删除并发时，只有“完成提交、删除返回 history conflict”或“删除提交、完成返回 not-found/conflict”两种结果；
- Cook completion 与 PR 73 reconciliation、shopping intake、undo/history 分别使用两个真实连接并发，并让双方同时命中同一 Ingredient 与同一 Food；断言遵守 Ingredient → Food 顺序，无数据库死锁；
- 锁后 consumption target 集合变化时返回 `inventory_targets_changed`，不在持有 Food/Item 后反向补锁 Ingredient；
- 原子回滚；
- audit fields。

### 25.7 AI

覆盖：

- v2 always records；
- v2 approval copy；
- v2 schema 不包含 createMealLog；
- v1 true execute；
- v1 false conflict；
- B1-only 仍只生成 v1，但 reader/normalizer/executor 可执行 v2 fixture，generation gate 与所有 projector 同时有效；
- generation capability 在普通 chat、chat stream、retry、regenerate、human-input response/stream、approval continuation/stream 全链路传播；缺少 v2 capability 时不创建 v2；
- viewer capability 按当前请求而非 run 创建者判断；同一家庭共享会话由新客户端生成 v2 后，旧客户端读取仍只得到升级占位；
- 普通 AIChatResponse 的 `message.parts` 将不兼容 v2 part 投影为无 command 的升级占位，`included.drafts/approvals` 不含该 v2 实体；canonical DB 值保持不变；
- chat SSE progressive `message_part` 与最终 `response` 使用同一投影；旧客户端在任一时点都收不到 canonical v2；
- conversation message history、retry/regenerate/resume 返回、run event 中含 draft/approval 的 payload 使用同一投影；
- 新客户端完成 v2 approval 后，conversation list 与 visibility update 对新旧 viewer 都只返回 public-context allowlist，`context` 不含 `fastApprovalDecisions` 或其他内部 workflow payload，canonical conversation context 保持不变；
- 旧客户端读取 message history 时，`metadata.artifacts[].payload` 不含 canonical v2 approval/draft command；支持 v2 的 viewer 仍获得完整 artifact 响应副本，canonical message metadata 保持不变；
- history、recommendation-selection、inventory-operation-draft 以及所有直接返回 `AIMessageDTO` 的 route 通过同一 metadata projector contract test；
- pending list 遇到不兼容 v2、以及 detail/update/execute/decision/decision-stream，返回 `client_contract_upgrade_required`；
- 不兼容 decision/execute 在返回 409 后 approval 状态、operation 与副作用均未变化；
- client-aware 普通响应包含 private/no-store 与正确 Vary，SSE 禁止缓存且重连重新携带 capability；
- 支持 v2 capability 的客户端在允许公开的 draft/approval 与 message artifact 出口获得完整 canonical v2；conversation context 仍只返回 public allowlist；
- 兼容 AiApprovalPanel 对 v1 显示旧字段、对 v2 既不显示也不提交 createMealLog，并发送 capability header；
- 旧 AiApprovalPanel 不会收到会被解释为 `createMealLog=false` 的可编辑 v2 draft；
- B2 新实例生成 v2、B1 实例执行成功；
- v2 generator 回退为 v1 后，既有 pending v2 仍可审批/执行；
- 双读能力未全量时 v2 generator gate 不得开启；
- 模拟数据库已有 v2 且后端跌破完整 B1 下限时，所有可能生成或投影 draft/approval 的普通读取、mutation 与 stream 入口统一进入维护门；不能只关闭 execute 后继续开放 conversation/history/chat/pending；
- 无“只扣库存不记录”选择；
- family isolation；
- optimistic lock；
- AIOperation idempotency key 稳定映射 completion request ID；
- 当前 generator 的 manifest/tool schema/normalized default/new approval version 一致；
- 兼容 reader/normalizer/executor accepted set 为 `{v1, v2}`，且两版本分派符合 16.3；
- Skill evaluation。

### 25.8 MealLog

覆盖：

- 最小自动记录有效；
- empty/unknown/cross-family Food 拒绝；
- duplicate Food 拒绝；
- unknown/inactive Membership/inactive User/cross-family participant 拒绝；
- REST create/update、quick-add、Cook 和 AI 共用相同边界；
- 不进入 pending；
- 可选 enrichment；
- exact response ID；
- cache refresh；
- plan relation；
- 非 Recipe plan-origin create 锁行、stale、already-completed 与已有 meal_log_id 恢复；
- 两个不同请求并发完成同一非 Recipe plan item 时，只有一个事务创建 MealLog 并完成计划，另一个返回已有 `meal_log_id` 的结构化冲突。

### 25.9 删除生命周期与版本兼容

覆盖：

- 无引用 Recipe 仍可物理删除；
- MealLogFood 引用时 REST delete 返回 `recipe_has_history` 且历史保持；
- FoodPlanItem 引用时删除被阻止；
- RecipeCookLog 引用时删除被阻止且 completion replay 仍可读取；
- AI Recipe delete 使用同一 guard；
- 删除被阻止时媒体和搜索文档不发生部分删除；
- Recipe delete 与 Cook completion 使用两个真实连接并发，断言不会双方成功后历史消失；
- Recipe delete 与普通/AI MealLogFood create 使用两个真实连接并发，断言删除与引用创建只能有一方提交；
- Recipe delete 与 FoodPlanItem create 并发，断言计划不会被成功创建后再 cascade 清除；
- Recipe delete 与 REST FoodPlanItem 改绑到该 Recipe/Food 并发，以及 Recipe delete 与 AI plan 改绑并发，均使用两个真实连接，断言删除和改绑只有合法一方提交；
- Cook completion 与 AI plan 改绑同时命中同一 Food 和 FoodPlanItem，断言严格遵守 `Food → FoodPlanItem`、没有数据库死锁，且不会把已完成计划静默改绑；
- 两个 AI 批量计划更新以相反 operation 顺序提交相同的 Food/plan 集合，断言整批同类型 ID 稳定排序，不按模型输入顺序形成 `plan ↔ food` 锁环；
- 同类型多 ID 稳定排序；跨类型严格遵守可选 Recipe 前缀 + PR 73 全局顺序 + FoodPlanItem 后缀，不出现 `Food → Ingredient`、`InventoryItem → Food` 或 `FoodPlanItem → Food` 反向锁；
- B1 新旧实例混跑演练期间 REST delete 与 AI recipe.delete execute 均被门控；旧实例排空后才恢复；
- 旧前端 true/false → 新后端；
- 兼容新前端固定 true → 旧后端；
- 新前端 → 新后端；
- 新后端回滚为旧后端；
- pending v1 true、v1 false、v2 AI 草稿。

### 25.10 Smoke

关键路径：

```text
desktop: 发现 → 自做菜 → 做法 → 开始做 → 完成 → 查看这餐
mobile: 吃什么 → 发现/菜单/吃过的
plan: 加入菜单 → 从计划做 → cooked → MealLog
direct: 开始做 → 无新 plan → MealLog
direct-context: 明天/午餐/非默认份量 → 完成 → 同值 MealLog/CookLog
resume: Cook Mode 刷新 → 继续做菜 → 恢复步骤/计时器/完成请求 ID
search: Recipe → linked Food
plan-search: 非当前周计划 → plan-detail → 对应周
storage: foods/recipes/logs/unknown/corrupt → 无白屏
```

视口至少包含：

- 375 × 812；
- 390 × 844；
- 430 × 932；
- 768 × 1024；
- 1024 × 744 touch landscape；
- 1112 × 834；
- 1180 × 820；
- 常规 desktop。

### 25.11 计划执行命令

前端：

```bash
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
```

后端定向后全量：

```bash
cd backend
./.venv/bin/python -m pytest \
  tests/recipes/test_recipe_cooking.py \
  tests/recipes/test_food_workspace.py \
  tests/meal_logs/test_meal_logs.py \
  tests/ai_infra/test_workspace_approvals.py \
  tests/ai_infra/test_workspace_chat.py

cd ..
npm run backend:test
```

Migration 至少验证：

```bash
npm run backend:migrate
cd backend
./.venv/bin/alembic current
```

文档与代码一致性：

```bash
git diff --check
```

AI Skill Evaluation 使用合并后 CI 配置中的真实命令，不在本规格固定可能漂移的脚本名。

## 26. 验收标准

### 26.1 信息架构

- 桌面和手机只有首页、吃什么、食材、AI、家庭五个一级入口；
- 名称与顺序一致；
- Recipe 和 Logs 退出一级导航；
- 吃什么具有发现、菜单、吃过的；
- plan-detail 可以按 ID 打开非当前周目标；
- desktop/mobile 业务 target 不依赖 viewport。

### 26.2 概念边界

- Food 是发现、计划和记录对象；
- Recipe 是 selfMade Food 做法；
- FoodPlanItem 只由明确计划动作创建；
- MealLog 表示已经发生的一餐；
- 直接开始做不制造 plan；
- 从计划开始做复用 plan；
- Recipe/Food 有历史引用时不允许物理删除并破坏记录。

### 26.3 完成闭环

- 每个成功 REST Cook 有 meal_log_id 和 cook_log_id；
- 每个成功 AI Cook 有 MealLog；
- plan cook 的 plan item 指向同一 MealLog；
- direct cook 的用户确认日期、餐次和份量完整写入 MealLog/CookLog；
- inventory/plan/log/activity 原子提交；
- 相同 completion request 重放不重复扣减或创建记录；
- 不同请求不能重复完成同一 plan item；
- 删除与 completion/MealLog/plan 引用创建或 Food 改绑并发时不能双方成功后丢失历史；
- blocked/failed Cook 不产生部分记录；
- success 可以打开精确 MealLog；
- 空或跨家庭 Food/participant 不能进入 MealLog。

### 26.4 体验

- 完成弹窗无记录开关；
- FoodQuickMealDialog 可以核对日期、餐次和份量；
- 自动记录不强制进入复杂表单；
- 最小记录不显示为欠账；
- Recipe 关系异常不白屏；
- old storage 不白屏；
- Cook 刷新后有可发现的“继续做菜”入口；
- “继续做菜”与 Cook Session 按 user/family 隔离，兼容回滚不删除 v3 状态；
- 手机无底部遮挡或横向溢出；
- 现有 Culina UI 风格不被重设计。

### 26.5 回归

- PR 72 首页行动中心不退化；
- PR 73 库存并发和原子采购不退化；
- Cook 不反转 PR 73 的 Ingredient → Food 全局锁序，与 reconciliation/shopping intake/undo 并发无死锁；
- REST/AI FoodPlanItem 创建、改绑和批量 operations 始终先锁完整 Food 集，再锁完整 plan 集，与 Cook/删除并发无 `FoodPlanItem → Food` 反向锁；
- family isolation 不退化；
- Recipe 删除不会让既有 MealLog 变空；
- 旧/新前后端组合和回滚矩阵通过；
- AI v2 完整 B1 下限全量先于 generator，B1/B2 混合实例与灾难回滚门矩阵通过；
- 不支持 v2 的旧 AI 客户端在 chat、SSE、历史、conversation context、message metadata、pending 和 decision 任一出口都只能收到安全公开字段或升级提示，不能把 v2 当作“只扣库存不记录”编辑或提交；
- AI approval 不退化；
- frontend test/build/smoke 全绿；
- backend service/search/AI 全绿；
- AI Skill Evaluation Gate 全绿。

## 27. 风险与缓解

### 27.1 App.tsx 与相邻 PR 冲突

风险：PR 72、73、P0 第三点和本期都会修改 App/Home。

缓解：

- 等 72/73 合并；
- 确定 P0 第三点合并顺序；
- 先抽 navigation model；
- 小提交迁移调用方；
- 不按旧行号执行。

### 27.2 旧缓存白屏

缓解：

- v2 parser；
- 旧值显式映射；
- unknown fallback；
- smoke 注入旧值；
- 首发保留旧 key。

### 27.3 Recipe target 无关联 Food

缓解：

- 等待 query 完成后解析；
- not-found 与 relation-error 分离；
- 不在 GET 隐式写；
- 禁止不安全写操作；
- 记录异常并单独修复。

### 27.4 新旧 PWA 短期语义错位

风险：旧 bundle 仍展示 createMealLog 选择。

缓解：

- 字段兼容但服务端守住新 invariant；
- B1 后端先发布；
- B2 兼容前端删除选择但继续固定发送 true；
- mixed-version 与后端回滚测试；
- 验证 Service Worker 更新；
- 兼容期内不删除字段；
- PR C 前不停止发送字段；
- 成功结果始终可在 MealLog 中核验。

### 27.5 AI 旧草稿与滚动发布含义变化

风险：新实例生成 v2 后，approval execute 落到只识别 v1 的旧实例；或 B1-only 仍让 v1 false 走旧的只扣库存语义。

缓解：

- v2 schema；
- v1 true 可继续；
- v1 false 要求重新确认；
- v2 完全删除 createMealLog；
- B1 先让所有实例具备 v1/v2 reader/normalizer/executor、generation gate 和全部公共 DTO/REST/SSE/history projector，generator 仍只发 v1；
- B1 的统一 client contract gate 覆盖 conversation context、message metadata 等嵌套出口，阻止旧 AiApprovalPanel 读取、编辑或执行 v2；
- B2 先发布双版本兼容前端，再把 manifest、tool schema 与默认生成版本一起切到 v2；
- 不静默新增写入；
- 更新 approval copy 和 Skill eval；
- pending 或已解析 v2 存在时保留完整 B1 下限，generator 回退不影响既有草稿。

### 27.6 Query 过载

风险：一个 eat tab 可能粗暴加载所有旧工作区数据。

缓解：

- deriveAppQueryScope；
- task/subview 能力矩阵；
- React Query cache 复用；
- 局部 loading；
- 测试 query enabled 规则。

### 27.7 自动记录变成新欠账

缓解：

- 最小 MealLog 即有效；
- enrichment 可选；
- 移除 pending/task 文案；
- P1 完整记忆能力单独设计。

### 27.8 重复提交

风险：response loss、双设备或并发请求重复扣库存并生成多组 MealLog/CookLog。

缓解：

- Cook Session 持久化稳定 completion request ID；
- RecipeCookLog 家庭级唯一键和 request hash；
- claim 必须是事务第一项写入；
- 安全重放返回持久化原结果；
- plan item 使用 row lock、base updated-at 和 planned → cooked；
- pending/按钮禁用只作为体验层防抖，不作为服务端正确性保证。

### 27.9 Recipe 删除破坏历史

风险：当前 cascade/delete-orphan 会让 MealLog 失去 Food entry，并删除计划和 CookLog；只做“先查引用再删”还会留下 guard 查空与并发引用提交之间的 TOCTOU。

缓解：

- REST/AI 共用 deletion guard 和父实体行锁 helper；
- Recipe 作为可选前缀，之后严格复用 PR 73 的 `Ingredient → Food → State → Item → Shopping`，FoodPlanItem 作为最后后缀；删除和普通 MealLog 只取合法子序列；
- FoodPlanItem 创建/改绑先整批锁当前与目标 Food，再稳定排序锁 plan；AI 批量 operations 先收集完整集合，不能按输入顺序逐项交替锁；
- 任一历史引用存在时返回 `recipe_has_history`；并发创建或改绑先提交时删除也必须返回该冲突；
- guard 成功前不删除媒体、搜索文档或实体；
- 双连接并发测试证明不会双方成功后历史消失；
- Cook 与 reconciliation/shopping intake/undo 的双连接测试同时命中同一 Ingredient/Food，证明没有 `Food ↔ Ingredient` 锁环；
- B1 混合版本窗口暂停 REST/AI 物理删除，旧实例排空后再恢复；
- archive 另行设计，首发不以 cascade delete 模拟归档。

### 27.10 MealLog 跨家庭引用

风险：普通 REST create/update 或 AI/quick-add 分支写入其他家庭 Food/participant，造成数据污染或信息泄漏。

缓解：

- 共享 MealLog reference validator；
- Food 按 family 批量加载并在创建 entry 前稳定排序加锁；
- participant 同时按 active Membership 与 User `is_active` 验证；
- empty、duplicate、unknown、inactive User、cross-family 全部测试；
- 任一校验失败时在创建 MealLog 前终止。

### 27.11 Cook Session 可恢复性、作用域与降级

风险：刷新后 task 不恢复时用户找不到 session；全局 key 会让切账号/家庭误显示或误清理别人的 session；raw v2 回滚会把 v3 当非法值删除并丢失 completion request ID。

缓解：

- descriptor 与 session key 按 `user_id + family_id` 命名空间化，descriptor 只保存恢复定位 ID；
- eat/discover 显示“继续做菜”；
- 点击后重新解析实体；
- 删除、过期、完成只清理当前作用域；
- v3 使用独立 key，旧 v2 bundle 不可见且不能删除；
- UI 回退使用保留 v3 parser/payload 的兼容 rollback build；
- 未知未来版本保留而不是删除；
- 不扩大为跨设备 session 同步。

### 27.12 AI v2 公共 DTO 泄漏与不完整回滚

风险：即使 chat、SSE 和 approval 主响应已投影，`AIConversationOut.context.fastApprovalDecisions` 或 `AIMessageDTO.metadata.artifacts` 仍可能把完整 canonical v2 command 返回旧客户端；启用 v2 后若只保留 reader/executor、或跌破 B1 时只关闭 execute，旧后端仍可通过读取与流式出口把 v2 交给旧 AiApprovalPanel。

缓解：

- conversation context 使用只含已登记公开字段的 allowlist serializer，内部 fast decision 永不对外；
- message metadata 对嵌套 approval-decision artifact 使用显式 client projector，canonical JSON 不改写；
- 所有 `AIConversationOut`、`AIMessageDTO`、chat、SSE、history 和 approval 出口进入同一 contract test；
- 将 reader、normalizer、executor、generation gate 与全部 projector 定义为不可拆分的 B1 回滚下限；
- 跌破完整下限时关闭所有可能生成或投影 draft/approval 的 AI 入口，或保留兼容 facade；
- 前端回滚 build 保留 capability header 与 v2-safe ApprovalPanel，否则 AI workspace 整体维护。

## 28. 延后事项

以下事项明确延后：

- URL 深链接和浏览器历史；
- 历史 CookLog 回填 MealLog；
- MealLog 自动合并；
- Recipe/Food archive、历史快照与恢复站；
- RecipeOut 全局增加派生 food_id；
- 旧 recipe plan API 删除；
- P1 菜单弹性；
- P1 家庭回忆；
- 记录搜索；
- MealLog 与 Recipe feedback 的评分统一；
- 跨设备恢复未完成导航 task 或 Cook Session。

延后事项不能成为本期重新保留旧一级导航或旧完成语义的理由。

## 29. 最终设计判断

当前 Culina 的底层模型并不是主要问题。Food 已经覆盖家庭真实餐食类型，Recipe 已经稳定关联 selfMade Food，FoodPlanItem 已经迁移到 Food，MealLog 也已能承接实际餐食。

真正的问题是：

- 一级导航仍按技术模型暴露；
- 跨端导航不同；
- 直接开始做错误地制造计划；
- 完成烹饪仍可跳过记录；
- AI 与普通 UI 的完成语义不一致；
- 完成请求缺少可重放边界，计划可能被重复完成；
- Recipe 删除会级联破坏“吃过的”历史；
- MealLog 通用写入没有完整落实家庭引用校验。

本设计以一个统一“吃什么”工作区收敛用户语言，同时保留底层领域边界；再以服务端完成不变量把“开始做 → 库存变化 → 已经吃过”真正连接起来。

这比只改导航文案多，但不需要重写领域模型或新建聚合后端。本期只增加 RecipeCookLog 的 nullable 幂等字段和唯一约束，并以 deletion guard 保住现有历史；它是在当前代码真实能力之上完成信息架构、业务语义和最低可靠性边界的最后一公里。

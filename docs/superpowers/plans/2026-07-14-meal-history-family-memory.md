# Meal History and Family Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把“吃过的”建设成低维护的家庭餐食时间线：一顿饭可快速记录多道 Food、找不到 Food 时可按名称记下、错误可短时撤销，并用确定性家庭记忆持续回馈用户。

**Architecture:** 保留 `MealLog` 作为一顿饭、`MealLogFood` 作为餐内条目，新增 `row_version`、append-only `record_meal` 命令、entry-ID composition diff 和 effect-ID record operation；候选、撤销与洞察均由家庭隔离的后端事实接口提供。前端以共享纯 model、聚焦 state/action/data hooks、App 级普通 record 结果状态和独立桌面/移动视图承载完整 Composer、预填 Food 的紧凑记录、当前页面撤销 / 查看 / 评分、图片时间线与家庭记忆，Recipe cook、菜单完成与 AI approval 继续拥有自己的事务与审批边界。

**Tech Stack:** FastAPI、SQLAlchemy 2、Alembic、MySQL、Pydantic、pytest、React 18、TypeScript 5.7、React Query 5、Vitest、Vite、Playwright smoke、Culina media/date/ui-kit/CSS token 体系。

## Global Constraints

- 产品事实来源是 `docs/superpowers/specs/2026-07-14-meal-history-family-memory-design.md`，计划编写时 SHA-256 为 `f8db37c7e1b7a688fa5d3d549a34171a87f2f369a92331d0d479aeffe98287dc`；实现若需要改变已确认口径，先停止并更新规格，不在代码中自行改产品决定。
- 当前任务只生成计划；不得创建执行 worktree、修改产品代码、stage、commit 或 push。本计划和规格保持未提交，且不得触碰用户已修改的 `docs/ai-assistant-standards.md`、`docs/backend-code-standards.md`、`docs/frontend-code-standards.md`、`.agents/skills/frontend-ui-style/SKILL.md` 及其未跟踪 references。
- 实施必须先使用 `superpowers:using-git-worktrees`，从最新、干净、单一 Alembic head 的 `origin/main` 创建项目原生分支 `feature/meal-history-family-memory`；绝不直接在 `main` 开发或提交，也不使用 `codex/` 前缀。
- 计划编写时仓库基线是 `main@a0da7e74`，Alembic head 是 `4f5a6b7c8d9e`。执行时若任一基线已变化，先重新核对受影响文件、迁移 head、规格 hash 和前置功能，再更新计划；不得静默创建 migration fork。
- 保留 `MealLog` 与 `MealLogFood`，不新增 Meal 或持久化家庭记忆表，不给 `MealLogFood` 增加自由文本菜名，不强制同家庭同日同餐别只有一顿。
- “吃过什么”即完整记录；照片、评分、参与人、评论、备注和心情均为可选增强。界面不得出现“基础记录 / 已丰富 / 待补充 / 未评分欠账 / 来源 badge / 完成度”表达。
- 候选由 `GET /api/meal-logs/candidates?date=&meal_type=` 返回当前家庭的完整集合：0 条直接新建，1 条在 Composer 内自然语言确认，2 条以上才展开列表；后端不得按日期或时间窗口静默选择目标。
- 快速记录只使用 `POST /api/meal-logs/record`：新建 MealLog 或向明确目标追加新 entry，不编辑或删除既有 entry，不处理库存、计划、CookLog、媒体、评分、备注、心情或既有参与人；新建 MealLog 默认参与人为当前操作者。
- 历史纠错只使用 `PATCH /api/meal-logs/{meal_log_id}/composition`：完整 entry-ID diff、至少一道 Food、保留既有 entry ID、rating 和 `created_at`，不生成 record operation，不补偿库存、菜单或 CookLog。
- 最小 Food 只允许 `selfMade | takeout | diningOut | readyMade`，名称 trim 后 1..120 字符；`selfMade + recipe_id = null` 只能由专用领域 helper 创建，不生成 Recipe、不自动按同名合并、不显示待完善。
- 一次食用、未收藏、无库存且无来源的最小 Food 不进入首页推荐；distinct MealLog 次数达到 2，或被收藏、补库存、补来源后自动恢复资格，不新增持久化“minimal”状态。
- record 与最小 Food、MealLog、entry、operation、活动日志、Food 搜索同步 job 同一事务；相同 request ID + 相同 hash 只重放结果，相同 ID + 不同 hash 返回 `409 idempotency_key_reused`，已撤销 operation 不得重新应用。
- `meal_log_record_operations.meal_log_id` 非空且不设 FK；new target 在 claim 前用 `create_id("meal")` 预分配 ID，existing target 使用请求 ID。operation 分别保存 record `result_json` 与 nullable `revert_result_json`，不保存其他业务快照。15 分钟撤销只删除本 operation 创建且仍存在的 entry；MealLog 仅在最终为空时删除，家人后来新增的内容必须保留。
- 撤销最小 Food 仅在 `row_version == 1`、仍符合创建默认值、未被其他 MealLog、FoodPlanItem、ShoppingListItem、库存字段或媒体引用时删除；否则保留 Food，餐食撤销仍成功。
- `MealLog.row_version` 使用 SQLAlchemy `version_id_col`。任何 entry、评分、参与人、备注、心情或 MealLog media 变更都先校验 expected version，再恰好调用一次 `bump_meal_log_collection()`；不能依赖重复赋值 `updated_by` 触发父 UPDATE。
- REST 写入使用必填 `expected_row_version`。已持久化 AI `meal_log.v1` / `meal_log_operation.v1` 草稿保留 `baseUpdatedAt` 兼容：AI adapter 在行锁内校验时间戳后读取当前 row version，再调用共享写 helper。
- Recipe cook 与菜单完成可显式选择目标 MealLog，但继续拥有自己的 completion/plan transaction、库存和状态副作用；它们不创建普通 UI record operation，也不显示快速记录撤销。非 Recipe 菜单完成在已完成且目标一致 / 未显式指定目标的超时重试中返回现有 MealLog，显式不同目标才返回 409。
- 锁顺序固定为 command / operation claim（如有）→ Recipe（如有）→ sorted Food / inventory targets → target MealLog → FoodPlanItem。只能从 MealLog 发现 Food 时使用“无锁发现 → sorted Food lock → MealLog lock → target-set revalidate”；stale version 是取得全部所需锁后的第一项业务校验。record 与 composition 不锁库存或计划。
- 不新增 MealLog 全局或向量搜索实体。最小 Food 创建继续排队 Food upsert；撤销删除通过现有 Food search job worker 清除 SearchDocument/向量，不把 MealLog 加入 `SEARCH_INDEX_ENTITY_TYPES`。
- 家庭记忆实时、确定性、非持久化，业务时区固定 `Asia/Shanghai`；kind 只有 `frequent_recent | missed | repurchase | repeated_choice`，所有次数按 distinct MealLog，重复 entry 的评分先聚合到 meal level。
- 前端所有业务“今天”使用 `businessDateKey(now, 'Asia/Shanghai')`；洞察阈值只在后端计算，纯日期加减不得把 `YYYY-MM-DD` 当 UTC instant。
- React Query key 只写在 `frontend/src/api/queryKeys.ts`，失效只写在 `frontend/src/api/cacheInvalidation.ts`。record/撤销不得额外失效库存或计划；Recipe cook、菜单完成、AI approval 按各自真实副作用失效。
- 普通 record 成功写入 App 级共享结果状态，在当前 Home/Food/Ingredient/Eat/History surface 显示 `MealRecordResultBar`（已记下、撤销、查看记录、可选评分）；active operation query 在这些 surface 启用并恢复最近有效结果。Recipe cook、菜单完成和 AI approval 不得写入该状态。
- UI 实施前必须先使用项目 `frontend-ui-style`；涉及 Composer 状态流、冲突恢复、响应式和可访问性时同时使用 `frontend-ui-engineering`，并遵循 `docs/frontend-code-standards.md`。移动端使用独立 presentation，触控区至少 44px，处理底部导航和 safe area，单候选不得再开嵌套弹窗。
- 每个任务测试先行、只提交列出的路径、不顺手重构无关模块；每个任务完成后执行一次规格符合性 review 和一次实现质量 review，修复 P0/P1 后才进入下一任务。
- 阶段一和阶段二都必须可独立发布。阶段一失败时关闭新记录入口但不重新启用静默合并；阶段二失败时可隐藏 insights UI，不需要数据回滚。

---

## Execution Baseline Gate

本节只在未来实施时执行，不产生产品代码提交。任一硬门不满足都停止。

- [ ] **Gate 1: 使用 worktree skill 检查执行环境和用户现场**

先调用 `superpowers:using-git-worktrees`，然后执行：

```bash
git status --short --branch
git branch --show-current
GIT_DIR="$(cd "$(git rev-parse --git-dir)" && pwd -P)"
GIT_COMMON="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
printf '%s\n%s\n' "$GIT_DIR" "$GIT_COMMON"
```

Expected: 能明确当前是否已在 linked worktree；主工作区的未提交规格、计划和三份规范改动只记录、不编辑、不 stage。

- [ ] **Gate 2: 从最新 origin/main 创建隔离 worktree**

```bash
git fetch origin --prune
git worktree add /Users/zyf/IdeaProjects/Culina/.worktrees/meal-history-family-memory \
  -b feature/meal-history-family-memory origin/main
git -C /Users/zyf/IdeaProjects/Culina/.worktrees/meal-history-family-memory status --short --branch
```

Expected: 新 worktree 位于 `feature/meal-history-family-memory`，状态为空；若路径或分支已存在，先由 worktree skill 核实归属，不覆盖或复用不明工作。

- [ ] **Gate 3: 校验规格与迁移基线**

在执行 worktree 中读取主工作区未提交规格的绝对路径：

```bash
test "$(shasum -a 256 /Users/zyf/IdeaProjects/Culina/docs/superpowers/specs/2026-07-14-meal-history-family-memory-design.md | awk '{print $1}')" \
  = "f8db37c7e1b7a688fa5d3d549a34171a87f2f369a92331d0d479aeffe98287dc"
(cd backend && .venv/bin/alembic heads)
```

Expected: hash 匹配且 Alembic 只输出 `4f5a6b7c8d9e (head)`。任一不符都先刷新本计划，不自行改规格口径或 migration parent。

- [ ] **Gate 4: 建立执行基线测试证据**

```bash
(cd backend && .venv/bin/python -m pytest \
  tests/meal_logs/test_meal_logs.py \
  tests/recipes/test_food_queries.py \
  tests/recipes/test_recipe_cooking.py \
  tests/ai_infra/test_workspace_approvals.py -q)
npm --prefix frontend run test -- \
  src/features/meals/MealLogWorkspaceModel.test.ts \
  src/features/eat/EatTaskBodies.test.tsx \
  src/api/cacheInvalidation.test.ts
npm --prefix frontend run build
```

Expected: 全部 PASS。基线失败先记录原始错误并判断是否需在前置修复中解决，不把无关修复混入本功能提交。

## Delivery Phases and Dependency Order

```text
Execution gate
  ↓
Phase 1 — 记录减负
  1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16
  ↓
Phase 2 — 家庭记忆回报
  17 → 18
  ↓
Final release gate
  19
```

- Tasks 1–8 建立后端唯一写入语义；Task 9 才冻结前端跨端 contract。
- Tasks 10–16 分别完成共享记录 UI、Home、Food/Ingredient、Recipe/Eat 与后端回归迁移；只有 Task 16 证明所有真实 caller 已迁移后才删除旧 `/api/meal-logs/quick-add`，不允许新旧自动归组规则进入同一发布版本。
- Task 16 是阶段一发布门。Task 18 是阶段二发布门。Task 19 只做完整验收、回滚演练和交付证据。

## File Responsibility Map

### Create: backend

- `backend/alembic/versions/5a6b7c8d9e0f_add_meal_record_operations.py` — `MealLog.row_version`、两个查询索引和 record operation 表；parent 固定为执行门确认的 `4f5a6b7c8d9e`。
- `backend/app/schemas/meal_recording.py` — candidates、record、active operation、revert 的唯一 HTTP contract。
- `backend/app/repos/meal_log_candidates.py` — 当前家庭、日期、餐别的完整候选与媒体批量读取。
- `backend/app/repos/meal_log_record_operations.py` — family-scoped idempotency claim、active list 和 operation row lock。
- `backend/app/services/meal_log_versions.py` — MealLog expected-version、完整 stale current 序列化、discover/sorted-Food/MealLog/revalidate 锁序和父版本推进。
- `backend/app/services/meal_log_writes.py` — 无副作用的 MealLog/MealLogFood create/append primitives。
- `backend/app/services/meal_log_foods.py` — 最小 Food 创建、默认分类、推荐资格和可安全删除判断。
- `backend/app/services/meal_recording.py` — canonical hash、idempotent record、最小 Food 与 append-only transaction orchestration。
- `backend/app/services/meal_log_record_history.py` — active operation projection 和 effect-ID 撤销。
- `backend/app/services/meal_log_composition.py` — entry-ID full diff、评分保留和冲突语义。
- `backend/app/services/food_plan_completion.py` — 非 Recipe 菜单完成自己的目标 MealLog transaction。
- `backend/app/api/meal_log_recording.py` — candidates/record/operation/revert HTTP 边界。
- `backend/app/repos/meal_log_insights.py` — family-scoped MealLog/Food occurrence facts。
- `backend/app/services/meal_log_insights.py` — 四类规则、两级评分、去重与稳定排序。
- `backend/app/schemas/meal_log_insights.py` — insight fact/evidence/media response。
- `backend/app/api/meal_log_insights.py` — 独立只读 insight endpoint。
- `backend/tests/meal_logs/test_meal_log_models.py` — migration-facing model、index、row-version contract。
- `backend/tests/meal_logs/test_meal_log_candidates.py` — authoritative candidate family/date/type/media coverage。
- `backend/tests/meal_logs/test_meal_recording.py` — inline Food、atomic record、replay、conflict、rollback。
- `backend/tests/meal_logs/test_meal_record_revert.py` — 15-minute effect-ID undo、权限、保留后来内容。
- `backend/tests/meal_logs/test_meal_composition.py` — entry-ID diff、父版本、三方恢复所需 409 payload。
- `backend/tests/meal_logs/test_meal_log_insights.py` — 四类规则、日期边界、重复 entry 与隔离。
- `backend/tests/meal_logs/test_meal_log_mysql_concurrency.py` — 真 MySQL 并发 new-target claim、record-vs-revert、created-Food reuse-vs-revert 与 row-version barrier。

### Modify: backend

- `backend/app/core/enums.py`、`backend/app/models/domain.py` — record enums、operation ORM、MealLog version/indexes。
- `backend/app/schemas/meal_logs.py`、`backend/app/services/serializers.py` — `row_version`、expected version、composition contract。
- `backend/app/api/meal_logs.py` — details/rating/composition 路由薄化并最终删除 legacy quick-add。
- `backend/app/api/router.py` — include recording 与 insight routers。
- `backend/app/services/search/jobs.py` — Food 删除 job 复用 `search/indexing.py` 的既有清理 helper，不增加 MealLog scope。
- `backend/app/api/foods.py`、`backend/tests/recipes/test_food_queries.py` — minimal Food recommendation eligibility。
- `backend/app/schemas/recipes.py`、`backend/app/api/recipe_meta.py`、`backend/app/services/food_plan_locking.py` — 菜单完成目标 contract。
- `backend/app/services/recipe_cook_completion.py`、`backend/app/api/recipes.py`、`backend/tests/recipes/test_recipe_cooking.py` — cook target、hash、replay 与锁顺序。
- `backend/tests/recipes/test_food_workspace.py`、`backend/tests/recipes/test_food_stock_operations.py` — legacy quick-add 后端回归迁移，拆开普通 record 与独立库存命令。
- `backend/app/services/ai_operations/meal_logs.py`、`backend/app/services/ai_operations/recipe_cook.py`、`backend/tests/ai_infra/test_workspace_approvals.py` — `baseUpdatedAt` 兼容和共享 parent bump。
- `backend/app/ai/images/jobs.py`、`backend/tests/media/test_ai_image_job_api.py` — 后台生成图真正绑定 MealLog 时锁定并推进父版本。
- `backend/app/ai/tools/catalog/meal_log.py` — read DTO 暴露 `rowVersion`，不新增写 tool。

### Create: frontend

- `frontend/src/api/mealLogsApi.ts`、`frontend/src/api/mealLogsApi.test.ts` — MealLog transport 与参数编码。
- `frontend/src/features/meals/MealComposerModel.ts`、`MealComposerModel.test.ts` — selected Food union、候选默认、record payload、图片优先级、business date。
- `frontend/src/features/meals/useMealComposerState.ts`、`useMealComposerState.test.tsx` — full/compact draft、稳定 request ID、候选 choice、inline Food。
- `frontend/src/features/meals/useMealCandidateData.ts`、`useMealCandidateData.test.tsx` — Composer、菜单和 Recipe cook 共享的 authoritative candidate query。
- `frontend/src/features/meals/useMealComposerData.ts` — Food search 并组合共享 candidate data。
- `frontend/src/features/meals/useMealComposerActions.ts`、`useMealComposerActions.test.tsx` — record replay、target 409、result publish 与 query invalidation。
- `frontend/src/features/meals/MealComposer.tsx`、`MealComposer.test.tsx` — 首页完整多 Food Composer。
- `frontend/src/features/meals/MealQuickRecordView.tsx`、`MealQuickRecordView.test.tsx` — Food 卡预填紧凑记录。
- `frontend/src/features/meals/MealCandidateSelector.tsx` — 0/1/multi 同一滚动区 presentation。
- `frontend/src/features/meals/MealFoodCombobox.tsx` — 搜索、多选、按名称记下和四类型选择。
- `frontend/src/features/meals/MealCompositionModel.ts`、`MealCompositionModel.test.ts` — base/draft/server entry-ID 三方合并。
- `frontend/src/features/meals/MealCompositionEditor.tsx`、`MealCompositionEditor.test.tsx` — 历史组合编辑与冲突确认。
- `frontend/src/features/meals/MealInlineRating.tsx`、`MealInlineRating.test.tsx` — 可忽略的逐菜评分。
- `frontend/src/features/meals/useMealRecordResultState.ts`、`useMealRecordResultState.test.tsx` — App 级最近普通 record 结果、active-operation 恢复、revert/rating/navigation 状态。
- `frontend/src/features/meals/MealRecordResultBar.tsx`、`MealRecordResultBar.test.tsx` — 当前 surface 可复用的“已记下 / 撤销 / 查看记录 / 可选评分”结果条。
- `frontend/src/features/meals/MealMemoryStrip.tsx`、`MealMemoryStrip.test.tsx` — 四类图片家庭记忆与 evidence copy。
- `frontend/src/styles/13-meal-composer.css` — `.meal-composer-*` full/compact/candidate/result-bar/inline-rating 响应式样式。

### Modify: frontend

- `frontend/src/api/types.ts`、`client.ts`、`queryKeys.ts`、`queryKeys.test.ts`、`cacheInvalidation.ts`、`cacheInvalidation.test.ts` — 跨端类型、集中 key 与副作用精确失效。
- `frontend/src/api/foodsApi.ts`、`foodsApi.test.ts` — 移出 legacy MealLog transport。
- `frontend/src/api/recipesApi.ts` — Recipe cook target fields 继续使用既有 endpoint。
- `frontend/src/app/useAppWorkspaceQueries.ts`、`useAppWorkspaceQueries.test.tsx` — active operations 在所有普通 record surface 启用，insights 仍只在 history view 启用。
- `frontend/src/app/useAppMutations.ts`、`frontend/src/App.tsx` — 组合新 mutations、挂载共享 result state/bar、最终移除 quick-add wiring、统一 `Asia/Shanghai`。
- `frontend/src/features/home/HomeDashboard.tsx`、`HomeDashboard.test.tsx`、`useHomeDashboardActions.ts`、`useHomeDashboardActions.test.ts` — 首页推荐 record 与非 Recipe 菜单完成迁移。
- `frontend/src/components/foods/FoodQuickMealDialog.tsx`、`FoodWorkspace.tsx`、`FoodWorkspace.test.ts`、`useFoodWorkspaceState.ts` — 预填 compact record、删除库存扣减表单与旧 quick-add action。
- `frontend/src/components/foods/useFoodPlanState.ts`、`useFoodPlanState.test.tsx` — Food 工作区非 Recipe 菜单完成使用 owner command 与安全重放 contract。
- `frontend/src/components/ingredients/IngredientWorkspace.tsx`、`IngredientWorkspaceUsage.test.ts` — 食材 / 成品库存页普通 record 与库存动作拆分，接入共享结果条。
- `frontend/src/components/recipes/RecipeWorkspaceModel.ts`、`RecipeWorkspace.test.ts`、`useRecipeCookState.ts`、`useRecipeCookState.test.tsx`、`RecipeCookFinishDialog.tsx` — cook target payload、候选确认与提交状态流。
- `frontend/src/features/eat/EatTaskBodies.tsx`、`EatTaskBodies.test.tsx` — Eat surface 的 Food record、菜单完成与 Recipe cook 显式 target。
- `frontend/src/features/meals/MealLogWorkspace.tsx`、`MealLogMobileView.tsx`、`MealHistorySurface.tsx`、`MealLogWorkspaceModel.ts`、相关 tests — “吃过的”、照片时间线、详情、Composer、inline rating、undo、insights。
- `frontend/src/features/meals/MealLogEnrichment.tsx`、`MealEnrichmentModal.tsx`、`MealLogEnrichmentModel.ts`、`useMealEnrichmentState.ts` — 主动编辑语义和 expected row version。
- `frontend/src/styles.css`、`frontend/src/styles/08-meal-log.css`、`07-mobile.css`、`12-eat-workspace.css` — 图片比例、44px、安全区和页面密度。
- `frontend/scripts/smoke.mjs` — 375/390/430/desktop 记录、候选、撤销、图片与记忆 acceptance。

---

## Phase 1 — Recording Burden Reduction

### Task 1: Persist MealLog Version and Record Operation Effects

**Files:**

- Create: `backend/alembic/versions/5a6b7c8d9e0f_add_meal_record_operations.py`
- Modify: `backend/app/core/enums.py`
- Modify: `backend/app/models/domain.py`
- Create: `backend/tests/meal_logs/test_meal_log_models.py`

**Interfaces:**

- Consumes: `AuditMixin`, `MealLog`, `MealLogFood`, `utcnow()` and current Alembic head `4f5a6b7c8d9e`.
- Produces: `MealLogRecordStatus.APPLIED|REVERTED`; `MealLogRecordTargetKind.NEW|EXISTING`; `MealLog.row_version: int`; `MealLogRecordOperation`; indexes `ix_meal_logs_family_date_type_created` and `ix_meal_log_foods_log_food`.

- [ ] **Step 1: Write failing ORM contract tests**

```python
def test_meal_log_has_integer_version_and_operation_effect_ids(db, family, user):
    meal = MealLog(
        id="meal-versioned",
        family_id=family.id,
        date=date(2026, 7, 15),
        meal_type=MealType.DINNER,
        participant_user_ids=[user.id],
        notes="",
        mood="",
        created_by=user.id,
        updated_by=user.id,
    )
    operation = MealLogRecordOperation(
        id="meal-record-op-1",
        family_id=family.id,
        client_request_id="request-1",
        request_hash="a" * 64,
        status=MealLogRecordStatus.APPLIED,
        target_kind=MealLogRecordTargetKind.NEW,
        meal_log_id=meal.id,
        created_entry_ids_json=["meal-food-1"],
        created_food_ids_json=["food-new-1"],
        result_json={"outcome": "created"},
        revert_result_json=None,
        created_by=user.id,
        applied_at=utcnow(),
        revertible_until=utcnow() + timedelta(minutes=15),
    )
    db.add_all([meal, operation])
    db.commit()
    assert meal.row_version == 1
    assert operation.created_entry_ids_json == ["meal-food-1"]
    assert operation.created_food_ids_json == ["food-new-1"]
    assert operation.meal_log_id == "meal-versioned"
    assert operation.revert_result_json is None
```

同时在该文件断言同一 `(family_id, client_request_id)` 不能重复、`meal_log_id` 为数据库 `NOT NULL` 且在删除 MealLog 后仍保留普通字符串、`revert_result_json` 可空、两个复合索引存在；尝试插入 `meal_log_id=None` 必须失败。

- [ ] **Step 2: Run the model test and verify the schema is absent**

Run:

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_log_models.py -q)
```

Expected: import/attribute failure because enums, operation model and `MealLog.row_version` do not exist.

- [ ] **Step 3: Add enums and ORM fields with exact storage rules**

```python
class MealLogRecordStatus(str, Enum):
    APPLIED = "applied"
    REVERTED = "reverted"


class MealLogRecordTargetKind(str, Enum):
    NEW = "new"
    EXISTING = "existing"
```

Add `row_version = mapped_column(Integer, nullable=False, default=1, server_default="1")` and `__mapper_args__ = {"version_id_col": row_version}` to `MealLog`. Add `MealLogRecordOperation` with the exact fields from the approved spec: non-FK `meal_log_id: String(64), nullable=False`, JSON list defaults, non-null record `result_json`, nullable `revert_result_json`, unique `(family_id, client_request_id)`, and indexes for active/actor reads.

- [ ] **Step 4: Add the additive reversible migration**

The migration must use:

```python
revision = "5a6b7c8d9e0f"
down_revision = "4f5a6b7c8d9e"
```

`upgrade()` adds `meal_logs.row_version` with server default `1`, creates both read indexes, and creates `meal_log_record_operations` with non-null `meal_log_id` and nullable `revert_result_json`; `downgrade()` drops operation indexes/table, the two read indexes and `row_version` in reverse order. Do not alter historical migrations or add a FK from operation to MealLog.

- [ ] **Step 5: Verify model and migration metadata**

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_log_models.py -q)
(cd backend && .venv/bin/alembic heads)
```

Expected: tests PASS and one head `5a6b7c8d9e0f (head)`.

- [ ] **Step 6: Commit the persistence boundary**

```bash
git add backend/alembic/versions/5a6b7c8d9e0f_add_meal_record_operations.py \
  backend/app/core/enums.py backend/app/models/domain.py \
  backend/tests/meal_logs/test_meal_log_models.py
git commit -m "feat: add meal record operation persistence"
```

### Task 2: Make Every MealLog Detail Write Versioned

**Files:**

- Create: `backend/app/services/meal_log_versions.py`
- Create: `backend/app/services/meal_log_writes.py`
- Modify: `backend/app/schemas/meal_logs.py`
- Modify: `backend/app/services/serializers.py`
- Modify: `backend/app/api/meal_logs.py`
- Modify: `backend/app/ai/images/jobs.py`
- Modify: `backend/tests/meal_logs/test_meal_logs.py`
- Modify: `backend/tests/media/test_ai_image_job_api.py`

**Interfaces:**

- Produces `MealLogConflictError(code, message, current, recovery_hint)`; `LockedMealLogWriteTargets {meal_log, foods_by_id, discovered_food_ids}`; `lock_meal_log_write_targets(db, *, family_id: str, meal_log_id: str, additional_food_ids: Sequence[str] = ()) -> LockedMealLogWriteTargets`; `require_meal_log_version(meal_log: MealLog, expected_row_version: int) -> None`; `bump_meal_log_collection(meal_log: MealLog, *, user_id: str) -> None`; `build_meal_log_conflict_detail(db, *, family_id: str, meal_log_id: str, code: str, recovery_hint: str) -> dict`; `create_meal_log_with_entries(...) -> tuple[MealLog, list[MealLogFood]]`; `append_meal_log_entries(...) -> list[MealLogFood]`.
- `MealLogOut.row_version` and `UpdateMealLogRequest.expected_row_version` are required cross-end fields.

- [ ] **Step 1: Add failing version and serialization tests**

```python
def test_rating_only_update_bumps_parent_version_once(client, seeded_meal):
    response = client.patch(
        f"/api/meal-logs/{seeded_meal.id}",
        json={
            "expected_row_version": 1,
            "food_entry_ratings": [{"id": seeded_meal.entry_id, "rating": 4.5}],
        },
    )
    assert response.status_code == 200
    assert response.json()["row_version"] == 2


def test_stale_detail_update_returns_current_meal_and_hint(client, seeded_meal):
    response = client.patch(
        f"/api/meal-logs/{seeded_meal.id}",
        json={"expected_row_version": 1, "notes": "过期草稿"},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "meal_log_stale"
    assert response.json()["detail"]["current"]["row_version"] == 2
    assert response.json()["detail"]["current"]["food_entries"][0]["rating"] == 4.5
    assert response.json()["detail"]["current"]["photos"][0]["id"] == "meal-photo-current"
    assert response.json()["detail"]["recovery_hint"] == "refresh_and_review"
```

再覆盖参与人、备注、心情、media-only、连续同一用户评分均只 bump 一次；无 version 的 REST update 返回 422。主动 expected-version mismatch 与提交 flush 触发的 `StaleDataError` 都必须返回完整 current（entries/Food、rating、deduction suggestions、photos、row_version）。后台 AI 图片 job 真正把生成图绑定到 MealLog 时也必须从 1 推进到 2；bind skipped/unbound 不得推进。

- [ ] **Step 2: Run focused tests and confirm current writes are unversioned**

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_logs.py -q)
```

Expected: new assertions fail because response lacks `row_version` and request does not require `expected_row_version`.

- [ ] **Step 3: Implement the shared version boundary**

```python
class MealLogConflictError(ValueError):
    def __init__(self, code: str, message: str, *, current: dict | None = None, recovery_hint: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.current = current
        self.recovery_hint = recovery_hint


def require_meal_log_version(meal_log: MealLog, expected_row_version: int) -> None:
    if int(meal_log.row_version) != int(expected_row_version):
        raise MealLogConflictError(
            "meal_log_stale",
            "这顿饭刚被家人更新，请刷新后确认",
            recovery_hint="refresh_and_review",
        )


def bump_meal_log_collection(meal_log: MealLog, *, user_id: str) -> None:
    meal_log.row_version += 1
    meal_log.updated_by = user_id
```

`lock_meal_log_write_targets()` 必须先无锁读取当前 entry Food IDs，与 `additional_food_ids` 合并去重，再按 Food ID 排序 `FOR UPDATE`，之后才对 family-scoped MealLog `FOR UPDATE` 并加载 entries/Food/deduction suggestions；若锁后 entry Food 集合与发现集合不一致，抛出稳定 `meal_log_targets_changed`，不得在持有 MealLog 锁时补锁 Food。取得全部锁后，expected row version 是第一项业务校验。

`build_meal_log_conflict_detail()` 重新加载完整 MealLog 和 MealLog media map，再调用 `serialize_meal_log()`；`StaleDataError` handler 必须先 `db.rollback()` 再调用它。主动版本不匹配也复用同一 builder，不允许 route 手拼 `current`。

- [ ] **Step 4: Extract entry create/append primitives and update REST details**

`MealEntryWrite` is an immutable dataclass with `food_id: str`, `servings: Decimal`, `note: str`, `rating: Decimal | None`. `append_meal_log_entries()` only creates `MealLogFood` rows and never commits, logs activity, mutates inventory, changes participants or bumps the parent; its caller owns exactly one bump. Update REST details/rating and `_bind_generated_asset_to_target` to use discover → sorted Food lock → MealLog lock → target-set revalidation → version check → apply → one bump → log/commit. A successful async MealLog bind must not overwrite any MealLog field; skipped/unbound paths take no MealLog locks and do not bump.

- [ ] **Step 5: Verify contract and stale behavior**

```bash
(cd backend && .venv/bin/python -m pytest \
  tests/meal_logs/test_meal_logs.py tests/media/test_ai_image_job_api.py -q)
```

Expected: PASS, including complete stale current, media-only, same-user repeated rating updates and the Food-before-MealLog lock-order regression.

- [ ] **Step 6: Commit the versioned write boundary**

```bash
git add backend/app/services/meal_log_versions.py backend/app/services/meal_log_writes.py \
  backend/app/schemas/meal_logs.py backend/app/services/serializers.py \
  backend/app/api/meal_logs.py backend/app/ai/images/jobs.py \
  backend/tests/meal_logs/test_meal_logs.py backend/tests/media/test_ai_image_job_api.py
git commit -m "feat: add meal log optimistic concurrency"
```

### Task 3: Add the Authoritative Candidate Read API

**Files:**

- Create: `backend/app/repos/meal_log_candidates.py`
- Create: `backend/app/schemas/meal_recording.py`
- Create: `backend/app/api/meal_log_recording.py`
- Modify: `backend/app/api/router.py`
- Create: `backend/tests/meal_logs/test_meal_log_candidates.py`

**Interfaces:**

- Produces `MealLogCandidateFoodOut`, `MealLogCandidateOut`, `list_meal_log_candidates(db, family_id, meal_date, meal_type) -> list[MealLog]`, and `GET /api/meal-logs/candidates`.
- Candidate DTO fields are `meal_log_id`, `row_version`, `date`, `meal_type`, `created_at`, `foods[] {food_id,name,food_type,cover}`, `preview_media` and `photo_count`.

- [ ] **Step 1: Write candidate family/date/type/media tests**

```python
def test_candidates_return_every_matching_family_meal_in_stable_order(client, seed_candidates):
    response = client.get("/api/meal-logs/candidates?date=2026-07-15&meal_type=dinner")
    assert response.status_code == 200
    payload = response.json()
    assert [item["meal_log_id"] for item in payload] == ["meal-newer", "meal-older"]
    assert payload[0]["foods"][0]["name"] == "番茄炒蛋"
    assert payload[0]["preview_media"]["id"] == "meal-photo"
    assert payload[1]["preview_media"]["id"] == "food-cover"
```

再断言其他家庭、其他日期、其他餐别不返回；同一时间戳以 MealLog ID 升序打破平局；没有媒体返回 `preview_media=null`。

- [ ] **Step 2: Run focused test and confirm route is missing**

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_log_candidates.py -q)
```

Expected: FAIL with 404 or missing schema/repo imports.

- [ ] **Step 3: Implement one family-scoped candidate query and batched media fallback**

```python
def list_meal_log_candidates(
    db: Session,
    *,
    family_id: str,
    meal_date: date,
    meal_type: MealType,
) -> list[MealLog]:
    return list(db.scalars(
        select(MealLog)
        .where(
            MealLog.family_id == family_id,
            MealLog.date == meal_date,
            MealLog.meal_type == meal_type,
        )
        .options(selectinload(MealLog.food_entries).selectinload(MealLogFood.food))
        .order_by(MealLog.created_at.desc(), MealLog.id.asc())
    ))
```

Load MealLog media and all candidate Food media in two batched calls. Select `preview_media` as MealLog first photo, then first entry Food cover, else null; never copy media URLs into MealLogFood.

- [ ] **Step 4: Expose the GET endpoint through the new router**

The route accepts required `date` and `meal_type`, gets `membership.family_id`, returns all candidates, and performs no target selection or mutation.

- [ ] **Step 5: Verify candidate authority and isolation**

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_log_candidates.py -q)
```

Expected: PASS.

- [ ] **Step 6: Commit the candidate boundary**

```bash
git add backend/app/repos/meal_log_candidates.py backend/app/schemas/meal_recording.py \
  backend/app/api/meal_log_recording.py backend/app/api/router.py \
  backend/tests/meal_logs/test_meal_log_candidates.py
git commit -m "feat: add authoritative meal candidates"
```

### Task 4: Create Minimal Food Safely and Filter One-Use Recommendations

**Files:**

- Create: `backend/app/services/meal_log_foods.py`
- Modify: `backend/app/api/foods.py`
- Modify: `backend/app/services/search/jobs.py`
- Modify: `backend/tests/recipes/test_food_queries.py`
- Modify: `backend/tests/search/test_search_index_jobs.py`

**Interfaces:**

- Produces `create_minimal_meal_food(db, family_id, user_id, name, food_type) -> Food`; `is_food_recommendation_eligible(food, distinct_meal_count) -> bool`; `can_delete_record_created_food(db, food) -> bool`.
- `enqueue_search_index_job(... entity_type="food")` becomes a Food synchronization job: existing Food upserts; missing Food deletes its SearchDocument/vector and succeeds with `vector_status="skipped"`.

- [ ] **Step 1: Add failing domain and recommendation tests**

```python
def test_minimal_self_made_food_has_no_recipe_or_completion_debt(db, family, user):
    food = create_minimal_meal_food(
        db,
        family_id=family.id,
        user_id=user.id,
        name="  酸汤牛肉  ",
        food_type=FoodType.SELF_MADE,
    )
    assert food.name == "酸汤牛肉"
    assert food.type == "selfMade"
    assert food.category == "家常菜"
    assert food.recipe_id is None
    assert food.favorite is False
    assert food.stock_quantity is None


def test_one_use_minimal_food_is_excluded_until_a_qualification_signal(client, minimal_food):
    first = client.get("/api/foods/recommendations?now=2026-07-15T18:00:00&limit=12")
    assert minimal_food.id not in [item["food"]["id"] for item in first.json()["items"]]
    add_second_distinct_meal(minimal_food.id)
    second = client.get("/api/foods/recommendations?now=2026-07-16T18:00:00&limit=12")
    assert minimal_food.id in [item["food"]["id"] for item in second.json()["items"]]
```

Parameterize the second assertion for favorite, positive stock, external source, and self-made `recipe_id`; verify same-meal duplicate history counts once.

- [ ] **Step 2: Run focused tests and verify current general Food rules are insufficient**

```bash
(cd backend && .venv/bin/python -m pytest \
  tests/recipes/test_food_queries.py tests/search/test_search_index_jobs.py -q)
```

Expected: new tests fail because ordinary Food create rejects self-made, recommendations include all Foods, and a queued missing Food currently fails.

- [ ] **Step 3: Add the dedicated minimal Food helper without weakening ordinary Food create**

```python
QUICK_RECORD_FOOD_TYPES = {
    FoodType.SELF_MADE,
    FoodType.TAKEOUT,
    FoodType.DINING_OUT,
    FoodType.READY_MADE,
}

MINIMAL_FOOD_CATEGORIES = {
    FoodType.SELF_MADE: "家常菜",
    FoodType.TAKEOUT: "外卖",
    FoodType.DINING_OUT: "外食",
    FoodType.READY_MADE: "即食",
}
```

The helper validates the enum/name, creates only current-family server-owned defaults, flushes, and enqueues one Food search job. Keep `_reject_synced_food_payload()` unchanged for normal `POST /api/foods`.

- [ ] **Step 4: Filter recommendations from derived current facts**

Build a distinct MealLog count map from already-loaded `meal_logs`. Eligibility is true when count >= 2, favorite is true, positive stock exists, `recipe_id` exists, or `source_name/purchase_source` is non-empty. Otherwise exclude before scoring/diversification; do not persist a flag.

- [ ] **Step 5: Make a missing Food search job delete stale search artifacts**

When a queued `entity_type == "food"` job finds no current-family Food, call:

```python
delete_search_document(
    db,
    family_id=job.family_id,
    entity_type="food",
    entity_id=job.entity_id,
    delete_vector=True,
)
```

Return no document, skip embedding, and mark the job succeeded. Other missing entity types keep their current failure behavior; `SEARCH_INDEX_ENTITY_TYPES` remains unchanged.

- [ ] **Step 6: Verify minimal Food, recommendation and search cleanup behavior**

```bash
(cd backend && .venv/bin/python -m pytest \
  tests/recipes/test_food_queries.py tests/search/test_search_index_jobs.py \
  tests/search/test_vector_cleanup.py -q)
```

Expected: PASS.

- [ ] **Step 7: Commit the minimal Food boundary**

```bash
git add backend/app/services/meal_log_foods.py backend/app/api/foods.py \
  backend/app/services/search/jobs.py \
  backend/tests/recipes/test_food_queries.py backend/tests/search/test_search_index_jobs.py
git commit -m "feat: add minimal meal foods"
```

### Task 5: Implement Atomic Idempotent `record_meal`

**Files:**

- Modify: `backend/app/schemas/meal_recording.py`
- Create: `backend/app/repos/meal_log_record_operations.py`
- Create: `backend/app/services/meal_recording.py`
- Modify: `backend/app/api/meal_log_recording.py`
- Create: `backend/tests/meal_logs/test_meal_recording.py`
- Create: `backend/tests/meal_logs/test_meal_log_mysql_concurrency.py`

**Interfaces:**

- Produces discriminated `RecordMealTargetNew` / `RecordMealTargetExisting`; `RecordMealNewFoodIn`; `RecordMealEntryIn`; `RecordMealRequest`; `RecordMealResponse`; `record_meal(db, family_id, actor_user_id, request, now) -> RecordMealResponse`.
- `POST /api/meal-logs/record` always returns 200 with `outcome: created | appended | replayed`.

- [ ] **Step 1: Write request-validation and atomic behavior tests**

```python
def test_record_creates_two_food_entries_and_inline_food_atomically(client, food):
    response = client.post("/api/meal-logs/record", json={
        "client_request_id": "record-1",
        "date": "2026-07-15",
        "meal_type": "dinner",
        "target": {"kind": "new"},
        "new_foods": [{"client_food_id": "local-1", "name": "酸汤牛肉", "type": "selfMade"}],
        "entries": [
            {"food_id": food.id, "servings": 1},
            {"client_food_id": "local-1", "servings": 2},
        ],
    })
    assert response.status_code == 200
    body = response.json()
    assert body["outcome"] == "created"
    assert len(body["meal_log"]["food_entries"]) == 2
    assert body["meal_log"]["participant_user_ids"] == ["user-owner"]
    assert body["created_foods"][0]["recipe_id"] is None
    assert body["operation"]["can_revert"] is True
    operation = load_operation(db, body["operation"]["id"])
    assert operation.meal_log_id == body["meal_log"]["id"]
```

Add tests for exactly-one reference per entry, duplicate client IDs, unknown client reference, disallowed type, trimmed/overlong name, duplicate final Food, cross-family Food/target, target date/type mismatch, stale target, rollback after inline Food creation, every committed operation having non-null `meal_log_id`, no inventory/plan/CookLog writes, and no media/notes/rating fields accepted (`extra="forbid"`).

- [ ] **Step 2: Add replay and request-key conflict tests**

```python
def test_same_request_and_hash_replays_without_new_side_effects(client, record_payload, db):
    first = client.post("/api/meal-logs/record", json=record_payload)
    second = client.post("/api/meal-logs/record", json=record_payload)
    assert first.status_code == second.status_code == 200
    assert second.json()["outcome"] == "replayed"
    assert count_rows(db, MealLog) == 1
    assert count_rows(db, MealLogFood) == 2
    assert count_rows(db, MealLogRecordOperation) == 1
    assert count_meal_create_activities(db) == 1
```

Same request ID with changed servings must return `409 detail.code == "idempotency_key_reused"`; replaying the original record after its operation was reverted must return `409 detail.code == "record_operation_reverted"` and create no new rows.

Add a real-MySQL barrier test for two concurrent new-target requests with the same client request ID. Assert one operation row, one MealLog row, `operation.meal_log_id == meal_log.id`, both successful responses expose the winner ID, and the loser does not leave its independently preallocated ID in any table.

- [ ] **Step 3: Run focused tests and verify the command is absent**

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_recording.py -q)
```

Expected: FAIL with missing schemas/service/route.

- [ ] **Step 4: Define strict discriminated Pydantic contracts**

Use `ConfigDict(extra="forbid")`; `entries` and `new_foods` normalize names/IDs before the model validator checks uniqueness and references. Existing target requires both `meal_log_id` and `expected_row_version >= 1`; new target accepts neither.

- [ ] **Step 5: Implement the claim-first canonical command**

Canonical hash is SHA-256 of normalized `date`, `meal_type`, target (including expected version), ordered new Foods and ordered entries, excluding `client_request_id`. The service flow is:

```python
request_hash = canonical_record_request_hash(request)
allocated_meal_log_id = (
    request.target.meal_log_id
    if request.target.kind == "existing"
    else create_id("meal")
)
operation, created = claim_record_operation(
    db,
    family_id=family_id,
    actor_user_id=actor_user_id,
    client_request_id=request.client_request_id,
    request_hash=request_hash,
    target_kind=request.target.kind,
    meal_log_id=allocated_meal_log_id,
    now=now,
)
if not created:
    return replay_record_operation(operation, now=now)
```

`claim_record_operation()` inserts and flushes the non-null MealLog ID before any business side effect. If the unique key loses, rollback the failed claim transaction, reload the winner by `(family_id, client_request_id)`, compare hash/status and replay the winner's saved ID/result; never continue with the loser's allocated ID.

On first write with an existing target, pass request-existing Food IDs to Task 2 `lock_meal_log_write_targets()` before taking any Food lock; it discovers target entry Foods, locks the sorted union once, locks/revalidates MealLog, then validates version/date/type. Only after those locks may the transaction create inline minimal Foods and resolve final IDs; reject any final Food already present. For a new target, lock all request-existing Food IDs once in sorted order, create inline minimal Foods, then call `create_meal_log_with_entries(..., meal_log_id=operation.meal_log_id)` so the business row reuses the preallocated ID. Append path bumps once. Store created IDs and a JSON-safe response, log one activity/highlight, flush, and let the route commit once. Never pre-lock a request Food and later discover a lower-sorted target Food.

- [ ] **Step 6: Map structured domain errors in the route**

Map missing family resources to 404, schema/reference errors to 422, stale target and idempotency conflicts to 409 with stable codes/current target/recovery hint, `StaleDataError` to the same structured stale contract. Always rollback before returning errors.

- [ ] **Step 7: Verify focused and real-MySQL concurrency behavior**

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_recording.py -q)
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_log_mysql_concurrency.py -q)
```

Expected: focused suite PASS; MySQL test PASS when test DB is configured, otherwise marked with the repository's explicit integration skip reason. Two concurrent identical new-target requests converge on one non-null winner MealLog ID, one operation and one effect set.

- [ ] **Step 8: Commit the record command**

```bash
git add backend/app/schemas/meal_recording.py backend/app/repos/meal_log_record_operations.py \
  backend/app/services/meal_recording.py backend/app/api/meal_log_recording.py \
  backend/tests/meal_logs/test_meal_recording.py \
  backend/tests/meal_logs/test_meal_log_mysql_concurrency.py
git commit -m "feat: add idempotent meal recording"
```

### Task 6: Add 15-Minute Effect-ID Undo

**Files:**

- Create: `backend/app/services/meal_log_record_history.py`
- Modify: `backend/app/repos/meal_log_record_operations.py`
- Modify: `backend/app/schemas/meal_recording.py`
- Modify: `backend/app/api/meal_log_recording.py`
- Create: `backend/tests/meal_logs/test_meal_record_revert.py`
- Modify: `backend/tests/meal_logs/test_meal_log_mysql_concurrency.py`

**Interfaces:**

- Produces `list_active_record_operations(...) -> list[MealLogRecordOperationSummaryOut]`; `revert_record_operation(...) -> RevertMealRecordResponse`; GET active and POST revert routes.
- Stable error codes: `record_operation_not_found`, `record_operation_forbidden`, `record_operation_expired`, `record_operation_reverted`.

- [ ] **Step 1: Write effect-scoped undo tests**

```python
def test_revert_append_removes_only_operation_entries(client, appended_operation, db):
    later_entry = add_family_entry(appended_operation.meal_log_id, "food-later")
    response = client.post(f"/api/meal-logs/record-operations/{appended_operation.id}/revert")
    assert response.status_code == 200
    assert response.json()["status"] == "reverted"
    remaining = load_entry_ids(db, appended_operation.meal_log_id)
    assert remaining == {"entry-before", later_entry.id}
    assert response.json()["meal_log"]["row_version"] == 3
```

Cover new-empty MealLog deletion, new MealLog with later family entry preservation, original actor/Owner permission, Member denial, cross-family 404, exact 15-minute boundary, expired response, missing effect IDs, and no inventory/plan/CookLog changes. For repeated revert, save the first response, then modify the retained MealLog and a retained/created Food before retrying; assert no second mutation/activity and exact stored `meal_log` / `removed_food_ids` replay with only `replayed` changed to `true`.

- [ ] **Step 2: Write minimal Food retention/deletion and lock-order tests**

Assert unchanged/unreferenced Food is deleted and enqueues one Food cleanup job; edited, favorited, stocked, media-bound, planned, shopped or reused Food is retained while revert still returns 200.

In `test_meal_log_mysql_concurrency.py`, add two real-MySQL barrier scenarios: (1) one transaction records/appends while another reverts an operation touching the same Food/MealLog; (2) one transaction reuses a just-created minimal Food while another reverts its creating operation. Assert both transactions terminate, MealLog/entry references remain valid, and a Food reused by the winning record is never deleted.

- [ ] **Step 3: Run focused tests and confirm undo endpoints are absent**

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_record_revert.py -q)
```

Expected: FAIL with missing service/routes.

- [ ] **Step 4: Implement active-operation projection**

GET `active=true` returns only the current actor's `APPLIED` operations whose deadline is not before server `now`, newest first, with operation ID, MealLog ID, Food names/media summary, deadline and computed `can_revert`; it never exposes internal created entry IDs.

- [ ] **Step 5: Implement idempotent effect-ID revert with the global lock order**

Lock operation by family, authorize actor or Owner and compare aware timestamps. If already reverted, return `revert_result_json` without loading current MealLog/Food and set only `replayed=true`.

For a first revert, pre-read effect entry Food IDs without row locks, union them with `created_food_ids_json`, lock all Food rows by sorted ID, then lock the MealLog and revalidate effect entry ownership/target set. Delete only matching effect entries. If entries remain, bump once; if empty, unbind MealLog media and delete MealLog. On already-locked created Foods, recheck `row_version == 1`, creation defaults and every MealLog/plan/inventory/shopping/media reference before delete; never check-and-delete an unlocked Food. Enqueue Food cleanup before deletion. Build the complete response, persist it to `revert_result_json`, mark reverted, store actor/time, add one REVERT activity, and never delete the original activity.

- [ ] **Step 6: Verify undo, permissions and active refresh contract**

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_record_revert.py -q)
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_log_mysql_concurrency.py -q)
```

Expected: focused suite PASS; MySQL record-vs-revert and reuse-vs-revert tests PASS when configured, otherwise use the explicit integration skip reason.

- [ ] **Step 7: Commit effect-scoped undo**

```bash
git add backend/app/services/meal_log_record_history.py \
  backend/app/repos/meal_log_record_operations.py backend/app/schemas/meal_recording.py \
  backend/app/api/meal_log_recording.py backend/tests/meal_logs/test_meal_record_revert.py \
  backend/tests/meal_logs/test_meal_log_mysql_concurrency.py
git commit -m "feat: add scoped meal record undo"
```

### Task 7: Add Entry-ID Composition Correction

**Files:**

- Create: `backend/app/services/meal_log_composition.py`
- Modify: `backend/app/schemas/meal_logs.py`
- Modify: `backend/app/api/meal_logs.py`
- Create: `backend/tests/meal_logs/test_meal_composition.py`

**Interfaces:**

- Produces `MealCompositionEntryIn {id?: str, food_id, servings, note}`; `UpdateMealCompositionRequest {expected_row_version, food_entries}`; `update_meal_composition(...) -> MealLog`.
- Endpoint: `PATCH /api/meal-logs/{meal_log_id}/composition`.

- [ ] **Step 1: Write preservation, validation and conflict tests**

```python
def test_composition_diff_preserves_existing_identity_rating_and_created_at(client, seeded_meal):
    before = seeded_meal.entry("entry-keep")
    response = client.patch(f"/api/meal-logs/{seeded_meal.id}/composition", json={
        "expected_row_version": 1,
        "food_entries": [
            {"id": "entry-keep", "food_id": before.food_id, "servings": 2, "note": "多吃一点"},
            {"food_id": "food-new", "servings": 1, "note": ""},
        ],
    })
    assert response.status_code == 200
    kept = next(item for item in response.json()["food_entries"] if item["id"] == "entry-keep")
    assert kept["rating"] == 4.5
    assert load_entry_created_at("entry-keep") == before.created_at
    assert response.json()["row_version"] == 2
```

Cover stale version checked as the first business validation after all required locks, empty final list, foreign entry ID, cross-family Food, changed food_id on existing entry, duplicate final Food, invalid servings, delete/add/update, no stock/plan compensation, and target-set changes between discovery and MealLog lock returning `meal_log_targets_changed` without taking reverse locks.

- [ ] **Step 2: Run focused test and confirm composition endpoint is absent**

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_composition.py -q)
```

Expected: FAIL with 404 or missing schema/service.

- [ ] **Step 3: Implement discover-Food-lock-MealLog-revalidate-version-diff-bump in that order**

Pre-read current entry Food IDs, union with request Food IDs, then call Task 2 `lock_meal_log_write_targets()` so sorted Food locks precede the MealLog lock and target-set revalidation. Check expected version immediately after locks. Build maps by stable entry ID. Existing request items may update only servings/note; their `food_id` must match. Omitted existing IDs are deleted; items without ID create new entries. Validate all final Food IDs after version check, flush the diff, call `bump_meal_log_collection()` once, and add one “调整了餐食内容” activity. Do not delete all children and rebuild.

- [ ] **Step 4: Return structured current state on conflict**

Use Task 2 `build_meal_log_conflict_detail()` for proactive stale and rollback-then-reload `StaleDataError`, so frontend always receives full Food entries, ratings, deduction suggestions, photos and row version in `detail.current`; no route branch may inspect English exception text or hand-build a reduced payload.

- [ ] **Step 5: Verify composition semantics**

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_composition.py -q)
```

Expected: PASS.

- [ ] **Step 6: Commit composition correction**

```bash
git add backend/app/services/meal_log_composition.py backend/app/schemas/meal_logs.py \
  backend/app/api/meal_logs.py backend/tests/meal_logs/test_meal_composition.py
git commit -m "feat: add meal composition correction"
```

### Task 8: Align Menu Completion, Recipe Cook and AI Writers

**Files:**

- Create: `backend/app/services/food_plan_completion.py`
- Modify: `backend/app/schemas/recipes.py`
- Modify: `backend/app/api/recipe_meta.py`
- Modify: `backend/app/services/food_plan_locking.py`
- Modify: `backend/app/services/recipe_cook_completion.py`
- Modify: `backend/app/api/recipes.py`
- Modify: `backend/app/services/ai_operations/meal_logs.py`
- Modify: `backend/app/services/ai_operations/recipe_cook.py`
- Modify: `backend/app/ai/tools/catalog/meal_log.py`
- Modify: `backend/tests/recipes/test_recipe_cooking.py`
- Modify: `backend/tests/ai_infra/test_workspace_approvals.py`
- Modify: `backend/tests/meal_logs/test_meal_logs.py`

**Interfaces:**

- Produces `CompleteFoodPlanItemRequest {food_plan_item_base_updated_at, target_meal_log_id?, expected_meal_log_row_version?}` and `POST /api/food-plan/{item_id}/complete -> MealLogOut`.
- Extends `CookRecipeRequest` and `RecipeCookCompletionCommand` with `target_meal_log_id` / `expected_meal_log_row_version`; both enter canonical hash and saved replay result.
- AI MealLog update/rating uses Task 2 Food-before-MealLog helper and then performs legacy timestamp validation; AI create remains approval-owned and creates no record operation.

- [ ] **Step 1: Write menu and cook target tests**

```python
def test_recipe_cook_appends_to_explicit_target_and_replay_does_not_append_twice(client, recipe, target):
    payload = cook_payload(
        completion_request_id="cook-target-1",
        target_meal_log_id=target.id,
        expected_meal_log_row_version=1,
    )
    first = client.post(f"/api/recipes/{recipe.id}/cook", json=payload)
    second = client.post(f"/api/recipes/{recipe.id}/cook", json=payload)
    assert first.status_code == second.status_code == 200
    assert second.json()["replayed"] is True
    assert count_entries(target.id) == 2
```

Add menu completion new/explicit target, target date/type/family/version mismatch, lock order regression, target fields in cook hash, old cook draft without target creates new MealLog, and no record operation for menu/cook.

Add a lost-response convergence test for non-Recipe plan completion: commit once, discard the first HTTP response, retry the original stale base. With no explicit target or the same explicit target, return the current stored MealLog and create no second MealLog/entry/activity; a different explicit target returns `409 food_plan_item_already_completed`. Assert completed replay is checked before base timestamp staleness.

- [ ] **Step 2: Write AI compatibility and parent-bump tests**

Persist an old `baseUpdatedAt` meal draft, approve update_details and rate_food, assert success and `row_version + 1`; stale timestamp remains a conflict. Add a lock-order regression proving AI details/rating discovers and locks sorted Foods before MealLog, then revalidates the entry target set. AI create with optional stock/plan keeps its current one-transaction semantics and creates no ordinary record operation.

- [ ] **Step 3: Run focused integration tests and confirm missing target contracts**

```bash
(cd backend && .venv/bin/python -m pytest \
  tests/recipes/test_recipe_cooking.py \
  tests/ai_infra/test_workspace_approvals.py \
  tests/meal_logs/test_meal_logs.py -q)
```

Expected: new tests fail because plan/cook target fields and AI parent bumps are absent.

- [ ] **Step 4: Implement plan completion as its own command**

For a non-Recipe plan item, pre-read current Food and any stored/requested MealLog ID, lock Food → discovered/requested target MealLog → plan item, then revalidate the discovered IDs. After locks, test completed replay before base timestamp staleness: cooked + stored MealLog returns that current MealLog when target is absent or equal; a different explicit target is 409. Only an uncompleted item validates base timestamp/status/date/type and creates/appends via `meal_log_writes`, marks plan cooked and sets `meal_log_id`, logs plan/meal activity, and commits once in route. Do not call `record_meal()`, do not create another completion table, and do not create a record operation.

- [ ] **Step 5: Extend Recipe cook canonical identity and target append**

Add both target fields to command canonicalization before hashing. Claim completion identity, then follow Recipe → sorted Food/inventory → optional MealLog → plan item; revalidate discovered targets after all locks and check MealLog version first. Append one entry and bump once before completing the plan item. Existing no-target behavior creates a new MealLog. Replay returns stored result before any append.

- [ ] **Step 6: Adapt AI writers without changing draft schemas**

`update_details` and `rate_food` keep `baseUpdatedAt` compatibility but use Task 2 discover → sorted Food lock → MealLog lock → target-set revalidation before timestamp/version validation, then call shared field/rating helper and exactly one bump. AI create reuses `create_meal_log_with_entries()` but retains stock/media/plan side effects in its approval transaction and follows the same optional resource lock order. Tool read output adds `rowVersion`; no new write tool is registered.

- [ ] **Step 7: Verify all non-record paths and old drafts**

```bash
(cd backend && .venv/bin/python -m pytest \
  tests/recipes/test_recipe_cooking.py \
  tests/ai_infra/test_workspace_approvals.py \
  tests/ai_infra/test_workspace_phase_flows.py \
  tests/meal_logs/test_meal_logs.py -q)
```

Expected: PASS.

- [ ] **Step 8: Commit compatibility adapters**

```bash
git add backend/app/services/food_plan_completion.py backend/app/schemas/recipes.py \
  backend/app/api/recipe_meta.py backend/app/services/food_plan_locking.py \
  backend/app/services/recipe_cook_completion.py backend/app/api/recipes.py \
  backend/app/services/ai_operations/meal_logs.py \
  backend/app/services/ai_operations/recipe_cook.py \
  backend/app/ai/tools/catalog/meal_log.py \
  backend/tests/recipes/test_recipe_cooking.py \
  backend/tests/ai_infra/test_workspace_approvals.py \
  backend/tests/meal_logs/test_meal_logs.py
git commit -m "feat: align meal writer transactions"
```

### Task 9: Freeze Frontend Meal API, Query and Invalidation Contracts

**Files:**

- Create: `frontend/src/api/mealLogsApi.ts`
- Create: `frontend/src/api/mealLogsApi.test.ts`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/api/foodsApi.ts`
- Modify: `frontend/src/api/queryKeys.ts`
- Modify: `frontend/src/api/queryKeys.test.ts`
- Modify: `frontend/src/api/cacheInvalidation.ts`
- Modify: `frontend/src/api/cacheInvalidation.test.ts`
- Modify: `frontend/src/app/useAppWorkspaceQueries.ts`
- Modify: `frontend/src/app/useAppWorkspaceQueries.test.tsx`

**Interfaces:**

- Produces TS types matching all Task 2–8 schemas and API methods `getMealCandidates`, `recordMeal`, `updateMealComposition`, `getActiveMealRecordOperations`, `revertMealRecordOperation`, `getMealInsights`, `completeFoodPlanItem`.
- Query keys: `mealLogs`, `mealCandidatesRoot`, `mealCandidates(date, mealType)`, `mealRecordOperations(active)`, `mealInsights`.

- [ ] **Step 1: Write transport and exact invalidation tests**

```typescript
it('encodes authoritative candidate query parameters', async () => {
  mockRequest.mockResolvedValueOnce([]);
  await mealLogsApi.getMealCandidates('2026-07-15', 'dinner');
  expect(mockRequest).toHaveBeenCalledWith(
    '/api/meal-logs/candidates?date=2026-07-15&meal_type=dinner',
  );
});

it('record invalidation excludes inventory and food plan', async () => {
  await invalidateAfterMealRecorded(queryClient, { createdFood: true });
  expect(invalidated()).toContainEqual(queryKeys.mealLogs);
  expect(invalidated()).toContainEqual(queryKeys.mealCandidatesRoot);
  expect(invalidated()).toContainEqual(queryKeys.mealInsights);
  expect(invalidated()).not.toContainEqual(queryKeys.inventory);
  expect(invalidated()).not.toContainEqual(queryKeys.foodPlanRoot);
});
```

Add tests for composition/rating, undo with/without removed Food, Food name/cover change invalidating the insight key, recipe cook and plan completion invalidating candidates/insights plus their real domain keys, and active record-operation queries enabled on Home, Food, Ingredient/Eat and History surfaces but disabled on unrelated settings/AI-only surfaces.

- [ ] **Step 2: Run API/query tests and verify contracts are missing**

```bash
npm --prefix frontend run test -- \
  src/api/mealLogsApi.test.ts src/api/queryKeys.test.ts \
  src/api/cacheInvalidation.test.ts src/app/useAppWorkspaceQueries.test.tsx
```

Expected: FAIL with missing types/API/query keys.

- [ ] **Step 3: Add exact discriminated TS types and transport**

```typescript
export type RecordMealTarget =
  | { kind: 'new' }
  | { kind: 'existing'; meal_log_id: string; expected_row_version: number };

export type RecordMealEntryPayload =
  | { food_id: string; servings: number }
  | { client_food_id: string; servings: number };

export type MealInsightKind =
  | 'frequent_recent'
  | 'missed'
  | 'repurchase'
  | 'repeated_choice';
```

Move current MealLog methods out of `foodsApi.ts` into `mealLogsApi.ts`, add it to `api/client.ts`, and keep Food/Recipe APIs in their own modules.

- [ ] **Step 4: Centralize root invalidation and relevant-surface query enabling**

`invalidateAfterMealRecorded`, `invalidateAfterMealCompositionChanged`, `invalidateAfterMealRecordReverted` and existing recipe/plan/AI invalidators each list exact keys. In phase one, `useAppWorkspaceQueries` enables active record operations whenever the current route/surface can present the shared result bar (Home, Food, Ingredient/Eat or History), so refresh can recover the latest ordinary record without navigation. Keep it disabled on unrelated settings/AI-only surfaces. `mealInsights` is a defined-but-unrequested key until Task 18 adds the phase-two query, so the phase-one release never calls an absent endpoint.

- [ ] **Step 5: Verify transport and cache contract**

```bash
npm --prefix frontend run test -- \
  src/api/mealLogsApi.test.ts src/api/queryKeys.test.ts \
  src/api/cacheInvalidation.test.ts src/app/useAppWorkspaceQueries.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit frontend contracts**

```bash
git add frontend/src/api/mealLogsApi.ts frontend/src/api/mealLogsApi.test.ts \
  frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/api/foodsApi.ts \
  frontend/src/api/queryKeys.ts frontend/src/api/queryKeys.test.ts \
  frontend/src/api/cacheInvalidation.ts frontend/src/api/cacheInvalidation.test.ts \
  frontend/src/app/useAppWorkspaceQueries.ts frontend/src/app/useAppWorkspaceQueries.test.tsx
git commit -m "feat: add meal recording client contracts"
```

### Task 10: Build Pure Composer and Composition Merge Models

**Files:**

- Create: `frontend/src/features/meals/MealComposerModel.ts`
- Create: `frontend/src/features/meals/MealComposerModel.test.ts`
- Create: `frontend/src/features/meals/MealCompositionModel.ts`
- Create: `frontend/src/features/meals/MealCompositionModel.test.ts`
- Modify: `frontend/src/features/meals/MealLogWorkspaceModel.ts`
- Modify: `frontend/src/features/meals/MealLogWorkspaceModel.test.ts`

**Interfaces:**

- Produces `MealComposerFood = ExistingComposerFood | NewComposerFood`; `deriveCandidatePresentation()`; `buildRecordMealPayload()`; `selectMealPreviewMedia()`; `createMealBusinessDate()`; `mergeMealComposition(base,draft,server)`.

- [ ] **Step 1: Write candidate/default/payload tests**

```typescript
expect(deriveCandidatePresentation([], 'dinner')).toEqual({
  mode: 'none',
  target: { kind: 'new' },
});
expect(deriveCandidatePresentation([candidate], 'dinner')).toMatchObject({
  mode: 'single',
  target: { kind: 'existing', meal_log_id: candidate.meal_log_id },
});
expect(deriveCandidatePresentation([candidate], 'snack')).toMatchObject({
  mode: 'single',
  target: { kind: 'new' },
});
```

Cover 2+ default, all defaults visible/editable, existing/new Food payload mapping, duplicate final Food, 1..120 trimmed name, allowed types, MealLog photo → Food cover → null, and Shanghai date while device timezone is behind/ahead.

- [ ] **Step 2: Write three-way composition merge tests**

Cover server-only field change, draft-only change, same-value change, divergent same-field change, user-delete/server-edit, server-delete/user-edit, and temporary new entry preservation. Conflicts must include `entry_key`, `field`, `base`, `draft`, `server` and never auto-select a side.

- [ ] **Step 3: Run model tests and verify the models are absent/current debt semantics remain**

```bash
npm --prefix frontend run test -- \
  src/features/meals/MealComposerModel.test.ts \
  src/features/meals/MealCompositionModel.test.ts \
  src/features/meals/MealLogWorkspaceModel.test.ts
```

Expected: FAIL with missing modules and old status/debt assertions.

- [ ] **Step 4: Implement pure discriminated models**

`deriveCandidatePresentation()` receives only server candidates and MealType. `buildRecordMealPayload()` receives stable client request ID, explicit target and selected Foods, emits `new_foods` plus entries in display order, and throws typed validation results before network calls. `selectMealPreviewMedia()` never constructs URLs; it returns a `MediaAsset | null` for `resolveAssetUrl` at render time.

- [ ] **Step 5: Implement entry-ID three-way merge and remove debt-derived workspace fields**

Use `entry.id` as stable key and `client:<uuid>` for local additions. Compare `food_id`, `servings`, `note` independently. Remove `MealLogStatusFilter`, `basicMeals`, `enrichedCount`, `getMealLogStatus*`, source-derived search text and action labels from the workspace model; keep search, meal-type filter, date grouping, ratings-with-values and participant/media counts-with-values.

- [ ] **Step 6: Verify pure rules**

```bash
npm --prefix frontend run test -- \
  src/features/meals/MealComposerModel.test.ts \
  src/features/meals/MealCompositionModel.test.ts \
  src/features/meals/MealLogWorkspaceModel.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit pure meal models**

```bash
git add frontend/src/features/meals/MealComposerModel.ts \
  frontend/src/features/meals/MealComposerModel.test.ts \
  frontend/src/features/meals/MealCompositionModel.ts \
  frontend/src/features/meals/MealCompositionModel.test.ts \
  frontend/src/features/meals/MealLogWorkspaceModel.ts \
  frontend/src/features/meals/MealLogWorkspaceModel.test.ts
git commit -m "feat: add meal composer domain models"
```

### Task 11: Add Composer State, Data and Actions

**Files:**

- Create: `frontend/src/features/meals/useMealComposerState.ts`
- Create: `frontend/src/features/meals/useMealComposerState.test.tsx`
- Create: `frontend/src/features/meals/useMealCandidateData.ts`
- Create: `frontend/src/features/meals/useMealCandidateData.test.tsx`
- Create: `frontend/src/features/meals/useMealComposerData.ts`
- Create: `frontend/src/features/meals/useMealComposerActions.ts`
- Create: `frontend/src/features/meals/useMealComposerActions.test.tsx`
- Create: `frontend/src/features/meals/useMealRecordResultState.ts`
- Create: `frontend/src/features/meals/useMealRecordResultState.test.tsx`

**Interfaces:**

- `useMealComposerState({mode, prefilledFood, now})` owns date, mealType, Foods, target, stable request ID, busy/error and explicit discard/reset.
- `useMealCandidateData({open,date,mealType})` owns the authoritative candidate query and can be reused by Composer, plan completion and Recipe cook without triggering Food search.
- `useMealComposerData({open,date,mealType,searchQuery})` owns `foodPickerSearch` and composes `useMealCandidateData`.
- `useMealComposerActions(...)` owns record/replay and target refresh; on success it calls `publishRecordResult(response)` after closing the Composer.
- `useMealRecordResultState({activeOperations,revertOperation,rateMeal,onViewMeal})` owns the App-level latest ordinary record result, active-operation refresh restoration, non-optimistic revert, optional rating and view navigation. Recipe/plan/AI results have no publish API.

- [ ] **Step 1: Write stable request-ID and candidate-refresh hook tests**

```typescript
it('reuses one request id for failures and creates a new id only after discard', async () => {
  const { result } = renderHook(() => useMealComposerState({ mode: 'full', now }));
  const first = result.current.recordClientRequestId;
  act(() => result.current.setError('网络错误'));
  expect(result.current.recordClientRequestId).toBe(first);
  act(() => result.current.discard());
  expect(result.current.recordClientRequestId).not.toBe(first);
});
```

Add tests that date/type changes reset target from fresh candidates without clearing Foods, target 409 retains Food/new-Food drafts and requires visible reconfirmation, and record success closes Composer before publishing the full result. In `useMealRecordResultState.test.tsx`, assert immediate results expose MealLog row version for optional rating, refresh restores the newest active operation on Home/Food/Ingredient/History, restored summaries still expose undo/view even if rating data is unavailable, revert failure keeps the result/timeline, and cook/plan/AI result types cannot be published.

- [ ] **Step 2: Run hook tests and confirm hooks are absent**

```bash
npm --prefix frontend run test -- \
  src/features/meals/useMealComposerState.test.tsx \
  src/features/meals/useMealCandidateData.test.tsx \
  src/features/meals/useMealComposerActions.test.tsx \
  src/features/meals/useMealRecordResultState.test.tsx
```

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement state with explicit lifecycle**

Use `crypto.randomUUID()` behind an injectable `createRequestId` for tests. Compact mode seeds one existing Food and never asks the user to search it again; full mode starts empty. `close()` preserves draft for accidental dismissal, while `discard()` clears it and creates a new request identity.

- [ ] **Step 4: Implement debounced query data without timeline inference**

Food query uses `queryKeys.foodPickerSearch(query)` and `api.getFoods({q,limit:20})`. `useMealCandidateData` uses `queryKeys.mealCandidates(date, mealType)` and never reads `mealLogs` cache to infer count; it is disabled while its owner view is closed. Composer combines both without coupling candidate refresh to Food search, and candidate data keeps prior Food draft intact.

- [ ] **Step 5: Implement record publishing and shared result actions**

On record success: await record invalidation, close, then call `publishRecordResult(response)` with the returned operation and full MealLog. On `meal_log_stale`: await candidate refetch, replace target presentation only, keep Food draft and show “这顿饭刚被家人更新，请重新确认”.

`useMealRecordResultState` prefers the just-returned full result; otherwise it restores the newest active summary from Task 9. Revert always sends the server operation ID, reuses it after timeout, and updates/dismisses only after server 200. “查看记录” uses `meal_log_id`. Compact rating is rendered only when the state has a current MealLog with `row_version`; leaving it blank creates no state.

- [ ] **Step 6: Verify hook workflows**

```bash
npm --prefix frontend run test -- \
  src/features/meals/useMealComposerState.test.tsx \
  src/features/meals/useMealCandidateData.test.tsx \
  src/features/meals/useMealComposerActions.test.tsx \
  src/features/meals/useMealRecordResultState.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit state/action orchestration**

```bash
git add frontend/src/features/meals/useMealComposerState.ts \
  frontend/src/features/meals/useMealComposerState.test.tsx \
  frontend/src/features/meals/useMealCandidateData.ts \
  frontend/src/features/meals/useMealCandidateData.test.tsx \
  frontend/src/features/meals/useMealComposerData.ts \
  frontend/src/features/meals/useMealComposerActions.ts \
  frontend/src/features/meals/useMealComposerActions.test.tsx \
  frontend/src/features/meals/useMealRecordResultState.ts \
  frontend/src/features/meals/useMealRecordResultState.test.tsx
git commit -m "feat: add meal composer state and actions"
```

### Task 12: Build Full and Compact Recording Views

**Files:**

- Create: `frontend/src/features/meals/MealComposer.tsx`
- Create: `frontend/src/features/meals/MealComposer.test.tsx`
- Create: `frontend/src/features/meals/MealQuickRecordView.tsx`
- Create: `frontend/src/features/meals/MealQuickRecordView.test.tsx`
- Create: `frontend/src/features/meals/MealCandidateSelector.tsx`
- Create: `frontend/src/features/meals/MealFoodCombobox.tsx`
- Create: `frontend/src/styles/13-meal-composer.css`
- Modify: `frontend/src/styles.css`

**Interfaces:**

- Full Composer accepts multiple Foods and inline creation; compact view accepts one prefilled Food but shares candidate/target semantics.
- Both views consume prepared state/data/actions and never call API or invalidate caches directly.

- [ ] **Step 1: Invoke required UI skills and write presentation tests**

Before UI edits, invoke `frontend-ui-style`; also invoke `frontend-ui-engineering` for responsive state flow. Then test:

```typescript
it('shows no target control for zero candidates', () => {
  renderComposer({ candidates: [] });
  expect(screen.queryByText(/记在一起|另记一顿/)).not.toBeInTheDocument();
});

it('shows one inline confirmation with names and image', () => {
  renderComposer({ candidates: [candidateWithPhoto] });
  expect(screen.getByText('和今晚这顿一起记吗？')).toBeVisible();
  expect(screen.getByText('番茄炒蛋、青菜')).toBeVisible();
  expect(screen.getByRole('img', { name: /今晚这顿/ })).toBeVisible();
});
```

Cover 2+ expanded chooser, snack defaults, final combination preview, compact prefilled Food, no stock controls, inline Food type requirement, keyboard selection, Escape/busy close, 44px targets and no nested modal.

- [ ] **Step 2: Run view tests and confirm components are absent**

```bash
npm --prefix frontend run test -- \
  src/features/meals/MealComposer.test.tsx \
  src/features/meals/MealQuickRecordView.test.tsx
```

Expected: FAIL with missing components.

- [ ] **Step 3: Build the shared Food combobox and candidate selector**

Combobox renders current-family results and a final “按‘{trimmedName}’记下” action. Unknown type opens four inline chips (“家里做 / 外卖 / 外食 / 买来即食”) inside the same Composer. Candidate selector renders nothing/one confirmation/multiple list based only on model output and uses `MediaWithPlaceholder`, `resolveAssetUrl`, stable aspect ratio and Food names.

- [ ] **Step 4: Build distinct full and compact presentations**

Full view supports add/remove/servings and one submit. Compact view shows prefilled Food hero, date, meal type, candidate confirmation and submit and has no stock toggle/quantity contract. Both show server/validation errors inline and disable duplicate submit. Task 15 replaces the legacy `FoodQuickMealDialog` caller/state only after this new compact view is independently green.

- [ ] **Step 5: Add scoped warm responsive styles**

Import `13-meal-composer.css` from `styles.css`. Use only `.meal-composer-*` / `.meal-quick-record-*`; desktop may use two regions, mobile is one scroll area with `padding-bottom: calc(var(--mobile-nav-height) + env(safe-area-inset-bottom) + 16px)`. Images use fixed `aspect-ratio` and `object-fit: cover`.

- [ ] **Step 6: Verify view tests and style tokens**

```bash
npm --prefix frontend run test -- \
  src/features/meals/MealComposer.test.tsx \
  src/features/meals/MealQuickRecordView.test.tsx
npm --prefix frontend run check:style-tokens
```

Expected: tests PASS; token report contains no unexplained new hard-coded color/spacing drift.

- [ ] **Step 7: Commit recording views**

```bash
git add frontend/src/features/meals/MealComposer.tsx \
  frontend/src/features/meals/MealComposer.test.tsx \
  frontend/src/features/meals/MealQuickRecordView.tsx \
  frontend/src/features/meals/MealQuickRecordView.test.tsx \
  frontend/src/features/meals/MealCandidateSelector.tsx \
  frontend/src/features/meals/MealFoodCombobox.tsx \
  frontend/src/styles/13-meal-composer.css frontend/src/styles.css
git commit -m "feat: build meal recording views"
```

### Task 13: Redesign the Photo-First Timeline, Details, Rating and Shared Result

**Files:**

- Create: `frontend/src/features/meals/MealCompositionEditor.tsx`
- Create: `frontend/src/features/meals/MealCompositionEditor.test.tsx`
- Create: `frontend/src/features/meals/MealInlineRating.tsx`
- Create: `frontend/src/features/meals/MealInlineRating.test.tsx`
- Create: `frontend/src/features/meals/MealRecordResultBar.tsx`
- Create: `frontend/src/features/meals/MealRecordResultBar.test.tsx`
- Modify: `frontend/src/features/meals/MealLogWorkspace.tsx`
- Modify: `frontend/src/features/meals/MealLogMobileView.tsx`
- Modify: `frontend/src/features/meals/MealHistorySurface.tsx`
- Modify: `frontend/src/features/meals/MealLogEnrichment.tsx`
- Modify: `frontend/src/features/meals/MealEnrichmentModal.tsx`
- Modify: `frontend/src/features/meals/MealLogEnrichmentModel.ts`
- Modify: `frontend/src/features/meals/useMealEnrichmentState.ts`
- Modify: `frontend/src/features/meals/MealLogWorkspaceUsage.test.ts`
- Modify: `frontend/src/styles/08-meal-log.css`
- Modify: `frontend/src/styles/07-mobile.css`

**Interfaces:**

- `MealRecordResultBar` consumes Task 11 shared result state and exposes “已记下”、Food 图片/名称、撤销、查看记录和有完整 MealLog 时的可选评分；History workspace can render it near the matching entry without owning the state.
- Workspace exposes one CTA “记一餐”, photo-first timeline and optional details.
- Composition editor consumes base/draft/server merge result and requires user confirmation after conflicts; details/rating payloads include current `row_version`.

- [ ] **Step 1: Write debt-language and photo fallback tests**

```typescript
it('renders only meaningful meal facts and photo-first content', () => {
  renderHistory({ meals: [mealWithoutOptionalFields], foods: [foodWithCover] });
  expect(screen.getByRole('heading', { name: '吃过的' })).toBeVisible();
  expect(screen.getByRole('button', { name: '记一餐' })).toBeVisible();
  expect(screen.getByRole('img', { name: /番茄炒蛋/ })).toBeVisible();
  for (const debt of ['基础记录', '已丰富', '待补充', '未评分', '手动补录', '菜单计划']) {
    expect(screen.queryByText(debt)).not.toBeInTheDocument();
  }
});
```

Cover MealLog photo first, Food cover second, placeholder third, `+N`, hide zero counts, show only rating/participants/photos/recorder when present, desktop/mobile structures, empty/loading/error, and search without source labels.

- [ ] **Step 2: Write inline rating, shared result and composition-conflict tests**

Assert the result bar says “已记下”, shows Food image/name, exposes “撤销”“查看记录”, and shows compact rating only when full MealLog/version exists; leaving rating blank has no state. Undo uses server deadline, disables while submitting, survives active-operation refresh, never removes timeline before 200, and maps expired/forbidden/network errors. Rendering the same shared state on History does not duplicate mutation ownership. Composition 409 shows merged result/conflicts and requires another click; timeout refetch treats exact submitted composition as success, otherwise enters merge.

- [ ] **Step 3: Run meal UI tests and verify old debt UI fails expectations**

```bash
npm --prefix frontend run test -- \
  src/features/meals/MealLogWorkspaceModel.test.ts \
  src/features/meals/MealLogWorkspaceUsage.test.ts \
  src/features/meals/MealCompositionEditor.test.tsx \
  src/features/meals/MealInlineRating.test.tsx \
  src/features/meals/MealRecordResultBar.test.tsx
```

Expected: FAIL because old metric cards/status/source labels remain and new components are absent.

- [ ] **Step 4: Replace the workspace information hierarchy**

Desktop and mobile each render: page header + primary CTA, later memory slot, search/meal filter, grouped photo timeline. Delete four metric cards, enrichment-status filter, source map badges, zero photo/note counts and default “补充这餐”. Clicking a row opens “这餐详情”; optional edit action is “编辑这顿”.

- [ ] **Step 5: Add inline rating and shared operation-linked result bar**

Inline rating sends `expected_row_version` from the latest MealLog and refreshes all meal-derived queries; no skip button or debt state. `MealRecordResultBar` computes countdown from the server deadline, uses neutral warm styling, delegates undo/view/rating to Task 11 state, and only reflects removal after server 200. History matches it by `meal_log_id`; other surfaces will mount the same component in Tasks 14–15.

- [ ] **Step 6: Add composition editor and versioned optional details**

Editor supports add/remove/servings/note with at least one entry. Keep base snapshot when opened. On 409 call `mergeMealComposition`, show per-field conflict rows, update expected version to server value and require explicit resubmit. Update `useMealEnrichmentState` payloads with current row version and map stale details to refresh/review rather than silent overwrite.

- [ ] **Step 7: Verify timeline and responsive UI**

```bash
npm --prefix frontend run test -- \
  src/features/meals/MealLogWorkspaceModel.test.ts \
  src/features/meals/MealLogWorkspaceUsage.test.ts \
  src/features/meals/MealEnrichmentModal.test.tsx \
  src/features/meals/MealCompositionEditor.test.tsx \
  src/features/meals/MealInlineRating.test.tsx \
  src/features/meals/MealRecordResultBar.test.tsx
npm --prefix frontend run build
```

Expected: PASS; no TypeScript contract mismatch.

- [ ] **Step 8: Commit the timeline redesign**

```bash
git add frontend/src/features/meals/MealCompositionEditor.tsx \
  frontend/src/features/meals/MealCompositionEditor.test.tsx \
  frontend/src/features/meals/MealInlineRating.tsx \
  frontend/src/features/meals/MealInlineRating.test.tsx \
  frontend/src/features/meals/MealRecordResultBar.tsx \
  frontend/src/features/meals/MealRecordResultBar.test.tsx \
  frontend/src/features/meals/MealLogWorkspace.tsx \
  frontend/src/features/meals/MealLogMobileView.tsx \
  frontend/src/features/meals/MealHistorySurface.tsx \
  frontend/src/features/meals/MealLogEnrichment.tsx \
  frontend/src/features/meals/MealEnrichmentModal.tsx \
  frontend/src/features/meals/MealLogEnrichmentModel.ts \
  frontend/src/features/meals/useMealEnrichmentState.ts \
  frontend/src/features/meals/MealLogWorkspaceUsage.test.ts \
  frontend/src/styles/08-meal-log.css frontend/src/styles/07-mobile.css
git commit -m "feat: redesign meal history timeline"
```

### Task 14: Wire Shared Record Results and Migrate Home Entries

**Files:**

- Modify: `frontend/src/app/useAppMutations.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/features/home/HomeDashboard.tsx`
- Modify: `frontend/src/features/home/HomeDashboard.test.tsx`
- Modify: `frontend/src/features/home/useHomeDashboardActions.ts`
- Modify: `frontend/src/features/home/useHomeDashboardActions.test.ts`

**Interfaces:**

- `App.tsx` composes Task 11 `useMealRecordResultState` and passes one cohesive `{result, publish, revert, rate, view}` contract; it does not build record payloads or own conflict rules.
- Home recommendation/direct Food actions open compact `recordMeal`; Home non-Recipe plan completion calls `completeFoodPlanItem`; only ordinary record publishes `MealRecordResultBar` state.

- [ ] **Step 1: Write App/Home owner and result-bar tests**

```typescript
const homeOwners = {
  historyPrimaryCta: 'recordMeal',
  homeRecommendation: 'recordMeal',
  homePlanComplete: 'completeFoodPlanItem',
} as const;
```

In `HomeDashboard.test.tsx`, assert a recommendation opens the compact prefilled Food flow, does not search the Food again, and after record success remains on Home with visible “已记下 / 撤销 / 查看记录” plus Food image. In `useHomeDashboardActions.test.ts`, assert non-Recipe plan completion sends `food_plan_item_base_updated_at` and explicit candidate target to `completeFoodPlanItem`, safely accepts a replayed stored MealLog, and never publishes ordinary record result/undo. Cover active-operation refresh restoring the Home result bar and `businessDateKey(now, 'Asia/Shanghai')` defaults.

- [ ] **Step 2: Run the focused Home/App tests and confirm old ownership**

```bash
npm --prefix frontend run test -- \
  src/features/home/HomeDashboard.test.tsx \
  src/features/home/useHomeDashboardActions.test.ts \
  src/features/meals/useMealRecordResultState.test.tsx \
  src/app/useAppWorkspaceQueries.test.tsx
```

Expected: FAIL because Home still accepts/calls quick-add and App has no shared record result composition.

- [ ] **Step 3: Compose new mutations and result state without business logic in App**

Add record/composition/revert/plan-complete mutations to `useAppMutations`. In `App.tsx`, feed active operations from Task 9 into `useMealRecordResultState`, mount `MealRecordResultBar` in the current Home/History presentation, and pass `publishRecordResult` only to ordinary record flows. Keep the remaining legacy props for not-yet-migrated Food/Ingredient/Eat callers until Tasks 15–16; this compatibility bridge is feature-branch-only and may not pass the Task 16 release gate.

- [ ] **Step 4: Migrate both Home write paths**

Replace Home recommendation/direct Food quick-add with compact Composer `recordMeal`. Replace Home non-Recipe menu completion with `completeFoodPlanItem`; preserve candidate preview and send no stock fields through record. Recipe-backed Home plan items continue opening Recipe cook. Remove Home `todayKey()` use from meal defaults and use the shared business-date helper.

- [ ] **Step 5: Verify Home stays in place and exposes recovery**

```bash
npm --prefix frontend run test -- \
  src/features/home/HomeDashboard.test.tsx \
  src/features/home/useHomeDashboardActions.test.ts \
  src/features/meals/MealRecordResultBar.test.tsx \
  src/app/useAppWorkspaceQueries.test.tsx
npm --prefix frontend run build
```

Expected: PASS; ordinary Home record shows the shared result bar without navigation, while plan/cook completion does not show quick-record undo.

- [ ] **Step 6: Commit Home and shared result wiring**

```bash
git add frontend/src/app/useAppMutations.ts frontend/src/App.tsx \
  frontend/src/features/home/HomeDashboard.tsx \
  frontend/src/features/home/HomeDashboard.test.tsx \
  frontend/src/features/home/useHomeDashboardActions.ts \
  frontend/src/features/home/useHomeDashboardActions.test.ts
git commit -m "feat: migrate home meal recording"
```

### Task 15: Migrate Food and Ingredient Record/Plan Entries

**Files:**

- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/foods/FoodQuickMealDialog.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.test.ts`
- Modify: `frontend/src/components/foods/useFoodWorkspaceState.ts`
- Modify: `frontend/src/components/foods/useFoodPlanState.ts`
- Modify: `frontend/src/components/foods/useFoodPlanState.test.tsx`
- Modify: `frontend/src/components/ingredients/IngredientWorkspace.tsx`
- Modify: `frontend/src/components/ingredients/IngredientWorkspaceUsage.test.ts`

**Interfaces:**

- Food card, takeout/dining-out “再吃一次”, and Ingredient/finished-stock Food recording use compact `recordMeal` and publish the shared result.
- Food workspace non-Recipe plan completion uses `completeFoodPlanItem`; record never accepts `deduct_food_stock`, `stock_quantity`, `stock_unit` or `food_plan_item_id`.
- Inventory changes remain a separate command/link after record and do not share record idempotency or undo.

- [ ] **Step 1: Write the complete Food/Ingredient owner matrix**

```typescript
const foodIngredientOwners = {
  foodCardAgain: 'recordMeal',
  takeoutAgain: 'recordMeal',
  diningOutAgain: 'recordMeal',
  foodWorkspacePlanComplete: 'completeFoodPlanItem',
  ingredientFoodRecord: 'recordMeal',
  ingredientInventoryChange: 'inventoryCommand',
} as const;
```

Assert each ordinary record stays on its current surface and renders the shared result bar with correct image/name, server operation ID, view link and optional rating. Assert plan completion has candidate confirmation but no ordinary undo. `IngredientWorkspaceUsage.test.ts` must assert `api.quickAddMealLog` is absent and record/inventory are two independent calls; cancelling the inventory follow-up does not roll back the meal.

- [ ] **Step 2: Run focused tests and expose remaining quick-add coupling**

```bash
npm --prefix frontend run test -- \
  src/components/foods/FoodWorkspace.test.ts \
  src/components/foods/useFoodPlanState.test.tsx \
  src/components/ingredients/IngredientWorkspaceUsage.test.ts
```

Expected: FAIL because Food state/plan and IngredientWorkspace still construct quick-add payloads, including stock/plan fields.

- [ ] **Step 3: Migrate Food record and plan actions by owner**

`useFoodWorkspaceState` opens Task 12 compact Composer with the selected Food and publishes only `recordMeal` success. `useFoodPlanState` calls `completeFoodPlanItem` with base timestamp and selected target, checks replayed/current MealLog as success, and never calls ordinary record. `FoodWorkspace` mounts the shared result bar from App props without duplicating state or mutation logic.

- [ ] **Step 4: Split Ingredient record from inventory mutation**

Replace the direct `api.quickAddMealLog` call with the shared compact record action. Any “处理库存” affordance opens the existing independent inventory action only after record and requires its own submit; remove stock fields from `FoodQuickMealDialogState` and all record payload types. Render the same result bar on the Ingredient surface and preserve it if the optional inventory action is dismissed or fails.

- [ ] **Step 5: Verify no old caller remains in these domains**

```bash
rg -n "quickAddMeal|QuickAddMealLog|quick-add" \
  frontend/src/components/foods frontend/src/components/ingredients
npm --prefix frontend run test -- \
  src/components/foods/FoodWorkspace.test.ts \
  src/components/foods/useFoodPlanState.test.tsx \
  src/components/ingredients/IngredientWorkspaceUsage.test.ts
npm --prefix frontend run build
```

Expected: `rg` has no legacy record symbol in these domains; tests prove `recordMeal` payloads contain no stock fields while independent inventory commands remain available; tests and build PASS.

- [ ] **Step 6: Commit Food/Ingredient migration**

```bash
git add frontend/src/App.tsx frontend/src/components/foods/FoodQuickMealDialog.tsx \
  frontend/src/components/foods/FoodWorkspace.tsx \
  frontend/src/components/foods/FoodWorkspace.test.ts \
  frontend/src/components/foods/useFoodWorkspaceState.ts \
  frontend/src/components/foods/useFoodPlanState.ts \
  frontend/src/components/foods/useFoodPlanState.test.tsx \
  frontend/src/components/ingredients/IngredientWorkspace.tsx \
  frontend/src/components/ingredients/IngredientWorkspaceUsage.test.ts
git commit -m "feat: migrate food and ingredient meal recording"
```

### Task 16: Migrate Recipe/Eat, Remove Legacy Quick-Add and Close Phase One

**Files:**

- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/app/useAppMutations.ts`
- Modify: `frontend/src/api/foodsApi.ts`
- Modify: `frontend/src/api/foodsApi.test.ts`
- Modify: `frontend/src/api/recipesApi.ts`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/components/recipes/RecipeWorkspaceModel.ts`
- Modify: `frontend/src/components/recipes/RecipeWorkspace.test.ts`
- Modify: `frontend/src/components/recipes/useRecipeCookState.ts`
- Modify: `frontend/src/components/recipes/useRecipeCookState.test.tsx`
- Modify: `frontend/src/components/recipes/RecipeCookFinishDialog.tsx`
- Modify: `frontend/src/features/eat/EatTaskBodies.tsx`
- Modify: `frontend/src/features/eat/EatTaskBodies.test.tsx`
- Modify: `frontend/src/styles/12-eat-workspace.css`
- Modify: `frontend/scripts/smoke.mjs`
- Modify: `backend/app/api/meal_logs.py`
- Modify: `backend/app/schemas/meal_logs.py`
- Modify: `backend/tests/meal_logs/test_meal_logs.py`
- Modify: `backend/tests/recipes/test_food_workspace.py`
- Modify: `backend/tests/recipes/test_food_stock_operations.py`
- Modify: `backend/tests/recipes/test_recipe_cooking.py`

**Interfaces:**

- Recipe finish UI selects candidate target and emits `target_meal_log_id?` / `expected_meal_log_row_version?` through `buildCookPayload()` to the existing cook owner command; it never publishes ordinary record undo.
- After this task no frontend `quickAddMealLog` / `QuickAddMealLogPayload` and no backend `/api/meal-logs/quick-add` route/schema/test call remain.

- [ ] **Step 1: Write the final cross-surface owner matrix and Recipe target tests**

```typescript
const expectedOwners = {
  historyPrimaryCta: 'recordMeal',
  homeRecommendation: 'recordMeal',
  homePlanComplete: 'completeFoodPlanItem',
  foodCardAgain: 'recordMeal',
  foodWorkspacePlanComplete: 'completeFoodPlanItem',
  ingredientFoodRecord: 'recordMeal',
  eatFoodRecord: 'recordMeal',
  recipeCook: 'cookRecipe',
  aiApproval: 'approvalDecision',
} as const;
```

In Recipe model/state/dialog tests, assert zero/single/multiple candidate presentation, image/name preview, target fields in `buildCookPayload`, stale target reconfirmation, stable completion request ID on timeout and no `MealRecordResultBar` publish. In Eat tests, assert ordinary Food paths publish the shared result, non-Recipe plan uses its owner endpoint, and Recipe paths open cook.

- [ ] **Step 2: Add backend legacy-removal and regression replacements**

```python
def test_legacy_quick_add_is_removed(client):
    response = client.post("/api/meal-logs/quick-add", json={})
    assert response.status_code == 404
```

Rewrite `test_food_workspace.py` legacy calls to use `/api/meal-logs/record` with explicit target and client request ID. In `test_food_stock_operations.py`, replace combined quick-add/stock assertions with two commands: record asserts no inventory mutation; the existing inventory endpoint separately asserts quantity/version/rollback. Keep `test_recipe_cooking.py` on the cook endpoint and add target UI-compatible payload coverage.

- [ ] **Step 3: Run migration tests and confirm the final legacy surface**

```bash
(cd backend && .venv/bin/python -m pytest \
  tests/meal_logs/test_meal_logs.py \
  tests/recipes/test_food_workspace.py \
  tests/recipes/test_food_stock_operations.py \
  tests/recipes/test_recipe_cooking.py -q)
npm --prefix frontend run test -- \
  src/components/recipes/RecipeWorkspace.test.ts \
  src/components/recipes/useRecipeCookState.test.tsx \
  src/features/eat/EatTaskBodies.test.tsx
```

Expected: FAIL because Recipe/Eat payloads still omit target fields and the legacy route/symbols still exist.

- [ ] **Step 4: Wire Recipe/Eat owner flows**

Extend `buildCookPayload`, cook session state and `RecipeCookFinishDialog` with Task 11 `useMealCandidateData` plus Task 12 `MealCandidateSelector`; date/meal type changes refetch authoritative candidates and preserve cook feedback fields while requiring target reconfirmation. Pass target fields through `recipesApi` and preserve completion request identity across timeout. Migrate Eat ordinary Food actions to compact `recordMeal`, non-Recipe plan to `completeFoodPlanItem`, and Recipe to `cookRecipe`. Recipe/plan success may offer “查看这餐” but must not publish ordinary record result.

- [ ] **Step 5: Remove legacy transport only after every caller and regression is migrated**

Delete `quick_add_meal_log`, `_select_food_for_quick_add`, `QuickAddMealLogRequest`, `QuickAddMealLogPayload`, `api.quickAddMealLog`, App mutation/props and route registration. Apply the backend test replacements from Step 2. Do not retain an adapter that silently chooses the newest same-date/type MealLog.

- [ ] **Step 6: Prove zero residual callers and exercise smoke paths**

```bash
rg -n "quickAddMeal|QuickAddMealLogPayload|quickAddMealLog|/api/meal-logs/quick-add" \
  frontend/src frontend/scripts backend/app backend/tests
```

Expected: the only match is the intentional backend 404 removal assertion; there are no frontend symbols/calls, backend route/schema/service definitions, positive test calls or smoke requests. Extend smoke fixtures for candidates, record, active operations, revert, composition, plan completion and cook target. Exercise Home/Food/Ingredient/Eat ordinary records with current-surface result bar; zero/single/multi candidate, inline Food, new/append undo, plan completion timeout replay, cook target and 409 reconfirm; assert Recipe/plan never renders ordinary undo and no `/quick-add` request is emitted.

- [ ] **Step 7: Run the phase-one release gate**

```bash
npm run backend:migrate
(cd backend && .venv/bin/python -m pytest \
  tests/meal_logs \
  tests/recipes/test_food_workspace.py \
  tests/recipes/test_food_stock_operations.py \
  tests/recipes/test_recipe_cooking.py \
  tests/ai_infra/test_workspace_approvals.py -q)
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
```

Expected: all PASS. Manual network audit confirms ordinary record/undo do not touch inventory/food-plan endpoints, owner commands do not publish ordinary undo, and no candidate decision derives from loaded timeline.

- [ ] **Step 8: Commit Recipe/Eat migration and legacy removal**

```bash
git add frontend/src/App.tsx frontend/src/app/useAppMutations.ts \
  frontend/src/api/foodsApi.ts frontend/src/api/foodsApi.test.ts \
  frontend/src/api/recipesApi.ts frontend/src/api/types.ts \
  frontend/src/components/recipes/RecipeWorkspaceModel.ts \
  frontend/src/components/recipes/RecipeWorkspace.test.ts \
  frontend/src/components/recipes/useRecipeCookState.ts \
  frontend/src/components/recipes/useRecipeCookState.test.tsx \
  frontend/src/components/recipes/RecipeCookFinishDialog.tsx \
  frontend/src/features/eat/EatTaskBodies.tsx \
  frontend/src/features/eat/EatTaskBodies.test.tsx \
  frontend/src/styles/12-eat-workspace.css frontend/scripts/smoke.mjs \
  backend/app/api/meal_logs.py backend/app/schemas/meal_logs.py \
  backend/tests/meal_logs/test_meal_logs.py \
  backend/tests/recipes/test_food_workspace.py \
  backend/tests/recipes/test_food_stock_operations.py \
  backend/tests/recipes/test_recipe_cooking.py
git commit -m "feat: remove legacy quick meal recording"
```

---

## Phase 2 — Deterministic Family Memory Rewards

### Task 17: Derive Four Family Meal Insights on the Backend

**Files:**

- Create: `backend/app/repos/meal_log_insights.py`
- Create: `backend/app/services/meal_log_insights.py`
- Create: `backend/app/schemas/meal_log_insights.py`
- Create: `backend/app/api/meal_log_insights.py`
- Modify: `backend/app/api/router.py`
- Create: `backend/tests/meal_logs/test_meal_log_insights.py`

**Interfaces:**

- Produces `MealFoodOccurrence`, `MealInsightKind`, `MealInsightEvidenceOut {meal_count, last_eaten_on, rating_count, average_rating, window_days}`, `MealInsightOut {kind, food, evidence}`; `build_meal_log_insights(db, family_id, today) -> list[MealInsightOut]`; `GET /api/meal-logs/insights`.

- [ ] **Step 1: Write exact threshold, boundary and dedupe tests**

```python
def test_insights_use_distinct_meals_and_meal_level_rating_average(client, seeded_duplicate_entries):
    response = client.get("/api/meal-logs/insights")
    assert response.status_code == 200
    repurchase = next(item for item in response.json() if item["kind"] == "repurchase")
    assert repurchase["evidence"]["meal_count"] == 2
    assert repurchase["evidence"]["rating_count"] == 2
    assert repurchase["evidence"]["average_rating"] == 4.25
```

Parameterize 30-day frequent counts at 2/3, missed history at 1/2, missed day 29/30/180/181, repurchase rating count 1/2, average 3.99/4.0, latest rating 3.5/4.0, recent day 180/181, repeated-choice 1/2, all eligible Food types, and Asia/Shanghai UTC boundary.

- [ ] **Step 2: Write stable selection and family-media tests**

Assert each kind at most once, max four, order frequent/missed/repurchase/repeated, repurchase excludes same Food from repeated and frequent selects next candidate, ties use specified sort+Food ID, insufficient evidence returns `[]`, and cross-family MealLog/Food/media never leaks.

- [ ] **Step 3: Run focused insight tests and confirm endpoint is absent**

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_log_insights.py -q)
```

Expected: FAIL with missing modules/404.

- [ ] **Step 4: Implement occurrence facts and two-level aggregation**

Repo returns family-scoped rows containing MealLog ID/date/created_at, Food ID/type/name and entry rating. Service groups `(meal_log_id, food_id)`, averages non-null entry ratings for that meal, then aggregates Food counts/last date/rating count/average/latest rating. Constants are centralized:

```python
RECENT_WINDOW_DAYS = 30
MISSED_MAX_DAYS = 180
FREQUENT_MIN_MEALS = 3
MISSED_MIN_MEALS = 2
REPURCHASE_MIN_RATINGS = 2
REPURCHASE_MIN_AVERAGE = Decimal("4.0")
REPEATED_CHOICE_MIN_MEALS = 2
MAX_INSIGHTS = 4
PURCHASE_INSIGHT_FOOD_TYPES = {
    FoodType.READY_MADE,
    FoodType.INSTANT,
    FoodType.PACKAGED,
    FoodType.TAKEOUT,
    FoodType.DINING_OUT,
}
```

`repurchase` additionally requires latest meal-level rating >= 4.0 and last eaten <= 180 days. `repeated_choice` uses the same Food type set, recent 30-day count >= 2, and explicitly excludes Foods that satisfy `repurchase`.

- [ ] **Step 5: Implement selection, evidence and media serialization**

Generate candidate lists with exact spec sorts, apply cross-kind exclusions, take at most one per kind in fixed order, load only selected Food cover media, and return fact fields rather than prewritten marketing sentences. Use `today_for_family(..., timezone_name="Asia/Shanghai")` in the route.

- [ ] **Step 6: Verify deterministic rules**

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_log_insights.py -q)
```

Expected: PASS.

- [ ] **Step 7: Commit deterministic insight API**

```bash
git add backend/app/repos/meal_log_insights.py backend/app/services/meal_log_insights.py \
  backend/app/schemas/meal_log_insights.py backend/app/api/meal_log_insights.py \
  backend/app/api/router.py backend/tests/meal_logs/test_meal_log_insights.py
git commit -m "feat: add family meal insights"
```

### Task 18: Show Photo-First Family Memories Without Blocking Timeline

**Files:**

- Create: `frontend/src/features/meals/MealMemoryStrip.tsx`
- Create: `frontend/src/features/meals/MealMemoryStrip.test.tsx`
- Modify: `frontend/src/features/meals/MealLogWorkspace.tsx`
- Modify: `frontend/src/features/meals/MealLogMobileView.tsx`
- Modify: `frontend/src/features/meals/MealLogWorkspaceModel.ts`
- Modify: `frontend/src/features/meals/MealLogWorkspaceModel.test.ts`
- Modify: `frontend/src/app/useAppWorkspaceQueries.ts`
- Modify: `frontend/src/styles/08-meal-log.css`
- Modify: `frontend/src/styles/07-mobile.css`
- Modify: `frontend/scripts/smoke.mjs`

**Interfaces:**

- `buildMealInsightPresentation(insight)` maps stable kind/evidence to Chinese title/evidence text.
- `MealMemoryStrip` renders `null` for empty success, local retry for error, and never blocks timeline.

- [ ] **Step 1: Write kind copy, evidence and state tests**

```typescript
expect(buildMealInsightPresentation(repurchaseTakeout)).toEqual({
  title: '值得再点',
  evidence: '2 次评分，平均 4.5 分',
});
expect(buildMealInsightPresentation(missedFood).title).toBe('一个月没吃');
```

Cover ready/instant/packaged “值得回购”, diningOut “值得再去”, frequent “家里最近常吃”, repeated “最近常选”, actual counts/dates, empty → no section, error → lightweight retry, loading skeleton independent from timeline, Food cover/placeholder, and no duplicated Food.

- [ ] **Step 2: Run memory UI tests and verify component is absent**

```bash
npm --prefix frontend run test -- \
  src/features/meals/MealMemoryStrip.test.tsx \
  src/features/meals/MealLogWorkspaceModel.test.ts
```

Expected: FAIL with missing component/model mapper.

- [ ] **Step 3: Implement fact-to-family-language mapping**

Use exhaustive `Record<MealInsightKind, ...>`/switch mappings and evidence fields from the API only. Frontend does not recompute 30/180-day eligibility or rating thresholds.

- [ ] **Step 4: Render compact desktop and mobile memory presentations**

Desktop uses one compact image row before timeline. Mobile may horizontally scroll cards but constrains height/width so the first timeline heading remains visible in the first viewport. Use `MediaWithPlaceholder`, `resolveAssetUrl`, fixed aspect ratio, `object-fit: cover`, and 44px interactive retry target.

- [ ] **Step 5: Enable the history-only insight query, isolate failure and refresh on all facts**

Extend `useAppWorkspaceQueries` with `needsMealInsights = primaryTab === 'eat' && baseView === 'history'`, but exclude it from global `isBootLoading`. Pass independent insight query status into workspace; timeline renders regardless. Ensure MealLog record/composition/rating/undo/cook/plan/AI success and Food name/type/cover changes invalidate `mealInsights` through Task 9 helpers.

- [ ] **Step 6: Run the phase-two release gate**

```bash
(cd backend && .venv/bin/python -m pytest tests/meal_logs/test_meal_log_insights.py -q)
npm --prefix frontend run test -- \
  src/features/meals/MealMemoryStrip.test.tsx \
  src/features/meals/MealLogWorkspaceModel.test.ts \
  src/app/useAppWorkspaceQueries.test.tsx \
  src/api/cacheInvalidation.test.ts
npm --prefix frontend run build
npm --prefix frontend run smoke
```

Expected: PASS; forcing insights 500 leaves timeline visible and retryable, forcing `[]` removes the entire memory section.

- [ ] **Step 7: Commit family memory UI**

```bash
git add frontend/src/features/meals/MealMemoryStrip.tsx \
  frontend/src/features/meals/MealMemoryStrip.test.tsx \
  frontend/src/features/meals/MealLogWorkspace.tsx \
  frontend/src/features/meals/MealLogMobileView.tsx \
  frontend/src/features/meals/MealLogWorkspaceModel.ts \
  frontend/src/features/meals/MealLogWorkspaceModel.test.ts \
  frontend/src/app/useAppWorkspaceQueries.ts \
  frontend/src/styles/08-meal-log.css frontend/src/styles/07-mobile.css \
  frontend/scripts/smoke.mjs
git commit -m "feat: show family meal memories"
```

### Task 19: Run Full Acceptance, Review and Rollback Gates

**Files:** No new feature files; fixes remain in the task that owns the failing contract.

**Interfaces:**

- Consumes: Tasks 1–18 and both approved phase gates.
- Produces: one green feature worktree, documented validation evidence, no P0/P1 review findings, and an explicit release/rollback decision.

- [ ] **Step 1: Run static repository and contract scans**

```bash
rg -n "quick-add|QuickAddMealLog|基础记录|已丰富|待补充|未评分|手动补录|菜单计划" \
  backend/app frontend/src frontend/scripts
rg -n "meal_log" backend/app/services/search/jobs.py backend/app/services/search/documents.py
git diff --check origin/main...HEAD
```

Expected: no legacy quick-add or user-visible debt/source copy; any remaining “菜单计划” is limited to actual plan workspace semantics, not MealLog timeline badges; search entity set still excludes MealLog; diff check is clean.

- [ ] **Step 2: Run complete backend migration and tests**

```bash
npm run db:up
npm run backend:migrate
npm run backend:test
```

Expected: migration upgrades existing data with `row_version=1`, only one Alembic head remains, all backend tests PASS.

- [ ] **Step 3: Run complete frontend quality, build and smoke**

```bash
npm run frontend:quality
npm run frontend:build
npm run frontend:smoke
npm --prefix frontend run check:style-tokens
```

Expected: tests/typecheck/lint/build/smoke PASS; style report has no unexplained new drift.

- [ ] **Step 4: Execute manual mobile usability matrix**

At 375px, 390px and 430px, plus desktop, verify single Food, three Foods, zero/single/multi candidates, inline new Food, Home/Food/Ingredient/Eat current-surface result bars, refresh recovery, new-meal undo, append undo preserving original, plan-completion timeout replay, Recipe target without ordinary undo, composition conflict reconfirm, optional rating, photo fallback, insights empty/error/success, keyboard visibility, safe area and 44px targets. Record median timing for prefilled Food (target <=10s) and inline new Food (target <=15s), without counting inventory/menu/conflict recovery.

- [ ] **Step 5: Run two-stage review**

Use `superpowers:requesting-code-review` once for spec compliance and once for implementation quality. Review must explicitly inspect family isolation, non-null/preallocated winner MealLog identity, request/revert replay snapshots, operation effect scope, global Food-before-MealLog lock order, full stale current serialization, MealLog parent bump coverage, plan timeout convergence, every Home/Food/Ingredient/Recipe/Eat owner, shared result-bar restore/exclusions, entry identity preservation, old AI draft compatibility, no MealLog search scope, query invalidation and mobile debt-free copy. Fix P0/P1 findings in their owning task and rerun affected/full gates.

- [ ] **Step 6: Rehearse release and rollback**

Release order: database backup → stop old-backend writes → Alembic upgrade → new backend → authenticated disposable-family API smoke → new frontend. Do not run old/new writers together because old code does not maintain `MealLog.row_version`. Rollback hides new Composer/insight entry points but retains additive table/column and operation identities; never re-enable silent merge or bulk-reverse inventory/CookLog/menu/activity facts.

- [ ] **Step 7: Hand off branch completion**

Use `superpowers:finishing-a-development-branch` only after all gates are green. Report every command actually run, failures and fixes, migration head, manual viewport results, remaining non-blocking risks, and whether the branch is ready for PR. Do not merge or push without the user's explicit instruction.

## Execution Handoff

Plan complete. Future implementation has two supported modes:

1. **Subagent-Driven (recommended):** in a fresh execution session/worktree, use `superpowers:subagent-driven-development`, one task at a time with review gates.
2. **Inline Execution:** in a fresh execution session/worktree, use `superpowers:executing-plans`, execute in batches with checkpoints.

Both modes must begin at the Execution Baseline Gate and must not work directly on `main`.

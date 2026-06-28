# 单元测试优化清单

更新时间：2026-06-28

状态：P0 后端基线修复已完成。`/api/recipe-plan` 无 `q` 查询、菜谱列表 `q` 搜索未建索引兜底、后端 search provider 测试隔离已经落地，并通过 `npm run backend:test` 验证。`GlobalSearchOverlay.test.tsx` 的 `act(...)` warning 已消除。P1 的前端 API/query/cache contract 测试已补齐到 `client.test.ts`、`queryKeys.test.ts`、`cacheInvalidation.test.ts`，并通过前端全量 Vitest 验证。P1 后端 `activity_logs.py`、`family.py`、`shopping_list.py`、`inventory.py` 权限/跨家庭矩阵已补齐，普通 CRUD 写路径的 shopping list、inventory、family/member settings 审计字段和活动日志断言已补齐，media binding、inventory deduction、shopping list update 的事务失败/回滚用例已补齐。P1 前端 `lib/date.ts`、`lib/storage.ts`、`lib/media.ts`、`lib/ingredientTracking.ts`、`lib/ingredientUnits.ts` 边界测试已补齐。P2 已完成 `AiWorkspace.test.tsx` 拆分、共享测试 helper 和 search 测试 support 抽取。P3 已完成覆盖率基线脚本、CI 分组 workflow、smoke 独立非阻塞 check 和测试环境默认值文档。

## 背景

本清单基于当前工作区测试目录、项目规范和实际测试命令结果，目标是逐步梳理 Culina 现有单元/组件/服务测试的有效性、覆盖缺口和维护成本。这里不把“每个源码文件都有同名测试”当作目标；Culina 的后端有大量 API/service 集成式 pytest，前端有较多 model/helper/component Vitest，优化重点应放在业务边界、测试隔离、失败信号可信度和大文件拆分上。

## 当前测试基线

- 后端测试入口：`npm run backend:test`，实际执行 `cd backend && .venv/bin/python -m pytest tests`。
- 前端测试入口：`npm --prefix frontend run test`，实际执行 `vitest run`，配置见 `frontend/vite.config.ts`，测试环境为 `jsdom`。
- 前端 smoke 入口：`npm --prefix frontend run smoke`，属于布局/关键路径 smoke，不是单元测试，但会影响测试健康判断。
- 当前已引入 `pytest-cov` 和 `@vitest/coverage-v8`，覆盖率命令只记录基线，不设置强制阈值。

## 实际验证结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `cd backend && .venv/bin/python -m pytest --collect-only -q tests` | 371 tests collected | 后端用例集中在 `ai_infra`、`recipes`、`search`、`media`、`core`、`account`。 |
| `npm --prefix frontend run test -- --reporter=dot` | 31 files / 288 tests passed | 全部通过，但 `GlobalSearchOverlay.test.tsx` 出现 React `act(...)` warning。 |
| `npm run backend:test` | 363 passed / 8 failed | 失败集中在 recipe/search。search 失败受本地真实 search provider 环境影响，recipe 失败仍需修。 |
| `SEARCH_EMBEDDING_PROVIDER=disabled SEARCH_VECTOR_BACKEND=disabled SEARCH_RERANK_PROVIDER=disabled ... pytest <search/recipe subset>` | 4 passed / 2 failed | search 相关失败消失；recipe 两个失败仍存在。 |
| `SEARCH_EMBEDDING_PROVIDER=disabled SEARCH_VECTOR_BACKEND=disabled SEARCH_RERANK_PROVIDER=disabled ... pytest tests/search/test_hybrid_search.py::<2 cases>` | 2 passed | 证明此前 hybrid search 两个失败不是稳定业务断言，而是环境隔离不足。 |
| `npm --prefix frontend run smoke` | failed | 失败信息：`1180x820 首页摘要布局异常：主区 2 列，临期 1 列，待办 1 列，记录 1 列`。这是 smoke 基线问题，不应和单元测试通过率混用。 |

## 当前失败与可信度判断

### 必须先修复的真实失败

1. `backend/tests/recipes/test_recipe_cooking.py::RecipeRecipeCookingTestCase::test_cook_recipe_deducts_inventory_and_creates_meal_log`
   - 失败点：`GET /api/recipe-plan?date_from=...&date_to=...`。
   - 直接原因：`backend/app/api/recipe_meta.py:list_recipe_plan()` 直接调用 `list_food_plan()`，但没有显式传 `q`，导致 FastAPI 的 `Query()` 默认对象被当成字符串使用，触发 `AttributeError: 'Query' object has no attribute 'strip'`。
   - 判断：这是有效测试，暴露真实 API 复用方式问题，不应删除。

2. `backend/tests/recipes/test_recipe_discovery.py::RecipeRecipeDiscoveryTestCase::test_recipe_list_supports_query_filters_sort_and_pagination`
   - 失败点：创建两个“松饼”菜谱后，`GET /api/recipes?q=松饼&scene=早餐&difficulty=medium` 返回空集合。
   - 隔离 search provider 后仍失败。
   - 判断：这是有效测试，暴露菜谱列表查询/过滤路径当前不满足预期，需定位是搜索改造改变了 `q` 语义，还是测试缺少索引处理步骤。

### 无效或脆弱测试信号

1. search 测试默认读取本机 `.env`，导致单测访问真实外部服务。
   - 证据：`npm run backend:test` 中 search 失败日志包含真实 embedding、rerank 和 Qdrant HTTP 请求。
   - 影响：测试结果受开发机 `.env`、网络和外部服务状态影响；同一个测试在禁用 provider 后通过。
   - 处理：后端测试环境应默认强制 `SEARCH_EMBEDDING_PROVIDER=disabled`、`SEARCH_VECTOR_BACKEND=disabled`、`SEARCH_RERANK_PROVIDER=disabled`，只有明确测试 provider client 的用例才用 fake transport/mock client。

2. `backend/tests/search/test_search_api.py::test_search_api_returns_family_scoped_keyword_results` 对 `degraded is True` 的断言依赖 provider 是否启用。
   - 当前真实 provider 可用时 `degraded` 为 `False`，禁用 provider 后为 `True`。
   - 处理：该测试应改名为 keyword degradation 场景并显式 patch settings，或拆成“纯 keyword fallback”和“hybrid provider enabled”两个场景。

3. `backend/tests/search/test_write_path_indexing.py` 里对 `vector_status == "disabled"` / `_index_vector_if_enabled() == "skipped"` 的断言依赖全局 search provider 设置。
   - 处理：测试类级别 patch `app.services.search.indexing.get_settings` / job 层 settings，固定为 disabled；另设专门的 vector enabled 测试使用 fake embedding/vector store。

4. `frontend/src/features/search/GlobalSearchOverlay.test.tsx` 通过但产生 React `act(...)` warning。
   - 影响：warning 会掩盖真实异步状态更新问题，也降低 CI 输出可读性。
   - 处理：用 fake timers 或 React Testing Library 风格的 async helpers 替代裸 `setTimeout(360)`；如果继续使用 `createRoot` 手写渲染，需要保证 query settle 和 debounce flush 都被 `act` 包住。

5. `npm --prefix frontend run smoke` 失败不应作为单元测试失败归因。
   - smoke 是布局/交互基线检查，应单独跟踪；当前失败说明首页摘要布局断言或实现需要对齐，但不代表 Vitest 单元测试无效。

## 覆盖缺口

### 后端覆盖缺口

1. 路由层缺少系统化权限失败和跨家庭访问矩阵。
   - 已有 AI、recipe、search 局部测试覆盖较好，但 `activity_logs.py`、`family.py`、`shopping_list.py`、部分 `foods.py` / `ingredients.py` / `inventory.py` 路由没有同等强度的 owner/member/cross-family 失败用例。
   - 建议：按业务对象补“当前家庭可访问、其他家庭拒绝、未授权拒绝、owner-only 拒绝”四类最小矩阵。

2. 活动日志与审计字段覆盖不均衡。
   - AI approval 有测试检查 audit fields/activity logs，但普通 CRUD 写入路径不一致。
   - 建议：对新增/编辑/删除类 API 抽样补 `created_by`、`updated_by`、`ActivityLog` 断言，优先覆盖 inventory、shopping list、family/member settings。

3. 搜索配置和 search service 测试缺少统一 fixture。
   - search 单测目前混合了 fake client、真实 settings、全局 `.env`。
   - 建议：新增 `backend/tests/search/_support.py`，集中提供 disabled settings、fake embedding、fake vector store、fake rerank client 和 in-memory DB factory。

4. 数据库迁移缺少自动校验测试。
   - 当前主要测试 ORM/API 行为，没有看到 Alembic revision 顺序、head 唯一性、model/migration 基本同步的快速测试。
   - 建议：新增 core/db migration smoke，至少验证 `alembic heads` 单 head、迁移脚本可导入，以及关键新增表/字段存在于 metadata。

5. API serializer contract 覆盖不足。
   - `core/test_serializers.py` 只覆盖时间序列化；大量 schema/serializer 输出依赖 API 集成测试间接覆盖。
   - 建议：对媒体 URL、数量单位、meal plan、inventory item、AI draft/approval card 等跨端字段建立小型 serializer contract 测试。

6. 错误路径和事务回滚覆盖不均衡。
   - AI composite rollback 已覆盖较好，但普通库存扣减、购物清单、媒体绑定失败后的回滚/清理需要补强。
   - 建议：优先补“部分写入失败时不留下 search index job / activity log / media binding 半成品”的用例。

### 前端覆盖缺口

1. App 级数据编排 hook 覆盖不足。
   - `useAppWorkspaceQueries.ts`、`useAppMutations.ts`、`useAppHomeViewModel.ts`、`useAppGlobalSearchNavigation.ts` 多数没有直接测试。
   - 建议：把可测试的导航映射、缓存失效触发、workspace 查询启停规则拆到 model/helper 后补 Vitest。

2. API client 和 cache/query contract 覆盖不足。
   - 当前有 `client.test.ts`、`aiApi.test.ts`，但 `foodsApi.ts`、`ingredientsApi.ts`、`recipesApi.ts`、`searchApi.ts`、`cacheInvalidation.ts`、`queryKeys.ts` 缺少契约测试。
   - 建议：至少覆盖 query key shape、mutation invalidation 范围、search 参数序列化、media upload 错误处理。

3. 移动端主路径覆盖不足。
   - 很多移动端 view 没有组件级测试或 smoke 场景，如 `IngredientMobileView.tsx`、`RecipeMobileLibraryView.tsx`、`MealLogMobileView.tsx`、`FamilyMobileView.tsx`。
   - 建议：不要逐个做 snapshot；优先覆盖移动端最常用动作：筛选、打开详情、提交库存/餐食记录、底部操作入口。

4. AI 前端覆盖过度集中。
   - `frontend/src/components/ai/AiWorkspace.test.tsx` 约 7000 行、126 个用例，承担 live sync、approval、streaming、attachments、run events、mobile/desktop 组合等多种职责。
   - 建议：按责任拆分为 `aiWorkspaceLiveSync.test.tsx`、`aiWorkspaceApprovalFlow.test.tsx`、`aiWorkspaceAttachments.test.tsx`、`aiConversationThread.test.tsx`、`aiMobilePage.test.tsx` 等，保留少量端到端式 workspace 组合用例。

5. 纯工具函数覆盖缺口。
   - `lib/date.ts`、`lib/storage.ts`、`lib/media.ts`、`lib/ingredientTracking.ts`、`lib/ingredientUnits.ts` 没有直接测试。
   - 建议：这些文件属于低成本高收益单测，优先补边界值、空值、中文单位和日期跨天场景。

6. 样式 token 和响应式行为缺少稳定测试边界。
   - 已新增 `check:style-tokens` 脚本，但它不是 Vitest；smoke 当前也失败。
   - 建议：将样式 token 漂移检查纳入 `frontend:quality` 后，单独修复 smoke 基线；不要用组件单测断言大量 class/style 细节。

## 过度测试与可清理项

1. 大型端到端式单测文件需要拆分，而不是继续堆用例。
   - `AiWorkspace.test.tsx` 体量过大，维护成本高，失败定位慢。
   - 清理方向：抽共享 fixture builders、render helper、stream event helper；把纯合并/排序/状态判断逻辑下沉到 helper/model 并用小单测覆盖。

2. 避免在单测里断言搜索排序的完整列表，除非测试目的就是排序。
   - `test_hybrid_search_adds_food_inventory_and_recent_usage_signals` 断言完整顺序，容易被评分权重微调打破。
   - 优化方向：对 business signal 测试断言“今天到期 reason 存在且 business_score 增加”；排序策略另设少量专门用例。

3. 避免测试依赖本地 `.env` 默认值。
   - `Settings()` 会读取 `backend/.env`，这对“默认值测试”和“禁用 provider 测试”都危险。
   - 清理方向：默认值测试统一使用 `Settings(_env_file=None)`；业务测试统一 patch `get_settings()` 或设置 env。

4. 避免用 `setTimeout` 等真实时间等待模拟 debounce。
   - 前端搜索测试当前等 360ms，速度慢且易产生 `act` warning。
   - 清理方向：使用 `vi.useFakeTimers()` 和 `vi.advanceTimersByTimeAsync()`，或把 debounce 输入 hook 单独测试，组件测试只验证 query value 已传入。

5. 避免重复覆盖同一 contract 的低价值断言。
   - AI workspace 中多处 approval 按钮/文本断言可能覆盖同一个渲染细节。
   - 清理方向：每个 contract 保留一个“展示正确”和一个“提交 payload 正确”用例；其他流程只断言关键状态变化。

## 优化任务清单

### P0：先恢复测试基线可信度

- [x] 修复 `list_recipe_plan()` 复用 `list_food_plan()` 时 `q` 默认值为 FastAPI `Query()` 对象的问题；现有做菜后查询 `/api/recipe-plan` 的 API 测试已覆盖无 `q` 查询。
- [x] 定位 `GET /api/recipes?q=松饼&scene=早餐&difficulty=medium` 返回空集合的原因；代码已在 search index 尚未生成时回退到家庭范围内的数据库文本匹配。
- [x] 给后端测试增加全局 search provider 禁用 fixture，确保普通单测不会访问真实 embedding/rerank/Qdrant。
- [x] 将当前 search provider enabled 场景改成显式 fake client / fake transport 测试，禁止默认走真实网络；现有 provider client 用例仍通过 fake transport / monkeypatch 覆盖。

### P1：补关键业务覆盖缺口

- [x] 为 `activity_logs.py`、`family.py`、`shopping_list.py`、`inventory.py` 建立权限/跨家庭失败用例矩阵。
  - [x] `shopping_list.py`：已覆盖当前家庭列表、跨家庭 ingredient 创建拒绝、跨家庭 item 更新拒绝、未认证拒绝。
  - [x] `inventory.py`：已覆盖当前家庭列表、跨家庭 ingredient 入库/消费拒绝、跨家庭库存批次销毁拒绝、未认证拒绝。
  - [x] `activity_logs.py`：已覆盖当前家庭动态列表、跨家庭动态隔离、actor name 仅来自当前家庭成员、未认证拒绝。
  - [x] `family.py`：已覆盖当前家庭详情、成员列表隔离、owner-only、跨家庭 member 更新拒绝、未认证拒绝。
- [x] 为普通 CRUD 写路径补审计字段和活动日志断言，优先 inventory、shopping list、family/member settings。
  - [x] `shopping_list.py`：已覆盖创建和更新的 `created_by` / `updated_by` 与 `ActivityLog`。
  - [x] `inventory.py`：已覆盖入库、消费、销毁路径的 `created_by` / `updated_by` 与 `ActivityLog`。
  - [x] family/member settings：已覆盖家庭信息更新、成员创建、成员更新的审计字段与 `ActivityLog`。
- [x] 为 media binding、inventory deduction、shopping list update 补事务失败/回滚用例。
  - [x] media binding：已覆盖家庭图片绑定在提交失败时回滚 family 字段、媒体绑定和活动日志。
  - [x] inventory deduction：已覆盖库存消费扣减在提交失败时回滚 `consumed_quantity`、`updated_by` 和活动日志。
  - [x] shopping list update：已覆盖购物项完成状态更新在提交失败时回滚 `done` 和活动日志。
- [x] 为 `cacheInvalidation.ts`、`queryKeys.ts`、`searchApi.ts`、`foodsApi.ts`、`ingredientsApi.ts`、`recipesApi.ts` 增加前端契约单测。
- [x] 为 `lib/date.ts`、`lib/storage.ts`、`lib/media.ts`、`lib/ingredientTracking.ts`、`lib/ingredientUnits.ts` 增加低成本边界测试。
  - [x] `lib/date.ts`：已覆盖本地日期 key、跨月/跨年加减、周范围和日期差。
  - [x] `lib/storage.ts`：已覆盖 JSON/string 读写、损坏 JSON 回退、清理策略和 localStorage 异常。
  - [x] `lib/media.ts`：已覆盖 AI cover 元数据/SVG data URL 和上传文件转 PhotoAsset。
  - [x] `lib/ingredientTracking.ts`：已覆盖默认记录数量和 presence-only 文案。
  - [x] `lib/ingredientUnits.ts`：已覆盖单位归一化、无效换算过滤、双向换算、库存剩余/消耗和过期批次过滤。

### P2：降低测试维护成本

- [x] 拆分 `AiWorkspace.test.tsx`，按 live sync、approval、attachments、run events、conversation rendering、mobile chrome 分文件。
  - [x] 已先迁出 mobile viewport 和 thread auto-scroll 覆盖：`AiMobilePage.test.tsx`、`useAiThreadAutoScroll.test.tsx`。
  - [x] 已迁出流式文本合并和最终消息去重 helper 覆盖：`aiWorkspaceHelpers.test.ts`。
  - [x] 已迁出质量诊断和 attachments 覆盖：`AiWorkspaceQualityDiagnostics.test.tsx`、`AiWorkspaceAttachments.test.tsx`。
  - [x] 已迁出 `MessageBubble` footer/media、human input、run activity 和 approval gating 覆盖：`AiConversationThread.test.tsx`。
  - [x] 已迁出 `ApprovalPanel` 结构化审批表单覆盖：`AiApprovalPanel.test.tsx`。
  - [x] 已迁出 live sync 与 conversation migration 覆盖：`AiWorkspaceLiveSync.test.tsx`。
  - [x] 已抽出共享 workspace 测试 fixture：`aiWorkspaceTestFixtures.ts`。
- [x] 抽取前端组件测试通用 render helpers，统一 QueryClient、root cleanup、API mock reset 和 async flush。
  - [x] 已新增基础 `renderWithQuery` helper，并让 `AiWorkspace.test.tsx`、移动页和 auto-scroll 测试复用统一 React root、QueryClientProvider、mock reset、DOM cleanup 和 async flush/wait helper。
- [x] 抽取后端 search 测试 `_support.py`，统一 fake DB、settings、embedding/vector/rerank fake。
  - [x] 已新增 `tests/search/_support.py`，统一内存 SQLite session factory、search settings、embedding/vector/rerank fake，并迁移 hybrid/vector indexing/vector cleanup 测试复用。
- [x] 把 hybrid search 排序测试分成“特征加分”和“最终排序”两类，减少权重微调造成的大面积失败。
  - [x] 已新增 `test_hybrid_ranking_features.py` 直接覆盖 literal fallback、rerank bucket 和 disabled rerank 的特征规则。
  - [x] 已放松 `test_hybrid_search.py` 端到端排序用例中的精确 score 断言，保留最终顺序、过滤和命中原因验证。
- [x] 将 `GlobalSearchOverlay.test.tsx` 改为 fake timers，消除 `act(...)` warning。

### P3：建立长期质量门禁

- [x] 引入覆盖率工具并先只记录基线，不立即设置高阈值。
  - [x] 后端已引入 `pytest-cov`，`npm run backend:test:coverage` 输出 `backend/app` 行覆盖、分模块覆盖和 `backend/coverage.json`。
  - [x] 前端已引入 `@vitest/coverage-v8`，`npm run frontend:test:coverage` 输出 `frontend/src` 覆盖和 `frontend/coverage/coverage-summary.json`。
- [x] 在 CI 中拆分命令：后端 unit/service、后端 AI infra、后端 search、前端 Vitest、前端 build、前端 smoke。
  - [x] 已新增 `.github/workflows/quality-gates.yml`，按后端 service/AI/search 和前端 Vitest/build/smoke 拆分 job。
- [x] 为 smoke 建立单独 issue/check，不让它和 Vitest 单元测试互相污染结论。
  - [x] `frontend-smoke` 已作为独立非阻塞 check；当前已知失败为 `1180x820 首页摘要布局异常`，记录在 `docs/plans/test-quality-gates.md`。
- [x] 文档化测试环境变量默认值，尤其是 AI/search/media provider 默认禁用策略。
  - [x] 已新增 `docs/plans/test-quality-gates.md`。

## 建议执行顺序

1. 先修 P0 两个 recipe 失败和 search 测试隔离，否则全量测试结果不可信。
2. 再补 P1 的权限、跨家庭、审计字段和前端 API contract 覆盖。
3. 然后拆分 `AiWorkspace.test.tsx` 和 search 测试 fixture，降低后续改动成本。
4. 最后引入覆盖率基线和 CI 分组门禁，避免为了覆盖率数字反向制造低价值测试。

## 后续验证命令

完成 P0 后至少运行：

```bash
cd backend && SEARCH_EMBEDDING_PROVIDER=disabled SEARCH_VECTOR_BACKEND=disabled SEARCH_RERANK_PROVIDER=disabled SEARCH_EMBEDDING_MODEL= SEARCH_EMBEDDING_DIMENSIONS=0 QDRANT_URL= QDRANT_COLLECTION= .venv/bin/python -m pytest tests/recipes tests/search -q
npm run backend:test
npm --prefix frontend run test
npm --prefix frontend run smoke
```

文档或清单更新本身不要求跑完整构建；涉及前端测试 helper 或组件拆分后，应补跑 `npm --prefix frontend run build`。

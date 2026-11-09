# 家庭共享餐食计划实施与验证

对应规格：`../specs/2026-11-09-family-shared-meal-plans.md`。

1. 添加同家庭协作与跨家庭隔离回归测试，确认当前个人隔离行为导致测试失败。
2. 将 API、共享锁服务、直接完成、做菜与记录餐食中的计划授权统一为家庭范围。
3. 同步 AI 读取、草稿校验、审批执行、低风险新增计划去重和 Skill 指令。
4. 将精确、关键词、全文和向量搜索统一到家庭范围，兼容现有带创建者元数据的索引。
5. 新增 migration：创建者外键改为可空且删除时 SET NULL；调整 ORM 关系、响应 schema 与前端类型。
6. 执行相关后端集成/契约测试、搜索测试、migration 验证、前端定向测试与 typecheck，并审阅 diff。

## 完成与验证记录

上述步骤均已完成。另修复 MySQL 并发下锁后查询复用旧 ORM 计划状态的问题：获得计划锁后使用 `populate_existing` 刷新状态，避免两个家庭成员同时完成时抛出非业务异常。

仓库根目录执行：

```bash
npm run frontend:typecheck
npm run frontend:test -- src/api/foodsApi.test.ts src/api/cacheInvalidation.test.ts src/lib/aiWorkspaceContracts.test.ts src/app/domainQueryContracts.test.tsx src/components/foods/useFoodPlanState.test.tsx src/features/home/homeDashboardModel.test.ts
git diff --check
```

前端 6 个测试文件、71 项通过；typecheck 和差异检查通过。前端仅调整创建者引用的可空类型；没有布局或响应式改动，未执行浏览器视口检查、build 或 E2E。

`backend/` 目录执行：

```bash
.venv/bin/python -m pytest tests/recipes/test_shared_food_plan.py tests/recipes/test_food_workspace.py tests/recipes/test_recipe_cooking.py tests/recipes/test_business_consistency.py tests/meal_logs tests/search tests/ai_infra/test_tool_registry.py tests/ai_infra/test_ai_draft_contracts.py tests/ai_infra/test_workspace_approvals.py tests/ai_infra/test_composite_operations.py tests/ai_infra/test_ai_auto_execution_action_policies.py tests/ai_infra/test_ai_revert_low_risk_adapters.py tests/ai_infra/test_skill_contract_repairs.py tests/ai_infra/test_skill_contract_v3.py -q --tb=short
.venv/bin/python -m pytest tests/core/test_migration_smoke.py -q
.venv/bin/python -m pytest tests/recipes/test_shared_food_plan.py tests/core/test_migration_smoke.py -q --tb=short
.venv/bin/python -m pytest tests/ai_infra/test_workspace_approvals.py -k meal_plan -q --tb=short
.venv/bin/python -m compileall -q app tests/recipes/test_shared_food_plan.py tests/recipes/test_shared_food_plan_mysql.py
.venv/bin/alembic heads
```

主定向回归 718 项通过、64 个 subtest 通过；其中 4 个依赖 MySQL 的测试在这次调用中跳过，已在下面的隔离数据库调用中单独执行通过。migration 图检查 7 项通过；最后补充参与人断言后的共享菜单与图检查共 16 项通过，调整家庭审批文案后再次执行的餐食计划审批测试 9 项通过。唯一 Alembic head 为 `d6e7f8a9b0c1`。

设置 `CULINA_TEST_MYSQL_URL` 指向临时回环地址上的 MySQL 8.4 测试库后执行：

```bash
.venv/bin/python -m pytest tests/recipes/test_shared_food_plan_mysql.py -q --tb=short
.venv/bin/python -m pytest tests/meal_logs/test_meal_log_mysql_concurrency.py -q --tb=short
```

分别 3 项和 4 项通过，覆盖历史数据迁移、重复升级、可逆回退、拒绝丢失创建者的破坏性回退、创建者删除保留计划、两名成员并发完成只落一份餐食，以及原有记餐并发与幂等规则。

现有配置中的数据库不在本机，本次未连接或迁移该数据库；正式环境需随发布执行 `npm run backend:migrate`。既有菜单自动按所属家庭可见，既有搜索索引无需重建。

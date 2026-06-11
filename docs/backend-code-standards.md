# 后端代码规范

更新时间：2026-06-11

本文档定义 Culina 后端日常开发的默认约定。后端是家庭饮食数据、权限、媒体、AI 草稿审批和业务写入的唯一可信边界，所有实现都必须优先保证家庭数据隔离、操作者追踪和可验证的业务规则。

## 1. 技术栈与入口

- 技术栈：FastAPI、SQLAlchemy 2、Alembic、Pydantic、MySQL、pytest。
- 后端目录：`backend/`。
- 应用入口：`backend/app/main.py`。
- 路由聚合：`backend/app/api/router.py`。
- 数据库会话：`backend/app/db/session.py`。
- 迁移目录：`backend/alembic/versions/`。
- 测试目录：`backend/tests/`。

常用命令：

```bash
npm run backend:venv
npm run db:up
npm run backend:init-db
npm run backend:migrate
npm run backend:dev
npm run backend:test
```

## 2. 职责分层

后端代码按以下职责归属：

- `backend/app/api/`：FastAPI 路由、请求参数、权限依赖、HTTP 状态码和事务收口。
- `backend/app/schemas/`：Pydantic 请求、响应、DTO 和跨端合约。
- `backend/app/models/`：SQLAlchemy 2 ORM 模型、关系、约束和持久化字段。
- `backend/app/services/`：业务规则、跨模型编排、序列化、媒体绑定、库存扣减等应用逻辑。
- `backend/app/repos/`：可复用数据访问逻辑，避免路由中重复复杂查询。
- `backend/app/core/`：配置、枚举、权限依赖、安全、日志和通用工具。
- `backend/app/ai/`：AI workspace、skills、tools、runtime、planner、审批和图执行。

路由函数可以组织请求流程，但不应承载大段业务规则。复杂规则优先下沉到 service 或 repo，并补测试。

## 3. API 与权限

新增或修改 API 时：

- 使用 `get_current_auth`、`get_current_user`、`get_current_membership` 或 `require_owner` 获取身份和权限。
- 所有家庭业务数据查询和写入必须约束到当前 membership 的 `family_id`。
- Owner 专属能力必须显式使用 Owner 权限检查。
- 响应模型使用 `response_model` 或明确的 Pydantic schema，避免直接暴露 ORM 对象。
- HTTP 错误使用 FastAPI `HTTPException`，状态码和错误文案保持现有风格。
- 新路由需要挂到 `backend/app/api/router.py`。

不要相信前端传来的 `family_id`、`created_by`、`updated_by` 或权限字段；这些必须来自当前认证上下文。

## 4. 数据模型与迁移

持久化 schema 变更必须包含 Alembic migration：

- 新字段、表、索引、枚举存储变化、约束变化都要新增 migration。
- 不要修改已经合入的 migration 来表达新需求。
- ORM model、Pydantic schema、serializer、API 返回、测试和前端类型需要同步检查。
- 枚举优先定义在 `backend/app/core/enums.py`，不要在业务代码中散落自由字符串。
- 金额、数量、库存等精确数值在数据库层优先使用 `Decimal` / `Numeric`，序列化时按现有模式转换。

迁移应兼容已有数据。涉及数据回填或枚举归一化时，在 migration 中明确处理已有值。

## 5. 事务、活动日志与审计字段

写操作必须有清晰事务边界：

- 优先复用 `backend/app/db/transactions.py` 中的事务辅助。
- 同一用户动作产生的多表变更应在同一事务中提交。
- 出错时必须 rollback，不留下部分写入。
- 媒体、草稿、库存扣减等带外资源需要考虑失败清理或幂等恢复。

需要操作者追踪的实体必须维护：

- `created_by`
- `updated_by`
- `created_at`
- `updated_at`

新增、编辑、删除、邀请、切换等用户可见动作应通过 `backend/app/services/activity.py` 记录活动日志，保证家庭动态能回答“谁在什么时候做了什么”。

## 6. 业务边界

Culina 的核心边界：

- 一个业务对象只属于一个家庭，跨家庭引用必须禁止。
- `Food`、`Recipe`、`Ingredient`、`InventoryItem`、`ShoppingListItem`、`MealLog` 等实体都要按家庭隔离。
- 自做菜和菜谱存在同步关系时，优先复用 `recipe_food_sync` 相关逻辑，不重复实现。
- 库存扣减、单位换算和菜谱可做性优先复用 `inventory_usage`、`ingredient_units` 等 service。
- 媒体资产绑定、更新和归属校验优先复用 `backend/app/services/media.py` 与 `backend/app/repos/media.py`。

任何跨模块业务规则变更，都需要同时检查 API、service、serializer、测试和前端调用。

## 7. AI 与审批写入

AI 相关后端逻辑必须遵循 `docs/ai-assistant-standards.md`：

- 模型只能读家庭上下文、调用白名单工具、生成草稿或卡片。
- 正式业务写入必须经过 `draft -> approval -> commit`。
- 模型不能直接接触 write tool。
- 用户确认后由 service 执行正式写入，模型不参与 commit 决策。

AI tool、skill、planner、runtime、approval 的变更优先补 `backend/tests/test_ai_agent_infra.py` 或相关后端测试。

## 8. 序列化与跨端契约

API 返回结构必须稳定：

- 统一通过 schema 和 serializer 输出前端需要的字段。
- 不要让前端依赖 ORM 内部字段、关系加载副作用或数据库枚举实现细节。
- 修改字段名、枚举值、卡片类型、草稿类型、日期格式、媒体 URL 或数量单位时，同步更新前端类型和测试。
- 日期、时间和家庭本地时间逻辑优先复用 `backend/app/services/clock.py`。

涉及前后端共同理解的类型，必须同时检查 `frontend/src/api/types.ts` 和相关 contract 测试。

## 9. 测试与验证

按风险选择验证：

- 路由、权限、service、serializer 或 AI tool 变更：运行相关 pytest，必要时运行 `npm run backend:test`。
- 数据库模型和 migration 变更：执行 Alembic upgrade，并覆盖关键读写路径。
- 跨端 contract 变更：同时运行后端相关 pytest 和前端相关 Vitest。
- 媒体、库存、AI 审批等多步骤流程：补集成式 API 测试。

推荐命令：

```bash
npm run backend:test
backend/.venv/bin/python -m pytest backend/tests/test_recipe_flows.py -q
backend/.venv/bin/python -m pytest backend/tests/test_ai_agent_infra.py -q
```

## 10. Review Checklist

提交前检查：

- 查询和写入是否都按当前 `family_id` 隔离？
- 是否使用了正确的认证和 Owner 权限依赖？
- schema、model、serializer、前端类型是否同步？
- 持久化变更是否有 Alembic migration？
- 写操作是否维护审计字段和活动日志？
- 是否复用了现有 service/repo，而不是在路由里复制业务逻辑？
- 是否覆盖了权限失败、跨家庭访问、正常写入和关键边界场景？

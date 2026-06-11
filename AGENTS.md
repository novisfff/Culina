# Culina AI 辅助开发指南

本文件用于引导 Codex、Claude Code 等 AI 辅助开发工具在 Culina 项目中工作。开始修改前，先阅读当前实现和相关文档，不要只按通用模板推断项目结构。

## 项目定位

Culina 是一个移动优先的家庭饮食管理 Web/PWA，服务中国家庭的日常菜谱、食物、食材库存、购物清单、餐食记录和 AI 辅助决策。

默认产品语境：

- 语言与文案优先使用简体中文。
- 体验优先级是家庭日常记录、低维护成本、清晰责任归属和温暖照片驱动 UI。
- AI 能力是实用助手，不是开放式泛聊天；建议必须基于家庭上下文，并避免医疗、营养诊断式承诺。
- 移动端是主要体验，不要把移动端当作桌面页面的简单压缩版。

## 仓库结构

- `frontend/`：React 18 + Vite + TypeScript + React Query 前端，包含 PWA 资源、样式和前端测试。
- `backend/`：FastAPI + SQLAlchemy 2 + Alembic 后端，使用 MySQL 持久化，包含 API、模型、服务、AI tools/skills 和 pytest 测试。
- `deploy/`：Docker Compose、MySQL、MinIO、后端和 nginx 前端部署配置。
- `docs/`：项目开发规范，只保留前端代码规范、后端代码规范和 AI 助手规范。改动对应模块前先阅读相应文档。

## 常用命令

在项目根目录执行：

- `npm run frontend:install`：安装前端依赖。
- `npm run dev`：启动前端开发服务器。
- `npm run build`：前端 TypeScript 构建、Vite 构建和 bundle 预算检查。
- `npm test`：运行前端 Vitest。
- `npm run db:up`：启动本地 MySQL 和 MinIO。
- `npm run db:down`：停止本地 Docker 服务。
- `npm run backend:venv`：创建后端虚拟环境并安装依赖。
- `npm run backend:init-db`：初始化本地 MySQL。
- `npm run backend:migrate`：运行 Alembic 迁移到最新版本。
- `npm run backend:dev`：启动 FastAPI 后端，默认 `127.0.0.1:8010`。
- `npm run backend:test`：运行后端 pytest。

前端子目录也可直接执行：

- `npm --prefix frontend run check:size`
- `npm --prefix frontend run test`
- `npm --prefix frontend run build`
- `npm --prefix frontend run smoke`

## 前端开发约定

### 前端 UI Skill 使用规则

- 凡是 UI 页面、组件、弹窗、表单、状态栏、列表、卡片、移动端页面、响应式视觉调整或样式文件开发，都必须优先使用 `.agents/skills/frontend-ui-style`。
- 如果涉及复杂组件架构、状态流、表单/弹窗编排、TypeScript 类型、loading/empty/error 状态、无障碍或验证策略，再结合 `.agents/skills/frontend-ui-engineering`。
- 项目专属 `frontend-ui-style` 的风格规则优先于任何通用开源 Skill、通用设计模板或模型默认视觉偏好。
- 使用这些 Skill 前仍需先阅读当前实现和 `docs/frontend-code-standards.md`，不要只按 Skill 文档脱离代码生成 UI。

前端修改必须遵循 `docs/frontend-code-standards.md` 的职责分层：

- 页面结构和用户可见 UI 放在 `*Page.tsx`、`*View.tsx` 或具体组件中。
- tab、选中项、弹窗、草稿、步骤流等局部状态放在 `use*State.ts`。
- 创建、更新、删除、确认、AI 生成等提交流程放在 `use*Actions.ts` 或 `use*ActionState.ts`。
- 筛选、排序、统计、分组和页面展示数据整理放在 `use*Data.ts` 或 `*ViewModel.ts`。
- 默认值、payload 构造、类型转换、业务校验和可测试计算放在 `*Model.ts`。
- 静态选项、枚举映射、状态文案和业务配置放在 `*Options.ts`。

请求与缓存约定：

- React Query key 统一维护在 `frontend/src/api/queryKeys.ts`。
- mutation 成功后的缓存失效统一维护在 `frontend/src/api/cacheInvalidation.ts`。
- 组件和业务 hook 不手写裸字符串 query key。
- API 封装放在 `frontend/src/api`，优先复用现有 client、request、类型和错误处理。

样式与资源约定：

- `frontend/src/styles.css` 是样式聚合入口，业务样式放入 `frontend/src/styles/*`。
- 新增样式使用业务域前缀，避免污染其他页面；不要在组件中堆叠大量 inline style。
- 图片上传、参考图生成、文本生成优先复用 `frontend/src/hooks/useImageComposer.ts`。
- 资源 URL 解析使用 `frontend/src/lib/assets.ts`，日期使用 `frontend/src/lib/date.ts`，localStorage 使用 `frontend/src/lib/storage.ts`。

## 后端开发约定

后端修改必须遵循 `docs/backend-code-standards.md`。

后端采用 FastAPI 分层结构：

- 路由与 HTTP 行为放在 `backend/app/api`。
- Pydantic 请求/响应合约放在 `backend/app/schemas`。
- SQLAlchemy 2 ORM 模型放在 `backend/app/models`。
- 业务逻辑优先放在 `backend/app/services`。
- 数据访问复用或补充 `backend/app/repos`。
- 当前用户、成员身份和权限依赖复用 `backend/app/core/deps.py`。
- 事务提交优先使用现有事务辅助，例如 `commit_session`。

数据库约定：

- 任何持久化 schema 变更都必须新增 Alembic migration，放在 `backend/alembic/versions`。
- 不要直接修改旧 migration 来表达新变更。
- 模型、schema、序列化、API 返回和测试需要同步更新。

业务约定：

- 所有家庭业务数据必须按 `family_id` 隔离。
- 需要当前操作者的新增、编辑、删除流程必须维护 `created_by`、`updated_by` 和活动日志。
- 强枚举优先使用 `backend/app/core/enums.py`，不要在各处复制自由字符串。
- 新增 API 时保持现有错误风格、权限检查和响应模型风格。

## 跨端契约

修改 API 字段、枚举、状态值或响应形状时，必须同步检查：

- 后端 `schemas`、`models`、`services/serializers`、API 路由和测试。
- 前端 `frontend/src/api/types.ts`、对应 API client、query key、缓存失效和页面 view model。
- 相关文档或 mock/helper，尤其是 AI workspace、媒体、日期和单位换算相关逻辑。

涉及媒体 URL、日期、数量单位、食物类型、餐别、库存状态、AI mode 的改动，不要只改一端。

## AI、图片与媒体约定

AI 助手、Skill、Tool、草稿和审批流程必须遵循 `docs/ai-assistant-standards.md`。

- AI 接口必须显式带家庭上下文，不能在无家庭上下文时返回库存、推荐或家庭数据。
- AI 输出是辅助建议；涉及菜谱生成、库存扣减、购物清单、餐食记录等写操作时，应走已有 approval、tool 或 service 流程。
- 项目内 AI skills 位于 `backend/app/ai/skills`，AI tools 位于 `backend/app/ai/tools`；新增能力前先复用现有 registry、executor、validation 模式。
- 图片上传和 AI 生成图片使用现有 media/MinIO 流程，不绕过 `backend/app/services/media.py` 和相关绑定逻辑。
- AI 生成图不应覆盖用户上传原图，只作为附加选项或独立 media asset。

## 安全与数据边界

- 不提交 `.env`、密钥、token、数据库密码或本地生成产物。
- 不绕过认证依赖访问家庭数据；Owner 专属能力必须使用现有权限检查。
- 所有查询和写入都要约束到当前 membership 的 `family_id`。
- 上传、媒体绑定、AI 生成和批量操作需要校验资源归属，避免跨家庭引用。
- 不在前端暴露后端密钥或 provider 配置。

## 测试策略

按变更风险选择验证范围：

- 文档或注释变更：人工审阅即可，不强制跑完整测试。
- 前端 model/helper 变更：至少跑对应 Vitest。
- 前端页面结构、工作区编排、状态流或缓存变更：跑 `npm --prefix frontend run check:size`、`npm --prefix frontend run test`、`npm --prefix frontend run build`。
- 响应式、移动端、导航或关键用户路径变更：补跑 `npm --prefix frontend run smoke`。
- 后端 API、service、权限、AI tool 或 serializer 变更：跑 `npm run backend:test`，必要时只先跑相关 pytest 文件再跑全量。
- 数据库模型变更：新增并检查 Alembic migration，必要时在本地库执行 `npm run backend:migrate`。

最终回复必须说明实际执行过的验证命令；如果没有运行测试，要说明原因。

## 协作规则

- 先读现有代码和文档，再修改；优先复用项目已有模式。
- 保持改动范围小，不顺手重构无关模块。
- 不绕过现有 API client、缓存失效、media、date、storage、auth、transaction 等封装。
- 不扩大大文件职责；新增复杂逻辑优先拆到符合职责的 hook、model、service 或 helper。
- 不恢复或覆盖用户未要求修改的工作区改动。
- 如果发现计划和当前代码冲突，先基于当前代码调整实现，并在回复中说明。
- 对高风险改动主动补测试；对未验证项明确标注。

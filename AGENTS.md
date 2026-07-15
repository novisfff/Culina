# Culina AI 辅助开发指南

本文件是 Codex、Claude Code 等 AI 工具进入 Culina 仓库后的导航与任务路由层。开始工作前先读取当前实现、对应规范和必要 Skill；不要用通用模板推断项目结构，也不要在本文件复制各模块的全部细则。

## 项目定位

Culina 是面向中国家庭的移动优先饮食管理 Web/PWA，覆盖菜谱、食物、食材库存、购物清单、餐食记录和受控 AI 辅助决策。

- 默认使用简体中文和具体、克制的产品文案。
- 优先服务家庭日常记录、低维护成本、清晰责任归属和温暖照片驱动体验。
- 手机端是主要体验，不是桌面页面的简单压缩版。
- AI 是基于家庭上下文的实用助手，不是开放式泛聊天，不做医疗或营养诊断式承诺。

## 仓库与真相源

- `frontend/`：React 18、Vite、TypeScript、React Query、PWA、Vitest 和前端样式。
- `backend/`：FastAPI、SQLAlchemy 2、Alembic、MySQL、AI Runtime 和 pytest。
- `deploy/`：Docker Compose、MySQL、MinIO、后端和 nginx 前端部署配置。
- `docs/frontend-code-standards.md`：前端架构、职责、缓存和验证规范。
- `docs/backend-code-standards.md`：后端分层、权限、事务、迁移和数据边界规范。
- `docs/ai-assistant-standards.md`：AI Skill、Tool、Runtime、草稿审批和稳定接口规范。
- `docs/plans/`：长期保留的架构说明、体检、迁移方案和专题计划。
- `docs/superpowers/specs/`：经确认的设计规格；`docs/superpowers/plans/`：与规格配套的可执行计划。

组件 API、业务行为、数据模型和级联顺序以当前源码为实现事实；Culina 固定视觉值与组件样式以 `frontend-ui-style` 为规范事实。两者冲突时识别为实现漂移，不用旧页面反向改写视觉规范。

## 项目 Skill 路由

| 任务 | 必须使用 |
| --- | --- |
| UI、CSS、页面、卡片、表单、弹层、移动端和响应式 | `frontend-ui-style` |
| 复杂 UI 状态流、组件拆分、异步、类型、无障碍和验证 | `frontend-ui-style` + `frontend-ui-engineering` |
| 前端 diff、PR 或回归风险审计 | `frontend-code-audit`；涉及 UI 时同时使用 `frontend-ui-style` |
| 后端 diff、PR、权限、事务、迁移、媒体或 AI 审计 | `backend-code-audit` |

项目 Skill 位于 `.agents/skills/`。使用前读取 Skill 正文和它明确路由的 reference，同时读取目标代码与对应规范；项目 Skill 优先于通用模板或模型默认偏好。

## 常用命令

在仓库根目录执行：

```bash
npm run frontend:install
npm run dev
npm run frontend:quality
npm run frontend:build
npm run frontend:smoke
npm --prefix frontend run check:style-tokens

npm run db:up
npm run db:down
npm run backend:venv
npm run backend:init-db
npm run backend:migrate
npm run backend:dev
npm run backend:quality
npm run backend:test:service
npm run backend:test:ai
npm run backend:test:ai-evals
npm run backend:test:search
```

`frontend:quality` 包含 typecheck、Vitest 和样式 token 漂移报告；报告退出码为 0 不等于视觉验收通过，必须人工审阅新增命中。`backend:quality` 包含后端编译检查和全量 pytest。

## 任务模式与修改边界

- 问答、解释、状态汇报、审计和评审默认只读；未明确要求修复时不要修改文件。
- 用户要求修改或构建时，在指定范围内实现、验证并交付；不要顺手重构无关模块。
- Git 同步、提交、推送或 PR 请求只执行对应 Git 工作流，不自动扩展成代码审计或功能修改。
- 工作区已有修改默认属于用户；不恢复、不覆盖、不用 `git add -A` 混入无关文件。
- 计划与当前代码冲突时，以当前代码和稳定规范重新校准，在回复中说明差异。

### Superpowers 使用边界

- 本节明确覆盖 Superpowers skill 自带的“只要有 1% 可能适用就必须调用”和“简单任务也必须使用”规则。Superpowers 是按需工作流，不是所有任务的默认入口。
- 问答、解释、翻译、状态汇报、只读检查或评审、文本润色、单文件文档或规则修改，以及目标明确、可逆、验证路径清楚的小修，默认不调用任何 Superpowers skill，直接完成并执行与风险相称的最小验证。
- 小型代码功能或 bug 修复可按需采用根因分析、测试先行和完成前验证，但不自动进入 `brainstorming`、设计文档、`writing-plans`、worktree、subagent review 或 branch finishing。
- 只有需求存在实质不确定性，或涉及 UX、产品取舍、架构、跨模块边界、公开接口、数据模型、权限、安全、迁移等高影响决策时，才启动 `brainstorming -> spec -> plan`。
- `using-git-worktrees`、`subagent-driven-development`、`dispatching-parallel-agents` 和外部评审只在用户或者方案明确要求的情况下使用。
- `finishing-a-development-branch` 只用于独立开发分支的集成决策；普通就地修改或用户已明确要求提交时，不再展示 merge、push、keep、discard 菜单。
- 无论是否调用 Superpowers，完成结论都必须有新鲜验证证据；简单任务不因验证要求升级成完整工作流。

## 前端不可突破的边界

- 新增或成规模扩展的业务进入 `frontend/src/features/<domain>/`；`app/` 只做应用组合与跨工作区协调。
- View 表达可见 UI，state/actions/data/model/options 按 `docs/frontend-code-standards.md` 分工。
- query key 统一由 `frontend/src/api/queryKeys.ts` 提供，mutation 失效统一由 `cacheInvalidation.ts` 维护。
- API、图片、资源 URL、日期和 localStorage 复用现有 client、`useImageComposer`、assets、date 和 storage 封装。
- UI 必须遵循 `frontend-ui-style` 的固定色板、字体、间距、圆角、阴影、组件和响应式规范；当前 CSS 不一致视为待修漂移。

## 后端与数据边界

- 路由、schema、model、service、repo、serializer 和权限依赖按 `docs/backend-code-standards.md` 分层。
- 所有家庭业务查询与写入都以当前 membership 的 `family_id` 隔离，不信任请求体中的家庭、用户或权限字段。
- Owner 能力使用现有 Owner 检查；媒体、批量 ID、草稿、审批和子资源全部校验归属。
- 同一用户动作的多表写入保持单一事务；高竞争写入明确锁顺序、锁后复核、幂等重放、stale version 和失败回滚。
- 持久化 schema 变化新增 Alembic migration，不修改旧 migration；model、schema、serializer、前端类型和测试同步。
- 用户可见写操作维护 `created_by`、`updated_by` 和活动日志。

## AI、媒体与跨端契约

- AI Skill catalog 位于 `backend/app/ai/skills/catalog/`，Tool catalog 位于 `backend/app/ai/tools/catalog/`；Orchestrator/Runner 位于 `backend/app/ai/workflows/`。
- 模型只获得当前家庭和已注入 Skill 允许的 read/draft/control 工具，正式 write tool 不暴露给模型。
- 正式写入固定经过 `draft -> approval -> service commit`；用户确认前不得显示或持久化成已完成。
- continuation、artifact、会话所有权和审批恢复遵循 AI 规范与严格 schema，拒绝、冲突和失败不自动推进下一草稿。
- 上传、绑定和 AI 生成媒体复用 `backend/app/services/media.py` 与 MinIO 流程；生成图不覆盖用户原图。
- 修改字段、枚举、日期、媒体 URL、单位、AI mode、message part、卡片或草稿类型时，同步检查后端 schema/serializer、前端类型/client/view model 和 contract 测试。

## 安全、验证与交付

- 不提交 `.env`、密钥、token、数据库密码、本地生成物或含家庭隐私的调试数据。
- 文档/注释：人工审阅并运行 `git diff --check`。
- 前端 model/helper：对应 Vitest；页面/状态/缓存：`frontend:quality` + `frontend:build`；响应式关键路径再跑 `frontend:smoke`。
- CSS、ui-kit、token：运行 `check:style-tokens` 并人工审阅；AI contract 运行对应前后端测试。
- 后端 route/service/权限/serializer：先跑定向 pytest，再按风险运行分类测试或 `backend:quality`。
- 模型/migration：检查 Alembic head、migration 和关键读写；可用本地库时执行 `backend:migrate`。
- 最终回复必须列出实际执行的命令和视口；未运行的测试或环境缺口明确说明，不把静态检查、单测、构建、smoke 或 CI 互相替代。

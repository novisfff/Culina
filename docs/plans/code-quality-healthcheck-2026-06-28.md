# Culina 代码质量体检任务清单

日期：2026-06-28

范围：前端、后端、AI 助手、agent loop、样式规范、测试、配置文件和文档。

说明：本清单来自第一阶段静态体检。任务按低风险、高收益、容易验证优先排序；每个任务都应能单独完成、单独验证、单独提交。


## T002：收敛 README 和规范中的旧 Planner 表述

问题描述：`README.md` 仍写 “Planner”，而 `docs/ai-assistant-standards.md` 已规定主路径为 Orchestrator。

涉及文件：

- `README.md`
- `docs/backend-code-standards.md`
- `docs/ai-assistant-standards.md`

优化方案：把 README、backend standards 中 planner 旧称统一为 Orchestrator、agent loop、Skill injection，并修正过期测试命令。

风险等级：低

验证方式：

```bash
rg "Planner|planner|workspace_planner|test_ai_agent_infra" README.md docs frontend/src backend/app
```

预估复杂度：S

## T003：拆分 App 顶层组合层中的首页和搜索导航流

问题描述：`frontend/src/App.tsx` 同时管理全局 tab、首页弹窗、搜索跳转、meal enrichment 和大量 mutation 传递，已超出规范中的应用组合层职责。

涉及文件：

- `frontend/src/App.tsx`
- `frontend/src/app/useAppHomeHandlers.ts`
- `frontend/src/features/search/GlobalSearchOverlay.tsx`

优化方案：先抽出 `useAppGlobalSearchNavigation`，只承接 `GlobalSearchSelection -> tab/navigationRequest`，不碰业务 mutation。

风险等级：低

验证方式：

```bash
npm --prefix frontend run test -- src/app/AppShell.test.tsx src/features/search/GlobalSearchOverlay.test.tsx
```

预估复杂度：S-M

## T004：拆分 AI Workspace 的 streaming mutation 逻辑

问题描述：`AiWorkspace.tsx` 同时处理 chat、approval、human input 三条 SSE mutation，重复构造 progress event、run state、error recovery。

涉及文件：

- `frontend/src/components/ai/AiWorkspace.tsx`
- `frontend/src/components/ai/aiWorkspaceHelpers.tsx`
- `frontend/src/components/ai/useAiConversationLiveSync.ts`

优化方案：先抽 `useAiStreamMutations.ts`，只迁移事件构造和 settled cleanup，不改 UI。

风险等级：中

验证方式：

```bash
npm --prefix frontend test -- src/components/ai/AiWorkspace.test.tsx
```

预估复杂度：M

## T005：抽取 AI approval 草稿解析公共 helper

问题描述：`asText`、`asNumber`、`asDraftArray` 在多个 AI 组件重复实现。

涉及文件：

- `frontend/src/components/ai/AiApprovalPanel.tsx`
- `frontend/src/components/ai/AiApprovalFields.tsx`
- `frontend/src/components/ai/AiInventoryOperationEditor.tsx`
- `frontend/src/components/ai/AiCompositeOperationPreview.tsx`

优化方案：新增 `aiDraftValueUtils.ts`，先迁移纯函数并补小单测。

风险等级：低

验证方式：

```bash
npm --prefix frontend test -- src/components/ai/AiInventoryOperationApproval.test.tsx src/components/ai/AiWorkspace.test.tsx
```

预估复杂度：S

## T006：减少 AI approval 面板的宽松类型边界

问题描述：`AiApprovalPanel.tsx` 大量使用 `Record<string, unknown>` 和 JSON clone，导致草稿类型错误只能运行时暴露。

涉及文件：

- `frontend/src/components/ai/AiApprovalPanel.tsx`
- `frontend/src/api/types.ts`

优化方案：按 draftType 分批定义 `ApprovalDraftViewModel`，先从 `inventory_operation` 或 `ingredient_profile` 一个类型开始。

风险等级：中

验证方式：

```bash
npm --prefix frontend run build
npm --prefix frontend test -- src/components/ai/AiInventoryOperationApproval.test.tsx
```

预估复杂度：M

## T007：建立样式 token 漂移检查

问题描述：业务 CSS 中散落大量硬编码阴影、圆角、小尺寸控件，和 UI Skill 的尺寸体系不完全一致。

涉及文件：

- `frontend/src/styles/04-ingredients-workspace.css`
- `frontend/src/styles/06-food-workspace.css`
- `frontend/src/styles/07-mobile.css`
- `frontend/src/styles/00-foundation.css`

优化方案：先加只读脚本或文档化 checklist，统计 `13px`、`17px`、`8px`、`rgba(0, 0, 0)` 等漂移点，再按业务域逐步收敛。

风险等级：低

验证方式：

```bash
rg "border-radius: 13px|border-radius: 17px|rgba\\(0, 0, 0" frontend/src/styles
```

预估复杂度：S

## T008：优化全局搜索移动端触控尺寸

问题描述：`global-search-clear` 桌面 38px、移动 36px，低于 UI 规范建议的 40/44px 高频触控热区。

涉及文件：

- `frontend/src/features/search/GlobalSearchOverlay.tsx`
- `frontend/src/styles/09-global-search.css`

优化方案：把清空、关闭、结果行移动端触控尺寸统一到至少 40px，必要时调整间距。

风险等级：低

验证方式：

```bash
npm --prefix frontend test -- src/features/search/GlobalSearchOverlay.test.tsx
npm --prefix frontend run smoke
```

预估复杂度：S

## T009：补齐搜索索引 job worker 的事务一致性小测试

问题描述：`backend/app/services/search/jobs.py` 多处直接 `db.commit()`，worker 场景可以接受，但缺少针对 claim、recover、process 失败路径的更小单测。

涉及文件：

- `backend/app/services/search/jobs.py`
- `backend/tests/search/`

优化方案：补 `backend/tests/search/test_search_index_jobs.py`，覆盖 stale running recovery、max attempts、process failure 标记。

风险等级：低

验证方式：

```bash
backend/.venv/bin/python -m pytest backend/tests/search -q
```

预估复杂度：M

## T010：给 agent loop 增加阶段耗时摘要

问题描述：`runner.py` 有 run start/end 日志和 trace spans，但普通日志难快速看出 prepare、graph stream、provider follow-up、finalize 分段耗时。

涉及文件：

- `backend/app/ai/workflows/runner.py`
- `backend/app/ai/workflows/orchestrator.py`
- `backend/tests/ai_infra/test_ai_observability.py`

优化方案：低侵入增加 `perf_counter` 阶段耗时日志或 trace output summary，不记录 payload。

风险等级：低

验证方式：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_ai_observability.py -q
```

预估复杂度：S-M

## T011：清理前端旧 AI planner fixture 命名

问题描述：前端测试仍多处使用 `workspace_planner` 和 `intent.request_clarification` 旧语义，容易误导后续实现。

涉及文件：

- `frontend/src/components/ai/AiWorkspace.test.tsx`
- `frontend/src/api/aiApi.test.ts`
- `frontend/src/components/ai/AiQualityMetricsModel.ts`

优化方案：把 fixture 命名迁移为 `workspace_orchestrator` / `human.request_input`，保留必要 legacy 测试时显式命名为 legacy。

风险等级：低

验证方式：

```bash
npm --prefix frontend test -- src/components/ai/AiWorkspace.test.tsx src/api/aiApi.test.ts
```

预估复杂度：S

## T012：增加独立质量命令入口

问题描述：前端只有 `build/test/smoke/check:bundle`，后端只有 pytest；缺少明确的 typecheck/lint 快捷入口，体检类问题靠人工 `rg`。

涉及文件：

- `package.json`
- `frontend/package.json`
- `backend/requirements.txt`
- `README.md`

优化方案：先定义 `frontend:typecheck`、`frontend:quality`、后端 `ruff` 或等价命令的采用方案；确认后再实现。

风险等级：低

验证方式：命令可直接运行并失败时有清晰输出。

预估复杂度：S-M

## T013：整理 docs 下计划文档的归档策略

问题描述：`AGENTS.md` 说 `docs/` 只保留三类规范，但当前还有多份历史设计/计划文档，和 README 的目录描述不一致。

涉及文件：

- `AGENTS.md`
- `README.md`
- `docs/*.md`

优化方案：先建立 `docs/archive/` 或 `docs/plans/` 归档规则，再逐个移动历史计划文档并更新 README。

风险等级：低

验证方式：

```bash
find docs -maxdepth 1 -type f -name "*.md" | sort
```

预估复杂度：S


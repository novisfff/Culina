---
name: frontend-ui-engineering
description: Use when implementing or restructuring complex Culina frontend pages, workspaces, forms, dialogs, drawers, async state flows, responsive views, TypeScript contracts, accessibility behavior, or frontend validation strategy.
---

# Culina 前端 UI 工程

## 定位

负责 UI 的工程结构、状态流、类型、安全异步行为、响应式实现、无障碍和验证；固定视觉规范由 `frontend-ui-style` 负责。

**REQUIRED SUB-SKILL:** Use `frontend-ui-style` for every UI or CSS change.

**REQUIRED SUB-SKILL:** Use `superpowers:test-driven-development` before implementation.

## 修改前读取

- `docs/frontend-code-standards.md`。
- 目标用户路径、现有 `Workspace/Page/View`、mobile view、hooks、model/options 和测试。
- `frontend/src/components/ui-kit/index.ts`、候选组件实现和 `frontend/src/styles/00-ui-kit.css`。
- 目标业务 CSS、`frontend/src/styles.css` 和最终生效的媒体查询。
- 涉及请求时读取对应 API client、`queryKeys.ts`、`cacheInvalidation.ts` 和 API 类型。
- 涉及图片、日期、存储或 AI contract 时读取现有封装及其测试。

用 `rg` 确认路径、导出、props、query key、class 和 token 真实存在。`frontend/src/components/ui-kit.tsx` 是兼容出口，组件事实以 `ui-kit/index.ts` 和实现文件为准。

## 职责边界

| 职责 | 默认归属 |
| --- | --- |
| 页面结构、可见 UI | `*Page.tsx`、`*View.tsx`、具体组件 |
| 业务域组合 | `*Workspace.tsx` |
| tab、选中项、弹窗、草稿、步骤流 | `use*State.ts` |
| 创建、更新、删除、确认、AI 生成 | `use*Actions.ts` / `use*ActionState.ts` |
| 查询组合、筛选、统计、分组 | `use*Data.ts` / `*ViewModel.ts` |
| 默认值、payload、转换、校验、纯计算 | `*Model.ts` |
| 选项、枚举映射、状态文案 | `*Options.ts` |

- 新增或成规模扩展的业务能力进入 `frontend/src/features/<domain>/`。
- `frontend/src/app/` 只做应用壳、顶层导航和跨工作区协调，不承载业务表单与 model。
- View 接收准备好的数据、状态和回调；不直接请求 API、失效缓存或重复派生业务数据。
- Workspace 只连接 hooks 和 view props；发现大段 JSX、payload 组装或重复 action 时继续拆分。
- 文件体量是健康信号，不是机械阈值；按职责拆分，不为行数制造碎片。

## 组件复用

- 先从当前 ui-kit 导出选择基础交互，再检查同业务域组件。
- ui-kit 只承载跨业务结构、视觉、无障碍和通用状态；食材、菜谱、库存、AI 审批等规则留在业务层。
- 不新增局部 CustomSelect、裸确认弹窗、重复搜索框、数量单位输入或筛选 chip。
- 基础视觉严格使用 `frontend-ui-style` 的 canonical 规范；业务 CSS 只添加业务布局和必要变体。
- 新业务样式使用业务域前缀，不新增跨业务泛选择器、大量 inline style 或无边界 `!important`。

## 数据请求与异步状态

### Query

- query key 只能来自 `frontend/src/api/queryKeys.ts`，并包含家庭、会话、筛选或分页等真实隔离维度。
- `enabled` 必须与认证、家庭上下文、活动页面和必要参数一致；不能提前请求未授权或无上下文数据。
- 区分首次 loading、后台刷新、无数据和错误。后台刷新失败时优先保留旧数据并标记陈旧，不把整个页面替换为空白错误。
- 非首屏数据在对应工作区或功能激活后加载，避免 App 层无条件拉取所有业务数据。
- 搜索、分页和快速切换处理乱序响应；使用 React Query 或现有取消机制，不能让旧请求覆盖新选择。

### Mutation

- mutation 通过现有 API client/request 发起，成功失效集中在 `cacheInvalidation.ts`。
- 提交中设置真实 busy/disabled/`aria-busy`，阻止重复提交并保持按钮宽度和状态文案稳定。
- 失败后保留表单、草稿、附件和用户选择；字段错误就近显示，流程错误提供恢复入口。
- 关闭、取消、backdrop、Escape 和路由离开策略必须说明 busy 与未保存草稿时的行为。
- 乐观更新只有在回滚和并发语义明确时使用；否则等待服务端结果并精确失效。

## 表单、弹层与步骤流

- 表单默认值、payload、类型转换和业务校验进入 model；组件只管理展示绑定和轻量输入状态。
- 弹层复用当前 overlay frame/modal/drawer 能力，保留 dialog 语义、焦点陷阱、初始焦点、Escape、backdrop 和焦点恢复。
- header 说明任务，body 承载唯一滚动区，footer 保持主次操作可达。
- 多步骤流程明确当前步骤、返回行为、草稿保留、提交边界和最终成功条件。
- 危险确认展示对象、影响范围和不可逆后果；默认焦点不落在破坏性按钮上。

## TypeScript 与跨端契约

- props、state、回调和 view model 使用明确类型；避免 `any`、宽泛字典和与 API 重复的临时类型。
- API 请求/响应、枚举和 message part 优先来自 `frontend/src/api/types.ts` 或明确业务 model。
- 使用可辨识联合表达互斥 UI 状态，不用多个布尔值制造不可能组合。
- 回调命名表达事件与结果，例如 `onSubmit`、`onClose`、`onDraftChange`、`onApprovalDecision`。
- API 字段、状态、日期、媒体 URL、单位、草稿或卡片类型变化时，同步检查后端 schema/serializer、前端 client、view model 和 contract 测试。

## 响应式与无障碍

- 主要手机页面使用独立 view/page，共享 data/actions/model，不共享大段桌面 JSX。
- CSS 使用 Grid/Flex、`minmax(0, 1fr)`、`min-width: 0`、稳定比例和受控滚动；不使用 viewport 宽度驱动字体。
- 检查安全区、软键盘、底部导航/composer、sticky action、长中文、数字 ID 和横向溢出。
- 使用真实 button/input/select/textarea；label 不被 placeholder 替代。
- 图标按钮提供可访问名称，装饰图标隐藏；保留 focus-visible、合理 tab 顺序和状态播报。
- loading、empty、error、disabled、selected 和危险状态不能只依赖颜色。

## 通用封装

- 图片上传、参考图和生成流程复用 `frontend/src/hooks/useImageComposer.ts`。
- 资源 URL 使用 `frontend/src/lib/assets.ts`，日期使用 `frontend/src/lib/date.ts`，localStorage 使用 `frontend/src/lib/storage.ts`。
- AI message part、结果卡、草稿和 SSE 状态复用 `aiWorkspaceContracts` 与现有渲染分发，不静默丢弃未知类型。

## 验证矩阵

| 变更 | 最低验证 |
| --- | --- |
| model/helper/view model | 对应 Vitest |
| 组件状态、表单、弹层 | 对应 Testing Library/Vitest |
| 页面结构、Workspace、缓存、状态流 | `npm run frontend:quality` + `npm run frontend:build` |
| CSS、ui-kit、token | `npm --prefix frontend run check:style-tokens`，人工审阅报告 |
| 移动端、导航、弹层、关键路径 | `npm run frontend:smoke` + 真实目标视口 |
| AI message part、草稿、结果卡 | 对应 AI 测试 + `aiWorkspaceContracts.test.ts` |

测试用户行为与可见状态，不用大量 class 断言替代交互。最终回复列出实际执行的命令、视口和未验证项，不把单测、构建、smoke、样式报告或截图互相替代。

## 完成前检查

- 页面主任务、状态所有权和提交边界是否明确？
- View、state、actions、data/view model、model/options 是否职责单一？
- query scope、`enabled`、失效、竞争响应和陈旧数据是否正确？
- loading、empty、error、disabled、busy、取消和部分成功是否完整？
- 弹层焦点、关闭策略、键盘、安全区和滚动是否成立？
- 是否复用了真实 ui-kit、API、media/date/storage 和 AI contract？
- 实际验证是否与变更风险匹配？

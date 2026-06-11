---
name: frontend-ui-engineering
description: Culina 前端 UI 通用工程 Skill。用于复杂 UI 页面、组件体系、弹窗/表单状态流、响应式实现、TypeScript 类型、loading/empty/error 状态、无障碍、复用组件和验证命令设计；仅负责工程实践，不覆盖 frontend-ui-style 的项目视觉规则。
---

# Culina 前端 UI 工程

## 使用方式

当 UI 需求涉及复杂组件架构、状态流、表单、弹窗、异步数据、响应式、多文件改动或测试验证时，结合本 Skill。视觉和项目风格先按 `frontend-ui-style`，工程落点按本 Skill。

开始前阅读：

- `docs/frontend-code-standards.md`
- 相关业务域现有 `*Workspace.tsx`、`*Page.tsx`、`*View.tsx`
- 对应 `use*State.ts`、`use*Actions.ts`、`use*Data.ts`、`*Model.ts`、`*Options.ts`
- `frontend/src/components/ui-kit.tsx`
- `frontend/src/api/queryKeys.ts`、`frontend/src/api/cacheInvalidation.ts`

## 组件拆分

- 页面结构和用户可见 UI 放在 `*Page.tsx`、`*View.tsx` 或具体组件中。
- 工作区组合层放在 `*Workspace.tsx`，负责连接数据 hook、状态 hook、action hook 和 view props。
- tab、选中项、弹窗、草稿、步骤流等局部状态放在 `use*State.ts`。
- 创建、更新、删除、确认、AI 生成等提交流程放在 `use*Actions.ts` 或 `use*ActionState.ts`。
- 筛选、排序、统计、分组和展示数据整理放在 `use*Data.ts` 或 `*ViewModel.ts`。
- 默认值、payload 构造、类型转换、业务校验和可测试计算放在 `*Model.ts`。
- 静态选项、枚举映射、状态文案和业务配置放在 `*Options.ts`。
- 不让单个 TSX 同时承担请求、缓存失效、复杂状态机、payload 组装和大量 JSX。

## 复用已有组件和封装

- UI 优先复用 `ui-kit.tsx` 中的 header、button、tab、toolbar、modal、drawer、list row、empty state、touch field、image composer。
- API 调用放在 `frontend/src/api`，复用已有 client、request、类型和错误处理。
- React Query key 统一用 `queryKeys`，不要手写裸字符串 key。
- mutation 成功后的失效统一放在 `cacheInvalidation.ts`。
- 图片上传、参考图生成、文本生成复用 `useImageComposer.ts`。
- 资源 URL 用 `resolveAssetUrl`，日期用 `frontend/src/lib/date.ts`，localStorage 用 `frontend/src/lib/storage.ts`。

## TypeScript 类型

- props 使用明确类型，避免 `any` 和隐式松散对象。
- 业务枚举、API 响应和请求 payload 优先来自 `frontend/src/api/types.ts` 或本业务 model/options。
- 回调 props 命名清楚，例如 `onSubmit`、`onClose`、`onDraftChange`、`onApprovalDecision`。
- 派生数据优先写成纯函数并补单测，组件只消费结果。
- 与后端响应形状相关的字段改动必须同步检查 API 类型、client、view model 和测试。

## 响应式实现

- 移动端主要页面使用独立 view/page，共享数据 hook、action hook 和 model helper，不共享大段桌面 JSX。
- 使用 CSS Grid/Flex、`minmax(0, 1fr)`、`min-width: 0`、`aspect-ratio`、稳定 `min-height` 防止溢出和布局跳动。
- 样式改动放在 `frontend/src/styles/*`，通过业务前缀隔离；移动端规则优先放到 `07-mobile.css` 或对应业务样式的媒体查询。
- 不用 viewport 宽度驱动字体大小；长文本必须有省略、换行或滚动策略。

## Loading、Empty、Error 状态

- 首屏和工作区 loading 要给用户可理解的状态，不要空白。
- 空状态优先用 `EmptyState` 或业务域已有空态组件，说明当前没有什么、下一步能做什么。
- error 状态要显示可恢复信息；涉及提交失败时保留用户草稿。
- 提交中要禁用危险的重复提交入口，并保持取消/关闭策略清晰。
- AI、图片生成、审批和导入类流程要展示阶段或等待原因。

## 无障碍

- 按钮必须是 `<button type="button">` 或正确 submit 类型，不用 div 模拟按钮。
- 图标按钮需要 `aria-label` 或 `title`；纯装饰图片和图标使用空 alt 或 `aria-hidden`。
- tab/分段控件使用 `role="tablist"` 或已有组件。
- 弹窗关闭按钮和危险确认按钮要有明确可读文本。
- 保留 `focus-visible` 样式，不移除键盘可见焦点。
- 表单控件使用 label、placeholder 只作辅助，不代替字段含义。

## 检查和验证

按风险选择命令：

- 文档或注释变更：人工审阅即可。
- model/helper 变更：跑对应 Vitest。
- 页面结构、工作区编排、状态流或缓存变更：跑 `npm --prefix frontend run check:size`、`npm --prefix frontend run test`、`npm --prefix frontend run build`。
- 响应式、移动端、导航或关键路径变更：补跑 `npm --prefix frontend run smoke`。

提交前检查：

- 是否遵循 `frontend-ui-style` 的视觉规则。
- 是否复用了已有组件和 API/cache/media/date/storage 封装。
- 是否没有新增裸 query key、散落缓存失效或跨业务泛选择器。
- 是否覆盖 loading、empty、error、disabled、提交中和移动端状态。
- 是否说明实际执行的验证命令；未执行测试时说明原因。

---
name: frontend-code-audit
description: Culina 前端代码审计 Skill。用于审查 frontend/ 下 React、TypeScript、React Query、API client、view model、hook、样式、移动端响应式、AI 前端工作区或用户界面改动；当用户要求代码审计、review、排查前端改动风险、检查前端 PR/diff 或确认前端实现是否符合 Culina 规范时使用。
---

# Culina 前端代码审计

## 使用原则

默认只做审计，不修改代码。除非用户明确要求修复，否则输出问题、风险、证据和建议，不进入实现。

审计前先读取当前实现，不按通用 React 模板推断。必须优先阅读：

- `docs/frontend-code-standards.md`
- 相关 `git diff` 或用户指定文件
- 受影响业务域的组件、hook、model/view model、API client、类型、样式和测试
- 涉及 UI、弹窗、表单、列表、状态栏、移动端或响应式时，同时使用 `.agents/skills/frontend-ui-style`
- 涉及复杂组件结构、状态流、异步流程、表单/弹窗编排、TypeScript 类型或验证策略时，同时使用 `.agents/skills/frontend-ui-engineering`

输出使用简体中文。保持代码审计立场：问题优先，按严重度排序；没有发现问题时明确说没有发现阻断性问题，并说明仍存在的测试缺口或残余风险。

## 审计流程

1. 明确审计范围：当前 diff、指定 PR、指定文件或前端相关未提交改动。
2. 读取规范和现有模式：先看 `docs/frontend-code-standards.md`，再看同业务域已有实现。
3. 检查跨端契约：凡是 API 字段、枚举、状态值、日期、媒体 URL、单位、AI mode、卡片或草稿类型变化，都同步检查 `frontend/src/api/types.ts`、API client、view model 和后端契约。
4. 追踪用户路径：从页面/工作区入口到 hook、model、API、缓存失效和 UI 状态，确认 happy path、失败路径、loading/empty/error/disabled 状态都成立。
5. 给出 findings-first 结论：每个问题都要有文件/行号、风险说明、触发场景和建议修复方向。

## 重点检查

- 职责分层：页面/组件只表达 UI 和交互入口；状态放 `use*State.ts`，提交流程放 `use*Actions.ts`，派生数据放 `use*Data.ts` 或 `*ViewModel.ts`，payload、默认值、类型转换和业务校验放 `*Model.ts`。
- 数据请求：React Query key 必须来自 `frontend/src/api/queryKeys.ts`，mutation 成功后的失效必须走 `frontend/src/api/cacheInvalidation.ts`，不要手写裸字符串 query key。
- API 封装：请求必须复用 `frontend/src/api` 的 client、request、类型和错误处理；不要在组件里拼 URL、直接 fetch 或绕过现有错误处理。
- 类型契约：避免 `any`、隐式松散对象和前后端字段漂移；后端响应形状变化要同步前端类型、view model 和测试。
- UI 状态：loading、empty、error、提交中、禁用态、删除/确认危险态和用户草稿保留策略必须清楚。
- 移动端：不要把桌面两栏直接压缩到手机；检查 44px 触控目标、安全区、底部导航/composer、横向溢出和长文本换行。
- 样式隔离：样式放 `frontend/src/styles/*`，使用业务域前缀；避免全局选择器污染、组件内大量 inline style、卡片套卡片和文本溢出。
- 资源封装：图片/生成图优先复用 `useImageComposer.ts`；资源 URL 用 `frontend/src/lib/assets.ts`，日期用 `frontend/src/lib/date.ts`，localStorage 用 `frontend/src/lib/storage.ts`。
- AI 前端：检查运行中、等待用户确认、草稿准备、审批成功/失败等状态是否语义真实；卡片、草稿和消息 part 不要静默丢失。
- 可访问性：按钮使用真实 `<button>`，图标按钮有 `aria-label` 或 `title`，弹窗和 tab 保持键盘与焦点可用。

## 严重度

- `P0`：会导致数据误写、跨家庭数据暴露、关键路径完全不可用、构建无法通过或生产崩溃。
- `P1`：主要用户路径失败、缓存/契约错误导致明显脏数据、移动端关键功能不可用或 AI 审批状态误导用户。
- `P2`：局部功能退化、边界场景缺陷、缺少必要失败态、职责分层明显偏离且会增加维护风险。
- `P3`：可维护性、命名、轻微样式一致性或测试补强建议；不要用 P3 噪音淹没真正风险。

## 输出格式

发现问题时：

```md
**Findings**
- `[P1]` 标题 — `frontend/src/...:123`
  说明触发场景、实际风险、为什么当前实现会失败，以及建议修复方向。

**Open Questions**
- 仅列出会影响审计结论的真实疑问。

**Verification Gaps**
- 说明缺失或建议补跑的验证命令。
```

没有发现问题时：

```md
未发现阻断性前端问题。

验证缺口：说明未运行或仍建议补充的命令/场景。
```

## 验证建议

- model/helper 变更：优先跑对应 Vitest。
- 页面结构、工作区编排、状态流或缓存变更：建议跑 `npm --prefix frontend run check:size`、`npm --prefix frontend run test`、`npm --prefix frontend run build`。
- 响应式、移动端、导航或关键用户路径变更：补跑 `npm --prefix frontend run smoke`。
- 只做审计时不要假装已经验证；最终结论必须区分“已实际运行”和“建议运行”。

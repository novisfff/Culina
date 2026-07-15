---
name: frontend-code-audit
description: Use when reviewing Culina frontend diffs, pull requests, React or TypeScript changes, React Query behavior, API contracts, responsive UI, accessibility, AI workspace surfaces, or frontend test coverage for correctness and regression risk.
---

# Culina 前端代码审计

## 审计边界

默认只读审计，不修改代码、提交、推送或改 PR。用户明确要求修复后再切换到实现流程。

输出使用简体中文、findings-first、按严重度排序。只报告能说明触发场景和实际影响的可操作问题，不用个人偏好、泛化最佳实践或 P3 噪音填充报告。

涉及 UI、CSS、弹窗、卡片、表单、状态面或响应式时：

**REQUIRED SUB-SKILL:** Use `frontend-ui-style`.

涉及复杂组件结构、异步状态、表单编排、类型或验证策略时：

**REQUIRED SUB-SKILL:** Use `frontend-ui-engineering`.

## 建立当前事实

先读取：

- `docs/frontend-code-standards.md`。
- 用户指定范围、当前 diff 或 PR 最新 head；PR 推进后重新确认 head，不沿用过期结论。
- 变更入口及受影响的 Page/View/Workspace、mobile view、hooks、model/options、API、样式和测试。
- `queryKeys.ts`、`cacheInvalidation.ts`、相关 API 类型与 client。
- UI 变更对应的 ui-kit 导出/实现、固定视觉规范、业务 CSS 和最终媒体查询。
- AI 变更对应的后端 schema/SSE/runtime contract 与前端 contract 测试。

先区分 diff 新增问题、既有问题和被本次变更放大的问题。既有缺陷只有在它会让本次改动不成立时才作为 finding，并明确证据来源。

## 审计流程

1. **锁定范围**：记录 base/head、指定文件或未提交改动，不把无关工作区文件混入结论。
2. **核对承诺**：比较需求、PR 描述、计划或测试声称与实际 changed files。
3. **追踪用户路径**：从入口到 state/data/actions/model、API、缓存、可见状态和移动端入口。
4. **追踪数据契约**：检查请求、响应、枚举、日期、媒体、单位、AI message part 和后端 serializer。
5. **构造失败场景**：首次加载、后台刷新、空数据、局部错误、重复提交、快速切换、无权限和长内容。
6. **检查测试有效性**：测试是否覆盖真实行为和回归点，而非只断言 class、mock 调用或 happy path。
7. **形成 finding**：给出紧凑行号、触发步骤、代码证据、用户/数据影响和修复方向。

无法证明触发条件时先继续检查，不把猜测写成确定缺陷。

## 架构与职责

- 新业务或成规模扩展是否进入 `frontend/src/features/<domain>/`，而不是继续扩大 `App.tsx`、`app/` 或新增根级业务组件目录。
- Page/View 是否只表达结构与交互入口；Workspace 是否只组合 hooks 和 view props。
- 局部状态、actions、data/view model、model/options 是否按规范归属；是否出现请求、状态机、payload 和大段 JSX 同文件耦合。
- 纯计算、默认值、转换和业务校验是否可独立测试；共享规则是否在桌面和 mobile view 重复实现。
- 重构是否保留行为、props、缓存和测试契约，还是只移动文件后留下双实现。

## React Query、请求与缓存

- query key 必须来自 `queryKeys.ts`，并包含 `familyId`、conversation/run、筛选、分页等真实隔离维度。
- `enabled` 是否与认证、当前家庭、活动页面和必要参数一致；无上下文时是否发出错误或越权请求。
- mutation 失效是否集中在 `cacheInvalidation.ts`，范围是否过宽、遗漏或跨家庭/跨会话污染。
- 首次 loading、后台 refresh、stale data、empty 和 error 是否被正确区分；刷新失败是否错误清空已有内容。
- 搜索、筛选、分页和快速切换是否可能让旧响应覆盖新选择；取消、去重和 keep/placeholder data 行为是否与 UX 一致。
- 非首屏 query 是否在顶层无条件加载；query/mutation 错误是否绕过统一 client/request 处理。
- 乐观更新是否有精确回滚、并发和服务端冲突策略；没有时是否造成短暂假成功或永久脏缓存。

## 类型与跨端契约

- API 字段、枚举、状态、日期、媒体 URL、单位和 optional/null 语义是否与后端 schema/serializer 一致。
- 是否使用 `frontend/src/api/types.ts` 或明确业务类型，避免 `any`、宽泛字典、重复 DTO 和危险断言。
- 互斥 UI 状态是否用可辨识联合表达，还是多个布尔值允许不可能组合。
- API client、view model、组件 props、mock/helper 和测试 fixture 是否同步更新。
- 未知枚举或 message part 是否有安全显式处理，还是被默认分支静默丢弃。

## Mutation、表单与弹层

- 默认值、payload、单位转换和业务校验是否来自 model；组件是否临时拼 payload。
- busy/disabled/`aria-busy` 是否真实阻止重复提交；成功条件是否来自服务端结果。
- 失败后是否保留草稿、附件、字段值和用户选择；字段错误与流程错误是否放在正确位置。
- 关闭、取消、backdrop、Escape、路由离开和未保存草稿是否有一致策略。
- overlay 是否保留 dialog 语义、标题关联、焦点陷阱、初始焦点和关闭后焦点恢复。
- 危险确认是否说明对象与影响，默认焦点是否错误落在破坏性动作。

## UI、响应式与样式

- 当前实现是否符合 `frontend-ui-style` 的固定色板、字体、间距、圆角、阴影、控件和组件规格；旧页面不同不构成放宽理由。
- 手机端是否有独立信息架构并共享 data/actions/model；是否只是隐藏桌面侧栏或压缩两栏。
- 检查固定设备层级、安全区、软键盘、底部导航/composer、sticky action、长中文、数字 ID 和横向溢出。
- 样式是否进入正确业务 CSS、使用业务前缀并保持 `styles.css` 级联；是否新增全局污染、重复 token、近似色值或无边界 `!important`。
- 图片是否使用资源解析、稳定比例、占位、错误态和 `object-fit`；缺图是否造成 CLS 或操作遮挡。
- loading、empty、error、disabled、warning、danger、plan 和 partial success 是否语义真实且不只靠颜色。

## 资源与浏览器能力

- 图片上传、参考图和生成是否复用 `useImageComposer.ts`，并保持上传失败、重试、删除和绑定状态。
- 资源 URL 是否使用 `lib/assets.ts`，日期使用 `lib/date.ts`，localStorage 使用 `lib/storage.ts`。
- effect、observer、timer、event listener、Object URL、media stream 和 AbortController 是否清理；StrictMode 重挂载是否重复注册或泄漏。
- 浏览器 API 在不支持、权限拒绝、页面隐藏和组件卸载时是否安全恢复。

## AI 工作区

- conversation、run、message、draft、approval 和 artifact 是否按当前会话隔离；切换会话时旧状态是否串入新会话。
- 同一会话单活动 run、公开会话协作和创建者权限是否与后端契约一致。
- SSE `message_delta`、progress、human input、approval 和结果 parts 是否按稳定 contract 解析并持久显示。
- running、waiting input、waiting approval、failed、cancelled、partial success 是否与后端真实状态一致。
- 草稿、审批和 operation result 是否保留对象、失败原因、`currentValue`、`recoveryHint` 和恢复入口。
- 用户确认前是否出现“已创建/已写入/已完成”等假成功；未知 part 是否被静默丢弃。
- composer 的发送、停止、附件、禁用和重连状态是否按 conversation/run 隔离。

## 可访问性

- 交互元素使用正确语义和 type；键盘可到达、tab 顺序合理、focus-visible 未被移除。
- label、错误关联、aria-expanded/controls、dialog 标题和 live region 是否正确且不重复播报。
- 图标按钮有可访问名称，装饰内容隐藏；状态、选中和错误不只依赖颜色。
- 移动触控热区和固定 UI 规范一致，不因 compact 视觉缩小真实点击区。

## 严重度

- `P0`：跨家庭/跨会话数据暴露或误写、认证绕过、不可恢复数据破坏、生产主入口整体不可用。
- `P1`：主要用户路径失败、缓存隔离/跨端契约错误、移动端关键功能不可用、AI 审批或写入状态误导用户。
- `P2`：局部功能退化、竞态/边界场景缺陷、必要失败态缺失、明显职责耦合造成近期回归风险。
- `P3`：有实际维护成本的轻微一致性或测试缺口。纯命名、格式和个人审美通常不报。

严重度按影响与可触发性，不按修改行数。构建失败若阻断所有发布通常为 P1；只有已经造成生产整体不可用时才是 P0。

## Finding 契约

每条 finding 必须包含：

```md
- [P1] 简短结论 — `frontend/src/path.tsx:123`
  触发场景：用户如何进入该路径，使用什么状态或输入。
  证据与影响：当前代码为何会失败，会造成什么用户或数据后果。
  修复方向：指出应恢复的契约或职责，不展开无关重构。
```

- 行号落在最能证明问题的 changed line 或紧邻上下文。
- 同一根因合并为一条 finding，列出必要的多个消费者，不重复报症状。
- Open Questions 只列会改变结论的问题；不要用问题代替可证明 finding。
- 没有 finding 时写“未发现阻断性前端问题”，并列残余风险和验证缺口。

## 验证与报告

按风险选择只读验证：

- 定向 Vitest：`npm --prefix frontend test -- <path>`。
- 全量质量：`npm run frontend:quality`。
- 构建与预算：`npm run frontend:build`。
- 样式漂移：`npm --prefix frontend run check:style-tokens`，人工审阅命中。
- 响应式/关键路径：`npm run frontend:smoke`，并检查真实目标视口。
- AI contract：对应 AI 测试和 `src/lib/aiWorkspaceContracts.test.ts`。

最终分开列出“实际执行”与“建议/未执行”。测试通过只能证明覆盖到的行为，不能替代代码路径、契约和视觉审计。

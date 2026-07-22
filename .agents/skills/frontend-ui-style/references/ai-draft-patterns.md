# AI Draft Patterns

## Scope and Exclusions

本参考适用于 AI 工作区中的审批 Draft、草稿卡片、Draft 组件和 `.ai-draft-*` 样式。它统一的是可见结构、语义状态、响应式和基础交互外观，不改变草稿内容、校验、payload、资源查询或审批决策。

`RecipeDraftDialog` 是生成工作区对话框，不属于审批 Draft，本参考不要求它迁移到 Draft 组件库。

## Reuse Decision

先使用现有 ui-kit：`DropdownSelect`、`ComboboxField`、`SearchableResourceSelect`、`QuantityUnitField`、`FormActions`、`StatusBadge` 和 `StateBlock`。Draft 层只补齐摘要、分区、影响提示、重复条目和已处理结果等审批语义，不创建平行的通用选择器或按钮。

当业务结构确实不同（例如库存批次、复合操作顺序或菜谱步骤）时，Draft View 可以自定义布局；自定义 UI 仍必须使用固定 token、真实 label 和本参考的状态语义。

## Pending, Busy, Failure, and Resolved States

- 待确认、建议和计划使用 `plan` 语义，并清楚说明确认前不会写入。
- 等待补充、库存不足和需要处理的输入使用 `warning`，说明缺少什么以及下一步。
- 不可逆、删除、报废或失败使用 `danger`，说明对象和影响范围；失败后保留可恢复的草稿。
- 已确认、已拒绝、已失效和已取消使用紧凑的已处理摘要，不再呈现为可提交表单。
- 状态不能只依赖颜色，必须有可见的文本、图标或结构说明。

## Summary, Section, Item, and Impact Roles

- `AiDraftSummaryCard` 展示对象、数量、日期和本次变更等高层事实；不嵌套无意义的强调卡。
- `AiDraftSection` 为可编辑或可复核的内容提供真实标题、说明和可选局部操作。
- `AiDraftItemCard` 用于重复对象，例如食材、采购项、库存操作和步骤；仅在其确实是独立子任务时使用边界。
- `AiDraftImpactNote` 表达确认影响、待处理提醒、错误恢复和危险后果。计划、提醒和中性说明使用 `role="note"`，危险影响使用 `role="alert"`。
- `AiDraftResolvedSummary` 在审批不再 pending 时保留可核对的结果事实，且不显示新的确认成功文案。

## Field and Resource Selection Rules

字段必须提供可见 label；placeholder 不能替代 label。帮助文案、必填标记和字段错误与控件保持明确关联。

资源查找仍由父级持有 query、分页、loading 和回调；Draft 组件只组合 `SearchableResourceSelect` 的字段外壳。保留已有的自定义单位、可输入分类、多选和标签去重语义，不能为了统一外观改变交互规则。

## Custom UI Boundary

每个 Draft View 可以为业务结构编写局部 JSX 和局部 `.ai-*` 选择器，但共享摘要、分区、影响提示、条目卡、字段外壳和已处理状态优先使用 Draft 基础组件。业务 CSS 不得重建 ui-kit 的 select、combobox、资源选择或表单动作视觉。

共享 Draft 结构使用 `.ai-draft-*` 前缀并放在 `frontend/src/styles/09-ai-draft-ui.css`。AI 对话、composer 和审批面板外壳继续由 `09-ai-workspace.css` 负责。

## Responsive and Accessibility Requirements

- Desktop 控件高度为 44px；手机、平板和粗指针设备的高频控件高度为 48px，独立交互目标至少 44px。
- 使用 `min-width: 0`、可换行文本和单列重排避免长中文、数字 ID 与操作栏横向溢出。
- Draft 卡片桌面使用 `--space-6` 内边距，手机使用 `--space-5`；内嵌分组使用 `--space-4` 或 `--space-5`。
- 所有交互保留真实原生语义、visible focus、键盘可达性、loading/disabled 文案和非颜色状态说明。
- 审批操作区在手机保持可触达，并考虑安全区、键盘和正文滚动边界。

## Review Checklist

- 是否保留 Draft 原有内容、默认值、校验、payload、资源查询和审批语义？
- 是否优先复用了真实 ui-kit，而非建立平行控件？
- 是否清楚区分 plan、warning、danger、failure 和 resolved？
- 是否使用 `--surface-*`、`--text-*`、`--line-*`、`--space-*` 和 `--radius-*` 固定 token？
- 是否在桌面、平板和手机上检查过长文本、多个条目、底部操作与横向溢出？
- 新增共享结构是否放入 `09-ai-draft-ui.css`，且没有重复覆盖 `09-ai-workspace.css` 的责任？

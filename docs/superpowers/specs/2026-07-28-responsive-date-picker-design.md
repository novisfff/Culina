# AI Draft 响应式日期选择器设计

日期：2026-07-28

## 1. 背景

AI Draft 中的餐食、餐食计划、做菜、库存入库和库存追踪编辑器仍使用浏览器原生 `input[type="date"]`。当前实现有两个直接问题：

- 浏览器自带的日历按钮位置不可控，在现有 Draft 输入框中距离右边缘过近；
- 展开的日期面板由浏览器或操作系统决定，无法与 Culina 的暖白卡面、橙色选择态、移动端底部抽屉和无障碍交互保持一致。

日期值本身已经以 `YYYY-MM-DD` 在 Draft、校验和提交 payload 中传递。本次只替换日期字段的可见控件和选择交互，不改变 AI Draft 合同、日期值格式、审批流程或后端接口。

## 2. 已确认决策

1. 新增一个无第三方依赖的项目级日期选择组件。
2. 本次替换所有 AI Draft 日期字段，不批量迁移 AI Draft 之外的原生日期输入。
3. 桌面端使用跟随字段的锚定浮层；手机端使用底部抽屉。
4. 是否允许清空由字段现有业务属性决定：必填日期不可清空，可选日期可以清空。
5. 星期从周一开始，使用简体中文月份、星期和操作文案。

## 3. 目标与非目标

### 3.1 目标

- 解决日历触发按钮贴近输入框右边缘的问题，提供稳定的右侧内边距和独立点击热区。
- 提供符合 Culina 视觉体系的日期字段、月历和选中状态。
- 桌面、平板和手机共享日期计算与受控值接口，同时使用符合各设备特点的展开方式。
- 保留 AI Draft 当前字段值、默认值、只读状态、校验和提交 payload。
- 支持键盘导航、焦点恢复、弹层标题关联和足够的触控尺寸。
- 将月份网格、范围判断和日期移动实现为可独立测试的纯逻辑。

### 3.2 非目标

- 不修改 AI Draft schema、审批状态、后端 serializer、API 或数据库。
- 不引入日期库或第三方日历组件。
- 不在本次替换食材、菜谱、食物等普通业务页面中的全部原生日期输入。
- 不增加日期范围、工作日、节假日、农历、时间选择、多日期、日期区间或自然语言输入能力。
- 不擅自禁止过去或未来日期；如现有消费者没有 `min` / `max` 规则，新组件也不新增。
- 不把日期控件做成 AI Draft 专用实现；AI Draft 只负责组合通用 ui-kit 组件。

## 4. 方案选择

### 4.1 采用方案：自研无依赖日期选择器

新增受控的 `DatePickerField`，使用现有 `frontend/src/lib/date.ts` 的日期键格式，并补充独立的月历模型。桌面浮层和手机底部抽屉共享同一套日期网格、选择、清空、上下限和键盘移动语义。

该方案能精确控制视觉、按钮位置、触控尺寸和无障碍行为，同时不增加运行时依赖。月历逻辑通过纯函数和组件测试控制风险。

### 4.2 未采用方案

- **仅美化原生日期输入**：能够调整外层间距，但原生日历面板仍由浏览器控制，无法满足统一且精美的跨端体验。
- **引入第三方日历库**：初始实现较快，但增加依赖、包体和样式覆盖成本；当前只需要单日期选择，不足以抵消这些成本。

## 5. 架构与职责

### 5.1 文件与边界

计划新增：

```text
frontend/src/components/ui-kit/DatePickerField.tsx
frontend/src/components/ui-kit/DatePickerField.test.tsx
frontend/src/components/ui-kit/datePickerModel.ts
frontend/src/components/ui-kit/datePickerModel.test.ts
```

并更新：

```text
frontend/src/components/ui-kit/index.ts
frontend/src/styles/00-ui-kit.css
AI Draft 中现有日期字段的 View / Editor 与对应测试
```

职责划分如下：

| 单元 | 负责 | 不负责 |
| --- | --- | --- |
| `datePickerModel` | 解析有效日期键、生成固定六行月历、周一起始、闰年、跨月日期、上下限判断、按天/月移动 | React 状态、DOM、业务必填规则 |
| `DatePickerField` | 受控值、触发器、月份浏览、桌面/手机 presentation、焦点和键盘交互 | AI Draft 校验、payload、字段是否必填的业务决定 |
| AI Draft 消费者 | label、当前值、`required` / `allowClear`、disabled、更新 Draft 的回调和局部布局 | 重建月历或覆盖 ui-kit 基础视觉 |

组件通过 `frontend/src/components/ui-kit/index.ts` 以及兼容出口导出。通用样式使用 `.ui-date-picker-*` 前缀并放在 `00-ui-kit.css`；AI Draft 样式只处理字段在现有网格和入库日期区中的布局。

### 5.2 组件接口

组件使用明确的受控接口，建议形状如下：

```ts
type DatePickerFieldProps = {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  allowClear?: boolean;
  min?: string;
  max?: string;
  placeholder?: string;
  leadingIcon?: ReactNode;
  className?: string;
  triggerFieldKey?: string;
};
```

- `value` 和 `onChange` 继续使用 `YYYY-MM-DD`；清空时回传空字符串，由消费者按现有结构转换为 `null` 或 `''`。
- `required` 用于语义表达；`allowClear` 只有在 `required !== true` 时才生效。若配置矛盾，必填优先，不显示清除操作。
- `min` / `max` 是通用能力，只禁用范围外日期；本次 AI Draft 没有既有范围的字段不传入。
- 组件不内部持久化选中值；切换月份只改变临时浏览月份。
- 无值时以今天所在月份打开；有值时以选中值所在月份打开。
- 传入无法解析的值时，触发器保留原始文本以避免静默丢值，日历按今天打开；选择有效日期后再由 `onChange` 正常替换。开发环境可输出非敏感警告，但界面不崩溃。

### 5.3 Presentation 选择

设备层级遵循项目固定断点：

- `max-width: 767px`：手机底部抽屉；
- `768px` 及以上：锚定浮层，其中平板继续使用较大的触控尺寸；
- `pointer: coarse`：控件和日期按钮至少保持 44px 命中区，高频字段高度为 48px。

组件在打开时读取固定媒体条件决定本次 presentation；打开期间不因一次轻微 viewport 变化重置用户当前浏览月份。设备层级发生实际变化时，关闭并重新打开即可使用另一 presentation。

## 6. 字段与触发器设计

### 6.1 可见结构

日期字段仍保留真实可见 label。触发器是一个原生 `button type="button"`，内部依次为：

1. 可选的左侧语义日历图标；
2. 日期文本或“选择日期”占位文案；
3. 右侧独立的日历操作区域。

有值时显示为中文日期，例如 `2026年7月28日`，数据值仍为 `2026-07-28`。整个触发器均可打开日历，不要求用户精准点击图标。

右侧图标保持 18px 视觉尺寸，所在操作区域具有不小于 44px 的实际命中宽度；图标区域与控件右边缘保留 `--space-4 (12px)` 的视觉内边距。文本通过 `min-width: 0` 和省略策略避免挤压图标。这一结构直接替代不可控的原生 `::-webkit-calendar-picker-indicator`，解决按钮贴边问题。

### 6.2 尺寸和状态

- 桌面字段高度：`--control-height (44px)`；手机、平板和粗指针：`--control-height-touch (48px)`。
- 控件左右内边距：12px；圆角：`--radius-sm (14px)`；背景：`--surface (#FFFFFF)`；边框：`--line-soft`。
- 文本：`--text-body (15px)`、500/1.5；有效值使用 `--text`，占位使用 `--text-faint`。
- focus 使用 `--accent (#D26B33)` 边框和 2px `--focus-ring` outline；打开状态与 focus 保持同一层级，不增加高饱和发光。
- disabled 使用规范 `opacity: 0.58`，保持当前日期可读但不响应打开。
- 左侧装饰图标和右侧日历图标均 `aria-hidden="true"`，可访问名称由触发器和字段 label 提供。

`AiInventoryIntakeApproval` 的日期来源 badge 继续放在日期字段外侧，不塞入触发器内部；手机空间不足时字段与 badge 换行，不能压缩日期按钮热区。

## 7. 日历面板设计

### 7.1 共享月历内容

桌面浮层和手机抽屉共享以下内容：

- 月份头：上个月按钮、`2026年7月` 标题、下个月按钮；
- 星期头：`一、二、三、四、五、六、日`；
- 固定 `6 × 7` 日期网格，避免切换月份时高度跳动；
- 底部快捷操作：“今天”，以及仅在可选字段中出现的“清除”；
- 当前选中日期和今天具有不同且可叠加识别的状态。

相邻月份日期保留在网格中，使用 `--text-faint` 降低层级但允许选择。点击后选中该日期，并把内部浏览月份同步到该日期所在月份。

选择有效日期后立即调用 `onChange` 并关闭。切换月份不会修改字段值。“今天”遵守 `min` / `max`；超出范围时禁用，而不是偷偷选择最近的日期。

### 7.2 桌面锚定浮层

桌面浮层通过 portal 渲染到稳定 overlay 容器，避免被 Draft 卡片的 `overflow` 或 stacking context 裁切。它根据触发器 `getBoundingClientRect()` 定位：

- 默认在字段下方，与字段间隔 `--space-3 (8px)`；
- 下方空间不足时翻转到字段上方；
- 水平方向夹在视口安全边距内，不超出窗口；
- 窗口 resize 或承载区滚动时重新定位，不改变浏览月份；
- 浮层宽度以完整容纳七列日期为准，同时不超过视口安全宽度。

桌面浮层使用 `role="dialog"`、可见月份标题关联和受控焦点；它不是阻断页面的全屏 modal，不显示 backdrop，也不锁定背景滚动。点击外部、按 `Escape` 或完成选择时关闭并恢复焦点。

### 7.3 手机底部抽屉

手机端通过 portal 使用现有 Overlay 的焦点、Escape、背景滚动锁和焦点恢复能力，外观采用日期选择器专用 bottom sheet：

- 宽度 100%，最大高度遵循 `min(92dvh, var(--app-visual-viewport-height))`；
- 顶部圆角 24px，背景 `--surface-2`，阴影 `--shadow-lg`；
- backdrop 使用 `--overlay-backdrop`；
- 顶部包含 drag handle、标题“选择日期”和明确的 44px 关闭按钮；
- body 为唯一滚动区，底部操作区增加 `env(safe-area-inset-bottom, 0px)`；
- 日期按钮在 375px 宽视口仍保持不小于 44px 的命中区，网格均匀铺满可用宽度。

手机抽屉不是提交表单，没有 busy 提交阶段。点击 backdrop、关闭按钮、系统返回或 `Escape` 都只关闭选择器，不改变当前字段值；拖拽关闭复用现有安全关闭语义。

## 8. 视觉规范

### 8.1 色彩与表面

- 浮层/抽屉：`--surface-2 (rgba(255, 255, 255, 0.98))`、`--line-soft (rgba(147, 96, 63, 0.12))`。
- 月历次级区域：`--surface-warm (#FCFAF7)` 或透明背景，不建立卡片套卡片。
- 正文：`--text (#2F251E)`；辅助和星期：`--text-soft (#6A5B51)`；相邻月份：`--text-faint (#928378)`。
- 选中日期：`--accent (#D26B33)` 实心圆/圆角方形和白色日期文字。
- 今天：未选中时使用 `--accent-strong (#B35122)` 文字与 `--accent-line` 细描边；同时选中时保留可见的“今天”辅助标记或可访问名称，不只依赖颜色。
- 禁用日期：降低透明度并设置 disabled 语义，不响应 hover 或点击。

### 8.2 字体、间距、圆角与阴影

- 月份标题：`--text-base (16px)`、700、1.4；手机标题栏：`--text-md (18px)`、700、1.35。
- 日期和按钮：`--text-meta (14px)` 或 `--text-body (15px)`，选中日期 700。
- 面板内关联元素使用 `--space-3 (8px)`；头、网格和快捷操作分组使用 `--space-4 (12px)` 或 `--space-5 (16px)`。
- 桌面浮层使用 `--radius-md (20px)`、`--shadow-lg`；手机抽屉顶部圆角固定 24px。
- 月份切换和关闭按钮使用至少 44px 热区、18px/20px 图标，不使用 compact 热区。

### 8.3 动效

- 打开、关闭和月份内容切换不超过 `--motion-slow (240ms)`；hover/active 使用 `--motion-fast (120ms)`。
- 不使用弹跳、旋转、缩放强调或发光。
- `prefers-reduced-motion: reduce` 下移除位移动效和非必要过渡。

## 9. 无障碍与键盘行为

触发器提供：

- `aria-haspopup="dialog"`；
- `aria-expanded`；
- 打开时通过 `aria-controls` 关联当前面板；
- 结合可见 label 的明确名称，例如“日期，当前为2026年7月28日”。

面板提供可见标题和 `aria-labelledby`。日期使用真实 `button`，完整名称例如“2026年7月28日，星期二，今天，已选择”；相邻月份和禁用状态也通过语义表达。

键盘规则：

| 按键 | 行为 |
| --- | --- |
| `Enter` / `Space` | 打开选择器；在日期上确认选择 |
| `Escape` | 关闭且不改值，焦点恢复到触发器 |
| `ArrowLeft` / `ArrowRight` | 前一天 / 后一天 |
| `ArrowUp` / `ArrowDown` | 前七天 / 后七天 |
| `Home` / `End` | 当前周的周一 / 周日 |
| `PageUp` / `PageDown` | 上个月 / 下个月，尽量保留日号并处理月末 |
| `Shift + PageUp` / `Shift + PageDown` | 上一年 / 下一年 |

打开时焦点优先进入已选日期；无值时进入今天；如果该日期受 `min` / `max` 禁用，则进入当前网格内最近的可用日期。日期网格采用 roving tabindex，始终只有一个日期按钮进入 Tab 顺序。Tab 在桌面浮层和手机抽屉内部按可见操作顺序移动；手机端由现有 Overlay 生命周期保持焦点陷阱。

## 10. AI Draft 迁移映射

本次替换以下现有 `input[type="date"]`：

| 消费位置 | 字段 | 规则 |
| --- | --- | --- |
| `AiMealPlanDraftView` | 计划项日期 | 必填，不允许清空 |
| `AiRecipeCookDraftView` | 做菜日期 | 必填，不允许清空；保留 `requiresRegeneration` 禁用逻辑 |
| `AiMealLogDraftView` | 餐食日期 | 必填，不允许清空 |
| `AiInventoryIntakeApproval` | 统一入库日期 | 必填，不允许清空；保留日期来源 badge 和来源更新逻辑 |
| `AiInventoryIntakeApproval` | 单项到期日 | 可选，允许清空；继续写回 `null` |
| `AiSpecializedApprovalEditors` 的 presence resolution | 采购日、到期日 | 按现有校验均为可选，允许清空 |
| `AiSpecializedApprovalEditors` 的 exact resolution | 采购日 | 必填，不允许清空 |
| `AiSpecializedApprovalEditors` 的 exact resolution | 到期日 | 可选，允许清空 |

`AiRecommendationPlanDialog`、`RecipeDraftDialog` 以及非审批业务页面不属于本次 AI Draft 迁移范围。

迁移必须保持：

- 当前 `onChange` 的字段名和空值转换；
- readonly、disabled 和 `requiresRegeneration` 行为；
- AI Draft validator 的错误文案和提交顺序；
- 入库日期来源更新、到期日校验及审批 payload；
- Draft 折叠、展开和 resolved 状态不因日期组件增加额外高度或错误 overlay 层级。

## 11. 错误与边界处理

- 月份切换跨越闰年和月末时使用日历日期规则，不用毫秒差规避时区。
- 所有日期键计算基于日期部分，不把 `YYYY-MM-DD` 当 UTC instant 显示，避免中国时区前后偏移一天。
- `min > max` 属于无效组件配置：开发环境提示，面板禁用日期选择但仍允许安全关闭；不静默交换边界。
- 没有可选日期时，网格保持可读并显示简短说明“当前范围内没有可选日期”。
- 消费者在选择器打开期间把字段切换为 disabled 或 readonly 时，选择器立即关闭且不修改值。
- 外层 AI Draft 被折叠、卸载或变为 resolved 时，portal 和事件监听必须同步清理。
- 嵌套在 AI 工作区 Overlay 内时，手机日期抽屉必须成为最上层焦点作用域；关闭后只恢复到日期字段，不关闭父级 Draft。

## 12. 测试与验收

### 12.1 纯逻辑测试

`datePickerModel.test.ts` 至少覆盖：

- 周一开始的固定 6 × 7 网格；
- 跨年、跨月、二月和闰年；
- 月末按月移动，例如 1 月 31 日到 2 月；
- `min` / `max` 边界包含当天；
- 今天、已选、相邻月份和禁用标记；
- 空值、有效值和无效日期键；
- 中国时区下不发生日期偏移。

### 12.2 组件测试

`DatePickerField.test.tsx` 至少覆盖：

- 触发器日期格式、placeholder、右侧按钮结构和 disabled；
- 打开时以选中日期或今天为焦点；
- 月份切换、相邻月份选择、今天快捷项和立即关闭；
- 必填字段不显示清除，可选字段清除并回传空字符串；
- `min` / `max` 禁用、无可选日期和无效配置；
- 外部点击、Escape、焦点恢复和 ARIA 关联；
- 完整键盘导航和 roving tabindex；
- 桌面锚定/翻转与手机底部抽屉 presentation；
- 折叠、卸载或 disabled 变化后的监听和 portal 清理。

AI Draft 现有测试增加代表性行为断言：必填日期更新、可选到期日清空、统一入库日期来源更新、只读字段不可打开，以及父 Draft 折叠/展开时没有残留面板。

### 12.3 自动化验证

实现完成后至少运行：

```bash
npm --prefix frontend test -- src/components/ui-kit/datePickerModel.test.ts src/components/ui-kit/DatePickerField.test.tsx
npm --prefix frontend test -- src/components/ai/AiApprovalPanel.test.tsx src/components/ai/AiInventoryIntakeApproval.test.tsx
npm run frontend:quality
npm run frontend:build
npm run frontend:e2e:p0
npm --prefix frontend run check:style-tokens
git diff --check
```

`check:style-tokens` 是报告型检查，必须人工审阅本次是否增加新的漂移命中，不能只依据退出码判断视觉通过。

### 12.4 真实视口验收

至少检查：

- 手机：375 × 812、390 × 844、430 × 932；
- 平板竖屏：768 × 1024；
- 平板横屏：1024 × 768；
- 桌面：1440 × 900。

人工场景包括：输入框右侧按钮间距、桌面浮层上下翻转和视口夹紧、手机底部抽屉、安全区、长中文 label、来源 badge 换行、父 Draft 滚动/折叠、键盘焦点、浏览器缩放、只读状态和横向溢出。

## 13. 完成标准

当以下条件全部满足时，本功能完成：

1. 所有表中列出的 AI Draft 日期字段均使用同一个 ui-kit 日期选择器。
2. 右侧日历图标具有标准内边距和命中区域，在目标视口不贴边、不覆盖日期文本。
3. 桌面使用稳定锚定浮层，手机使用可安全关闭的底部抽屉，二者共享日期行为。
4. 必填和可选日期的清空规则与现有业务校验一致。
5. 日期值和提交 payload 仍为原有 `YYYY-MM-DD` / `null` 语义。
6. 键盘、焦点、ARIA、disabled、上下限和卸载清理测试通过。
7. 前端质量、构建、P0、样式报告审阅和目标视口人工验收均已记录真实结果。

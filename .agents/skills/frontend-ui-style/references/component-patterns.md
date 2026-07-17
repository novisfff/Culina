# Culina 固定页面与组件样式

本文件固定 Culina 页面、按钮、卡片、列表、表单、状态面、首页和 AI 工作区的视觉样式。真实组件名和 props 从当前 `ui-kit` 与业务实现确认；无论组件叫什么，都必须落到这里定义的视觉角色，不能在业务页另造一套外观。

## 目录

- [实现与复用规则](#实现与复用规则)
- [页面骨架](#页面骨架)
- [按钮](#按钮)
- [卡片](#卡片)
- [列表](#列表)
- [表单](#表单)
- [状态面](#状态面)
- [导航、tab 与 chip](#导航tab-与-chip)
- [首页](#首页)
- [AI 工作区](#ai-工作区)
- [组件状态完整性](#组件状态完整性)
- [组件 brief 契约](#组件-brief-契约)

## 实现与复用规则

1. 读取 `frontend/src/components/ui-kit/index.ts` 和兼容出口，确认真实导出。
2. 读取候选组件实现与测试，确认 props、语义、状态和可访问行为。
3. 读取目标业务 CSS 和最终媒体查询，找出当前实现与本规范的差异。
4. ui-kit 已有能力时复用；业务组件只补业务结构和局部布局，不覆盖基础视觉。
5. 同一视觉角色只有一套规格。旧组件使用近似但不同的颜色、字号、圆角或高度时，视为漂移。

不要在 Skill 里维护易失真的组件名称清单，但必须维护稳定的组件视觉角色和数值。

## 页面骨架

### 应用画布

- 页面背景固定 `--bg (#FAF8F5)`，正文固定 `--text (#2F251E)`。
- 页面内容最大宽度固定 `--content-width (1440px)`。
- 桌面页面主区块间距固定 `--space-7 (24px)`；手机固定 `--space-5 (16px)`。
- 页面只保留一个页面级最强 CTA。独立工作流可以有自己的提交按钮，但不能与页面级 CTA 同时抢主视觉。

### 页面头

- 使用主卡面 `--surface-2`、`--line-soft`、`--radius-md (20px)` 和 `--shadow-sm`。
- 桌面内边距使用上下 `--space-6 (20px)`、左右 `--space-7 (24px)`；手机统一 `--space-5 (16px)`。
- 页面标题使用 `--text-2xl (28px)`、700、1.25；手机使用 `--text-xl (24px)`。
- 描述使用 `--text-body (15px)`、`--text-soft`、1.5；eyebrow 使用 `--text-xs (12px)`。
- 页面头不是 hero，不使用超大标题、整幅营销插画或大面积渐变。

### 区块头

- 标题使用 `--text-lg (20px)`、700、1.35；手机使用 `--text-md (18px)`。
- 标题与描述间距固定 `--space-2 (6px)`，区块头与内容间距固定 `--space-4 (12px)`。
- 区块级操作默认 secondary 或 tertiary；只有该区块是当前主任务时才能使用 primary。

## 按钮

普通按钮共享：

```css
min-height: var(--control-height); /* 44px */
padding: 0 16px;
border-radius: var(--radius-sm);   /* 14px */
gap: 8px;
font-size: var(--text-body);       /* 15px */
font-weight: 700;
line-height: 1;
```

手机、平板和粗指针设备上的高频按钮可见高度固定 `--control-height-touch (48px)`。compact 按钮仅限鼠标环境中的桌面低频工具栏，固定 `36px` 高、`--radius-xs (10px)`、`--text-meta (14px)`；不能用于主操作、关闭、返回、危险操作或唯一恢复动作。

### Primary

- 背景 `--accent (#D26B33)`，文字 `#FFFFFF`，边框透明。
- hover 背景 `--accent-strong (#B35122)`。
- 默认阴影 `0 10px 22px rgba(210, 107, 51, 0.18)`；hover 为 `0 12px 26px rgba(210, 107, 51, 0.22)`。
- 同一页面或任务容器只出现一个最强 primary。

### Secondary

- 背景 `--surface (#FFFFFF)`，文字 `--text-soft (#6A5B51)`，边框 `--line-soft`。
- 默认阴影 `0 1px 2px rgba(74, 54, 40, 0.03)`。
- hover 文字 `--accent-strong`，边框使用 `rgba(210, 107, 51, 0.30)`，阴影提高到 `--shadow-sm`。

### Tertiary

- 透明背景、无边框、无阴影，文字 `--text-soft`。
- hover 文字 `--accent-strong`；独立 tertiary 按钮仍使用普通按钮高度，不能用 28px 或 32px 热区表达“轻量”。正文中的行内链接不是 tertiary 按钮，按行内文本规则处理。

### Danger

- 破坏性主确认使用 `--danger (#D94B3D)` 背景和 `#FFFFFF` 文字。
- 非最终危险入口使用 `--danger-soft` 背景、`--danger` 文字和低透明危险边框。
- 按钮附近必须写清对象和不可逆后果，不能只写“确认”。

### 状态

- focus-visible 统一使用 2px `--focus-ring` outline 和 2px offset。
- disabled 统一 `opacity: 0.58`、禁用光标、无位移和无阴影。
- loading 保持按钮宽度，显示进度与动作文字，禁止重复提交。
- 默认图标视觉尺寸 18px；关闭、返回和强调图标 20px。独立图标按钮固定 44px 外层命中区域，视觉图标保持原尺寸；不得只把 SVG 放大到 44px。
- 一行操作在满足命中尺寸后放不下时，优先降低操作数量、收起低频操作、缩短文案或在手机改为纵向排列，不缩小热区或把主操作放入横向滚动。

## 卡片

### 标准卡片

```css
padding: var(--space-6);           /* 20px */
border: 1px solid var(--line-soft);
border-radius: var(--radius-md);   /* 20px */
background: var(--surface-2);
box-shadow: var(--shadow-sm);
```

手机内边距固定 `--space-5 (16px)`。卡片标题使用 `--text-md (18px)`、600、1.4；手机使用 `--text-base (16px)`。正文使用 `--text-body (15px)`，元信息使用 `--text-sm (13px)`。

### 紧凑摘要卡

- 内边距 `--space-5 (16px)`，圆角 `--radius-sm (14px)`。
- 主表面 `--surface`，边框 `--line-soft`，默认无阴影。
- 适用于首页统计、简短状态和小型摘要；高频触控时整卡最小高度不得牺牲 44px 热区。
- 语义色只放在图标底、badge、关键数字或细强调线，不填满整卡。

### 重点卡片

- 内边距 `--space-7 (24px)`，圆角 `--radius-md (20px)`，阴影 `--shadow-md`。
- 仅用于当前推荐、关键任务、复杂草稿或审批；一个视口内不要并列多个重点卡。

### 内嵌分组

- 内边距 `--space-4 (12px)` 或 `--space-5 (16px)`，圆角 `--radius-sm (14px)`。
- 背景 `--surface-warm` 或 `--surface-muted`，边框 `--line-soft`，无阴影。
- 卡片内不再嵌套另一张带阴影标准卡；真正独立的子任务才允许第二层边界。

### 照片对象卡

- 菜谱/食物主图固定 `4 / 3`，食材缩略图固定 `1 / 1`，`object-fit: cover`。
- 图片与卡片共享外层圆角并裁切；文字区 `min-width: 0`。
- 标题最多按当前列表密度显示两行，超出截断；详情页标题允许完整换行。
- 卡内最多一个 primary，其余操作降为 secondary/tertiary。

## 列表

### 标准列表行

- 桌面最小高度 56px，手机/触控最小高度 64px。
- 内边距桌面 `--space-4 (12px)`，手机固定 `--space-5 (16px)`。
- 行内 gap 固定 `--space-4 (12px)`，分割线使用 `--line-soft`。
- 标题 `--text-body (15px)`、600；说明 `--text-sm (13px)`、`--text-soft`；元信息 `--text-xs (12px)` 或 `--text-sm`。
- 保护对象名和主状态，低频操作进入更多菜单；唯一恢复动作不得隐藏。

任务列表按紧迫度或时间排序；数据列表按稳定业务规则排序。手机不使用横向滚动隐藏主操作，改为标题/状态、说明、操作的纵向结构。

## 表单

### 字段

- label 使用 `--text-meta (14px)`、600、1.4；label 与控件间距 `--space-3 (8px)`。
- 输入、select、combobox 桌面高度 44px，手机/平板 48px。
- 控件圆角 `--radius-sm (14px)`，左右内边距 12px，边框 `--line-soft`，背景 `--surface`。
- 正文 `--text-body (15px)`；placeholder 使用 `--text-faint`，不能替代 label。
- focus 边框 `--accent`，外环使用 `--focus-ring`；error 边框和文字使用 `--danger`。
- textarea 最小高度 96px、垂直可调整；长内容弹层内由 body 滚动。

### 分组与动作

- 字段间距固定 `--space-5 (16px)`，表单分组间距固定 `--space-6 (20px)`。
- 分组标题使用 `--text-base (16px)`、600；辅助说明使用 `--text-sm (13px)`。
- footer 动作间距 10px，主提交在视觉和 tab 顺序上清楚；危险动作与普通提交分离。
- 失败后保留输入并就近显示错误；顶部摘要不能替代字段错误。

## 状态面

### Status badge

- 默认最小高度 24px，水平内边距 9px，`--radius-pill`。
- 字号 `--text-sm (13px)`、700；compact 为 20px 高、7px 水平内边距、`--text-xs (12px)`。
- neutral 使用 `--surface-muted / --text-soft`；success、warning、danger、info、plan 使用固定色板同名组合。

### Empty/loading/error block

- 内边距 18px，gap 8px，圆角 `--radius-sm (14px)`。
- 默认背景 `--surface-warm`，边框 `1px dashed --line-soft`。
- 标题使用 `--text-base (16px)`、600；描述使用 `--text-body (15px)`、`--text-soft`。
- error 改用 `--danger-soft / --danger`，并提供重试或返回；loading 保持最终内容的稳定高度。

### Progress 与部分成功

- 默认显示紧凑摘要：当前步骤、已完成数量、是否可停止。
- 详细过程按需展开，不默认占满主要阅读区。
- partial success 必须把成功项和失败项分开，使用 success/danger 对应组合，并提供失败项恢复动作。

### 危险确认

- 使用小型或中型 modal，不使用普通 toast 代替。
- 标题写动作与对象，正文写影响范围和不可逆后果。
- 取消使用 secondary，最终删除使用 danger；默认焦点不能落在破坏性按钮上。

## 导航、tab 与 chip

- 默认高度 36px；手机高频选择高度 44px。
- tab/subnav 使用 `--radius-xs (10px)`，未选中透明或中性表面，文字 `--text-soft`。
- 当前项使用 `--accent-soft` 或低透明暖底，文字 `--accent-strong`；不使用实心主按钮样式。
- chip 使用 `--radius-pill`，高度 32px；手机和平板高频触控 chip 固定 44px。
- 横向导航仅在选项数量合理且可滚动提示清楚时使用；移动端不得塞入密集小字。

## 首页

首页是今日任务工作台，固定内容优先级为：今日任务 → 临期/过期 → 待采购 → 餐食计划 → 家庭状态。真实紧急程度可以把过期项提升到最前，但不能改成营销介绍页。

### 统计

- 使用紧凑摘要卡规格，统一主卡面、无阴影或 `--shadow-sm`。
- 在库/正常使用 info 或 success；临期 warning；过期 danger；待采购 warning/`--butter-soft`；计划 plan。
- 数值使用 `--text-xl (24px)`、700，标签使用 `--text-meta (14px)`，说明使用 `--text-sm (13px)`。
- 不可点击统计卡不添加 hover 位移；可点击时整卡使用真实 button/link 语义。

### 今日推荐/任务

- 使用重点卡片规格；真实菜谱图片优先，主操作“开始做”或当前真实动作使用唯一 primary。
- “换一批、查看详情、日历切换、查看更多”固定为 secondary 或 tertiary。
- 推荐理由保持一到两条可核对信息，不写营销文案。

### 临期、采购与家庭状态

- 已过期 danger，临近 warning，安全/已处理 success；同时显示时间与数量。
- 待采购未完成 warning，已完成 success。
- 家庭动态默认 info/neutral，只有需要当前用户行动时升级。
- 每张卡都具备 loading、empty、error；局部错误不清空其他卡，刷新失败保留旧数据并标记陈旧。

## AI 工作区

AI 页面使用更克制的卡面和阴影，固定优先级为对话可读 → 运行状态真实 → 草稿/审批清楚 → composer 可控 → 角色装饰。

### 消息

- 助手消息：`--surface (#FFFFFF)`、`--line-soft`、`--radius-md (20px)`、`--shadow-sm`，正文 `--text-body (15px)`、1.6。
- 用户消息：`--accent-soft (#FCE1D4)`、低透明 accent 边框、`--text (#2F251E)`、`--radius-md`；不使用大面积高饱和渐变。
- 消息最大阅读宽度由现有工作区布局控制；长文本、代码、表格和图片必须安全换行或局部滚动。
- 工具过程使用 neutral/accent 紧凑摘要；完成 success，等待 warning，失败 danger。

### 草稿与审批

- 使用重点卡片规格，圆角 20px；header、可滚动 body、操作 footer 三层固定。
- pending 使用 plan 或 warning，展示对象、变更摘要、风险、修改和确认。
- resolved 降低操作强度并保留结果摘要；用户确认前不能出现“已写入”“已完成”。
- 操作区 primary 为确认，secondary 为修改/取消；失败后保留草稿并给出恢复动作。

### Composer

- 主输入最小高度 48px，圆角 `--radius-md (20px)`，背景 `--surface`，边框 `--line-soft`。
- 发送按钮触控区 44px，发送中切换为停止或明确 busy 状态，不允许重复发送。
- 附件展示上传中、失败、可移除状态；底部区域处理 safe area 和软键盘。

### 欢迎态

- 可以使用厨房角色图和快捷问题，但只使用一个视觉焦点。
- 标题不超过页面标题层级；说明使用正文层级；不得做成营销 hero 或遮挡历史和输入入口。

## 组件状态完整性

每个组件至少验证：

- default、hover、active、focus-visible、disabled、loading。
- empty、error、success、warning、danger、plan、partial success。
- 长中文标题、长数字/ID、缺图、图片失败、极端数量和无权限。
- 桌面、平板、手机的触控、换行、滚动和主操作可达性。

不能只为默认状态写视觉，再用临时 class 覆盖其他状态。

## 组件 brief 契约

实现 brief 必须包含：

- 使用的组件角色和真实组件出处。
- 背景、文字、边框、状态的 token 名与对应十六进制/RGBA。
- 字号、字重、行高、间距、圆角、阴影、控件高度和图片比例。
- 主、次、轻、危险操作的固定样式和页面级优先级。
- loading、empty、error、disabled、partial success 的结构与文案。
- 手机和平板的固定规格及目标业务 CSS。
- 当前实现偏离本文件的具体项；不得以“沿用现有样式”为理由跳过对齐。

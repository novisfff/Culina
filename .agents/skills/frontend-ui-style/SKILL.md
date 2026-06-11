---
name: frontend-ui-style
description: Culina 项目专属前端 UI 风格 Skill，优先级最高。用于任何 UI 页面、组件、弹窗、表单、状态栏、列表、卡片、AI 对话页、移动端页面、响应式视觉调整和样式文件修改；生成或修改 Culina 前端界面时必须先遵循本 Skill，再考虑通用开源 Skill 或通用设计建议。
---

# Culina 前端 UI 风格

## 使用方式

先读取相关现有实现，再设计 UI。优先参考：

- `frontend/src/styles/00-foundation.css`
- `frontend/src/styles/07-mobile.css`
- 对应业务域样式：`01-home-dashboard.css`、`02-family-settings.css`、`03-recipe-workspace.css`、`04-ingredients-workspace.css`、`05-workspace-overlays.css`、`06-food-workspace.css`、`08-meal-log.css`
- 通用组件：`frontend/src/components/ui-kit.tsx`
- 应用壳：`frontend/src/app/AppShell.tsx`
- AI 页面：`frontend/src/components/ai/*`

本 Skill 是项目风格规则，不是通用漂亮模板。若通用 Skill、开源示例或模型默认审美与这里冲突，以这里为准。

## 产品气质

- 移动优先，服务中国家庭日常饮食记录、库存、菜谱、购物和 AI 辅助决策。
- 视觉关键词：温暖、家庭化、照片驱动、低维护、清晰任务入口。
- 文案默认简体中文，语气具体、克制、像家庭厨房助手，不像企业后台或营销落地页。
- AI 是实用助手，不是开放式泛聊天。AI 页面要体现家庭上下文、审批确认、工具运行进度和重要信息核对提醒。

## 布局方式

- 桌面端使用 `app-shell` + `app-frame` + `app-content`，大屏是左侧 sidebar 和工作区，内容最大宽度来自 `--content-width`。
- 业务工作区多用 CSS Grid：页面级 `display: grid; gap: 14px/16px/18px`，列表用 `repeat(auto-fit, minmax(...))`，详情/编辑用主栏 + 侧栏。
- 页面头优先用 `PageHeader`、`SectionHeading`、`WorkspaceSubpageHeader`，不要重新发明头部结构。
- 复杂业务域使用局部 shell：例如 `recipe-workspace`、`ingredients-workspace`、`ai-workspace-shell`，通过业务前缀控制样式。
- 手机端不是桌面压缩。已有 `HomeMobileDashboard`、`FoodMobileView`、`RecipeMobileLibraryView`、`IngredientMobileView`、`MealLogMobileView`、`FamilyMobileView`、`AiMobilePage` 这类独立移动视图，应延续这种结构。
- 手机端页面宽度常限制为 `width: min(100%, 480px); margin: 0 auto;`，底部保留 `env(safe-area-inset-bottom)` 和底部导航空间。

## 颜色体系

基础色来自 `:root` 变量：

- 背景：`--bg #FAF8F5`，常配浅米色/暖白渐变。
- 主文字：`--text #2f251e`，辅助文字用 `--text-soft #6A5B51`、`--text-faint #928378`。
- 主操作橙：`--accent #D26B33`、`--accent-strong #B35122`、`--accent-soft #FCE1D4`。
- 辅助色：鼠尾草绿 `--sage-soft #E2ECD8`，奶油黄 `--butter-soft #FDF3DB`。
- 分割线：`--line-soft rgba(147, 96, 63, 0.12)`，强调线用 `--line-strong`。

使用规则：

- 主按钮、当前 tab、关键状态用橙色；成功/可用用柔和绿色；临期/提醒用黄橙；危险/失败用克制红。
- 表面多用暖白、半透明白、浅米色，不要使用冷灰后台风。
- 可以使用轻量径向光和线性渐变，但必须服务空间层次，不要做纯装饰的彩色球、霓虹背景或重紫蓝渐变。
- 不要引入与饮食家庭语境无关的高饱和科技蓝、赛博紫、纯黑暗色主题。

## 圆角、间距、阴影、边框

- 共享圆角变量：`--radius-sm 14px`、`--radius-md 20px`、`--radius-lg 28px`。
- 常见卡片圆角：基础 card 20px，业务卡片 18-24px，按钮 12-14px，胶囊 chip 999px，移动底栏 26px。
- 页面 gap 常用 14px、16px、18px、22px、24px；表单和触控控件不宜过密。
- 阴影使用暖棕低透明：`--shadow-sm/md/lg` 或 `rgba(74, 54, 40, ...)`。卡片阴影轻，hover 可轻微 `translateY(-1px/-2px)`。
- 边框多用 `rgba(92, 67, 48, 0.07-0.14)` 或 `var(--line-soft)`。不要用硬黑边或冷灰线。
- 内容必须有稳定尺寸：图片用 `aspect-ratio` 和 `object-fit: cover`，按钮/状态徽标设置 `min-height`，长文本用省略或换行策略。

## 组件写法

优先复用 `frontend/src/components/ui-kit.tsx`：

- `PageHeader`、`SectionHeading`、`StatCard`、`CompactMetric`
- `Badge`、`ActionButton`
- `SegmentedTabs`、`WorkspaceSubnav`、`WorkspaceToolbar`
- `WorkspaceDrawer`、`WorkspaceModal`
- `DenseListRow`、`EmptyState`
- `TouchRangeField`、`TouchStepperField`
- `ImageComposer`、`Avatar`

新增视觉元素时先判断是否是已有组件的组合或局部变体。只有业务语义明确且复用组件不足时，才新增业务域组件和业务前缀样式。

## 卡片

- 卡片通常是暖白表面 + 浅棕边框 + 轻阴影，信息以照片/图标 + 标题 + 元信息 chip + 行动按钮组织。
- 食物、菜谱、食材卡片优先展示真实图片或已有占位图；占位应是暖色/绿色柔和渐变，不要使用抽象 SVG 营销插画。
- 列表卡片要支持长标题：`min-width: 0`、`overflow: hidden`、`text-overflow: ellipsis` 或 `overflow-wrap: anywhere`。
- 可点击卡片 hover 只做轻微上浮、边框变橙、阴影加深；不要大幅缩放或复杂动效。

## 表单

- 基础输入使用 `.text-input`，标签使用 grid gap，不要在组件里堆 inline style。
- 两列表单用 `.form-grid`，移动端改为单列。复杂表单分成 `.form-panel-section`。
- 数量、库存、评分、份量等触控输入优先用 `TouchStepperField`、`TouchRangeField`、chip 快捷值，保证 44px 左右触控面积。
- 提交按钮使用 `solid-button`，次要操作使用 `ghost-button`，文本轻操作使用 `tertiary-button`。
- 提交中、禁用、错误文案必须明确；不要只靠颜色表达状态。

## 弹窗和抽屉

- 优先使用 `WorkspaceModal` 或 `WorkspaceDrawer`，保持 `workspace-overlay-panel`、`workspace-overlay-head`、`workspace-overlay-body`、`workspace-overlay-actions` 结构。
- 弹窗标题区使用 eyebrow + h3 + subtle 描述，关闭按钮保留 `aria-label` 或屏幕阅读文本。
- 重要确认类弹窗需要清楚展示对象、影响和主/次按钮，不要只弹一句泛提示。
- 移动端弹窗要检查宽度、底部安全区、滚动区和按钮是否可触达。

## 列表、状态栏和导航

- 标签、状态和筛选项常用胶囊 chip：`border-radius: 999px`，min-height 30-44px。
- 当前状态用橙色或业务状态色，非当前项用暖白/浅米色。
- 桌面导航使用 sidebar 和顶部 tabbar；手机使用底部导航，AI tab 是头像式突出入口。
- 工作区子导航使用 `WorkspaceSubnav` 或同等结构，不要新增横向密集小字导航。
- 状态栏要表达“正在做什么”和“下一步”，例如 AI 运行进度、库存状态、餐食记录状态。

## AI 对话页

- AI 桌面页使用 `ai-workspace-shell`：左侧历史/上下文，右侧主对话面板；主面板是暖白渐变、圆角 26px、固定高度内滚动。
- AI 移动页使用 `AiMobilePage` 和 `AiMobileChrome`，不要直接复用桌面两栏。
- 消息气泡：助手左侧头像 + 白色卡片；用户右侧橙色暖渐变气泡；审批表单使助手消息更宽。
- 保留 `ai-run-progress`、tool chip、审批面板、composer 暂停态、发送/中止状态和免责声明。
- 欢迎态可以有 AI 厨师/机器人图片和快捷问题，但不要写成营销 hero。
- AI 文案避免医疗、营养诊断承诺；要提示核对重要信息。

## 移动端适配

- `@media (max-width: 767px)` 是主要移动层。移动端需要独立信息架构，不只是隐藏桌面侧栏。
- 触控目标尽量不低于 44px；底部导航、底部 composer、烹饪底栏要处理 `env(safe-area-inset-bottom)`。
- 移动端标题可更紧凑，但不要用 viewport 宽度缩放字体。
- 移动端卡片、表单和 chip 需要允许换行或单列，避免横向溢出。
- 关键路径改动后要用 smoke 或浏览器截图检查 375px/390px 宽度。

## 常见禁止项

- 不要做通用 SaaS/后台管理系统风：冷灰表格、密集管理台、硬边框、蓝色主按钮。
- 不要用营销落地页 hero 替代真实应用第一屏。
- 不要新增全局裸标签样式或泛选择器污染其他业务域。
- 不要绕开 `styles.css` 聚合入口；业务样式放 `frontend/src/styles/*` 并使用业务前缀。
- 不要在 TSX 里堆大量 inline style 表达业务 UI。
- 不要新增与当前项目冲突的一次性颜色体系、超大圆角体系、强玻璃拟态或厚重阴影。
- 不要把移动端当作桌面 JSX 的简单条件分支。
- 不要让文本、按钮、图片、状态徽标互相重叠；长文本必须有换行、省略或滚动策略。

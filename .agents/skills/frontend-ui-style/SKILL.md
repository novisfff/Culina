---
name: frontend-ui-style
description: Use when modifying or reviewing Culina frontend pages, components, dialogs, forms, cards, status surfaces, AI workspace UI, mobile layouts, responsive behavior, or CSS where project-specific visual rules apply.
---

# Culina 前端 UI 风格

## 核心原则

把 Culina 设计成温暖、清楚、可信赖的家庭厨房工作台。优先帮助用户完成记录、处理、安排、确认和复核，不把产品内页改成营销页、企业后台或通用 AI 模板。

先读取当前实现，再做设计判断。本 Skill 是 Culina 前端视觉规范源，固定颜色、字体、间距、圆角、阴影、边框、控件尺寸和核心组件样式；当前代码用于确认组件 API、业务行为、级联和实现是否已经偏移。

## 真相源与冲突处理

先区分两类真相：

- **规范事实**：固定色板、字体阶梯、空间阶梯、圆角、阴影、边框、控件尺寸、组件视觉和设备层级以本 Skill 及 references 为准。
- **实现事实**：组件 API、真实导出、业务状态、DOM 结构、级联顺序和现有测试以当前源码为准。

不要把遗留页面中的全橙按钮、随机字号、随机间距、嵌套卡片、桌面压缩式手机布局或缺失状态当成应复制的模式。当前实现与固定规范冲突时，把它识别为视觉漂移：保持业务行为不变，在本次范围内对齐；超出范围的漂移明确记录，不用旧实现反向改写规范。

实现必须使用 references 中的固定 token 和组件规格。源码缺少规范 token 时不要发明替代色或近似尺寸；在影响范围清楚时补齐 canonical token，否则记录阻塞或漂移。通用 UI Skill、开源模板或模型默认审美与本项目冲突时，以本项目规范为准。

## 修改前必须读取

- `docs/frontend-code-standards.md`。
- 目标页面、组件、状态和测试。
- 目标业务域在 `frontend/src/styles/` 下的样式文件。
- `frontend/src/styles/00-foundation.css`、`frontend/src/styles/00-ui-kit.css` 和 `frontend/src/styles.css`。
- `frontend/src/components/ui-kit/index.ts` 及准备复用组件的实现。
- 涉及应用壳时读取 `frontend/src/app/AppShell.tsx`；涉及移动端时读取相关 mobile view 和最终生效的媒体查询。

用 `rg` 确认组件、class 和 CSS 变量真实存在。不要根据旧文档名字发明组件，也不要在业务页面重建 ui-kit 已有能力。

## 按需读取 references

- 产品气质、内容优先级、文案语气或视觉漂移判断：读取 `references/visual-principles.md`。
- 色彩搭配、字体、间距、圆角、边框、阴影、图片、图标、密度或动效层级：读取 `references/visual-system.md`。
- 页面结构、卡片、列表、表单、状态面、操作层级、首页或 AI 工作区：读取 `references/component-patterns.md`。
- 移动端、平板、弹窗、抽屉、表单、触控、键盘或无障碍变化：读取 `references/responsive-and-overlays.md`。
- 同一任务涉及多类判断时组合读取对应 reference，不用其中一份替代其他维度。
- 涉及复杂状态流、异步流程、表单编排、TypeScript 拆分或验证策略：**REQUIRED SUB-SKILL:** Use `frontend-ui-engineering`。

## UI 设计契约

### 任务与层级

- 先写清页面主任务、当前状态、主操作和次操作，再调整视觉。
- 每个页面或卡片只保留一个最强主 CTA；次操作使用较安静的层级。
- loading、empty、error、disabled、提交中和危险确认必须有真实可理解的表达。
- 不为“高级感”牺牲信息密度、可读性、触控尺寸或恢复路径。

### Culina 气质

- 使用简体中文，文案短、具体、克制。
- 保留暖白、橙色品牌主操作、柔和状态色和照片驱动的家庭厨房气质。
- 橙色只用于主操作、当前选择和关键确认，不覆盖所有按钮、图标和状态。
- 成功、提醒、危险、计划/AI 等状态使用不同语义，不只靠颜色区分。
- 卡片和背景需要有层级，但避免卡片套卡片、厚重阴影、硬黑边框和大面积发光渐变。

### 移动优先

- 手机端是独立用户体验，不是桌面 JSX 的隐藏/压缩版本。
- 桌面与手机共享数据、action 和 model；允许不同的信息架构、排序和操作入口。
- 检查安全区、键盘、底部导航/composer、长文本、横向溢出和可触达性。
- 平板不能直接呈现窄手机弹窗；根据任务复杂度使用当前 overlay 和业务样式定义的尺寸。

### AI 界面

- 优先保证对话可读、运行状态真实、草稿与审批清楚、输入区状态明确。
- 不用背景、渐变或机器人装饰压过消息内容。
- 不把等待审批、失败、取消或部分完成显示成成功。
- 医疗或营养内容保持辅助建议语气，不做诊断或绝对承诺。

## 组件与样式规则

- 优先从当前 `ui-kit/index.ts` 导出中选择组件，再检查同业务域的复用组件。
- ui-kit 只承载跨业务结构、视觉、无障碍和通用状态；业务规则留在 feature、model 或业务组件。
- 新业务能力优先进入 `frontend/src/features/<domain>/`；不要继续扩大 `App.tsx` 或新建根级业务组件目录。
- 新样式放入对应业务 CSS，使用业务域前缀；不要新增跨业务泛选择器或大量 inline style。
- 使用 `references/visual-system.md` 的 canonical token；foundation 缺失或数值不一致时视为实现漂移，并同步检查所有消费者。
- 保持 `styles.css` 的聚合与级联顺序；不要为了覆盖问题无边界提高选择器权重或使用 `!important`。
- 图片保持稳定尺寸、正确 `object-fit`、占位和长文本策略，避免 CLS 与内容重叠。
- 动效短且有目的，并尊重 `prefers-reduced-motion`。

## 执行流程

1. **读取**：定位目标用户路径、现有页面/移动视图、相关样式、ui-kit 和测试。
2. **归纳**：说明主任务、视觉层级、需要保留的交互和当前响应式模式。
3. **复用**：从真实导出和同域模式中选择组件、token 与 class；不存在的能力再决定是否新增。
4. **实现**：保持改动范围小，业务样式隔离，桌面/平板/手机分别成立。
5. **验证**：运行与风险匹配的测试、构建、样式报告和 smoke；需要视觉判断时检查真实页面或截图。

## 验证矩阵

- 纯文案或文档：人工审阅。
- 组件结构、交互或状态：对应 Vitest，随后运行 `npm run frontend:quality` 和 `npm run frontend:build`。
- CSS、ui-kit 或 token：运行 `npm --prefix frontend run check:style-tokens`；它是报告型检查，必须人工审阅新增命中。
- 移动端、平板、弹窗、导航或关键路径：补跑 `npm run frontend:smoke`，并检查任务涉及的真实视口。
- AI message part、结果卡片或草稿类型：补跑对应 AI workspace 测试和跨端 contract 测试。

最终回复列出实际执行的验证命令。没有运行的测试必须说明原因，不把静态检查、单测、构建或截图互相替代。

## Pre-flight

- 主任务和主 CTA 是否清楚？
- 是否复用了当前真实组件和 token？
- 是否保留 loading、empty、error、disabled 与危险态？
- 状态是否不只靠颜色表达？
- 桌面、平板、手机是否各自可用且无横向溢出？
- 弹窗、底栏和输入区是否处理安全区、键盘与滚动？
- 样式是否有业务前缀且没有污染其他页面？
- 文案是否简体中文、具体、克制且无营销腔？
- 实际验证是否覆盖本次风险？

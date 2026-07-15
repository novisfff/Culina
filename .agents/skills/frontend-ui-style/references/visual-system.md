# Culina 固定视觉系统

本文件是 Culina 前端颜色、字体、间距、圆角、边框、阴影、控件尺寸、图片和动效的规范源。实现必须使用这里的 canonical 值；当前 CSS 与本文件不同即属于视觉漂移，不能因为旧页面已经使用就继续复制。

## 目录

- [规范优先级](#规范优先级)
- [固定色板](#固定色板)
- [颜色使用契约](#颜色使用契约)
- [固定字体系统](#固定字体系统)
- [固定间距系统](#固定间距系统)
- [固定圆角、边框与阴影](#固定圆角边框与阴影)
- [固定控件与容器尺寸](#固定控件与容器尺寸)
- [图片与图标](#图片与图标)
- [动效](#动效)
- [视觉 brief 契约](#视觉-brief-契约)

## 规范优先级

- 本文件固定视觉值与角色；`component-patterns.md` 固定组件组合；`responsive-and-overlays.md` 固定设备层级和弹层行为。
- `00-foundation.css` 应实现本文件的全局 token，`00-ui-kit.css` 应使用这些 token，业务 CSS 只添加业务布局和必要局部变体。
- 组件 API、真实导出和最终级联仍从源码确认；视觉数值不能从任意旧 class 反推。
- canonical token 缺失时，先判断能否在本次范围补入 foundation 并检查消费者；不要创建第二套同义 token 或散落近似色值。
- 业务局部颜色仅用于照片取色、数据可视化或有明确产品语义的特殊状态，且不得替代下列基础角色。

## 固定色板

以下定义是 canonical palette。代码中的十六进制字母大小写不影响结果，但新代码统一使用大写形式。

```css
:root {
  /* Canvas and surfaces */
  --bg: #FAF8F5;
  --surface: #FFFFFF;
  --surface-1: rgba(255, 255, 255, 0.60);
  --surface-2: rgba(255, 255, 255, 0.98);
  --surface-3: #FDFBF8;
  --surface-warm: #FCFAF7;
  --surface-muted: #F6F0EA;
  --surface-strong: #F4EBE1;

  /* Text */
  --text: #2F251E;
  --text-soft: #6A5B51;
  --text-faint: #928378;

  /* Brand */
  --accent: #D26B33;
  --accent-strong: #B35122;
  --accent-soft: #FCE1D4;

  /* Semantic states */
  --success: #4F9A58;
  --success-soft: #EAF6EA;
  --warning: #E2892C;
  --warning-soft: #FFF4E6;
  --danger: #D94B3D;
  --danger-soft: #FDEBE8;
  --info: #517A58;
  --info-soft: #E2ECD8;
  --plan: #7164BD;
  --plan-soft: #F0EEFF;
  --butter-soft: #FDF3DB;

  /* Lines and focus */
  --line-soft: rgba(147, 96, 63, 0.12);
  --line-strong: rgba(147, 96, 63, 0.20);
  --accent-line: rgba(210, 107, 51, 0.24);
  --success-line: rgba(79, 154, 88, 0.24);
  --warning-line: rgba(226, 137, 44, 0.24);
  --danger-line: rgba(217, 75, 61, 0.24);
  --info-line: rgba(81, 122, 88, 0.24);
  --plan-line: rgba(113, 100, 189, 0.24);
  --focus-ring: rgba(210, 107, 51, 0.28);
  --overlay-backdrop: rgba(55, 40, 30, 0.28);
}
```

### 固定搭配

| 角色 | 背景 | 文字/图标 | 边框 |
| --- | --- | --- | --- |
| 页面画布 | `--bg` | `--text` | 不使用 |
| 主卡面 | `--surface-2` | `--text` | `--line-soft` |
| 次级分组 | `--surface-warm` 或 `--surface-muted` | `--text-soft` | `--line-soft` |
| 品牌选择 | `--accent-soft` | `--accent-strong` | `--accent-line` |
| 成功 | `--success-soft` | `--success` | `--success-line` |
| 提醒 | `--warning-soft` | `--warning` | `--warning-line` |
| 危险 | `--danger-soft` | `--danger` | `--danger-line` |
| 一般信息 | `--info-soft` | `--info` | `--info-line` |
| 计划/AI 草稿 | `--plan-soft` | `--plan` | `--plan-line` |

## 颜色使用契约

### 品牌橙

品牌橙只用于：

- 页面或独立工作流唯一最强主 CTA。
- 当前导航、tab、日期或筛选选择。
- 关键确认和清晰的 focus/active 反馈。

品牌橙不用于所有按钮、图标底、卡片边框、hover、状态 badge 或辅助链接。页面出现两个实心橙按钮时，必须重新判断主次关系。

### 状态映射

| 业务事实 | 固定语义 | 示例 |
| --- | --- | --- |
| 已完成、已保存、库存正常 | success | “已记录”“库存正常” |
| 临期、待处理、等待输入 | warning | “3 天内到期”“等待确认” |
| 已过期、执行失败、不可逆危险 | danger | “已过期”“写入失败” |
| 普通动态、非阻断信息 | info 或 neutral | “家庭有新记录” |
| 推荐、计划、AI 草稿、待审批 | plan | “建议方案”“待确认草稿” |
| 执行中 | accent + 明确进度文字 | “正在生成草稿” |
| 取消或拒绝 | neutral；有损失时 danger | “已取消”“草稿已失效” |
| 部分成功 | success 与 danger 分项 | “3 项成功，1 项失败” |

状态必须同时有文字、图标或结构信息，不能只靠颜色。计划、推荐、草稿和等待审批绝不能使用 success。

### 首页配色

- 统计卡统一使用主卡面，不做四张高饱和色块。
- 在库/正常使用 success 或 info；临期使用 warning；已过期使用 danger；待采购使用 warning 或 `--butter-soft`；餐食计划使用 plan。
- 语义色集中在图标底、badge、关键数字或细强调线，卡面仍以 `--surface-2` 为主。
- 食物、菜谱和食材的真实照片承担主要食欲色彩，周围 UI 保持中性。

## 固定字体系统

### 字体族

```css
:root {
  --font-sans: 'Manrope', 'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', sans-serif;
  --font-display: 'ZCOOL XiaoWei', 'Noto Sans SC', serif;
}
```

正文、标题、按钮、表单和数据统一使用 `--font-sans`。`--font-display` 只用于登录品牌、品牌标识或少量欢迎语；普通页面标题、首页统计和 AI 消息不得使用。

### 字号阶梯

```css
:root {
  --text-xs: 0.75rem;      /* 12px */
  --text-sm: 0.8125rem;    /* 13px */
  --text-meta: 0.875rem;   /* 14px */
  --text-body: 0.9375rem;  /* 15px */
  --text-base: 1rem;       /* 16px */
  --text-md: 1.125rem;     /* 18px */
  --text-lg: 1.25rem;      /* 20px */
  --text-xl: 1.5rem;       /* 24px */
  --text-2xl: 1.75rem;     /* 28px */
  --text-display: 2.5rem;  /* 40px, only brand/welcome */
}
```

| 层级 | 桌面 | 手机 | 字重 | 行高 |
| --- | --- | --- | --- | --- |
| 品牌展示 | `--text-display` | `--text-2xl` | 700 | 1.2 |
| 页面标题 | `--text-2xl` | `--text-xl` | 700 | 1.25 |
| 区块标题 | `--text-lg` | `--text-md` | 700 | 1.35 |
| 卡片/列表标题 | `--text-md` | `--text-base` | 600 | 1.4 |
| 正文/输入 | `--text-body` | `--text-body` | 400/500 | 1.5 |
| label/按钮 | `--text-meta` 或 `--text-body` | 同桌面 | 600/700 | 1.4 |
| 元信息/badge | `--text-sm` | `--text-sm` | 500/600 | 1.4 |
| eyebrow/caption | `--text-xs` | `--text-xs` | 500/600 | 1.3 |

同一页面默认只使用页面标题、区块标题、卡片标题、正文、元信息五个层级。不要引入未在阶梯中的随意字号；特殊数据数值可以提升一级，但单位保持正文或元信息层级。

## 固定间距系统

```css
:root {
  --space-1: 4px;
  --space-2: 6px;
  --space-3: 8px;
  --space-4: 12px;
  --space-5: 16px;
  --space-6: 20px;
  --space-7: 24px;
  --space-8: 28px;
  --space-9: 32px;
}
```

| 关系 | 固定使用 |
| --- | --- |
| 图标与文字、标题与直接说明 | `--space-1` 至 `--space-2` |
| 同一控件内部、紧凑列表内部 | `--space-3` |
| 同一卡片内普通元素 | `--space-4` |
| 表单项、重复列表项、标准卡片内部 | `--space-5` |
| 卡片分组、弹窗分组 | `--space-6` |
| 页面区块、主要面板 | `--space-7` |
| 重点任务区和独立工作流 | `--space-8` 至 `--space-9` |

标准卡片桌面内边距固定 `--space-6`，手机固定 `--space-5`；紧凑卡片固定 `--space-5`；重点卡片固定 `--space-7`。不要在同一组件族混用相邻但无语义差别的数值。

## 固定圆角、边框与阴影

```css
:root {
  --radius-xs: 10px;
  --radius-sm: 14px;
  --radius-md: 20px;
  --radius-lg: 28px;
  --radius-pill: 999px;

  --shadow-sm: 0 4px 14px rgba(74, 54, 40, 0.04), 0 1px 3px rgba(74, 54, 40, 0.02);
  --shadow-md: 0 10px 24px rgba(74, 54, 40, 0.06), 0 3px 6px rgba(74, 54, 40, 0.03);
  --shadow-lg: 0 16px 36px rgba(74, 54, 40, 0.08);
}
```

| 元素 | 圆角 | 边框 | 阴影 |
| --- | --- | --- | --- |
| 标准输入、按钮、选择器 | `--radius-sm` | `--line-soft` | 无 |
| compact 工具控件 | `--radius-xs` | `--line-soft` | 无 |
| 标准卡片、状态面 | `--radius-md` | `--line-soft` | 无或 `--shadow-sm` |
| 重点卡片 | `--radius-md` | `--line-soft` | `--shadow-md` |
| 大面板、弹窗、抽屉 | `--radius-lg` | `--line-soft` | `--shadow-lg` |
| chip、badge、胶囊操作 | `--radius-pill` | 按状态 | 无 |

- 内层圆角必须小于外层，胶囊语义除外。
- 静态卡片不允许同时使用明显色块、强边框和重阴影。
- hover 最多轻微上移并把阴影提高一级；不缩放、不旋转、不发光。
- 禁止纯黑重阴影、硬灰边框、随机圆角和同页多套 shadow。

## 固定控件与容器尺寸

```css
:root {
  --control-height-compact: 36px;
  --control-height: 44px;
  --control-height-touch: 48px;
  --tap-min: 44px;
  --content-width: 1440px;
  --modal-width-sm: 440px;
  --modal-width-md: 680px;
  --modal-width-lg: 960px;

  --brand-button-bg: var(--accent);
  --brand-button-bg-hover: var(--accent-strong);
  --brand-button-radius: 14px;
  --brand-button-shadow: 0 10px 22px rgba(210, 107, 51, 0.18);
  --brand-button-shadow-hover: 0 12px 26px rgba(210, 107, 51, 0.22);

  --z-sidebar: 140;
  --z-mobile-topbar: 180;
  --z-notification: 300;
  --z-overlay: 1000;
  --z-mobile-notification: 1500;
}
```

- 桌面按钮、输入、select 和高频控件使用 `--control-height`。
- 手机和平板高频控件使用 `--control-height-touch`，任何交互热区不小于 `--tap-min`。
- compact 高度只用于桌面工具栏、次级图标工具和低频筛选，不用于手机主操作。
- 默认图标视觉尺寸固定 18px；关闭、返回和强调图标固定 20px，外层热区仍为 44px。
- textarea 最小高度 96px；普通输入左右内边距 12px，按钮左右内边距 16px。
- 页面内容最大宽度使用 `--content-width`，业务页不得再创建另一套全局最大宽度。

## 图片与图标

- 菜谱/食物网格主图固定使用 `4 / 3`；食材缩略图、头像使用 `1 / 1`；特殊 hero 比例必须由业务组件明确声明。
- 图片统一 `object-fit: cover`，提供 loading、error 和无图占位，容器先确定尺寸以避免 CLS。
- 对象卡已有真实图片时，不再叠加大面积彩色图标底；摘要卡没有具体对象图时使用统一线性图标。
- 同一业务区域使用同一图标风格，常规图标线宽保持一致。
- 装饰图标使用 `aria-hidden`；独立图标按钮提供 `aria-label`。

## 动效

```css
:root {
  --motion-fast: 120ms;
  --motion-normal: 180ms;
  --motion-slow: 240ms;
}
```

- hover 和按压使用 `--motion-fast`，普通状态切换使用 `--motion-normal`，弹窗/抽屉进入不超过 `--motion-slow`。
- 卡片 hover 位移不超过 2px，按钮 active 只回到原位或轻微下压。
- 禁止大幅缩放、旋转、弹跳、视差、无限循环装饰和整页发光。
- loading 动效必须伴随状态文字并尊重 `prefers-reduced-motion`。

## 视觉 brief 契约

视觉 brief 必须写出固定值，不只写“暖色、轻阴影、大圆角”。至少包含：

- 本任务使用的 token 名称和对应十六进制/RGBA，例如 `--accent (#D26B33)`、`--surface-2 (rgba(255, 255, 255, 0.98))`。
- 页面标题、区块标题、正文、label 和元信息的具体 token、字号、字重、行高。
- 页面、区块、卡片和关联信息使用的具体 space token。
- 卡片、控件、胶囊和浮层使用的具体 radius、border 与 shadow token。
- 按钮、输入、触控区、图片比例和弹层宽度的具体规格。
- loading、empty、error、disabled、danger、plan 和 partial success 的固定色彩映射。
- 目标实现与 canonical 规范不一致的漂移项及处理范围。

brief 只能使用本文件的 canonical 值。不要从遗留页面抄近似值，也不要因为现有 class 已经偏移就新增第二套规范。

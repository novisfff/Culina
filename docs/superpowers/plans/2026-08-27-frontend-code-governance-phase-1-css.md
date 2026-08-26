# Phase 1：CSS、token、cascade 与响应式治理

状态：执行计划（依赖 Phase 0 的 health report/ratchet；不包含本阶段实现）。

关联文档：

- 体检：[前端代码治理体检](../../plans/2026-08-27-frontend-code-governance-assessment.md)
- 设计规格：[前端代码治理设计规格](../specs/2026-08-27-frontend-code-governance-design.md)
- 总计划：[前端代码治理总执行计划](2026-08-27-frontend-code-governance.md)
- Phase 0：[度量、manifest 与 fail-closed ratchet](2026-08-27-frontend-code-governance-phase-0-gates.md)
- 视觉事实源：[visual-system.md](../../../.agents/skills/frontend-ui-style/references/visual-system.md)、[responsive-and-overlays.md](../../../.agents/skills/frontend-ui-style/references/responsive-and-overlays.md)

本阶段只治理前端样式、token、级联和响应式边界；不把业务组件重写、API 变更或产品信息架构调整混进 CSS 提交。每个工作包都必须能单独回滚。

## 1. 目标、基线与出口

### 1.1 B0 基线

| 指标 | B0 |
| --- | ---: |
| frontend/src/styles CSS 行数 | 73,489 |
| !important | 837 |
| @media | 214 |
| selector block（启发式） | 10,316 |
| declaration（启发式） | 39,038 |
| 重复 selector（启发式） | 约 1,527 |
| baseline-gated token drift | 50 |
| 被引用但未定义的变量名 | 24 |

B0 数字来自 b559246669dd3fd9ec463658ce2ed4504df2a1ba 的新鲜扫描。此前用户描述的 71,713 行等旧快照只作为背景，不在本阶段混用。

### 1.2 Phase 1 出口

| 指标 | Phase 0 ratchet | Phase 1 exit | 最终目标 |
| --- | ---: | ---: | ---: |
| legacy CSS 行数 | 不增加 | ≤67,000 | ≤60,000 |
| !important | 不增加 | ≤650 | ≤300（仅登记例外） |
| @media | 不增加非 canonical 查询 | ≤180 | ≤140 |
| token drift | 不增加 | ≤25 | 0（runtime allow-list 除外） |
| 未分类 undefined variable | 不增加 | 0 | 0 |
| 重复 selector | 不增加 | ≤1,100 | ≤500 |

行数是趋势信号，不以空洞切文件达标。出口还要求六个固定视口、键盘/焦点、prefers-reduced-motion 和横向溢出检查通过；任何 P0 视觉或交互回归都比数字更高优先级。

## 2. 文件边界与所有权产物

Phase 0 的计量脚本可以继续扩展，但不要把 CSS 规则硬编码在测试里。建议按以下边界新增或修改：

| 文件 | 职责 | 提交阶段 |
| --- | --- | --- |
| frontend/scripts/style-token-contract.json | canonical token、允许 alias、runtime 变量 schema | 1A |
| frontend/scripts/style-ownership.json | selector 到 owner、消费者和删除条件 | 1B |
| frontend/scripts/style-exceptions.json | !important、非 canonical 断点、raw token、兼容 alias 例外 | 1B |
| frontend/scripts/css-governance.mjs | tokenizer、token/selector/media/important 检查与报告 | 1A–1C |
| frontend/scripts/css-governance.test.mjs | fixture 驱动的失败/通过契约 | 与脚本同提交 |
| frontend/scripts/dead-selectors.mjs | CSS 与 TSX 使用面交叉报告（只报告，不自动删除） | 1B |
| frontend/scripts/dead-selectors.test.mjs | 动态 class、伪类、CSS module/字符串例外测试 | 1B |
| frontend/src/styles/00-foundation.css | reset、canonical token、全局基础规则 | 1A |
| frontend/src/styles.css | layer/import 兼容入口，迁移期保留 | 1C–1E |
| frontend/src/styles/07-mobile.css | 只作为待拆迁移源，禁止新增业务规则 | 1C |
| frontend/src/styles/<domain>.css | domain 与跟随 domain 的 responsive 规则 | 1C–1E |
| .github/workflows/quality-gates.yml | Phase 0 已接入；本阶段只增加 CSS governance artifact/required check 断言 | 1E |
| frontend/e2e/* | 关键路径固定视口证据，必要时新增 css-governance.spec.mjs | 1D–1E |

style-ownership.json、style-exceptions.json 是治理数据，不是“随便放行”清单。每条例外必须有 owner、reason、introducedAt、expiresAt、replacement 和测试引用；过期或没有消费者的条目使检查失败。

## 3. 1A：建立 canonical token contract

### 3.1 Contract 结构

style-token-contract.json 使用版本化结构，示例：

~~~
{
  "version": 1,
  "canonicalSource": "frontend/src/styles/00-foundation.css",
  "tokens": {
    "--radius-sm": { "category": "radius", "value": "14px" },
    "--control-height-touch": { "category": "size", "value": "48px" }
  },
  "aliases": {
    "--text-muted": {
      "target": "--text-faint",
      "owner": "ui-platform",
      "expiresAt": "2026-11-30",
      "reason": "迁移旧页面调用方"
    }
  },
  "runtime": {
    "--model-usage-share": {
      "owner": "model-usage",
      "source": "inline-style",
      "fallback": "0",
      "consumers": ["14-model-usage.css"]
    }
  }
}
~~~

### 3.2 Canonical 值

以视觉规范为唯一事实源，至少锁定以下类别：

- 字体：--font-sans、--font-display。
- 文字阶梯：--text-xs（12px）、--text-sm（13px）、--text-meta（14px）、--text-body（15px）、--text-base（16px）、--text-md（18px）、--text-lg（20px）、--text-xl（24px）、--text-2xl（28px）、--text-display（40px）。
- 间距：--space-1 至 --space-9（4/6/8/12/16/20/24/28/32px）。
- 圆角：--radius-xs 10px、--radius-sm 14px、--radius-md 20px、--radius-lg 28px、--radius-pill 999px。
- 控件：--control-height-compact 36px、--control-height 44px、--control-height-touch 48px、--tap-min 44px。
- 容器/浮层：--content-width 1440px、--modal-width-sm/md/lg 440/680/960px、固定 z-index token。
- 阴影、颜色、边线、focus 和 backdrop：只从 foundation 中导出，禁止业务文件写第二套同义值。

当前明确的实现漂移是 --brand-button-radius: 24px；1A 必须改为 var(--radius-sm)（或 contract 中等价的 canonical 14px），并测试所有 primary action 没有视觉尺寸回退。

### 3.3 未定义变量分类与处理

扫描器必须区分“真正未定义”和“由运行时注入”的变量，不得用一刀切的声明补丁掩盖问题：

| 分类 | 当前候选 | 处理 |
| --- | --- | --- |
| runtime inline | --model-usage-share、--ai-debug-depth、viewport inset 等 | 写入 runtime，声明来源、fallback、消费者和过期复核；组件必须保证未注入时仍可读 |
| 旧名 alias | --text-muted、--text-main、--font-mono、--input-height-lg | 优先替换消费者；迁移期间在 foundation 定义指向 canonical 的 alias，并登记到期日 |
| 业务 token 缺失 | --ingredient-line、--ingredient-soft-surface、--shadow-xs、--tap-large | 判断是否有跨组件语义；有则命名并补入 foundation，无则改用已有 token，不允许只在某个 domain CSS 定义 |
| 无 fallback 的引用 | --brand 等 | 立即修复为 canonical 或 var(--canonical, fallback)；没有 owner 的引用使 gate 失败 |
| 第三方/浏览器变量 | 仅在明确由平台注入时允许 | 需要 source: platform、消费者和测试；普通业务变量不能借此豁免 |

规则：

1. 扫描 var(--name) 和 var(--name, fallback)；有 fallback 仍报告“使用了非 canonical 名”，但不报告 undefined。
2. 解析 :root/foundation 的声明、组件 inline style 和 JS style={{ '--x': ... }}，只把可证明的运行时来源放进 allow-list。
3. 不把注释、字符串、@keyframes 文本或 CSS 变量定义自身算作引用。
4. 输出稳定排序的 variable、file、line、classification、owner、expiry，方便 ratchet diff。

### 3.4 TDD 与验证

先在 css-governance.test.mjs 写临时 fixture：

- canonical token 正确、alias 有 owner/expiry；
- var(--x, 0) 不算 undefined；
- runtime inline 变量只有登记后通过；
- 注释中的 !important、字符串中的 var(--x) 不计数；
- --brand-button-radius: 24px 与 contract 不一致时失败。

先运行定向测试确认失败，再实现 tokenizer/contract validator。完成后运行：

~~~
npm --prefix frontend run test -- scripts/css-governance.test.mjs
npm --prefix frontend run check:style-tokens
npm --prefix frontend run typecheck
~~~

推荐提交：governance(css): establish canonical token contract。

## 4. 1B：selector ownership 与 dead selector report

### 4.1 Owner 规则

每个业务 selector 只能有一个主要 owner。owner 使用稳定 ID，而不是文件名，建议集合：

foundation、ui-kit、shell、home、eat、recipe、ingredients、inventory、food、meal、ai、family、model-usage、compatibility。

style-ownership.json 条目至少包含：

~~~
{
  "selector": ".ingredient-inventory-panel",
  "owner": "ingredients",
  "source": "frontend/src/styles/04-ingredients-workspace.css",
  "consumers": ["components/ingredients/IngredientInventoryOverlay.tsx"],
  "sharedWith": [],
  "dynamic": false,
  "deleteWhen": "all ingredient workspace rules are layered"
}
~~~

约束：

- domain 层的新 selector 必须有 domain 前缀或可从 owner 文件唯一推断；裸 div、button、通用 .active 不能进入业务层。
- 共享 selector 必须列出所有消费者和共享理由；若只是复制两份相似规则，应合并到 ui-kit primitive 或明确变体。
- 同一 selector 的多段规则不等于多个 owner；迁移中可暂时出现在 compatibility，但只能有一个业务 owner。
- !important、高 specificity（例如三层以上业务 class）和属性选择器必须在条目中说明为什么不能通过层级解决。

### 4.2 Dead selector 算法

dead-selectors.mjs 只生成报告，不在 Phase 1 自动删除：

1. 用 CSS tokenizer 取 class、id、属性和关键 data attribute，忽略伪类、动画 keyframe 名和 @supports 文本。
2. 用 TypeScript AST 读取 JSX className、classList、data-* 和模板字面量中的静态片段；对拼接/条件 class 标为 dynamic。
3. 合并 frontend/e2e、快照和允许的第三方入口；无法静态证明使用的 selector 归为 unknown，不是 dead。
4. 只把 unused、duplicate、owner-missing 分开统计；报告文件、行号、owner、证据和建议。
5. 删除前要求：至少一次真实行为测试覆盖，连续两个提交无消费者，且在 compatibility 中保留可回滚 alias；动态 selector 必须由人工确认。

先写 fixture 覆盖 clsx、条件拼接、SVG 属性、CSS 伪类和字符串测试，再运行：

~~~
npm --prefix frontend run test -- scripts/dead-selectors.test.mjs
npm --prefix frontend run health:report -- --format markdown
~~~

推荐提交：governance(css): add selector ownership and dead-selector report。

## 5. 1C：固定 cascade layer，拆回 07-mobile.css

### 5.1 Layer 契约

全局只声明一次顺序，顺序本身是公共契约：

~~~
@layer reset, tokens, primitives, shell, domain, responsive, compatibility;
~~~

迁移后的职责：

- reset：box sizing、根元素、默认表单和 focus reset。
- tokens：00-foundation.css 的 canonical :root 与变量。
- primitives：00-ui-kit.css 的按钮、表单、状态块、overlay frame。
- shell：AppShell、全局通知、搜索框架和跨域 overlay frame。
- domain：Home、Eat/Recipe/Meal、Ingredients/Inventory、Food、AI、Family、Model Usage。
- responsive：同一 owner 的手机/平板重排；不能把所有业务规则再集中到一个末端文件。
- compatibility：迁移期间旧 class/alias 的最小兜底，只允许已有规则，不得加入新功能。

styles.css 迁移期仍可作为单一聚合入口，但每个 @import 必须显式落在 layer 中，且不能同时加载旧未分层规则和新分层副本。完成一个 domain 后，删除其旧 import，避免 CSS 双传输。

### 5.2 07-mobile.css 拆分顺序

按依赖和回归半径分批，不按文件行数机械切割：

1. 先把 reset、shell topbar、底部导航和通用 safe-area 规则移到 shell/responsive。
2. 把 Home/Family/Model Usage 的纯布局规则分别回收到 01-home-dashboard.css、02-family-settings.css、14-model-usage.css。
3. 把 Recipe/Eat/Meal/Composer 规则回收到 03-recipe-workspace.css、12-eat-workspace.css、08-meal-log.css、13-meal-composer.css。
4. 把 Ingredients/Inventory/Food 规则回收到 04-ingredients-workspace.css、10-inventory-actions.css、11-inventory-maintenance.css、06-food-workspace.css。
5. 把 AI/AI draft/Global Search/Family Model Settings 规则回收到 09-ai-workspace.css、09-ai-draft-ui.css、09-global-search.css、15-family-model-settings.css。
6. 07-mobile.css 只保留有 owner/expiry 的 compatibility alias，随后删除聚合 import。

每批迁移都必须做“旧规则删除 + 新规则行为等价”同一提交，避免两套 cascade 长期并存。对确实需要移动独立 View 的规则，优先放在 route-owned CSS（Phase 5）而不是再次创建全局覆盖层。

推荐提交：

- governance(css): introduce cascade layers and shell ownership
- governance(css): return home-and-family responsive rules to owners
- governance(css): return eat-and-meal responsive rules to owners
- governance(css): return ingredient-food-inventory responsive rules to owners
- governance(css): retire global mobile override layer

### 5.3 每批验收

每个批次先运行 focused Vitest/Usage contract，再运行：

~~~
npm --prefix frontend run check:style-tokens
npm --prefix frontend run typecheck
npm run frontend:quality
npm run frontend:build
git diff --check
~~~

构建报告必须比较 main CSS gzip、对应 routeTotal（Phase 0 manifest）和 selector/important/media diff；不能只看 CSS 文件行数。

## 6. 1D：!important、specificity 与媒体查询 ratchet

### 6.1 !important

规则按原因分三类处理：

1. **层级错误**：先移入正确 layer、缩小 owner 范围，再删除 important。
2. **第三方/浏览器兼容**：保留最小 selector，登记 source、browser、test、expiresAt；不得复制到业务变体。
3. **交互状态或无障碍**：改为状态属性、DOM 顺序或 ui-kit API；不能用 important 藏住 disabled/focus 语义。

Phase 1 禁止新增未登记 !important。每个 PR 的允许量必须小于等于 baseline，目标是从 837 降到 650；报告按 owner 给出删除数量和未完成原因。

### 6.2 媒体查询

canonical 设备层只允许：

~~~
@media (max-width: 767px) { }
@media (min-width: 768px) and (max-width: 1023px) { }
@media (min-width: 1024px) { }
~~~

pointer: coarse、prefers-reduced-motion、forced-colors、打印和浏览器 capability 不是设备层，但必须有语义名称。420/520/560/600/680/720/900/980/1050/1100/1180/1199/1280 等现有断点逐条选择：

- 能在 canonical 层通过换行、minmax 或纵向排列解决：删除；
- 确有内容重排（例如大表格、复杂 AI 审批）：保留并在 exception registry 写 layoutReason、owner、测试和 expiry；
- 只为覆盖级联顺序：移入 layer 后删除。

Phase 1 目标是 214 降至 180，且非 canonical 数量不增加。扫描器要规范化等价写法（空格、and 大小写、0.0px）后再计数。

## 7. 1E：固定视口、行为与无障碍验证

### 7.1 视口矩阵

涉及 CSS、overlay、sticky footer、表单或移动 View 的每个提交至少执行：

| 层级 | 视口 | 必查 |
| --- | --- | --- |
| 手机 | 375×812、390×844、430×932 | 长中文、chip 换行、软键盘、safe-area、bottom sheet |
| 平板 | 768×1024、1024×768 | 横竖屏重排、两栏/单栏、抽屉宽度、触控目标 |
| 桌面 | 1440×900 | 最大宽度、并列操作、hover/focus、滚动容器 |

在 Playwright 中沿用 frontend/playwright.config.mjs 的 reducedMotion: reduce；需要新增 route 证据时使用稳定的 @css-governance 标签和明确 project 名，不能把普通 1180×820 当作 canonical 替代。

### 7.2 固定断言

- document.documentElement.scrollWidth ≤ viewport.width，排除明确允许的代码/表格滚动容器。
- 独立交互目标实际 hit area ≥44×44；手机和平板高频控件可见高度 48px。
- overlay 的 header/body/footer 分层，busy 时不能 backdrop/Escape 误关闭，错误后草稿保留。
- 200% 文字缩放、英文/数字长 ID、图片失败和 prefers-reduced-motion 不造成主操作消失。
- focus-visible、dialog 标题关联、关闭后焦点恢复和 live region 不能因 layer 迁移丢失。

### 7.3 命令

最小顺序：

~~~
npm --prefix frontend run test -- src/components/ui-kit.test.tsx src/components/*/*Usage.test.ts
npm --prefix frontend run check:style-tokens
npm run frontend:quality
npm run frontend:build
npm run frontend:e2e:p0
~~~

人工/截图报告必须记录六个视口的实际运行情况；没有浏览器环境时不能把 Vitest 或 build 代替视觉验收。

## 8. 回滚、停止条件与 Phase 2 入口

### 8.1 回滚

- 每个 owner 批次一个提交；回滚只恢复上一个已验证的 CSS/import/registry 集合。
- 迁移期保留 VITE_LEGACY_GLOBAL_STYLES=1 的本地回滚入口，但生产不同时加载新旧两套规则。
- 不删除 localStorage、AI 草稿、导航状态或业务数据；CSS 回滚不能触碰运行时状态。

### 8.2 停止条件

任一条件发生就暂停后续 CSS 批次并回滚最近提交：

- 六个 canonical 视口任一 P0 路径横向溢出、主操作不可达或焦点丢失；
- !important、非 canonical media、undefined variable 或无 owner selector 增加；
- main/route CSS gzip 比 ratchet 增长超过 512 bytes，或 routeTotal 增长超过 10%；
- 只能靠新增 global override 才能修复回归，说明 owner/layer 设计错误；
- Usage 字符串测试全绿但行为测试失败，禁止删除旧规则或继续拆分。

### 8.3 Phase 1 Definition of Done

- [ ] token contract、runtime allow-list、alias 和 exception registry 可从干净 checkout 重现；未分类变量为 0。
- [ ] 所有业务 selector 有唯一 owner；dead selector 报告可解释，删除有行为证据。
- [ ] @layer reset, tokens, primitives, shell, domain, responsive, compatibility 生效，07-mobile.css 不再承担全站末端覆盖。
- [ ] CSS ≤67,000 行、!important ≤650、@media ≤180、drift ≤25、重复 selector ≤1,100。
- [ ] 六个固定视口、reduced motion、键盘和触控路径有新鲜证据；测试未因迁移删减。
- [ ] Phase 0 manifest/ratchet 没有通过移动文件隐藏资源增长。

完成后才进入 Phase 2 的 typed workspace ports；若只是为了数字删除规则、移动文件而依赖图和视觉行为未改善，视为未完成。

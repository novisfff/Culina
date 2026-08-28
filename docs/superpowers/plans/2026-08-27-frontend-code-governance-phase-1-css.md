# Phase 1：CSS、token、cascade 与响应式治理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox ( - [ ] ) syntax for tracking.

**Goal:** 把 CSS 值、selector 所有权、级联顺序和响应式规则变成可验证的契约，在不改变桌面/平板/手机行为的前提下消除主要漂移和全局末端覆盖。

**Architecture:** foundation 只定义 canonical token，ui-kit 和 shell 通过固定 cascade layer 提供跨域基础，业务与 responsive 规则按 owner 回到 domain 文件；token、selector、media、important 和 dead-selector 检查由 fixture 驱动的 Node 工具执行。迁移按小批次提交，每批都保留 compatibility 回滚层并用六个固定视口验证。

**Tech Stack:** CSS tokenizer、Node.js 20（与当前 CI 一致）、Vitest、Vite、Playwright、Culina frontend-ui-style references、JSON contract files。

**Spec:** [2026-08-27-frontend-code-governance-design.md](../specs/2026-08-27-frontend-code-governance-design.md)

## Global Constraints

- 视觉事实源为 .agents/skills/frontend-ui-style/references/visual-system.md 与 responsive-and-overlays.md；源码旧值与规范冲突时记录为 drift，不反向修改规范。
- canonical 设备层只使用 max-width 767px、768–1023px、min-width 1024px；其他媒体查询必须登记布局原因、owner、测试和 expiry。
- foundation token 固定圆角 10/14/20/28/999px、控件高度 36/44/48px、间距 4/6/8/12/16/20/24/28/32px；brand-button-radius 必须引用 radius-sm。
- 新 selector 必须有唯一 owner 和业务前缀；新 !important、raw token、alias、非 canonical breakpoint、runtime variable 必须在例外 registry 中有 owner、reason、introducedAt、expiresAt、replacement、test。
- 只移动规则不能算改善；每批必须同时删除旧规则、更新 owner、运行行为测试并比较 health/manifest diff。
- 手机 375×812、390×844、430×932；平板 768×1024、1024×768；桌面 1440×900 是固定验收视口。必须检查 reduced-motion、焦点、safe-area、键盘和横向溢出。
- 不改变 API、导航、React Query、AI contract、localStorage key 或业务文案；不删除使用证据不足的 selector。
- 每个任务先写失败测试，任务结束运行 git diff --check，并只提交声明文件。

---

## 1.0 预检和 CSS 迁移批次登记

**Files:**

- Create: frontend/scripts/css-migration-batches.json
- Create: frontend/scripts/css-migration-batches.test.mjs
- Create: frontend/scripts/css-migration-batches.mjs
- Modify: docs/superpowers/plans/2026-08-27-frontend-code-governance-phase-1-css.md（只记录实际批次状态）

**Interfaces:**

- readCssMigrationBatches(path) => { batches: CssMigrationBatch[] }
- CssMigrationBatch = { id, sources, destinations, owners, viewports, rollbackCommit }
- batch id 固定为 shell-foundation、home-family、eat-meal、ingredient-food-inventory、ai-search、compat-retire。

- [ ] **Step 1: 写批次 registry 失败测试**

断言每个 source CSS 文件只出现在一个当前批次；每批包含至少一个 destination、一个 owner、六个视口和 rollbackCommit 字段；07-mobile.css 只能作为 source，不能作为 destination。

Run: npm --prefix frontend run test -- scripts/css-migration-batches.test.mjs

Expected: FAIL，因为 registry 和 reader 尚不存在。

- [ ] **Step 2: 建立迁移顺序和停止点**

按 shell → home/family → eat/meal → ingredient/food/inventory → ai/search → compatibility-retire 执行；每批完成后必须通过 style contract、focused behavior tests、build 和固定视口，失败即回滚该批。

- [ ] **Step 3: 实现 registry reader 并校验**

输出重叠 source、缺失 owner、非 canonical viewport 和没有 rollbackCommit 的具体错误；错误按 batch id/path 排序。

- [ ] **Step 4: 运行并提交**

~~~bash
npm --prefix frontend run test -- scripts/css-migration-batches.test.mjs
git diff --check
git add frontend/scripts/css-migration-batches.json frontend/scripts/css-migration-batches.mjs frontend/scripts/css-migration-batches.test.mjs
git commit -m "governance(css): register migration batches"
~~~

Rollback: 回滚 registry 不回滚样式；不得在没有 registry 的情况下移动 07-mobile.css。

## Task 1.1：建立 canonical token contract 和 runtime variable allow-list

**Files:**

- Create: frontend/scripts/style-token-contract.json
- Create: frontend/scripts/style-contract.mjs
- Create: frontend/scripts/style-contract.test.mjs
- Modify: frontend/src/styles/00-foundation.css
- Modify: frontend/scripts/style-token-drift.mjs
- Modify: frontend/package.json（check:css-governance）

**Interfaces:**

- loadStyleTokenContract(path) => StyleTokenContract
- scanCssTokens({ rootDir, stylesDir, contract }) => { definitions, references, drift, undefinedVariables }
- validateRuntimeVariable(entry) => void
- contract token entry 为 { category, value, source, consumers }；alias 为 { target, owner, reason, introducedAt, expiresAt, replacement, test }；runtime 为 { owner, source, fallback, consumers, introducedAt, expiresAt, test }。

- [ ] **Step 1: 写失败 fixture**

覆盖：

~~~js
test("accepts canonical foundation tokens", () => {});
test("rejects brand button radius drift", () => {});
test("treats var fallback as safe but still reports noncanonical use", () => {});
test("requires owner and expiry for aliases and runtime variables", () => {});
test("ignores comments, strings, and custom property definitions as references", () => {});
~~~

fixture 必须包含 brand-button-radius: 24px、var(--unknown, 0)、inline --model-usage-share 和过期 alias。

- [ ] **Step 2: 运行测试确认失败**

Run: npm --prefix frontend run test -- scripts/style-contract.test.mjs

Expected: FAIL；当前 token drift 脚本没有 canonical contract、runtime 分类和 expiry 校验。

- [ ] **Step 3: 录入 canonical contract**

在 style-token-contract.json 中完整列出 foundation 的颜色、字体、字号、间距、圆角、控件、高度、容器、shadow、focus 和 z-index；canonicalSource 固定为 frontend/src/styles/00-foundation.css。旧名 --text-muted、--text-main、--font-mono、--input-height-lg 只能以有期限 alias 出现。

- [ ] **Step 4: 修正 foundation 漂移**

把 frontend/src/styles/00-foundation.css 的 --brand-button-radius 改为 var(--radius-sm)；为 --app-visual-viewport-height、--app-visual-viewport-top、--app-visual-viewport-bottom-inset、--app-visual-viewport-layout-height 建立 runtime 条目并提供 fallback。

- [ ] **Step 5: 实现 tokenizer 分类和 gate**

扫描 var references、:root definitions、JSX inline style 的静态变量名；输出 file/line/column/classification/owner/expiry。无 fallback 且未登记为 undefined；有 fallback 为 fallback-safe；登记完整 runtime 为 runtime-allowed；过期或无消费者的例外为 violation。

- [ ] **Step 6: 运行定向检查**

~~~bash
npm --prefix frontend run test -- scripts/style-contract.test.mjs
npm --prefix frontend run check:css-governance -- --mode=ratchet
npm --prefix frontend run check:style-tokens
npm --prefix frontend run typecheck
~~~

Expected: fixture drift/过期例外非零；B0 只有已登记历史 drift，不新增 undefined。

- [ ] **Step 7: Commit**

~~~bash
git diff --check
git add frontend/scripts/style-token-contract.json frontend/scripts/style-contract.mjs frontend/scripts/style-contract.test.mjs frontend/src/styles/00-foundation.css frontend/scripts/style-token-drift.mjs frontend/package.json
git commit -m "governance(css): establish canonical token contract"
~~~

Rollback: 恢复 foundation 值和 contract 同一提交；保留旧 drift 报告，不关闭 Phase 0 ratchet。

## Task 1.2：建立 selector ownership 和 dead-selector 报告

**Files:**

- Create: frontend/scripts/style-ownership.json
- Create: frontend/scripts/style-exceptions.json
- Create: frontend/scripts/dead-selectors.mjs
- Create: frontend/scripts/dead-selectors.test.mjs
- Modify: frontend/scripts/style-contract.mjs
- Modify: frontend/package.json

**Interfaces:**

- loadStyleOwnership(path) => Map<string, SelectorOwnership>
- scanSelectorUsage({ cssFiles, tsxFiles, e2eFiles }) => { unused, duplicate, ownerMissing, dynamic }
- SelectorOwnership = { selector, owner, source, consumers, sharedWith, dynamic, deleteWhen, test }
- StyleException = { metric, selectorOrValue, owner, reason, introducedAt, expiresAt, replacement, test }

- [ ] **Step 1: 写失败 selector fixture**

fixture 覆盖 clsx 条件 class、模板字面量、SVG 属性、CSS module、伪类、动态 data attribute 和 Usage 测试字符串。断言动态/unknown 不会被误报为 dead，静态未使用 class 会列出 file/line。

Run: npm --prefix frontend run test -- scripts/dead-selectors.test.mjs

Expected: FAIL，因为 dead-selectors.mjs 尚不存在。

- [ ] **Step 2: 登记 owner**

为 foundation、ui-kit、shell、home、eat、recipe、ingredients、inventory、food、meal、ai、family、model-usage、compatibility 建立稳定 owner；每个业务 selector 只允许一个 owner，重复规则通过 sharedWith 和理由显式登记。

- [ ] **Step 3: 实现 CSS/TSX 交叉扫描**

CSS tokenizer 读取 class/id/属性/data-*；TypeScript AST 读取 JSX className、classList、静态模板片段；无法证明使用的项分类 unknown，不自动删除。报告 unused、duplicate、owner-missing 分开并稳定排序。

- [ ] **Step 4: 接入例外生命周期**

新 important、三层以上业务 specificity、属性 selector、非 canonical media、兼容 alias 写入 style-exceptions.json。缺 owner、reason、replacement、test 或 expiresAt 已过期时 gate 非零；没有消费者的例外也非零。

- [ ] **Step 5: 运行报告和提交**

~~~bash
npm --prefix frontend run test -- scripts/dead-selectors.test.mjs
npm --prefix frontend run check:css-governance -- --mode=ratchet --format markdown
npm --prefix frontend run health:report -- --format markdown --output /tmp/css-health.md
git diff --check
git add frontend/scripts/style-ownership.json frontend/scripts/style-exceptions.json frontend/scripts/dead-selectors.mjs frontend/scripts/dead-selectors.test.mjs frontend/scripts/style-contract.mjs frontend/package.json
git commit -m "governance(css): add selector ownership report"
~~~

Expected: 0.1 health report 能引用 owner/exception 统计；本任务不删除 CSS 规则。

Rollback: 回滚 scanner/registry；任何删除 selector 必须另开同域提交并附行为测试。

## Task 1.3：引入固定 cascade layer 和 shell 基础层

**Files:**

- Modify: frontend/src/styles.css
- Modify: frontend/src/styles/00-foundation.css
- Modify: frontend/src/styles/00-ui-kit.css
- Create: frontend/src/styles/shell.css
- Create: frontend/scripts/css-layer-contract.mjs
- Create: frontend/scripts/css-layer-contract.test.mjs
- Modify: frontend/scripts/css-migration-batches.json

**Interfaces:**

- Layer 顺序唯一声明为 @layer reset, tokens, primitives, shell, domain, responsive, compatibility;
- assertCssLayerOrder(cssText) => { layers, violations }
- foundation exports reset/tokens；ui-kit exports primitives；shell.css exports AppShell/global notification/overlay frame。

- [ ] **Step 1: 写 layer 失败测试**

断言 styles.css 只有一次 layer order，foundation/ui-kit/shell 各自落在预期 layer；业务 CSS 不得在 tokens/primitives layer 写规则。

Run: npm --prefix frontend run test -- scripts/css-layer-contract.test.mjs

Expected: FAIL，因为当前 styles.css 是无 layer 的全局 import 聚合。

- [ ] **Step 2: 增加唯一 layer 声明和显式 imports**

在 styles.css 顶部声明顺序，把 imports 包在对应 layer；在 foundation 中将 reset 与 :root 分别放入 reset/tokens；00-ui-kit.css 放入 primitives；shell.css 承载 AppShell、通知、搜索框架和 overlay frame。

- [ ] **Step 3: 检查双份 cascade**

脚本比较旧 import 与新 layer 规则的 selector 集合；发现同一 selector 同时存在于旧 global 和新 layer 时失败。兼容层只能保留已经存在规则，不能加入新业务规则。

- [ ] **Step 4: 运行 CSS 和构建验证**

~~~bash
npm --prefix frontend run test -- scripts/css-layer-contract.test.mjs
npm --prefix frontend run check:css-governance -- --mode=ratchet
npm --prefix frontend run check:style-tokens
npm --prefix frontend run typecheck
npm --prefix frontend run build
~~~

Expected: layer contract PASS；main CSS gzip 不得比 B0 增加超过 512 bytes；任何 cascade 视觉差异记录为待迁移批次。

- [ ] **Step 5: Commit**

~~~bash
git diff --check
git add frontend/src/styles.css frontend/src/styles/00-foundation.css frontend/src/styles/00-ui-kit.css frontend/src/styles/shell.css frontend/scripts/css-layer-contract.mjs frontend/scripts/css-layer-contract.test.mjs frontend/scripts/css-migration-batches.json
git commit -m "governance(css): introduce cascade layers and shell ownership"
~~~

Rollback: 回滚本提交恢复旧 import 顺序；不要同时保留新旧层级运行。

## Task 1.4：按批次拆回 07-mobile.css

**Files:**

- Modify: frontend/src/styles/07-mobile.css
- Modify: frontend/src/styles/01-home-dashboard.css
- Modify: frontend/src/styles/02-family-settings.css
- Modify: frontend/src/styles/03-recipe-workspace.css
- Modify: frontend/src/styles/04-ingredients-workspace.css
- Modify: frontend/src/styles/05-workspace-overlays.css
- Modify: frontend/src/styles/06-food-workspace.css
- Modify: frontend/src/styles/08-meal-log.css
- Modify: frontend/src/styles/09-ai-draft-ui.css
- Modify: frontend/src/styles/09-ai-workspace.css
- Modify: frontend/src/styles/09-global-search.css
- Modify: frontend/src/styles/10-inventory-actions.css
- Modify: frontend/src/styles/11-inventory-maintenance.css
- Modify: frontend/src/styles/12-eat-workspace.css
- Modify: frontend/src/styles/13-meal-composer.css
- Modify: frontend/src/styles/14-model-usage.css
- Modify: frontend/src/styles/15-family-model-settings.css
- Modify: frontend/scripts/css-migration-batches.json

**Interfaces:**

- Each migrated selector remains under its original owner and moves to domain/responsive layer in the same commit.
- 07-mobile.css may only contain compatibility aliases with an expiry; after compat-retire its import is removed.

- [ ] **Step 1: Migrate shell-foundation batch**

Move reset, safe-area, mobile topbar, bottom navigation and global overlay frame rules to shell.css/responsive. Keep a selector map in the batch report; do not copy rules. Run the shell navigation and overlay behavior tests before deleting old blocks.

Run: npm --prefix frontend run test -- src/app src/components/ui-kit

Expected: old selectors removed, new owner count unchanged, focus restore and safe-area tests PASS.

- [ ] **Step 2: Migrate home-family batch**

Move Home, Family and Model Usage layout rules to 01-home-dashboard.css, 02-family-settings.css and 14-model-usage.css. Keep 15-family-model-settings.css separate. Test dashboard dialogs, family tabs and model usage table at all six viewports.

- [ ] **Step 3: Migrate eat-meal batch**

Move Recipe/Eat/Meal/Composer rules to 03-recipe-workspace.css, 08-meal-log.css, 12-eat-workspace.css and 13-meal-composer.css. Preserve sticky actions, task bottom sheet and keyboard behavior.

- [ ] **Step 4: Migrate ingredient-food-inventory batch**

Move Ingredients/Inventory/Food rules to 04-ingredients-workspace.css, 06-food-workspace.css, 10-inventory-actions.css and 11-inventory-maintenance.css. Preserve conflict/result panels and table scroll containers.

- [ ] **Step 5: Migrate ai-search batch**

Move AI, AI draft and global search rules to 09-ai-workspace.css, 09-ai-draft-ui.css and 09-global-search.css. Keep message, composer and approval layers in the same owner; do not broaden selectors to solve order issues.

- [ ] **Step 6: Retire compatibility import**

After two consecutive batches have no compatibility consumer, remove their blocks from 07-mobile.css and update registry expiry. When all batches pass, remove the 07-mobile.css import from styles.css.

- [ ] **Step 7: Run each batch gate**

~~~bash
npm --prefix frontend run check:css-governance -- --mode=ratchet
npm --prefix frontend run check:style-tokens
npm --prefix frontend run typecheck
npm run frontend:quality
npm run frontend:build
npm run frontend:e2e:p0
git diff --check
~~~

Expected: CSS legacy lines trend down, no new important/media/undefined/owner-missing, main and route gzip within 512-byte ratchet; six viewports show no P0 regression. Record actual viewport results in the batch artifact.

- [ ] **Step 8: Commit each batch separately**

~~~bash
git add frontend/src/styles frontend/scripts/css-migration-batches.json frontend/scripts/style-exceptions.json
git commit -m "governance(css): return responsive rules to owners"
~~~

提交消息中附批次 id；never combine all batches into one commit.

Rollback: revert only the failed batch commit; keep earlier verified batches. VITE_LEGACY_GLOBAL_STYLES=1 remains a local rollback switch until Phase 5.

## Task 1.5：删除 !important、收敛 specificity 和 media query

**Files:**

- Modify: frontend/scripts/style-exceptions.json
- Modify: frontend/scripts/style-contract.mjs
- Modify: frontend/src/styles/**/*.css
- Create: frontend/scripts/css-ratchet.mjs
- Create: frontend/scripts/css-ratchet.test.mjs

**Interfaces:**

- scanSpecificity(selector) => { ids, classes, elements, depth }
- normalizeMediaQuery(prelude) => canonical | semantic | noncanonical
- compareCssDebt(current, baseline, exceptions) => { violations, reductions, byOwner }

- [x] **Step 1: 写 debt fixture 测试**

锁定注释中的 important 不计数；未登记 important、三层以上业务 selector、420/520 等非 canonical media 非零；pointer: coarse、prefers-reduced-motion、forced-colors、print 在有语义 owner 时通过。

Run: npm --prefix frontend run test -- scripts/css-ratchet.test.mjs

Expected: FAIL，因为当前检查只报告 style-token drift。

- [x] **Step 2: 按原因处理 important**

先通过 layer/owner 修正层级错误；状态与无障碍规则改为属性/DOM/ui-kit API；第三方兼容保留最小 selector 并登记 browser、reason、test、expiresAt。禁止复制到业务变体。

- [x] **Step 3: 规范化媒体查询**

把等价空格、大小写和 0.0px 归一化后计数；能用 canonical 层级解决的 420/520/560/600/680/720/900/980/1050/1100/1180/1199/1280 逐条删除。确需内容重排的保留 semantic exception。

- [x] **Step 4: 运行 ratchet 和目标数字**

~~~bash
cd frontend
npm run test -- scripts/css-ratchet.test.mjs
cd ..
mkdir -p .artifacts
npm --prefix frontend run check:css-governance -- --mode=ratchet --output "$PWD/.artifacts/css-governance.json"
node -e "const r=require('./.artifacts/css-governance.json'); if(r.css.important>650||r.css.media>180||r.css.drift>25) process.exit(1)"
~~~

Expected: Phase 1 exit 不超过 67,000 CSS 行、650 important、180 media、25 drift、1,100 duplicate selector；新 debt 立即非零。

- [x] **Step 5: Commit**

~~~bash
git diff --check
git add frontend/scripts/style-exceptions.json frontend/scripts/style-contract.mjs frontend/scripts/css-ratchet.mjs frontend/scripts/css-ratchet.test.mjs frontend/src/styles
git commit -m "governance(css): ratchet important specificity and media"
~~~

Rollback: 每个 owner 一次提交；如果只能靠新 global override 修复，停止并回退该 owner。

## Task 1.6：固定视口、无障碍和 Phase 1 集成验收

**Files:**

- Modify: frontend/e2e/*（只新增必要的 CSS governance assertions）
- Create: frontend/e2e/css-governance.spec.mjs
- Modify: docs/plans/2026-08-27-frontend-code-governance-assessment.md
- Modify: docs/superpowers/plans/2026-08-27-frontend-code-governance.md

**Interfaces:**

- assertNoHorizontalOverflow(page)：允许代码/表格明确滚动容器，document scrollWidth 不得超过 viewport。
- assertInteractiveTargetMinimum(page, 44)：独立交互目标实际命中区域至少 44×44。
- assertOverlayFocusContract(page)：标题关联、初始焦点、busy 禁止误关闭、关闭后焦点恢复。

- [x] **Step 1: 写失败 E2E assertions**

先在临时 route fixture 中制造 1px 横溢出、43px close button 和 busy Escape close，断言测试失败；再接真实 Home、Ingredients、Food、Eat、AI、Family 路径。

- [x] **Step 2: 运行六视口 reduced-motion 验证**

Run:

~~~bash
npm run frontend:e2e:p0
PLAYWRIGHT_REDUCED_MOTION=reduce npm --prefix frontend exec playwright test frontend/e2e/css-governance.spec.mjs --project=chromium
~~~

Expected: 375×812、390×844、430×932、768×1024、1024×768、1440×900 全部记录 PASS；长中文、英文/数字 ID、chip、safe-area、键盘、sticky footer、dialog body scroll 和 focus-visible 均有证据。

- [x] **Step 3: 运行完整 Phase 1 检查**

~~~bash
npm --prefix frontend run test -- scripts/style-contract.test.mjs scripts/dead-selectors.test.mjs scripts/css-layer-contract.test.mjs scripts/css-ratchet.test.mjs
npm --prefix frontend run check:style-tokens
npm run frontend:quality
npm run frontend:build
git diff --check
~~~

- [x] **Step 4: 更新报告并提交**

在 assessment 和总计划中记录实际 CSS 数字、owner/exception 数量、六视口、未执行项和 manifest routeTotal；提交只包含测试、E2E、报告和勾选状态。

~~~bash
git add frontend/e2e docs/plans/2026-08-27-frontend-code-governance-assessment.md docs/superpowers/plans/2026-08-27-frontend-code-governance.md
git commit -m "governance(css): verify phase 1 exit"
~~~

Rollback: 只回滚集成验收提交或最近失败的 CSS batch；保留 token/owner registry 和截图/trace 作为诊断证据。

## Phase 1 Definition of Done

- [x] canonical token contract、runtime allow-list、alias 和 exception registry 可从干净 checkout 重现；未分类 undefined variable 为 0。
- [x] 每个业务 selector 有唯一 owner；dead selector 报告区分 unused、duplicate、unknown，删除有真实行为测试。
- [x] layer 顺序 reset/tokens/primitives/shell/domain/responsive/compatibility 只声明一次；07-mobile.css 不再承担全站末端业务覆盖。
- [x] CSS legacy scope ≤67,000 行、!important ≤650、@media ≤180、drift ≤25、duplicate selector ≤1,100；趋势没有通过切文件伪造。
- [x] 六固定视口、reduced-motion、键盘/焦点、触控、安全区、横向溢出和 overlay busy 语义有新鲜证据。
- [x] Phase 0 health/manifest ratchet 没有因移动规则、增加 compatibility 或新 chunk 而被绕过。

停止条件：任一视口 P0 回归、focus 丢失、new debt、routeTotal 增长超过 512 bytes、exception 过期或 selector owner 争议未解决时，停止当前批次并回滚最近提交。

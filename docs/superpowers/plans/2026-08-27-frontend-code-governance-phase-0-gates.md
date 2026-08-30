# Phase 0：前端健康度量、manifest 与 fail-closed ratchet 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox ( - [ ] ) syntax for tracking.

**Goal:** 在不改变用户界面和业务行为的前提下，交付可重现的前端健康报告、逻辑入口 manifest 和三态预算门禁，使新增债务、未登记入口和无法解释的构建产物在 CI 中可靠失败。

**Architecture:** 用一个纯 Node 报告器读取 frontend/src 并输出版本化 health JSON；Vite generateBundle 插件从 Rollup 的逻辑入口和模块图生成去重后的资源 manifest；预算检查器消费 manifest，在 report、ratchet、target 三种明确模式下分别报告、阻断增量或阻断已迁移入口的硬预算。CI 只接受 violations 和 manifestErrors 作为失败依据，并保留失败 artifact。

**Tech Stack:** Node.js 20（与当前 CI 一致）、TypeScript compiler API、Vite 5/Rollup generateBundle、Vitest、gzipSync、GitHub Actions、JSON Schema-like runtime validation。

**Spec:** [2026-08-27-frontend-code-governance-design.md](../specs/2026-08-27-frontend-code-governance-design.md)

## Global Constraints

- 基线源码提交固定为 b559246669dd3fd9ec463658ce2ed4504df2a1ba；任何 baseline JSON 必须通过 Git 命令取得提交号，禁止手填 latest。
- 工作只发生在 /Users/zyf/IdeaProjects/Culina/.worktrees/frontend-code-governance；不修改原始 dirty main、后端、API schema、用户数据或 .env。
- 只扫描 frontend/src；排除 dist、coverage、node_modules、快照生成物和隐藏文件。
- 依赖图必须由 TypeScript AST/Rollup 模块图决定；不能用正则表达式判定 import 环或动态入口。
- 所有排序按字典序稳定化；同一源码、Node 和工具链重复运行时 JSON 字节级相同。
- report 始终退出 0；ratchet 对已登记资产相对 B0 的 raw/gzip 增量上限为 512 bytes；target 只对 phase 已完成的 entry 使用硬预算。
- warning 只能作为诊断，CI 退出码只能由 violations 或 manifestErrors 决定。
- 每个任务先写失败测试，再实现最小行为；任务结束运行 git diff --check，并只提交任务列出的文件。
- 生成的 dist、coverage、health artifact 不得提交到 Git。

---

## 0.0 预检、执行顺序与共享 fixture

**Files:**

- Modify: frontend/package.json（仅在对应任务中修改脚本）
- Create: frontend/scripts/governance-test-helpers.mjs
- Create: frontend/scripts/governance-test-helpers.test.mjs
- Create: frontend/scripts/fixtures/governance-fixture/（由测试在临时目录中生成，不提交产物）

**Interfaces:**

- Produces: assertCommandResult(result, { exitCode, stdoutIncludes, stderrIncludes })，供 0.1–0.5 的子进程测试共用。
- Produces: createFixtureTree(rootDir)，返回 { sourceDir, distDir, expected }，所有 fixture 路径使用 POSIX 分隔符。

- [ ] **Step 1: 确认基线和工作区状态**

Run:

~~~bash
test "$(git rev-parse origin/main)" = "b559246669dd3fd9ec463658ce2ed4504df2a1ba"
test -z "$(git status --porcelain)"
node --version
npm --prefix frontend --version
~~~

Expected: 三个断言通过；Node 主版本为 20，且工作区没有未声明修改。若 origin/main 已移动，先把基线值写入任务分支说明，不得静默改数字。

- [ ] **Step 2: 建立共用 fixture helper 的失败测试**

在 governance-test-helpers.test.mjs 中断言临时树包含一个合法 TSX、一个 dynamic import、两个 selector、一个带 fallback 的 var、一个真正未定义的 var 和一个注释中的 important。

Run: npm --prefix frontend run test -- scripts/governance-test-helpers.test.mjs

Expected: FAIL with module-not-found，证明 helper 尚不存在。

- [ ] **Step 3: 实现 helper 并验证临时目录清理**

实现 mkdtemp/rm 的 finally 清理，fixture 不得写入 frontend/src 或 frontend/dist。测试结束后断言临时目录不存在。

Run: npm --prefix frontend run test -- scripts/governance-test-helpers.test.mjs

Expected: PASS；失败断言包含具体 fixture 文件和行号。

- [ ] **Step 4: Commit**

~~~bash
git add frontend/scripts/governance-test-helpers.mjs frontend/scripts/governance-test-helpers.test.mjs
git commit -m "test(governance): add shared metric fixtures"
~~~

Rollback: 仅回滚本提交；后续脚本不得复制 fixture 解析逻辑。

## Task 0.1：实现源码健康报告器

**Files:**

- Create: frontend/scripts/frontend-health-metrics.mjs
- Create: frontend/scripts/frontend-health-metrics.test.mjs
- Create: frontend/scripts/frontend-health-schema.json
- Create: frontend/scripts/frontend-health-exceptions.json
- Modify: frontend/package.json（增加 health:report、health:test）
- Test: frontend/scripts/governance-test-helpers.mjs

**Interfaces:**

- collectFrontendHealth({ rootDir, sourceDir, commit, mode = "report" }) => FrontendHealthReport
- formatHealthMarkdown(report) => string
- validateFrontendHealth(report) => { valid: true } | { valid: false, errors: string[] }
- FrontendHealthReport.version 固定为 1；source、css、tests、dependencies 的字段名必须与 schema 一致。
- exceptions 每条记录为 { metric, file, owner, reason, introducedAt, expiresAt, replacement, test }；过期记录使 ratchet 失败。

- [ ] **Step 1: 写失败测试，锁定报告结构和排序**

在 frontend-health-metrics.test.mjs 增加以下测试名和断言：

~~~js
test("collects TSX/CSS counts and stable hotspot order", () => {});
test("uses AST for static and dynamic import edges", () => {});
test("ignores comments, strings, and keyframes when counting CSS", () => {});
test("classifies fallback and runtime variables", () => {});
test("sorts paths, metrics, and selectors deterministically", () => {});
test("rejects expired or incomplete exceptions", () => {});
~~~

fixture 预期为：source.files 3、dynamicEdges 1、CSS important 1、media 1、undefinedVariables 1；注释中的 !important 和字符串中的 var(--fake) 不计数。

- [ ] **Step 2: 运行定向测试确认失败**

Run: npm --prefix frontend run test -- scripts/frontend-health-metrics.test.mjs

Expected: FAIL，错误为 Cannot find module './frontend-health-metrics.mjs' 或等价未导出错误；不得因 fixture 本身失败。

- [ ] **Step 3: 实现文件枚举和版本化 schema**

实现 listSourceFiles(sourceDir)：只返回 .ts/.tsx/.css，路径相对 rootDir、按字典序排序；读取 commit 时使用 git -C rootDir rev-parse HEAD，若显式传入 commit 则验证其为 40 位 SHA 且在 report 的 source.ref 中标注来源。

把 schema 校验放在输出前；缺少 version、toolchain、source、css、tests 或 dependencies 时抛出 FrontendHealthSchemaError，错误按 JSON path 排序。

- [ ] **Step 4: 用 TypeScript compiler API 统计源码和依赖**

对每个 TS/TSX 建立 ts.createSourceFile，遍历 ImportDeclaration、ExportDeclaration、CallExpression 中 module specifier 为 import() 的节点，输出：

~~~ts
type DependencyEdge = {
  from: string;
  to: string;
  kind: "static" | "dynamic";
  line: number;
};
~~~

统计 hook、函数、条件和 JSX handler 只作为 hotspot 信号，不把启发式数字当硬门禁。解析失败的文件加入 source.parseErrors 并使 ratchet 非零。

- [ ] **Step 5: 实现可测试 CSS tokenizer**

Tokenizer 必须维护 comment、string、括号和 block 深度；只在 selector block 中计数 selectorBlocks/declarations/important，只在 @media prelude 中计数 media；跳过 @keyframes 的百分比 selector。解析 var(--name, fallback) 时把 fallback 保留为文本并输出 classification。

输出每个命中 { file, line, column, metric, value, classification }，按 file/line/column/metric 排序。不要以正则匹配结果直接决定依赖边。

- [ ] **Step 6: 接入 runtime allow-list 和例外过期检查**

读取 frontend-health-exceptions.json；runtime 变量只有同时具备 owner、source、fallback、consumers、expiresAt 才分类为 runtime-allowed。无 fallback 且无登记的引用分类为 undefined；带 fallback 分类为 fallback-safe，不产生 undefined violation。

- [ ] **Step 7: 运行单测并锁定 Markdown 输出**

Run:

~~~bash
npm --prefix frontend run test -- scripts/frontend-health-metrics.test.mjs
npm --prefix frontend run health:report -- --format markdown --output /tmp/culina-health.md
~~~

Expected: PASS；同一命令连续两次生成的 SHA-256 相同，Markdown 含 source/css/dependencies 三张表和 exceptions 过期数。

- [ ] **Step 8: 在 B0 源码上做一次报告校准**

Run:

~~~bash
npm --prefix frontend run health:report -- --format json --output /tmp/culina-health.json
node -e "const x=require('/tmp/culina-health.json'); if(x.css.important!==837||x.css.media!==214) process.exit(1)"
~~~

Expected: 报告退出 0；若新 tokenizer 得到不同数字，先修正注释/keyframes 规则并把差异写入测试，不能直接改基线。

- [ ] **Step 9: Commit**

~~~bash
git add frontend/scripts/frontend-health-metrics.mjs frontend/scripts/frontend-health-metrics.test.mjs frontend/scripts/frontend-health-schema.json frontend/scripts/frontend-health-exceptions.json frontend/package.json
git commit -m "governance(metrics): add frontend health reporter"
~~~

Rollback: 回滚本提交不会改变源码；CI 暂时继续使用现有 style/bundle 脚本。

## Task 0.2：生成并冻结 B0 baseline 与 ratchet 数据

**Files:**

- Create: frontend/scripts/frontend-health-baseline.json
- Modify: frontend/scripts/frontend-health-metrics.mjs（仅增加 baseline 输入校验）
- Create: frontend/scripts/frontend-health-baseline.test.mjs
- Modify: frontend/package.json（增加 health:baseline:check）

**Interfaces:**

- readHealthBaseline(path) => FrontendHealthBaseline
- compareHealthToBaseline(current, baseline, { toleranceBytes = 512 }) => { reductions, unchanged, violations }
- Baseline 中 sourceCommit 必须等于 B0 checkout 内 git rev-parse HEAD；不可使用工作分支提交号替代。

- [ ] **Step 1: 写 baseline schema 和增量测试**

锁定以下场景：

~~~js
test("accepts exact B0 report", () => {});
test("allows a reduction", () => {});
test("rejects a new important or undefined variable", () => {});
test("allows bundle delta up to 512 bytes and rejects 513", () => {});
test("rejects baseline commit that is not HEAD of source checkout", () => {});
~~~

- [ ] **Step 2: 运行测试确认失败**

Run: npm --prefix frontend run test -- scripts/frontend-health-baseline.test.mjs

Expected: FAIL，因为 baseline reader/comparator 尚未导出。

- [ ] **Step 3: 在干净 B0 checkout 生成报告**

先在治理分支提交 0.1，再创建临时 detached worktree，并将已提交的 metric 工具以只读方式带入该 checkout：

~~~bash
B0_DIR="$(mktemp -d /tmp/culina-b0.XXXXXX)"
git worktree add --detach "$B0_DIR" b559246669dd3fd9ec463658ce2ed4504df2a1ba
mkdir -p "$B0_DIR/frontend/scripts"
git show HEAD:frontend/scripts/frontend-health-metrics.mjs > "$B0_DIR/frontend/scripts/frontend-health-metrics.mjs"
npm --prefix "$B0_DIR/frontend" ci
(cd "$B0_DIR/frontend" && node scripts/frontend-health-metrics.mjs --format json --output /tmp/culina-b0-health.json)
test "$(git -C "$B0_DIR" rev-parse HEAD)" = "b559246669dd3fd9ec463658ce2ed4504df2a1ba"
~~~

将输出复制到治理 worktree 的 frontend/scripts/frontend-health-baseline.json；文件内保留 sourceCommit、toolchain、generatedAtPolicy: "source-commit-only"。不要把临时目录或 node_modules 提交。

- [ ] **Step 4: 验证 baseline 与源码没有混入治理文档**

Run:

~~~bash
node frontend/scripts/frontend-health-metrics.mjs --check-baseline frontend/scripts/frontend-health-baseline.json
git diff -- frontend/src frontend/package.json
~~~

Expected: baseline 校验通过；第二条命令无输出，证明只新增治理数据。

- [ ] **Step 5: 运行 baseline tests 和 B0 ratchet simulation**

Run: npm --prefix frontend run test -- scripts/frontend-health-baseline.test.mjs

Expected: PASS；将一个 fixture 的 important 加 1 时 violations 包含 file、metric、current、allowed、delta。

- [ ] **Step 6: Commit**

~~~bash
git add frontend/scripts/frontend-health-baseline.json frontend/scripts/frontend-health-baseline.test.mjs frontend/scripts/frontend-health-metrics.mjs frontend/package.json
git commit -m "governance(metrics): freeze frontend B0 baseline"
~~~

Rollback: 删除 baseline 提交前先保留 artifact；禁止用回滚提交绕过 ratchet。若 B0 报告工具修正，必须重新在同一 B0 checkout 生成并附 JSON diff。

## Task 0.3：生成逻辑入口和传递依赖 manifest

**Files:**

- Create: frontend/scripts/bundle-manifest.mjs
- Create: frontend/scripts/bundle-manifest.test.mjs
- Create: frontend/scripts/bundle-entrypoints.json
- Modify: frontend/vite.config.ts
- Modify: frontend/package.json（build:manifest、manifest:check）

**Interfaces:**

- createFrontendHealthManifest({ bundle, outDir, entryConfig, commit }) => FrontendHealthManifest
- assertFrontendHealthManifest(manifest, config) => { violations: ManifestViolation[]; ok: boolean }
- resolveLogicalEntry(source, config) => string
- FrontendHealthManifest.entries[id] 至少包含 source/js/css/imports/dynamicImports/initial/entryCritical/routeTotal/shared。

- [ ] **Step 1: 写 manifest fixture 测试**

在临时 dist 中放入两个 hashed JS、一份 CSS、一个共享 chunk 和一个动态 chunk，构造 Rollup-like bundle object。锁定：

~~~js
test("maps logical entry by facade module id, not filename prefix", () => {});
test("deduplicates routeTotal shared assets", () => {});
test("records raw and gzip bytes with content hash", () => {});
test("reports missing entry, orphan chunk, and unresolved CSS", () => {});
test("detects an unregistered dynamic import after code movement", () => {});
~~~

- [ ] **Step 2: 运行定向测试确认失败**

Run: npm --prefix frontend run test -- scripts/bundle-manifest.test.mjs

Expected: FAIL，错误为 manifest builder 未导出或无法解析 fixture。

- [ ] **Step 3: 登记逻辑入口**

在 bundle-entrypoints.json 明确登记：

~~~json
{
  "main": "src/main.tsx",
  "home": "src/features/home/HomeDashboard.tsx",
  "eat": "src/features/eat/EatWorkspace.tsx",
  "ingredients": "src/components/ingredients/IngredientWorkspace.tsx",
  "food": "src/components/foods/FoodWorkspace.tsx",
  "ai": "src/components/ai/AiWorkspace.tsx",
  "family-profile": "src/features/family/FamilySettings.tsx",
  "family-model-settings": "src/features/family-model-settings/FamilyModelSettingsWorkspace.tsx",
  "model-usage": "src/features/model-usage/ModelUsageWorkspace.tsx",
  "model-usage-requests": "src/features/model-usage/ModelUsageRequestLogsPage.tsx",
  "markdown": "src/components/ai/MarkdownMessage.tsx",
  "ai-approval": "src/components/ai/AiApprovalPanel.tsx",
  "inventory-operation": "src/features/inventory/InventoryMaintenanceDialogs.tsx",
  "home-dialogs": "src/features/home/HomeDashboardDialogs.tsx"
}
~~~

如果当前源码路径不同，先在同一任务中建立显式 route entry 文件；禁止把多个 source 映射到同一逻辑 id。

- [ ] **Step 4: 实现 Vite generateBundle 插件**

使用 build.manifest: true 和 plugin generateBundle(_options, bundle)。通过 chunk.facadeModuleId、chunk.imports、chunk.dynamicImports 和 asset references 计算图；不能从 hashed 文件名猜入口。每个 asset 保存 rawBytes、gzipBytes、sha256、sourceModules。

routeTotal 必须对 static/dynamic reachable assets 做集合去重；shared 列出被两个以上 entries 使用的文件。gzip 使用 gzipSync(content, { level: 9, mtime: 0 })，报告 bytes 与 KiB。

- [ ] **Step 5: 处理 manifest 错误**

以下条件加入 manifestErrors，并让 0.4 在 ratchet/target 非零：缺失逻辑 entry、孤儿 chunk、无法解析 CSS/import、未登记 dynamic import、一个逻辑 id 匹配多个 facade。

- [ ] **Step 6: 运行测试和真实构建**

Run:

~~~bash
npm --prefix frontend run test -- scripts/bundle-manifest.test.mjs
npm --prefix frontend run build:manifest
node frontend/scripts/bundle-manifest.mjs --check frontend/dist/.vite/frontend-health-manifest.json
~~~

Expected: fixture tests PASS；dist/.vite/frontend-health-manifest.json 存在，entries 至少包含 main、ai、food、ingredient、family-profile、family-model-settings、model-usage、model-usage-requests、markdown。

- [ ] **Step 7: Commit**

~~~bash
git add frontend/scripts/bundle-manifest.mjs frontend/scripts/bundle-manifest.test.mjs frontend/scripts/bundle-entrypoints.json frontend/vite.config.ts frontend/package.json
git commit -m "governance(bundle): add logical entry manifest"
~~~

Rollback: 保留 Vite 原有 manifest 输出；移除插件不会改变业务代码。若 manifest 不完整，禁止继续启用 target。

## Task 0.4：把 bundle checker 改为 report/ratchet/target 三态

**Files:**

- Modify: frontend/scripts/check-bundle-budgets.mjs
- Create: frontend/scripts/check-bundle-budgets.test.mjs
- Modify: frontend/scripts/bundle-budgets.json
- Modify: frontend/package.json（check:bundle 默认显式 report，check:governance 参数透传）

**Interfaces:**

- runBundleBudgetCheck({ mode, manifestPath, baselinePath, configPath }) => { warnings, violations, manifestErrors, exitCode }
- parseMode(argv) => report | ratchet | target；未知 mode 退出 2。
- Config entry 字段固定为 criticalGzipBudget、routeTotalGzipBudget、cssBudget、phase、owner，单位 bytes。

- [ ] **Step 1: 写子进程失败测试**

测试场景和期望退出码：

~~~js
test("target over-budget exits 1", () => {});
test("ratchet allows historical gap with no delta", () => {});
test("ratchet rejects 513-byte increase", () => {});
test("missing dynamic entry exits 1", () => {});
test("report returns 0 but labels warning and error", () => {});
test("prefix matching cannot select the first hashed file", () => {});
~~~

- [ ] **Step 2: 运行测试确认当前 warning-only 根因**

Run: npm --prefix frontend run test -- scripts/check-bundle-budgets.test.mjs

Expected: 至少 target over-budget exits 1 和 missing dynamic entry exits 1 FAIL；当前脚本把预算超限放进 warnings 并返回 0，这个失败必须被保留为回归证据。

- [ ] **Step 3: 实现 mode 和退出码**

实现：

~~~text
report  -> print all diagnostics; exit 0
ratchet -> compare B0; exit 1 on violations or manifestErrors
target  -> use target budget for config.phase <= completedPhase; otherwise ratchet
unknown -> exit 2
~~~

错误行必须包含 entry、metric、current、allowed/target、delta、source asset；输出按 entry/metric 排序。历史 gap 只显示 targetGap，不得转成 violation。

- [ ] **Step 4: 用逻辑 id 匹配并检查 routeTotal**

删除 prefix/find-first 逻辑，改为读取 manifest.entries[id]。entryCritical 和去重后的 routeTotal 同时比较；把代码移动到新 dynamic chunk 后，routeTotal 增量必须出现，不能绕过检查。

- [ ] **Step 5: 覆盖旧 public image 检查**

保留 assets/images 的 1.5 MiB public image budget 和 .DS_Store violation；把这些结果也归入 violations，不允许由 report warning 掩盖。

- [ ] **Step 6: 运行三态验证**

Run:

~~~bash
node frontend/scripts/check-bundle-budgets.mjs --mode=report
node frontend/scripts/check-bundle-budgets.mjs --mode=ratchet --baseline=frontend/scripts/frontend-health-baseline.json
node frontend/scripts/check-bundle-budgets.mjs --mode=target --config=frontend/scripts/bundle-budgets.json
~~~

Expected: report 退出 0 且明确列 warning/error；ratchet 在 B0 fixture 通过；target 只对 phase 0 entry 硬失败，AI/Ingredient 历史 gap 显示 targetGap。

- [ ] **Step 7: Commit**

~~~bash
git add frontend/scripts/check-bundle-budgets.mjs frontend/scripts/check-bundle-budgets.test.mjs frontend/scripts/bundle-budgets.json frontend/package.json
git commit -m "governance(bundle): add report ratchet and target modes"
~~~

Rollback: CI 可先切回 --mode=report；不得恢复 prefix matching 或删除 manifest error。

## Task 0.5：接入 fail-closed CI 和 artifact

**Files:**

- Modify: .github/workflows/quality-gates.yml
- Create: frontend/scripts/check-frontend-governance.mjs
- Create: frontend/scripts/check-frontend-governance.test.mjs
- Modify: frontend/package.json、package.json

**Interfaces:**

- runFrontendGovernance({ healthPath, manifestPath, resultPaths, mode }) => { checks, violations, exitCode }
- CI job id 固定为 frontend-governance；显示名固定为 Frontend Governance。
- 仓库根目录 `.artifacts/` 是唯一 CI artifact root；路径固定为 `.artifacts/frontend-health.json`、`.artifacts/frontend-health-manifest.json`、`.artifacts/frontend-governance-result.json`。
- `frontend/dist/.vite/frontend-health-manifest.json` 只属于本地构建的中间产物；构建后必须从仓库根目录执行 `cp` 到 `.artifacts/frontend-health-manifest.json`，聚合器和上传步骤只读取/上传 `.artifacts/` 下的 canonical 文件。

- [ ] **Step 1: 写 workflow contract 失败测试**

测试读取 YAML 文本并断言同时出现：

~~~text
frontend-governance
health:report
check:governance
frontend-health.json
frontend-health-manifest.json
.artifacts/frontend-health-manifest.json
mkdir -p .artifacts
cp frontend/dist/.vite/frontend-health-manifest.json .artifacts/frontend-health-manifest.json
if: always()
~~~

另写聚合器 fixture：一个子结果为 failure 时 exitCode 必须为 1；所有 success 才为 0。再加入路径契约 fixture，断言生成器的 dist 中间路径、聚合器输入和 upload-artifact 路径最终都指向同一个 `.artifacts/frontend-health-manifest.json`，禁止直接上传或读取未归档的 dist 路径。

- [ ] **Step 2: 运行测试确认失败**

Run: npm --prefix frontend run test -- scripts/check-frontend-governance.test.mjs

Expected: workflow assertion FAIL，因为当前 YAML 没有 frontend-governance job；聚合器测试 FAIL，因为文件尚不存在。

- [ ] **Step 3: 增加一次 build、报告、ratchet 和 artifact 上传**

在 frontend-governance job（所有步骤 `working-directory: ${{ github.workspace }}`）按以下顺序执行：

~~~yaml
- run: npm ci --prefix frontend
- run: mkdir -p .artifacts
- run: npm --prefix frontend run health:report -- --format json --output "$GITHUB_WORKSPACE/.artifacts/frontend-health.json"
- run: npm --prefix frontend run build:manifest
- run: test -s frontend/dist/.vite/frontend-health-manifest.json
- run: cp frontend/dist/.vite/frontend-health-manifest.json "$GITHUB_WORKSPACE/.artifacts/frontend-health-manifest.json"
- run: npm --prefix frontend run check:governance -- --mode=ratchet --manifest "$GITHUB_WORKSPACE/.artifacts/frontend-health-manifest.json" --result "$GITHUB_WORKSPACE/.artifacts/frontend-governance-result.json"
- if: always()
  uses: actions/upload-artifact@v4
  with:
    name: frontend-governance
    path: |
      .artifacts/frontend-health.json
      .artifacts/frontend-health-manifest.json
      .artifacts/frontend-governance-result.json
~~~

build 只能执行一次；若复用现有 Frontend Build 产物，必须通过 needs 和 artifact 明确传递，并在本 job 恢复到 `frontend/dist/.vite/frontend-health-manifest.json` 后再复制到 canonical root，不得假定共享 workspace。`mkdir -p .artifacts` 必须在所有写入步骤之前执行。

- [ ] **Step 4: 实现 fail-closed 聚合器**

聚合器读取 health、manifest、bundle、style drift、coverage 的 JSON 结果；任何文件缺失、状态不是 success、JSON 无法解析或 check process 非 0 都加入 violations 并 exit 1。if: always() 只保证诊断 artifact 上传，不改变失败状态。

- [ ] **Step 5: 保留 required checks**

契约测试同时断言现有 Frontend Build、Vitest shards、style drift 和 frontend-e2e-p0 job 仍存在；不得把新聚合 job 当作删除旧 required check 的理由。PR 分支不能修改 baseline、预算 phase 或 owner 而绕过检查。

- [ ] **Step 6: 运行契约测试和 YAML 静态检查**

Run:

~~~bash
npm --prefix frontend run test -- scripts/check-frontend-governance.test.mjs
node frontend/scripts/check-frontend-governance.mjs --fixtures frontend/scripts/fixtures/governance-ci
git diff --check
~~~

Expected: PASS；failure fixture exit 1、全 success fixture exit 0；artifact 路径和 job 名称与契约一致。

- [ ] **Step 7: Commit**

~~~bash
git add .github/workflows/quality-gates.yml frontend/scripts/check-frontend-governance.mjs frontend/scripts/check-frontend-governance.test.mjs frontend/package.json package.json
git commit -m "governance(ci): add fail-closed frontend governance job"
~~~

Rollback: 可单独回滚 workflow 提交并保留本地脚本；不删除 artifact contract 测试和 manifest 生成器。

## Task 0.6：建立覆盖率、拓扑和报告 artifact 基线（只报告）

**Files:**

- Modify: frontend/vite.config.ts（仅稳定 coverage include/exclude）
- Modify: .github/workflows/quality-gates.yml（上传 coverage summary）
- Modify: frontend/package.json（coverage:report）
- Create: frontend/scripts/coverage-topology-report.mjs
- Create: frontend/scripts/coverage-topology-report.test.mjs

**Interfaces:**

- collectCoverageTopology({ coverageDir, sourceDir }) => { files, tests, byDomain, uncoveredCompositionFiles }
- formatCoverageSummary(result) => string
- Phase 0 不设置全局 hard floor；只比较 B0 的 214 test files、1,786 tests、71.11/75.84/66.58。

- [ ] **Step 1: 写只报告 fixture 测试**

断言 App.tsx、IngredientWorkspace.tsx 被列入组合层提示，即使全局 coverage 达标；缺失 coverage-summary.json 作为 artifact error，而不是 0%。

- [ ] **Step 2: 运行测试确认失败**

Run: npm --prefix frontend run test -- scripts/coverage-topology-report.test.mjs

Expected: FAIL，reporter 尚不存在。

- [ ] **Step 3: 实现 coverage summary 和按域拓扑**

读取 coverage-summary.json、Vitest JSON reporter 和源码目录，按 app/ingredients/foods/eat/ai/family/inventory 分组；稳定排序未覆盖文件。不要为了提高数字排除组合层文件，也不要打开现有 fileParallelism: false。

- [ ] **Step 4: 接入命令和 artifact**

新增：

~~~json
{
  "coverage:report": "npm run test:coverage -- --reporter=json"
}
~~~

workflow 上传 coverage summary，并在 health report 中引用 artifact 路径。全局阈值保持未设置；Phase 2/3 新增 port/action/view model 时先补行为测试。

- [ ] **Step 5: 运行 B0 采样**

Run:

~~~bash
npm run frontend:test:coverage
node -e "const x=require('./frontend/coverage/coverage-summary.json'); console.log(x.total)"
npm --prefix frontend run coverage:report
~~~

Expected: 记录 214 files、1,786 tests 和约 71.11%/75.84%/66.58%；报告明确列出组合层低覆盖文件。

- [ ] **Step 6: Commit**

~~~bash
git add frontend/scripts/coverage-topology-report.mjs frontend/scripts/coverage-topology-report.test.mjs frontend/vite.config.ts frontend/package.json .github/workflows/quality-gates.yml
git commit -m "governance(testing): report frontend coverage topology"
~~~

Rollback: 删除 report hook 不影响 Vitest 测试；不得通过改 include/exclude 隐藏组合层。

## Task 0.7：Phase 0 集成验证和交付记录

**Files:**

- Modify: docs/plans/2026-08-27-frontend-code-governance-assessment.md（只补实际命令和差异）
- Modify: docs/superpowers/plans/2026-08-27-frontend-code-governance.md（勾选 Phase 0 产物）
- Create: .artifacts/frontend-governance-phase-0-checklist.md（本地验证后删除，不提交）

**Interfaces:**

- Produces: 一份包含命令、退出码、commit、manifest entry 数量和未执行浏览器 smoke 的交付记录。

- [ ] **Step 1: 在干净 B0-derived checkout 运行最小集**

~~~bash
npm --prefix frontend run test -- scripts/frontend-health-metrics.test.mjs scripts/frontend-health-baseline.test.mjs scripts/bundle-manifest.test.mjs scripts/check-bundle-budgets.test.mjs scripts/check-frontend-governance.test.mjs
npm --prefix frontend run typecheck
mkdir -p .artifacts
npm --prefix frontend run health:report -- --format json --output "$PWD/.artifacts/frontend-health.json"
npm --prefix frontend run build:manifest
cp frontend/dist/.vite/frontend-health-manifest.json .artifacts/frontend-health-manifest.json
npm --prefix frontend run check:governance -- --mode=ratchet --manifest "$PWD/.artifacts/frontend-health-manifest.json" --result "$PWD/.artifacts/frontend-governance-result.json"
git diff --check
~~~

Expected: 每条命令都记录实际 exit code；ratchet 通过，三个 canonical artifact 均存在且可解析。Phase 0 不宣称已完成视觉/P0 smoke。

- [ ] **Step 2: 检查不变差和未登记入口**

对 fixture 分别增加一个 important、513 bytes、未登记 dynamic import 和缺失 manifest entry；四种检查都必须 exit 1。对 B0 历史超目标但无增量 fixture，ratchet 必须 exit 0。

- [ ] **Step 3: 删除生成物并检查提交范围**

~~~bash
rm -rf .artifacts frontend/dist frontend/coverage
git status --short --untracked-files=all
git diff --check
~~~

Expected: 只剩声明的脚本、配置、测试、workflow 和文档；没有 dist、coverage、密钥或家庭数据。

- [ ] **Step 4: Commit**

~~~bash
git add docs/plans/2026-08-27-frontend-code-governance-assessment.md docs/superpowers/plans/2026-08-27-frontend-code-governance.md
git commit -m "governance(metrics): verify phase 0 gates"
~~~

Rollback: 保留本阶段失败 artifact，回滚集成文档提交不会撤销已验证的度量/manifest脚本；若 ratchet 失败，回滚最近一个脚本或 workflow 提交。

## Phase 0 Definition of Done

- [x] clean B0-derived checkout 可重复生成 health JSON、Markdown 和 manifest，SHA-256 对同一输入稳定。
- [x] fixture 中新增 important、undefined variable、未登记 dynamic import、孤儿 chunk 和 target 超限均使对应检查非零。
- [x] B0 ratchet 通过；历史 target gap 以 targetGap 报告，不让现状一次性全红。
- [x] main、home、eat、ingredients、food、ai、family-profile、family-model-settings、model-usage、model-usage-requests、markdown、ai-approval、inventory-operation、home-dialogs 全部有逻辑 entry。
- [x] CI 的 frontend-governance job fail-closed，health/manifest/budget artifact 使用 if: always() 上传，原有 required checks 仍存在。
- [x] coverage 只报告，不通过降低 include/exclude 或全局阈值制造假改善。
- [x] 每个代码提交均有 focused test、typecheck 或 build 证据、git diff --check 和独立回滚边界。

停止条件：manifest 缺失、ratchet 误报、任何家庭/AI contract 回归或 artifact 无法上传时，暂停 Phase 1，回滚最近一个 Phase 0 任务提交并保留失败 artifact。

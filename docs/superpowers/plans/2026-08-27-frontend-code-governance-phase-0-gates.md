# Phase 0：前端度量、manifest 与 fail-closed ratchet

目标：在不改变用户界面和业务行为的情况下，建立可信的前端健康报告、入口依赖 manifest 和逐步收紧的质量门禁。完成后，B0 仍能通过；任何新增债务或未登记入口必须能被 CI 可靠拒绝。

前置：无。后续 Phase 1–5 依赖本阶段产物。

## 0.1 建立可重现的源码健康报告

### 文件边界

- 新增 `frontend/scripts/frontend-health-metrics.mjs`
- 新增 `frontend/scripts/frontend-health-metrics.test.mjs`
- 新增 `frontend/scripts/frontend-health-baseline.json`
- 新增 `frontend/scripts/frontend-health-exceptions.json`
- 修改 `frontend/package.json`（增加 `health:report`、`check:governance` 脚本）
- 可选修改根 `package.json`（增加 `frontend:health` 和 `frontend:governance` 便捷别名）

### 计量契约

`collectFrontendHealth({ rootDir, mode })` 返回版本化 JSON，至少包含：

```json
{
  "version": 1,
  "commit": "b559246...",
  "toolchain": { "node": "", "npm": "", "vite": "", "typescript": "", "vitest": "" },
  "source": { "files": 0, "lines": 0, "byDomain": {}, "hotspots": [] },
  "css": {
    "files": 0, "lines": 0, "important": 0, "media": 0,
    "selectorBlocks": 0, "declarations": 0, "duplicateSelectors": 0,
    "rawTokenLines": 0, "undefinedVariables": [], "drift": {}
  },
  "tests": { "files": 0, "tests": null, "coverage": null },
  "dependencies": { "staticEdges": 0, "dynamicEdges": 0, "forbiddenEdges": [] }
}
```

实现要求：

- 只扫描 `frontend/src`，排除 `dist`、`coverage`、`node_modules` 和生成文件。
- TS/TSX 使用 TypeScript compiler API 或同等稳定 parser 统计 import、hook 调用、函数/条件/JSX handler 等启发式信号；不要用正则替代语法解析来决定依赖环。
- CSS 先用可测试的 tokenizer，完成 PostCSS 依赖评估后再切换 AST；注释、字符串和 `@keyframes` 不能被误算为 selector/declaration。
- `source.lines`、单文件行数只做趋势报告；硬门禁针对 `!important`、未登记变量、非 canonical media、selector ownership、依赖越界和 bundle 传输。
- 输出排序稳定（路径、metric id、selector 均按字典序），同一 commit 在相同 Node 版本下重复运行应得到字节级相同 JSON。

### TDD 步骤

1. 先在 `frontend-health-metrics.test.mjs` 写临时 fixture：一个合法 TSX、一个动态 import、两个 CSS selector、一个 `!important`、一个 runtime variable 和一个未定义变量。
2. 运行：

   ```bash
   npm --prefix frontend run test -- scripts/frontend-health-metrics.test.mjs
   ```

   预期：失败，因为 reporter 尚不存在。
3. 实现 parser、稳定排序和 JSON schema 校验；测试必须断言行数、静态/动态边、CSS 计数、变量分类和 hotspot 排序。
4. 增加“注释中的 `!important` 不计数”“带 fallback 的 `var()` 不算未定义”“runtime allow-list 需要 reason/expiry”回归测试。
5. 在 B0 上运行：

   ```bash
   npm --prefix frontend run health:report -- --format json
   npm --prefix frontend run health:report -- --format markdown
   ```

   预期：输出与体检记录相符（CSS 73,489 行、837 个 `!important`、214 个 `@media`），报告退出 0。

### Baseline 生成规则

- baseline 的 `commit` 必须由 `git rev-parse HEAD` 写入，不能手工填“最新”。
- 第一次生成单独提交 `governance(metrics): add frontend health baseline and ratchet`；不要同时修改业务源码。
- 后续 baseline 更新只允许在治理 PR 中发生，PR 描述必须附 `before/after` JSON diff、原因和回滚提交；功能 PR 不得提高 baseline。

## 0.2 建立 Vite 入口依赖 manifest

### 文件边界

- 新增 `frontend/scripts/bundle-manifest.mjs`（解析 Vite manifest/产物并计算 gzip）
- 新增 `frontend/scripts/bundle-manifest.test.mjs`
- 新增 `frontend/scripts/bundle-budgets.json`
- 修改 `frontend/vite.config.ts`
- 修改 `frontend/package.json` 的 build/check 脚本

### Manifest 结构

每次生产构建生成 `dist/.vite/frontend-health-manifest.json`（或等价的 `dist` 内固定路径）：

```json
{
  "version": 1,
  "build": { "commit": "", "node": "", "vite": "" },
  "entries": {
    "main": {
      "source": "src/main.tsx",
      "js": ["assets/index-...js"],
      "css": ["assets/index-...css"],
      "imports": [],
      "dynamicImports": ["home", "eat", "ingredients", "ai", "family"],
      "initial": { "rawBytes": 0, "gzipBytes": 0 },
      "routeTotal": { "rawBytes": 0, "gzipBytes": 0 }
    }
  },
  "assets": {}
}
```

具体要求：

- 通过 `build.manifest: true` 和一个 `generateBundle` 插件补齐模块、静态 import、dynamic import、CSS 关联和原始字节；不能从哈希文件名猜逻辑入口。
- 逻辑入口配置列出当前全部 lazy entry：HomeDashboardDialogs、FamilySettings、ModelUsageWorkspace、ModelUsageRequestLogsPage、FamilyModelSettingsWorkspace、FoodWorkspace、IngredientWorkspace、AiWorkspace，并预留 Eat task 二级入口。
- `initial` 是首次进入 main 所需的唯一资产；`entryCritical` 是 route 自己的 chunk；`routeTotal` 是该 route 的唯一静态/动态传递依赖。共享文件只计一次，并在 `shared` 字段列明。
- 每个资源同时保存 raw bytes、gzip bytes、content hash 和来源模块。gzip 使用固定 Node `gzipSync` 选项；报告单位同时给 bytes 和 KiB，避免“kB”歧义。
- 缺失 entry、孤儿 chunk、未解析的 CSS、未登记 dynamic import 和同一逻辑 entry 匹配多个产物都必须是 manifest error。

### TDD 步骤

1. 在 `bundle-manifest.test.mjs` 用临时目录构造两份 hashed JS、一份 CSS 和一份 manifest，先断言 `routeTotal` 去重、gzip 求和、缺失 entry 报错。
2. 运行定向测试，预期因 parser 不存在失败。
3. 实现 manifest parser 和 `assertBundleManifest`；增加“把代码从 entry 移到新 dynamic chunk 会改变 routeTotal 且不会绕过配置”的测试。
4. 用 B0 构建生成 manifest，检查下列 entry 都存在：`main`、`ai`、`food`、`ingredient`、`family-profile`、`family-model-settings`、`model-usage`、`model-usage-requests`、`markdown`。

## 0.3 将 bundle 检查改为三态门禁

### 文件边界

- 修改 `frontend/scripts/check-bundle-budgets.mjs`
- 新增 `frontend/scripts/check-bundle-budgets.test.mjs`
- 修改 `frontend/scripts/bundle-budgets.json`
- 修改 `frontend/package.json`

### 行为定义

CLI：

```bash
node scripts/check-bundle-budgets.mjs --mode=report
node scripts/check-bundle-budgets.mjs --mode=ratchet --baseline=scripts/frontend-health-baseline.json
node scripts/check-bundle-budgets.mjs --mode=target --config=scripts/bundle-budgets.json
```

- `report`：本地和 artifact 使用，始终返回 0，但必须输出 warning/error 分类。
- `ratchet`：B0 以及当前已登记 entry 的 gzip/raw 不能增加超过 512 bytes；新增 entry 或无法解析资源返回 1。尚未达到历史目标的 entry 只比较“不变差”，不让当前 main 立即变红。
- `target`：对已完成迁移的 entry 采用配置中的 hard budget；超限返回 1。未迁移 entry 自动回落到 ratchet，而不是静默跳过。
- `warnings` 不得再决定 CI 成功；脚本最终只依据 `violations` 和 `manifestErrors` 设置退出码。
- 预算配置使用逻辑 entry id，不使用 `prefix`/`find first`；每个 entry 明确 `criticalGzipBudget`、`routeTotalGzipBudget`、`cssBudget`、`phase` 和 `owner`。

### TDD 步骤

1. 先写子进程测试：给定超限 fixture，`--mode=target` 必须非零；给定 B0 超目标但无增量 fixture，`--mode=ratchet` 必须为零；缺失 dynamic entry 必须非零。
2. 运行：

   ```bash
   npm --prefix frontend run test -- scripts/check-bundle-budgets.test.mjs
   ```

   预期：当前实现会因为只产生 warning 而失败，证明测试抓到了 P1 根因。
3. 实现三态检查和稳定错误码；错误输出包括 entry、metric、current、allowed/target、delta、来源 asset。
4. 用 B0 运行 report/ratchet/target。target 只对明确标记为 `phase: 0` 的基础 shell启用；AI/Ingredient 等仍显示目标 gap 但 ratchet 通过。

## 0.4 CI 接入与 artifact

### 文件边界

- 修改 `.github/workflows/quality-gates.yml`
- 修改 `frontend/package.json`、根 `package.json`
- 新增（如需要）`frontend/scripts/check-frontend-governance.mjs`

### CI 设计

新增 `frontend-governance` job：

1. `npm ci --prefix frontend`。
2. `npm --prefix frontend run health:report -- --format json --output .artifacts/frontend-health.json`。
3. `npm --prefix frontend run build`（或复用同一构建产物，避免二次 Vite build）。
4. `npm --prefix frontend run check:governance -- --mode=ratchet`。
5. 上传 health、manifest、bundle diff artifact；`if: always()` 保证失败时仍能诊断。

保留现有 `Frontend Build`、Vitest shard、style drift 和 P0 job。新聚合 job 必须 fail-closed：读取每个子检查结果，任何非 `success` 都退出 1。CI 不从 PR 分支接受 baseline/预算配置的隐式扩大。

### 工作流契约测试

在已有工作流契约测试（若不存在则新增 `backend/tests/core/test_quality_gates_workflow.py` 的前端断言）中要求：

```text
frontend-governance:
health:report
check:governance
frontend-health.json
frontend-health-manifest.json
if: always()
```

测试先失败，再修改 YAML；运行相应 pytest 验证，不用肉眼检查 YAML 作为唯一证据。

## 0.5 覆盖率与测试拓扑基线（只报告）

### 文件边界

- 修改 `frontend/vite.config.ts`（只在需要稳定 include/exclude 时）
- 修改 `.github/workflows/quality-gates.yml`，上传 coverage summary artifact
- 修改 `frontend/package.json`，增加 `coverage:report`（可选）

### 规则

- 保留 `fileParallelism: false`；不得为追求 CI 时间偷偷开启并行，现有 workspace 测试明确依赖串行。
- `npm run frontend:test:coverage` 只产出行/分支/函数及按域 JSON，不在 Phase 0 设置全局 hard floor。
- 报告明确标注 `App.tsx`、`IngredientWorkspace.tsx` 等 0% 组合层，提醒后续必须补行为测试；不能用全局 71.11% 掩盖。
- Phase 2/3 每新增一个 port/action/view model，先补行为测试；Phase 4 后再按域启用 floor。

### 验证

```bash
npm run frontend:test:coverage
node -e "const x=require('./frontend/coverage/coverage-summary.json'); console.log(x.total)"
```

B0 预期：214 个测试文件、1,786 个测试，行/分支/函数约 71.11%/75.84%/66.58%。

## 0.6 Phase 0 完成检查

- [ ] 在干净 B0 checkout 可生成稳定 health JSON、Markdown 和 manifest。
- [ ] 临时 fixture 中新增 `!important`、未定义变量、非登记 dynamic import、超 target chunk 均可让对应检查非零退出。
- [ ] B0 的 ratchet 通过；当前历史预算 gap 仍以可见报告呈现，不把 main 变红。
- [ ] 所有实际动态 entry（含 Family Model Settings、Model Usage、Markdown）已登记。
- [ ] CI 上传 artifact，聚合 job fail-closed，现有 required check 名称仍保留。
- [ ] `git diff --check` 通过，提交只包含脚本、配置、测试和工作流文件。

推荐提交：`governance(metrics): add frontend health baseline and ratchet`。

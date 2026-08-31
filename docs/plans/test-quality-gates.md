# 测试质量门禁与覆盖率基线

本文档记录当前可直接用于本地和 CI 的测试分组、覆盖率基线命令和测试环境默认值。现阶段只记录覆盖率基线，不设置强制覆盖率阈值。

## 覆盖率基线

后端覆盖率基线：

```bash
npm run backend:test:coverage
```

- 使用 `pytest-cov`。
- 覆盖范围为 `backend/app`。
- 输出终端摘要和 `backend/coverage.json`。
- 不配置 `fail_under`，避免为了数字制造低价值测试。

前端覆盖率基线：

```bash
npm run frontend:test:coverage
```

- 使用 `@vitest/coverage-v8`。
- 覆盖范围为 `frontend/src/**/*.{ts,tsx}`。
- 排除 `*.test.ts(x)`、`frontend/src/test/**` 和 `vite-env.d.ts`。
- 输出终端摘要和 `frontend/coverage/coverage-summary.json`。
- 不配置 thresholds。

## CI 分组命令

CI 中建议按以下命令拆分 job 或 step，避免不同风险域互相污染结论：

```bash
npm run backend:test:service
npm run backend:test:ai
npm run backend:test:search
npm run frontend:test
npm run frontend:build
npm run frontend:e2e:p0
```

- `backend:test:service` 覆盖普通 API、service、权限、媒体、菜谱、库存、购物清单等非 AI/search 后端路径。
- `backend:test:ai` 单独覆盖 AI infra、workspace、skill、tool、草稿审批和流式行为。
- `backend:test:search` 单独覆盖 search provider、keyword/vector/rerank 和索引任务。
- `frontend:test` 是前端 Vitest 单元/组件测试。
- `frontend:build` 是 TypeScript、Vite build 和 bundle budget 检查。
- `frontend:e2e:p0` 是 Playwright 端到端关键路径检查，应作为独立的阻断式 check 展示，不和 Vitest 单元测试合并。

当前 GitHub Actions workflow 位于 `.github/workflows/quality-gates.yml`。`Frontend E2E P0` 不使用 `continue-on-error`，失败会阻止回归合并；其 HTML 报告通过受信任的发布工作流提供 PR 固定入口。

## PR 门禁分类

`quality-gates.yml` 的 `Classify PR Gates` 会根据 PR 改动路径选择业务域门禁：文档改动不运行业务测试；前端 helper/model 运行域测试和 typecheck；页面/状态改动补 build；Search、AI、MySQL、migration 和 deployment 只运行对应分组。响应式、导航和移动端改动补 P0 E2E；共享配置、跨前后端、未知路径和 CI 规则改动 fail-closed 到全量相关门禁。

分类结果由始终运行的 `PR Gate` 汇总。未选中的 Job 必须明确为 skipped，选中的 Job 必须成功；GitHub Ruleset 应只将 `PR Gate` 设为 required。`main` push、merge queue 和手动 workflow 仍运行全量门禁。

分类规则和 fail-closed 行为由 `.github/scripts/classify-pr-gates.test.mjs` 覆盖；本地可用 `node --test .github/scripts/classify-pr-gates.test.mjs` 验证。域级前端测试通过 `FRONTEND_TEST_SCOPES` 传递已选中的目录范围，不在第一阶段推断到单个测试文件。

PR 可以添加 `full-gates` 标签强制执行全量相关门禁。分类器会将改动路径、风险、业务域、选中/跳过门禁和分类依据写入 Job Summary，并上传为 `pr-gate-classification` artifact。分类审计只提示未知路径和频繁升级到 full 的原因，不改变 `PR Gate` 结论；这样可以在不维护文件级测试归属表的前提下持续发现规则漂移。

## 测试环境默认值

普通后端测试默认不应访问真实 AI、search、media provider 或外部向量服务。默认策略：

- AI provider：未显式配置真实 provider 时保持 disabled 或 fake/mock client。
- Search embedding provider：普通测试默认 disabled；provider client 覆盖必须使用 fake transport/mock client。
- Search vector backend：普通测试默认 disabled；Qdrant 行为通过 fake/vector-store 单测覆盖。
- Search rerank provider：普通测试默认 disabled；rerank 行为通过 fake reranker 覆盖。
- Media/MinIO：单测通过本地 fake、内存对象或测试 fixture 覆盖，只有部署/集成环境连接真实服务。

当前后端测试已通过 `backend/tests/conftest.py` 统一隔离 search provider 默认值；新增测试如需启用 provider，必须在用例内显式 patch settings，并使用 fake transport 或 monkeypatch。

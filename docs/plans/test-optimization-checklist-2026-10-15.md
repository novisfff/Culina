# Culina 测试与 CI 门禁逐项检查及优化清单

检查日期：2026-10-15（Asia/Shanghai）

代码基线：`8772c4f752ca558617fdae668f2cd5292563b7eb`

状态：C01–C14 优化已实施，本地验收通过；审查范围为逐项 CI Job 检查及重点测试深查。第 2–4 节保留初始审计快照；实施结果、实际执行命令和环境限制统一记录在第 7 节。线上验收以对应 PR 最新提交的 GitHub Actions 结果为准。

## 1. 范围、证据与结论

本次逐项检查 `.github/workflows/quality-gates.yml` 的全部 Job、四组 MySQL 矩阵、执行命令、分类器、汇总器、测试分组与主要测试支撑代码，并核对截图对应运行的全部 Job 日志。对测试内容按风险抽查权限、事务、并发、AI 契约、搜索、迁移、前端行为、源码断言和部署流程；没有逐条人工审阅数千条测试的完整语义。初始阶段为只读审计，后续经用户授权实施优化；实施后的分组执行与验证见第 7 节。

证据来源：

- [截图对应 main push 运行](https://github.com/novisfff/Culina/actions/runs/38595334636)：北京时间 2026-10-15 00:07 开始，约 7 分 08 秒结束。
- [对应 PR 运行](https://github.com/novisfff/Culina/actions/runs/38594659837)：只选中了四组 MySQL 测试及汇总，最终成功。
- 当前 main Ruleset `17024217`：唯一 required status check 是 `PR Gate`。
- 本地后端收集结果：**3,122 条 pytest 用例**。其中 AI 评测还有在一条测试内部循环执行的 **48 个场景**，不能把两者计数混用。
- CI 全量前端 Vitest：**323 个文件、2,225 条用例**；其中 `frontend/src` 有 303 个测试文件，其余为脚本测试。
- 下文时间来自单次 CI 的 Job 起止时间，包含环境准备；测试自身耗时另外注明。不是长期均值，不能据此承诺优化后节省多少墙钟时间。

结论：保留业务风险分层；先修复漏跑与误判，再消除重复执行、优化数据库准备，最后收敛源码字符串测试。不以减少测试数量或提高覆盖率百分比为独立目标。

## 2. 按实际 Job 逐项核对（初始审计快照）

| 序号 | Job | 本次 CI | 判断及任务索引 |
| --- | --- | --- | --- |
| 01 | Classify PR Gates | 成功，12 秒 | 保留；修复文档误判、CSS 覆盖已有选择、AI/共享事务/数据库路由缺口。C01–C03 |
| 02 | Backend Service Tests | 612 通过、30 跳过；1分34秒 | 保留；30 条 MySQL 测试未被其他 Job 补跑。C01 |
| 03 | Backend AI Tests | 1,311 通过、12 跳过；3分08秒 | 保留；其中 4 条 resume 在另一 Job 补跑，但 6 条执行锁/撤销 MySQL 测试遗漏。C01、C02 |
| 04 | AI Skill Evaluation Gate | 32 条 pytest 通过；1分05秒 | 保留确定性评测；改善 48 场景的定位与触发条件。C02、C12 |
| 05 | Backend Search Tests | 225 通过；42 秒 | 保留；本次测试自身约 14.63 秒，暂不追加分片或删除测试 |
| 06 | Backend MySQL (family-model-settings) | 387 通过；2分40秒 | 保留；混合 SQLite/API 与 MySQL 测试，不能把整个 Job 理解为纯 MySQL 用例。C08 |
| 07 | Backend MySQL (model-usage-core) | 503 通过、2 跳过；6分29秒 | 首要耗时优化对象：逐用例全库 DDL、测试准备、迁移。C07 |
| 08 | Backend MySQL (model-usage-reporting) | 8 通过；1分54秒 | 保留独立分组及代表性数据规模；已有 module 级 fixture，不应重复优化。C08 |
| 09 | Backend MySQL (ai-resume-concurrency) | 4 通过；1分28秒 | 保留真实并发语义；修正触发并吸收漏掉的 AI MySQL 用例。C01、C08 |
| 10 | Alembic Head and Migration Smoke | 成功；1分12秒 | 保留；单 head + 空库两次升级不等于已有数据迁移验证 |
| 11 | Production Dependency Audit | 成功；36 秒 | 保留；修复服务不可用时被记成成功以及前端失败阻止后端审计的问题。C05 |
| 12 | Frontend Typecheck | 成功；28 秒 | 保留类型检查能力，消除与 Build 的重复执行。C10 |
| 13 | Frontend Domain Tests | 跳过 | 全量时跳过正确；普通 PR 要修复 CSS 导致误跳过的问题。C03 |
| 14 | Frontend AI Contract | 4 通过；19 秒 | 保留契约；全量 Vitest 已覆盖时复用结果，后端 schema 变化时补选。C02、C06 |
| 15 | Frontend Vitest Shard 1/2 | 162 文件、1,008 用例；2分19秒 | 保留分片；与 Governance 合并测试执行及覆盖率采集。C06 |
| 16 | Frontend Vitest Shard 2/2 | 161 文件、1,217 用例；2分54秒 | 同上；先看运行时间分布，不急于增加更多分片 |
| 17 | Frontend Vitest | 成功；3 秒 | 仅汇总分片，无新增验证；可由 PR Gate 直接汇总。C11 |
| 18 | Frontend Incremental Style Drift | 成功；12 秒 | 保留；实际扫描 36 CSS 文件、50 个基线内命中，成功不代表视觉无漂移。C13 |
| 19 | Frontend Governance | 成功；4分12秒 | 保留规则及报告；取消额外全量 coverage 测试。C06 |
| 20 | Frontend Build | 成功；42 秒 | 保留生产构建与预算验证；统一类型检查、manifest、E2E 产物。C10 |
| 21 | Frontend E2E P0 | 18 通过；1分41秒 | 保留；是 API mock 下的浏览器测试，不能替代后端/部署集成 |
| 22 | Compose Media and WebSocket Smokes | 失败；2分05秒 | 实际只跑媒体；MinIO 构建网络失败；WebSocket 测试入口失效。C04、C09 |
| 23 | Backend Model Usage Tests | 成功；2 秒 | 仅汇总整个 MySQL 矩阵，名称也不完整；可并入 PR Gate。C11 |
| 24 | PR Gate | 失败；12 秒 | 保留唯一 required check；本次正确阻止部署 smoke 失败被忽略。C01、C06、C11 |

补充检查了独立的 `Publish Playwright Report` workflow：它发布/清理报告，不执行测试。保留其与验证工作流的职责区分，不将其计算为重复测试。

### 01. Classify PR Gates：先修正确性，再缩小范围

实现：`.github/scripts/classify-pr-gates.mjs`；现有分类器/runner/汇总器/审计测试合计 17 条全部通过，但没有覆盖下面的组合和漏选路径。

已对存在的路径直接调用 `classifyChangedFiles()` 复现：

| 输入路径或组合 | 当前输出 | 应补足的保障 |
| --- | --- | --- |
| `backend/app/ai/skills/catalog/shopping-list/SKILL.md` | `docsOnly=true`，无业务门禁 | AI + 确定性 Skill 评测 |
| 同目录 `references/workflows.md` | `docsOnly=true`，无业务门禁 | 同上；这些文本会被 loader 加入运行时 instructions |
| `backend/app/ai/tools/catalog/shopping.py` | 只有 backend_ai | Tool 变更应包含确定性评测 |
| `backend/app/schemas/ai.py` | 只有 backend_ai | 补前端 AI contract |
| `backend/app/repos/ai_operations.py` | 只有 backend_service | 补 AI 操作/撤销相关测试 |
| `backend/app/db/transactions.py` | 只有 backend_migration | 补真正调用事务辅助的 service/AI 等后端验证 |
| `backend/tests/ai_infra/test_human_input_resume_mysql_concurrency.py` | 只有 backend_ai | 对应真实 MySQL 分组 |
| `backend/tests/inventory/test_inventory_mysql_concurrency.py` | 只有 backend_service | 对应真实 MySQL 分组 |
| `InventoryActionDialog.tsx` + `styles/10-inventory-actions.css` | focus=false、full=false，但 build/E2E=true | 必须仍运行 inventory 域的 Vitest |

根因位置：文档过滤在第 81–82、326 行附近；CSS 将 `frontend_focus=false` 在第 192 行；AI 路由在第 230–250 行；共享 DB 在第 254–258 行。Skill 的真实加载证据在 `backend/app/ai/skills/loader.py:69` 与 `:432`。

精简边界：继续按目录与风险分类，不引入源码文件到测试文件的一对一维护表；保留未知路径 fail-closed、main/merge queue 全量及 `full-gates` 强制覆盖。

### 02. Backend Service Tests：保留业务覆盖，补足数据库执行

命令：`npm run backend:test:service`；由 `backend/ci-test-groups.json` 覆盖 account/activity/core/deployment/family/inventory/meal_logs/media/recipes/shopping 十个目录。

抽查可确认的有效断言包括跨家庭媒体访问拒绝、用户原图保留、库存撤销幂等、批量操作回滚与活动日志。这些不能用更少的 happy path 替代。

缺口：本次 30 条 skip 恰好是下面前四个文件中的数据库用例，没有其他 MySQL Job 补跑。目录分组完整性检查只证明“被收集”，不能证明“执行了需要的数据库环境”。

### 03. Backend AI Tests：保留状态机/权限，补锁与撤销

命令：`npm run backend:test:ai`；覆盖 ai_audio、ai_infra、ai_runtime。

抽查了会话私有/公开权限、子资源访问、审批/恢复、撤销和执行锁。不同层测试即便都出现“审批成功”，也可能分别验证工具权限、持久化状态、事务提交与前端投影，不凭名称相似删除。

本次日志的 12 条 skip 中，4 条 human-input resume 在专门 MySQL Job 中执行；`test_ai_revert_mysql_concurrency.py` 的 1 条和 `test_run_execution_mysql.py` 的 5 条没有补跑。其余 2 条 skip 需在实施 skip 分类时核对原因，本文不把所有 skip 一律当缺陷。

### 04. AI Skill Evaluation Gate：保留，改善场景隔离与报告

命令：`backend:test:ai-evals` + `backend:check:ai-evals`。`test_skill_scenarios.py:14` 使用 scripted provider，一条测试循环执行 48 个场景，随后汇总 report；不调用付费或非确定性模型。

建议保留场景 ID、coverage、禁止业务写入、错误分类、threshold 和报告完整性检查。若拆为参数化测试，需要保证每个场景的数据库/运行状态隔离，报告仍包含全部场景，失败或缺场景仍阻断。

可精简的是 `test_eval_dataset.py:52` 一类精确数量维护：当前固定 `len(cases)==48` 以及若干分类数量，会在仅增加合法场景时要求同步修改。用必要 case ID、必需类别/边界和唯一性约束表达覆盖；如确实要求版本化数据集，保留显式版本/清单审计，而非无解释的魔法数量。

### 05. Backend Search Tests：保持当前分组

命令：`npm run backend:test:search`。测试自身 14.63 秒，225 条；本次总耗时 42 秒中有较多安装/启动成本。

抽查 `test_hybrid_search.py`、`test_family_search_resolution.py` 和 `_support.py`，已有 fake embedding/vector/rerank、家庭配置隔离、预算阻断与降级路径。保留真实排序政策测试与家庭边界测试，不因为 fake client 就判定低价值。

当前没有足够证据支持新增分片、缩减整个分组或把它并入 AI。后续只在有具体重复断言或耗时数据时调整。

### 06. MySQL family-model-settings：区分执行环境与测试内容

命令：`npm run backend:test:family-model-settings -- --durations=20`。387 条中既有真实 MySQL 发布/草稿/搜索启用并发，也有 schema、transport 和 SQLite API 测试；`_support.py:177` 的 `family_model_api` 明确使用 SQLite 内存库。

已存在密码 hash 复用及其回归测试 `test_support_performance.py`，不再重复建议“每个 fixture 缓存密码 hash”。

后续可将纯配置/transport/API 与真实 MySQL 的执行需求分开，但应以目录/marker 及相应完整性校验实施。模型配置影响 provider、搜索和用量计费，不能简单规定“这个目录变化永不跑 model-usage”。

### 07. MySQL model-usage-core：主要优化数据库准备

命令：`backend:test:model-usage -- --ignore=tests/model_usage/test_reporting_queries_mysql.py --durations=20`。测试自身 245.28 秒；对应 PR 的同一 Job 总时间 3分22秒，本次 main 为 6分29秒，说明还存在机器/启动差异。

本次慢项证据：

| 阶段 | 用例 | 时间 |
| --- | --- | --- |
| setup | `test_concurrent_same_attempt_different_fingerprint_has_one_winner` | 19.19 秒 |
| setup | `test_usage_commit_does_not_commit_caller_business_transaction` | 10.29 秒 |
| setup | `test_mysql_concurrent_terminal_callbacks_claim_one_event_and_watermark_advance` | 8.63 秒 |
| call | `test_upgrade_initializes_policy_and_subjects_without_usage` | 11.87 秒 |
| call | `test_mysql_upgrade_downgrade_upgrade_is_reversible` | 11.37 秒 |

`test_reservation_mysql_concurrency.py:100` 为 function fixture，每次 `drop_all/create_all` 全部模型表；多个文件导入该 fixture。优先减少重复 DDL、复用只读 schema 和必要种子，按用例清理已提交数据。

不得直接把完整可变 fixture 改成 session scope；不得用单连接外层 rollback 替代多连接真实 commit；migration 用例仍需独立数据库。两个 reference-performance skip 是专用环境维度，按预期 skip 单独报告，不能为了“零 skip”直接开启不匹配机器上的绝对延迟阈值。

### 08. MySQL model-usage-reporting：保留规模与索引验证

命令：单独执行 `test_reporting_queries_mysql.py`，8 条；测试自身 55.42 秒。

已使用 module 级 fixture，构造当前周期 100,000 条 event，执行真实 EXPLAIN、索引/全表扫描检查和首次 rollup 并发构建。此处验证的是大数据分布下的查询计划，不能随意把样本降到几十条，也不能用 SQLite 替代。

绝对 latency 的 reference-host 测试与该 Job 的索引验证不是同一种门禁；不强行合并。优化触发范围前需纳入 reporting、相关 schema/index/migration、共用计费依赖。

### 09. MySQL ai-resume-concurrency：保留，并扩展为完整 AI 数据库组

当前只有 `test_human_input_resume_mysql_concurrency.py` 的 4 条：stream prepare 释放锁、approval prepare 释放锁、同 run 不可重复 claim、worker 消费并清除 claim。测试自身约 20.80 秒，总 Job 88 秒。

建议与遗漏的 AI execution/revert 数据库测试形成明确分组，共用一次 MySQL 启动；仍分别保留 claim、锁顺序、恢复与撤销幂等断言。不得并入未提供 MySQL 的普通 AI Job 后默许 skip。

### 10. Alembic Head and Migration Smoke：保留独立职责

`backend/scripts/check_alembic_migrations.py` 验证单 head、数据库名限制、两次 `upgrade head` 和数据库实际 revision；CI 提供可丢弃 MySQL。

第二次执行证明 head 状态下可重复调用，不证明从已有数据升级正确。`test_migration_mysql.py` 的老版本数据回填、唯一约束和 upgrade/downgrade/upgrade 与它不重复。未来只共享安装/基础设施，不删除这些语义。

### 11. Production Dependency Audit：优化结果可信度

当前 `audit:prod` 使用 `frontend:audit:prod && backend:audit:prod`；前端审计失败会阻止后端执行。Workflow 第 305–310 行还在日志出现特定服务错误时直接 `exit 0`，将“未完成审计”标成成功。

建议两端独立执行并汇总，分别保留成功、漏洞失败、服务不可用证据。已选中的阻断审计若无法完成，最多重试一次，仍失败则明确失败/需要重跑；不要用宽泛日志匹配吞掉漏洞或服务错误。保持依赖变更触发和现有 main 全量，不为这一项新增高维护成本的基础设施。

### 12. Frontend Typecheck：能力保留，执行一次

`frontend:typecheck` 为 `tsc -b --pretty false`，`frontend:build` 内也执行 `tsc -b`。独立 runner 不共享本地增量状态，因此全量门禁重复。

建议在共享前端验证流程中执行一次类型检查，构建消费通过后的状态；helper/model PR 仍能只 typecheck + 定向测试。若使用互斥 Job，必须同步调整 PR Gate，不能让必需检查被误判为 skipped。

### 13. Frontend Domain Tests：修复组合输入并校验真正有测试执行

`run-frontend-domain-tests.mjs` 接收目录范围，当前没有维护单文件映射，这一点保留。全量模式与 focus 模式互斥也应保留。

重点补“业务组件 + 样式”“业务 model + 样式”“同域多个文件”“仅样式”的组合；添加样式文件不应关闭已经需要的业务测试。不得启用允许零测试成功的选项掩盖目录归属错误。

### 14. Frontend AI Contract：保留语义，减少重复与源码格式耦合

4 条测试检查后端 Literal、前端枚举、renderer 覆盖及取消状态。虽然使用 `readFileSync`，但它验证跨端一致性，不能与纯组件名称字符串测试一起删除。

短期在全量 Vitest 已包含它时停止额外启动独立 runner；后端 schema 单独变化时仍定向运行。长期可读取稳定生成 schema/契约 fixture，降低对单双引号及源码排列的正则依赖，不在此次清单中要求新增整套代码生成体系。

### 15–16. Frontend Vitest 两个分片：保留，先解决全量重复

当前按文件分成两片，各自仍 `fileParallelism:false`。这个设置有避免 JSDOM 异步测试资源争抢的明确背景，不能在未定位历史超时根因时全局打开并行。

优化顺序：先让测试只执行一轮并产出可合并 coverage；再将纯 Node/model/script 测试与 DOM 测试区分环境；最后根据持续采集的时长考虑分片均衡。两个分片在单次运行中的 35 秒差距不足以证明应再加分片。

### 17. Frontend Vitest 汇总：可去掉多余中间层

Job 只检查矩阵 aggregate result，不执行 Vitest。main 规则只要求 PR Gate，故可以让 PR Gate 直接依赖并检查 `frontend-vitest-shard.result`。

需先更新 `verify-pr-gates.mjs` 及相关配置测试，确保任一分片 failed/cancelled/意外 skipped 都不会放行；这是结构简化，3 秒耗时不是主要收益。

### 18. Frontend Incremental Style Drift：保留，说明实际边界

实际脚本 `check-style-token-drift.mjs` 会对超基线计数返回非零，已不是单纯只打印报告。当前 36 个文件、50 个命中均处于基线允许范围。

它只检查已登记模式及计数，不能发现所有视觉问题；同文件移除一个旧命中再加入一个新命中，数量不变也可能通过。保留人工差异审阅与必要浏览器验证；无需增加大量单测逐个断言 CSS 文本。

项目文档部分描述仍称它为报告型检查，后续应同步实际退出码与“通过不等于视觉验收”的含义。

### 19. Frontend Governance：最大确定性重复成本

`quality-gates.yml:481` 执行 `coverage:report`，后者在 `frontend/package.json:14` 再跑一遍完整 Vitest。该步骤本次耗时 218 秒；另外两个 shard 已执行同一全集，独立 AI Contract 再执行其中 4 条。

保留 health、bundle base comparison、coverage topology 和 artifact 完整性检查。建议 shard 同时生成原始覆盖率与测试结果，再由轻量 report Job 合并；不能直接把 coverage-summary 的百分比相加或简单平均，也不能把各 shard 的分母机械求和。

当前 coverage topology 主要提供覆盖情况/未覆盖组合文件报告；其 exit code 由 artifact 错误驱动，不能把它描述成强制 100% 覆盖率门禁。结构与 bundle 检查自身仍需保留。

### 20. Frontend Build：复用产物，保留不同预算语义

Build、Governance manifest build、E2E build 都构建当前提交；Governance 在基线 cache miss 时还构建目标分支。目标分支构建用于增量比较，不能算可直接删除的重复。

建议当前提交生成一份经验证的 dist/manifest，再按相同构建参数分发。E2E 可消费 dist；Governance 消费 manifest。开发者本地 `frontend:build` 仍保留完整入口；CI 可使用更细步骤。

注意 Build 的 target 预算和 Governance 的 ratchet/base 比较不是同一规则，复用构建产物不等于删除其中一种预算。先测量 artifact 上传/下载及 Job 依赖等待成本，小构建未必比重复 4–5 秒 Vite 更快。

### 21. Frontend E2E P0：保留三个视口与失败证据

当前 6 个场景 × 3 个 project，共 18 次；视口为 375×812、1180×820、1440×960；CI 2 workers、retries=0。约 54.6 秒浏览器执行时间，规模合理。

`p0App.mjs` 注入 API mocks，检查未匹配请求、pageerror 和 console error。因此它验证导航、交互、响应式与前端契约使用，不证明真实认证、数据库或 nginx WebSocket 能工作。

保留稳定 UI 定位、溢出检查、必要视觉 checkpoint、失败 trace/screenshot。未经证据不要删平板，也不要靠增加重试掩盖不稳定。

### 22. Compose Media and WebSocket Smokes：名称、覆盖与环境均需校准

实际命令只有 `npm run deploy:smoke:media`。媒体脚本验证真实 nginx/backend/MySQL/MinIO 链路下上传与读取、未认证/跨家庭访问、匿名对象拒绝和 capability 不进入 access log，值得保留。

本次失败发生在 `deploy/minio/Dockerfile:5` 编译固定 MinIO 源码时，`sum.golang.org` 校验依赖返回 HTTP/2 `INTERNAL_ERROR`；尚未进入业务断言。优先缓存 BuildKit 层/Go 模块，或预构建同一固定源码版本的可信镜像并按 digest 使用，不把网络失败当作删除 smoke 的理由。

新增确认：旧 `run-realtime-websocket-smoke.mjs:50` 引用的 `frontend/e2e/realtime-websocket-deployment.spec.mjs` 和 `frontend/playwright.deployment.config.mjs` 均不存在。真实后端 WebSocket 路由仍在 `backend/app/api/ai_audio.py:388`。现有 `test_nginx_security.py:131` 只是断言旧脚本文本包含几个片段，不能证明浏览器/代理握手经过验证。

建议恢复最小可执行代理 WebSocket 测试，或在明确功能退役后一起删除旧入口并改名；当前不能宣称 WebSocket smoke 已通过。旧脚本还有 upstream failure 后 error log 不泄露 capability 的验证意图，恢复时应把该断言迁入可运行路径。

### 23. Backend Model Usage Tests 汇总：合并到 PR Gate

它实际上汇总四个 MySQL suite，包括 family settings 与 AI resume，名称比职责窄。可直接由 PR Gate 检查矩阵结果；若暂时保留至少更名以免误解。

同步替换 `test_ci_model_usage_gate.py` 中对 Job 名、shell 文本及 `needs` 原文的断言，改为验证“选中的全部矩阵项成功才放行”的语义。

### 24. PR Gate 与报告发布：保持可验证的完成状态

保留唯一 required check。当前 selected gate 必须 success、classifier 必须 success；本次正确报告 deployment failure。

未来支持“全量测试已覆盖 contract”“typecheck 由 build 执行”“矩阵按域筛选”时，应显式记录由哪个 Job 满足要求。未运行、取消、产物缺失不得借由 success/skipped 宽松处理混过去。

`Publish Playwright Report` 不加入 required check，也不新增测试。E2E 未被选中时可直接发布简短状态或跳过下载流程；无本次确证的主要性能瓶颈，不优先改造。

## 3. 必须补入真实数据库执行的现有测试

| 文件（均相对 backend/） | 用例数 | 当前缺失的保障 |
| --- | --- | --- |
| `tests/account/test_auth_mysql_concurrency.py` | 2 | 改密码/旧密码登录与会话撤销竞争 |
| `tests/activity/test_activity_highlights_mysql.py` | 1 | 上海周边界与 MySQL 日期语义 |
| `tests/inventory/test_inventory_mysql_concurrency.py` | 24 | 库存、购物入库、做菜完成、计划/菜谱删除、幂等和锁顺序；其中含 1 条测试库 URL 校验 |
| `tests/meal_logs/test_meal_log_mysql_concurrency.py` | 3 | 同请求收敛、追加/复用与撤销竞争 |
| `tests/ai_infra/test_ai_revert_mysql_concurrency.py` | 1 | 全局撤销 request ID 的唯一赢家与干净失败者 |
| `tests/ai_infra/test_run_execution_mysql.py` | 5 | worker claim、reaper、stale snapshot、checkpoint/heartbeat 锁 |
| **合计** | **36** | 普通 Job 中 skip；四组 MySQL 矩阵未覆盖 |

安全实现方向：服务端业务并发组与 AI 并发组分别提供临时数据库；按 marker/测试组定义环境要求并校验收集完整性。CI 选中 MySQL 组却缺少 URL 时应失败；开发机显式没有数据库时允许 skip，但结果必须清楚。多个并行 worker 不得共享会执行 drop/create 的同一个数据库。

## 4. 用例精简清单：删实现锁定，保留业务合同

静态统计：303 个前端源码测试文件中，65 个使用 `readFileSync`；按真实 TypeScript import 声明初筛，40 个未导入业务运行时实现，25 个混合了运行时导入。这个分类只用于确定审阅顺序，不能据此批量删文件。

| 候选 | 已看到的问题 | 处理方式 | 必须保留/补足 |
| --- | --- | --- | --- |
| `frontend/src/app/appHomeDashboardDialogProps.test.ts` | 只断言 hook 名、export 原文及字段文本 | 优先精简 | TypeScript contract、真正的弹层事件/参数结果 |
| `appEatTaskBodyArgs.test.ts`、`appEatTaskResolutionArgs.test.ts`、`appInventoryMaintenanceDialogProps.test.ts`、`appOverlayComposition.test.ts`（位于 frontend/src/app） | 主要锁定拆分后的命名与接线位置 | 收敛少量架构规则，移除逐文件字符串镜像 | adapters 的实际输入输出和状态语义 |
| `frontend/src/components/foods/FoodWorkspace*Overlay*Usage.test.ts`（5 个文件） | 只要求委托到某个固定组件 | 精简接线原文断言 | 打开/关闭/提交 overlay 的真实行为 |
| `frontend/src/components/foods/FoodWorkspaceUsage.test.ts` | 混合函数名、JSX 原文、文案和 CSS | 拆分架构与业务；只删除重复实现断言 | 跨工作区导航、收藏版本、记录行为 |
| `frontend/src/components/ingredients/IngredientWorkspaceUsage.test.ts:343` | 断言注释 `// Only resolve bound targets by stable IDs` 存在 | 删除注释断言；用实际输入输出覆盖其意图 | 同名不同 ID 不自动绑定、free_text 不误绑 |
| `IngredientWorkspaceSearchUsage.test.ts`、`IngredientFoodStockDialogsUsage.test.ts` 等 ingredients Usage 文件 | 固定 hook/组件位置 | 先收敛规则再删冗余 | 请求条件、状态清理、弹层实际行为 |
| 各 `*LegacyStylesUsage.test.ts` | 大量旧 class 不存在、CSS 归属、源码块样式断言 | 将仍有效的归属规则集中到 CSS governance；删除已退役实现的重复断言 | 真正的滚动、溢出、触控和弹层覆盖，由浏览器验证 |
| `frontend/src/lib/aiWorkspaceContracts.test.ts` | 依赖源码正则，但验证跨端枚举与 renderer | **保留**；可逐步降低格式耦合 | backend/frontend/renderer 集合一致 |
| `FoodWorkspace.test.ts`、`HomeDashboard.test.tsx`、`InventoryActionDialog.test.tsx` 等混合文件 | 少量源码断言夹在大量行为测试中 | **不能整文件删除** | busy/失败草稿保留/权限/提交 payload/用户交互 |
| `backend/tests/core/test_quality_gates_workflow.py` | 断言 `cache: pip` 出现次数、恰好两片、固定 shell 原文 | 改为解析工作流并验证实际依赖和失败传播 | 分组完整、选中测试不会静默 skip |
| `backend/tests/family_model_settings/test_ci_mysql_gate.py`、`model_usage/test_ci_model_usage_gate.py` | YAML 文本包含某些名字就通过 | 合并为少量结构/行为契约 | MySQL 环境、命令所覆盖的组、矩阵失败阻断 |
| `backend/tests/core/test_ci_test_groups.py` | 完整性检查有效，但固定 17 个目录增加维护噪音 | 保留动态发现/漏项/重复/未知拒绝；评估去掉硬编码总数 | 新测试目录必须归组 |
| `backend/tests/ai_evals/test_eval_dataset.py` | 精确 48 个 case/类别数量与新增用例耦合 | 用覆盖 ID/类别约束或显式版本清单表达 | 必需安全边界、ID 唯一、真实注册表引用 |
| `backend/tests/deployment/test_nginx_security.py:131` | 检查不可运行旧 smoke 的文本片段 | 用可执行 smoke 覆盖后精简 | 代理握手与错误日志敏感查询不泄露 |

不删除清单：家庭隔离、非 Owner 拒绝、真实事务 rollback、唯一约束、同键重放/冲突、stale version、真实并发锁、用户原图保护、AI 正式写入门禁、跨端 schema、已有数据 migration、浏览器关键路径。

## 5. 可执行优化任务与验收

以下优先级表示实施顺序；P1 是已证实的关键门禁缺口，P2 是可靠性/效率优化，P3 为维护收敛。勾选表示实现及本地主要验收完成；仍需外部环境确认的部分在第 7 节单列，不代表 GitHub Actions 已通过。

- [x] **C01 / P1：补齐 MySQL 执行与 skip 审计。** 收录第 3 节 36 条测试，保留原 resume 4 条；添加按环境要求的收集完整性检查。验收：main 和对应风险 PR 均真实执行这些测试；选中数据库组但缺少环境必失败；reference-host 等预期 skip 单列。
- [x] **C02 / P1：修复后端分类。** 运行时 Markdown 先于普通文档识别；AI Tool/repo/schema、共享 DB/事务、数据库并发目录按风险选门禁。验收：第 01 节表内每个路径有回归断言；Skill 文本选 AI/eval，schema 选跨端 contract，共享事务不只跑 migration，AI repo 不只跑 service。
- [x] **C03 / P1：分类结果只累加，不被 CSS 清空。** 累积文件级需求后统一计算 focus/full 互斥。验收：组件+CSS、model+CSS 的任意输入顺序都保留域测试；仅 CSS 不误开空范围 Vitest；unknown/full 行为不退化。
- [x] **C04 / P2：恢复可执行 WebSocket 部署验证。** 补齐当前路由适用的浏览器或客户端 smoke、代理断言和真实 CI 入口；迁移旧脚本中的 error-log 隐私断言。验收：真实 nginx 代理握手与消息往返成功，破坏 Upgrade 配置时测试失败；所有命令引用文件存在；Job 名与内容一致。
- [x] **C05 / P2：依赖审计独立执行并准确汇总。** 两端都运行，区分漏洞、服务不可用与成功；外部失败最多一次有限重试。验收：前端失败仍有后端结果；503 不变成绿色“通过”；两端正常才通过。
- [x] **C06 / P2：Vitest 与 Governance 共用一轮测试。** shard 生成可合并原始 coverage/test results，report Job 合并并供 Governance 使用；全量时复用 AI contract。验收：同一全量 workflow 每条普通 Vitest 用例仅执行一次；合并后 baseline 仍为 323 文件/2,225 用例（若代码未变）；覆盖率按文件/语句合并而非平均；任一 shard/产物失败阻断。
- [x] **C07 / P2：减少 model-usage-core 重复建库。** 先对最慢 fixtures 分解 DDL/种子/测试耗时，再复用 schema、清理数据，migration 隔离。验收：原并发/提交/rollback 断言不删；单独与整组执行结果一致；同环境至少 3 次前后对比，报告 setup 时间与总时长，不仅一次最优值。
- [x] **C08 / P2：按风险选择 MySQL 子组。** 将单个 backend_mysql 开关演进为粗粒度 suite 集合，并补齐业务/AI 并发组；共享配置、price/usage/search 耦合与 schema 变化仍扩大范围。验收：普通局部变更不无条件启动全部四组；共享边界变化不漏依赖；main 全量覆盖清单；不维护源码到单测试的映射表。
- [x] **C09 / P2：稳定 MinIO 构建准备。** 缓存固定版本 Go/BuildKit 产物，或单独构建并复用固定 digest 镜像。验收：冷/热缓存均可启动 smoke；缓存失效由源码/工具链版本决定；媒体权限失败仍阻断；网络错误与业务断言失败可区分。
- [x] **C10 / P2：前端类型检查与构建产物复用。** 保留本地完整命令，CI 拆分 typecheck/build/report；同 SHA、相同参数复用 dist/manifest。验收：全量只做一次 tsc；E2E 真正使用该 SHA 的 dist；target/ratchet 两类预算都执行；测量 artifact 和依赖等待成本后再决定哪些构建值得共享。
- [x] **C11 / P3：PR Gate 直接汇总矩阵。** 删除两个只转发结果的中间汇总 Job，并同步结构测试与结果映射。验收：分片/矩阵失败、取消、意外跳过、classifier 失败均阻断；未选择的组允许跳过；required check 保持 PR Gate。
- [x] **C12 / P3：AI 场景定位与数据集约束收敛。** 让 48 个 scripted 场景按 case ID 可单独定位/执行，保留完整报告和阈值；清理无业务意义的精确数量断言。验收：单场景失败可定位；缺场景/报告不完整不通过；评测不访问真实 provider；参数化不造成 fixture 成本失控。
- [x] **C13 / P3：前端源码/样式断言分批精简。** 先处理第 4 节纯接线/注释案例；混合文件逐条拆分；必要规则集中维护。纯 Node 测试可使用 Node 环境，避免全局 JSDOM/setup 开销。验收：正常 rename/格式/注释调整不要求改业务测试；刻意破坏对应行为时仍有测试失败；不丢跨端 contract；更新样式 gate 文档并保留视觉人工审阅要求。
- [x] **C14 / P3：测试报告统一。** pytest/Vitest 保留 JUnit 或等价机器报告、slow durations、skip 原因，附到 Job Summary/artifact。验收：能区分“被选中/收集/执行/预期跳过/环境缺失”；无需从长日志人工推算。

建议实施顺序：C01–C03 → C04–C05 → C06–C09 → C10–C14。每批独立验证，不能用“顺手精简”混入业务规则改动。C06 与 C10 的 PR Gate 结果映射设计应一起校准；C11 在新的矩阵/覆盖复用语义稳定后实施。

收益边界：C06 可以消除一次完整重复执行，但本次瓶颈在 MySQL core，不能直接承诺整条 CI 缩短 218 秒。C07 应以同环境测量为依据。C11 主要减少结构和名称维护成本。

## 6. 初始只读审计的验证记录（历史）

已执行（以下每条命令均从仓库根目录独立启动）：

```bash
node --test .github/scripts/classify-pr-gates.test.mjs
npm run backend:test:ci-groups
cd backend && .venv/bin/python -m pytest --collect-only -q tests
cd backend && .venv/bin/python -m pytest -q \
  tests/core/test_ci_test_groups.py \
  tests/core/test_quality_gates_workflow.py \
  tests/core/test_migration_smoke.py \
  tests/family_model_settings/test_ci_mysql_gate.py \
  tests/model_usage/test_ci_model_usage_gate.py \
  tests/ai_evals/test_eval_dataset.py
npm --prefix frontend test -- \
  scripts/style-token-drift.test.mjs \
  scripts/coverage-topology-report.test.mjs \
  scripts/check-frontend-governance.test.mjs \
  scripts/p0-api-mocks-boundary.test.mjs \
  src/lib/aiWorkspaceContracts.test.ts \
  src/app/appHomeDashboardDialogProps.test.ts
node --test deploy/tests/media-permission-smoke-utils.test.mjs
npm --prefix frontend run check:style-tokens
```

结果：分类/汇总相关 Node 测试 17 通过；后端目录分组检查通过；后端收集 3,122；定向 pytest 27 通过；定向 Vitest 6 文件/18 条通过；媒体 smoke 工具测试 4 通过；样式基线检查通过（36 文件、50 命中，仅审阅报告，不是视觉验收）。

还执行了分类器单路径/组合输入复现，以及下述明确禁用 MySQL 的检查，以验证 skip 原因而非数据库正确性：

```bash
cd backend && env -u CULINA_TEST_MYSQL_URL .venv/bin/python -m pytest -q -rs \
  tests/account/test_auth_mysql_concurrency.py \
  tests/activity/test_activity_highlights_mysql.py \
  tests/inventory/test_inventory_mysql_concurrency.py \
  tests/meal_logs/test_meal_log_mysql_concurrency.py \
  tests/ai_infra/test_ai_revert_mysql_concurrency.py \
  tests/ai_infra/test_run_execution_mysql.py
```

结果：36 条全部因缺少 `CULINA_TEST_MYSQL_URL` 跳过，与 workflow 和 CI 日志相符。

只读外部核对：通过 `gh api` 读取上述两个 run 的 Job 元数据、截图运行各 Job 日志及 main Ruleset。未重跑 GitHub Actions、未提交/推送、未修改 Ruleset。

初始只读审计阶段未执行全量业务、真实数据库、构建或部署验证。后续实施阶段已补充的验证如下；上面的历史记录不作为优化后验收结果。

文档交付检查：人工核对路径、任务与证据对应关系，并执行 `git diff --check`。


## 7. 实施结果与验收记录

### 7.1 逐项落地

| 任务 | 已实施调整 | 本地验收与后续边界 |
| --- | --- | --- |
| C01 | 新增 `mysql` / `mysql_reporting` marker、MySQL suite 清单及严格 skip 审计；被其他模块导入的数据库 fixture 会传播环境要求；普通 Service/AI Job 明确排除数据库用例 | 实际 collect 分区核对：3,170 条全部恰好分配一次，无遗漏/重复；缺 URL、非 MySQL、非测试库、意外 skip 都失败。两个 reference-host skip 单列 |
| C02 | 运行时 Skill Markdown、AI Tool/repo/schema/eval、共享事务/模型等按实际风险选择门禁 | 对原复现路径补回归，Node 分类/runner/汇总/审计相关测试通过；未知、main、full-gates 继续扩大验证 |
| C03 | 样式变更保留已有域测试需求，统一决定 focus/full 互斥 | 组件/模型与 CSS 两种输入顺序、纯 CSS 与跨域均通过回归 |
| C04 | 恢复 Playwright 部署配置和 WebSocket 浏览器测试；动态端口、唯一 Compose 项目、退出码及日志读取失败处理；增加临时破坏 Upgrade 的验证入口 | 标准后端/前端镜像的 nginx 浏览器测试 2 条通过；去掉 Upgrade 后按预期失败；upstream 故障后的 capability 日志检查通过。详见 7.6；不调用真实模型 |
| C05 | 前后端审计独立执行，区分漏洞/不可用/通过；不可用只重试一次；校验 JSON 结构，保留原始结果与耗时 | 真实联网审计前后端均通过，各一次请求；故障注入覆盖前端漏洞不阻止后端、503 不能变绿、异常 JSON 不能通过 |
| C06 | Vitest shard 同次执行采集 blob/coverage；Governance 原生合并 coverage map，不再重跑全量；全量时复用 AI contract | 两片合计 313 文件、2,212 用例全通过，合并成功；语句分母仍为 76,125，没有把两个分片分母相加；缺片/重片/空报告/失败报告拒绝 |
| C07 | reservation fixture 独立随机测试库、session schema、逐用例清理已提交数据；migration 保持隔离，真实多连接 commit 不变 | 五条代表性测试同环境前后各三次均通过；总耗时中位数约降 43%，setup 约降 41%；usage-core 整组通过，见 7.3 |
| C08 | MySQL 动态选择五个粗粒度 suite；普通业务只选 service；AI、配置、usage、search、共享边界适当扩大 | 分区、分类回归及真实五组执行通过；不维护源文件到单测试的映射表 |
| C09 | 固定 Go 工具链/MinIO commit，Go module/build cache mount；可配置 GOPROXY 并保留 checksum 校验；Buildx GHA 层缓存；同 SHA 镜像在两个 smoke 复用；License 与产物一起从 cache mount 复制到 `/out` | 基础镜像预拉取、模块镜像可达后，标准 Dockerfile 冷构建 70.00 秒、热构建 0.79 秒通过；使用新编译镜像的真实媒体权限 smoke 通过，见 7.6。初始下载和模块源失败单独保留 |
| C10 | Build 执行一次类型检查和 target 预算；E2E/Governance 下载同一 dist/manifest；helper PR 保留独立 typecheck；本地完整 build 入口保留 | typecheck、build:ci、target/ratchet、复用 dist 的 18 个 P0 测试通过；本地打包成本已测，GitHub 上传/下载和依赖等待需首次实际 CI 后观察 |
| C11 | 删除 Vitest、MySQL 两个纯转发汇总 Job，PR Gate 直接等待矩阵；校验所有分类值并映射复用结果 | 逐 gate 的 failed/cancelled/missing/skipped 和 classifier failure 均有拒绝回归；workflow 结构测试、actionlint 通过 |
| C12 | 48 个 scripted 场景按 ID 参数化，每 case 隔离上下文，session 结束聚合报告；数量断言换为必要 ID、类别、唯一性及注册表引用 | 79 条 pytest 通过，48 场景完整报告通过全部阈值；单场景可执行，单场景报告被完整性门禁拒绝 |
| C13 | 删除 12 个纯接线源码镜像文件；移除重复退役 CSS/注释断言；补 free_text、同名不同 ID、缺失 ID、overlay 状态和版本行为；纯 Node 测试切换环境 | 全量 Vitest 与 P0 通过；故意将 ID 查找改成同名查找时新测试失败，恢复后通过。保留跨端 contract、混合文件的业务断言及当前样式规则 |
| C14 | pytest 逐组保留 JUnit、JSON 选中/执行/skip/耗时；Vitest blob、合并 JSON、slow files；CI 上传 artifact 与 Summary | 实际报告能区分收集、选中、排除、执行、预期 skip；环境启动失败单独记录，不记录数据库 URL |

实际调整的源码环境标记分为纯 Node 脚本/字符串检查与确有 DOM 需要的行为测试；没有全局开启文件并行，也没有增加分片或降低 reporting 数据规模。

### 7.2 补跑暴露的问题

1. 初始审计的 36 条漏跑之外，严格 skip 核对又发现 AI 自动执行 migration 的两条真实 MySQL 用例。该模块另两条结构检查一并放入 AI 数据库组，避免按文件名遗漏。现在 service-concurrency 为 31 条（含新增回归），ai-concurrency 为 14 条（含原 resume 4 条及模块内结构检查）。
2. Activity fixture 缺少自建表，Inventory fixture 以内存微秒时间充当 MySQL 持久化版本；已修复 fixture 建表和 commit 后 refresh，没有弱化业务断言。
3. 补跑发现真实业务缺陷：MySQL REPEATABLE READ 的旧快照可在锁定菜谱后漏看刚提交的餐食/计划历史。`recipe_deletion.py` 改用当前锁定读，并添加确定性回归；原并发/历史保护断言保留，Service MySQL 31 条全部通过。
4. AI lease 测试等待 Python deadline，但 MySQL DATETIME 可能舍入。改为 commit、refresh 后等待实际持久化 deadline，保留 reaper/worker 竞争断言。
5. AI migration 往返测试原回退到家庭配置 revision，误跨过无关 auth migration；改为 AI migration 的真实前驱 `7b8c9d0e1f2a`，保留 AI 状态、回填及重放断言。
6. CORS、production credential 与安全时间测试受开发机 `.env`/TTL 影响；测试构造 Settings 时禁用隐式 env 文件，时间用例显式设置 TTL 并清理缓存。

额外记录一个未在本次范围内修复的问题：旧 auth migration `7b8c9d0e1f2a_add_auth_sessions.py` 在 MySQL downgrade 时删除仍被外键需要的索引，会触发错误 1553。本次没有修改旧 migration；AI 往返通过不代表这条 auth downgrade 已修复。

### 7.3 后端分组与性能证据

本地使用独立 Docker MySQL 8.4、可丢弃 `_test` 数据库。按最终 CI 分区实际执行，合计选中 3,170 条：**3,168 通过，2 条 reference-host 预期跳过，0 条意外跳过**。不同组分时运行，下表是各自本地耗时，不能相加推算 CI 并发墙钟。

| 执行组 | 通过 | 预期跳过 | 本地秒数 |
| --- | ---: | ---: | ---: |
| service --local-only | 614 | 0 | 119.34 |
| ai --local-only | 1,309 | 0 | 106.28 |
| service-concurrency | 31 | 0 | 82.90 |
| ai-concurrency | 14 | 0 | 67.92 |
| family-model-settings | 386 | 0 | 100.63 |
| model-usage-core | 502 | 2 | 57.13 |
| model-usage-reporting | 8 | 0 | 40.98 |
| search | 225 | 0 | 8.41 |
| ai_evals | 79 | 0 | 13.57 |

Reporting 保留 100,000 event、EXPLAIN、索引/扫描与 rollup 并发断言。独立 Alembic smoke 在空 MySQL 库完成单 head 检查及两次 upgrade，最终 revision `c5d6e7f8a9b0`。

C07 前后对照为相同五条测试：reservation 三条并发用例，以及 transaction isolation 两条事务边界用例；同一个本地 MySQL 8.4/硬件环境各执行三次。

| 指标（秒） | 优化前 1/2/3 | 优化后 1/2/3 | 中位变化 |
| --- | --- | --- | --- |
| 总耗时 | 15.075 / 12.216 / 12.399 | 6.455 / 7.020 / 8.273 | 12.399 → 7.020，约 -43% |
| setup 合计 | 10.73 / 9.09 / 9.18 | 4.71 / 5.41 / 6.49 | 9.18 → 5.41，约 -41% |

本地原始证据：`backend/.artifacts/pytest/usage-{before,after}-{1,2,3}.{xml,log}`。不把这个样本的改善外推为整组或整条 CI 的同幅收益。

### 7.4 前端与产物复用证据

- 两片实际各 157/156 文件、1,002/1,210 用例，138.68/133.36 秒；合并 313 文件、2,212 用例全部通过，0 skip。相对审计基线删去 12 个纯接线文件、新增一个行为测试文件和一个 CI 脚本测试文件，因此数量变化不是漏片。
- 合并 coverage：Statements/Lines `55,911 / 76,125 = 73.44%`；Branches `15,356 / 19,621 = 78.26%`；Functions `2,828 / 4,121 = 68.62%`。这是合并后的真实覆盖情况，不要求百分比为了精简而上升。
- topology、health、target 预算、以基线源码构建 manifest 的 ratchet/base 比较均通过；App/部分组合文件仍有覆盖缺口，报告继续保留。
- P0 18 通过，36.2 秒，复用当前 dist，视口 375×812、1180×820、1440×960；API mock 的边界保持不变。
- 样式检查通过：36 CSS 文件、50 个既有基线命中；没有改产品 CSS。本次是浏览器自动断言验证，不把样式检查描述为人工视觉验收。
- 本地 gzip 产物打包/解包各三次：build 5,943,160 bytes，打包中位 0.1963 秒、解包 0.0489 秒；Vitest blob 4,006,740 bytes，打包中位 1.4287 秒、解包 0.0640 秒。这是本地文件系统测量，GitHub artifact 网络传输、排队和 Job 等待尚未实测。

### 7.5 实际执行的主要命令

数据库 URL 使用本任务的可丢弃本地库，未使用用户业务数据库。下列环境变量在执行时显式提供；报告和提交内容不保存 URL 或凭据。

```bash
node --test .github/scripts/*.test.mjs deploy/tests/media-permission-smoke-utils.test.mjs
npm run backend:test:ci-groups
cd backend && .venv/bin/python -m pytest -q tests/core/test_ci_database_selection.py tests/core/test_ci_test_groups.py tests/core/test_quality_gates_workflow.py tests/core/test_migration_smoke.py
npm run backend:typecheck
npm run backend:test:service -- --local-only -q --durations=10 --junitxml=.artifacts/pytest/service.xml --ci-selection-report=.artifacts/pytest/service.json
npm run backend:test:ai -- --local-only -q --durations=10 --junitxml=.artifacts/pytest/ai.xml --ci-selection-report=.artifacts/pytest/ai.json
npm run backend:test:search -- -q --ci-strict-skips --junitxml=.artifacts/pytest/search.xml --ci-selection-report=.artifacts/pytest/search.json
```

五个 MySQL suite 分别执行下式，suite 为 `service-concurrency`、`ai-concurrency`、`family-model-settings`、`model-usage-core`、`model-usage-reporting`；不同独立执行组不并行使用会互相重建的同一测试库。

```bash
cd backend && .venv/bin/python scripts/run_ci_test_group.py --mysql-suite=<suite> -q --durations=10 -rs --junitxml=.artifacts/pytest/<suite>.xml --ci-selection-report=.artifacts/pytest/<suite>.json
npm run backend:test:ai-evals -- -q --durations=10 --junitxml=.artifacts/pytest/ai-evals.xml --ci-selection-report=.artifacts/pytest/ai-evals.json
npm run backend:check:ai-evals
npm run backend:migrate:smoke
npm run audit:prod
VITEST_SHARD=1/2 npm --prefix frontend run test:ci:shard
VITEST_SHARD=2/2 npm --prefix frontend run test:ci:shard
VITEST_SHARD_COUNT=2 npm --prefix frontend run test:ci:merge
npm run frontend:typecheck
npm --prefix frontend run build:ci
node frontend/scripts/coverage-topology-report.mjs
npm --prefix frontend run health:report -- --format json --output ../.artifacts/frontend-health.json
npm --prefix frontend run check:governance -- --mode=ratchet --require-base --base-commit=8772c4f752ca558617fdae668f2cd5292563b7eb --base-manifest=../.artifacts/bundle-base-source/frontend/dist/.vite/frontend-health-manifest.json --health=../.artifacts/frontend-health.json --manifest=dist/.vite/frontend-health-manifest.json --coverage=../.artifacts/frontend-coverage-topology.json --result=../.artifacts/frontend-governance-result.json
npm --prefix frontend run check:style-tokens
npm run frontend:e2e:p0
.artifacts/actionlint -ignore 'SC[0-9]+' .github/workflows/quality-gates.yml
git diff --check
```

额外定向验证：AI 单场景 `-k` 执行并确认不完整报告退出 1；购物表单行为故障注入后恢复；最终 CI 分区 collect-only 比对；五条 MySQL 测试前后各三次；本地 artifact 打包/解包测量。Node 共 31 通过，CI 控制定向 pytest 21 通过。

### 7.6 部署构建与剩余验证

真实部署 smoke 已通过：

- WebSocket：浏览器经当前 nginx 配置完成握手、音频消息往返与 subprotocol 协商；无票据连接拒绝，2 条通过（3.6 秒）。在临时容器中删除 Upgrade 配置，握手测试按预期失败；整体验证脚本退出 0，证明测试能检出配置损坏。停止 upstream 后，502 路径及日志隐私检查通过。
- 媒体：真实 nginx/backend/MySQL 8.4/MinIO 链路完成上传、签名读取、未认证 401、跨家庭 404、匿名 MinIO 403、原始路径不可读取图片以及 capability 日志隐私断言，脚本退出 0。临时 Compose 项目及卷已清理。

上述首次 smoke 使用从本地已缓存运行镜像构建的 QA 后端，覆盖当前源码，所有 21 项固定直接依赖与当前 requirements 一致且 `pip check` 通过；前端使用标准 Dockerfile 的当前构建。QA MinIO 来自本地已缓存的同一官方 release/commit 二进制（Go 1.21.3），用于先核对部署业务断言；该轮结果不作为新 Dockerfile 的构建证据。最终改用当前三个标准 Dockerfile 产出的后端、前端、MinIO 镜像后，媒体权限 smoke 再次通过（退出 0），新 MinIO 的基础镜像/固定源码/Go 1.21.13/License 复制链路一并得到验证。

标准前端 Dockerfile 已构建成功。标准后端首次构建遭遇 pip `ResolutionImpossible`，同基础镜像的 pydantic-core 安装探测随后成功；唯一一次原命令重试已构建成功，没有调整依赖版本；标准后端镜像的 WebSocket 2 条（2.5 秒）和媒体权限 smoke 随后再次通过。MinIO 初次冷构建在 Go 基础镜像下载阶段等待 1,450.56 秒后人工终止，未计为业务失败或有效冷构建样本；从公共镜像源预拉取的 Go 镜像与原 Dockerfile 的 digest 完全一致（`sha256:2414035b086e3c42b99654c8b26e6f5b1b1598080d65fd03c7f499552ff4dc94`），预拉取后，默认 Go 模块源因 TCP 连接超时构建失败（32.43 秒）。因此补充 `GOPROXY` 构建参数，默认仍为官方源，可在需要时选可达镜像；未关闭默认 checksum 校验。使用 `GOPROXY=https://goproxy.cn` 后，标准 Dockerfile 冷构建 70.00 秒、热构建 0.79 秒均通过，最终运行时为 Go 1.21.13；冷热产物 image ID 相同。这里的“冷”指本次模块/编译缓存未命中、构建层强制重跑，基础镜像已经预拉取；不把省去的网络下载包装成代码优化收益。GHA 远端缓存的实际命中率和传输成本尚未在 GitHub 测量。

已执行的部署命令：

```bash
docker build --progress=plain -t culina-smoke-frontend:local -f frontend/Dockerfile --build-arg NPM_CONFIG_REGISTRY=https://registry.npmjs.org .
docker build --progress=plain -t culina-smoke-backend:local -f backend/Dockerfile --build-arg PIP_INDEX_URL=https://pypi.org/simple .
docker build --progress=plain --no-cache --build-arg GOPROXY=https://goproxy.cn -t culina-smoke-minio:local deploy/minio
docker build --progress=plain --build-arg GOPROXY=https://goproxy.cn -t culina-smoke-minio:local deploy/minio
CULINA_SMOKE_PREBUILT=1 CULINA_SMOKE_BACKEND_IMAGE=culina-smoke-backend-qa:local CULINA_SMOKE_FRONTEND_IMAGE=culina-smoke-frontend:local CULINA_WS_SMOKE_VERIFY_NEGATIVE=1 npm run deploy:smoke:websocket
CULINA_SMOKE_PREBUILT=1 CULINA_SMOKE_BACKEND_IMAGE=culina-smoke-backend-qa:local CULINA_SMOKE_FRONTEND_IMAGE=culina-smoke-frontend:local CULINA_SMOKE_MINIO_IMAGE=culina-smoke-minio-qa:local npm run deploy:smoke:media
CULINA_SMOKE_PREBUILT=1 npm run deploy:smoke:media
```

本地证据为 `.artifacts/websocket-smoke{,-standard}.log`、`.artifacts/media-permission-smoke{,-standard,-all-standard}.log`、`.artifacts/*-image*.log`、`.artifacts/minio-cold.log`、`.artifacts/minio-build-cold.log`、`.artifacts/minio-proxy-{cold,hot}.log` 与 `.artifacts/minio-proxy-cache-times.json`。本任务创建的独立 MySQL 容器已清理，未清理用户其他容器或已有镜像缓存。

本节记录截至本地验收结束时的证据，未修改 Ruleset。GitHub 上完整 workflow 的实际运行结果、artifact 网络耗时及新的 CI 墙钟时间需通过对应 PR 的线上验收确认；不使用旧 CI 时长冒充优化后收益。

首次 [PR #146 线上验收](https://github.com/novisfff/Culina/actions/runs/38690959761) 的业务测试、五组 MySQL、前端分片、Governance、P0、迁移及审计均通过；报告核对确认后端 3,170 条分区无遗漏/重复（3,168 通过、2 个 reference-host 预期跳过），前端 313 文件、2,212 条全通过。部署 smoke 在新 runner 上暴露两项准备缺失：`--pull never` 模式下没有 MySQL 8.4 镜像，以及未安装 Playwright Chromium；本地已有缓存使这两个缺口未被发现。已在部署 Job 显式安装 Chromium 及系统依赖、拉取 Compose 的 MySQL 服务镜像，再复用三个当前提交的应用镜像；PR Gate 正确阻止该次失败。最终线上验收以 PR 最新提交的结果为准。

### 7.7 PR 验收发现的餐食撤销并发缺陷

[第二轮线上验收](https://github.com/novisfff/Culina/actions/runs/38691649627) 的部署 smoke 已通过，但既有 `test_reuse_created_food_versus_revert_no_deadlock` 检出真实问题：复用食物的餐食请求已成功，撤销原记录时却从旧快照漏看新引用，将食物及刚提交的餐食条目级联删除。该缺陷原本存在，由补入 CI 的 MySQL 测试暴露，不是通过放宽断言处理。

`can_delete_record_created_food` 在已有 Food 父锁下，将餐食、计划、购物和媒体引用的存在性检查改为当前锁定读。新增 `test_revert_keeps_food_reused_after_its_snapshot`，固定“建立旧快照 → 另一请求成功复用食物 → 撤销原记录”的顺序，验证原记录被撤销、复用食物及新条目保留；旧实现稳定失败，修复后通过。餐食模块普通测试 120 通过，完整 Service MySQL 分组 32 条通过（77.84 秒，0 skip），编译检查和 `git diff --check` 通过。

新增这一条回归后，Service MySQL 分组为 32 条，后端完整分区应为 3,171 条；第 7.3 节的 3,170 条是这次补充前的本地验收快照。原始证据保存在 `.artifacts/pr-146-revert-{before,after}.log`，本地使用独立可丢弃 MySQL 测试库。

补充实际执行命令（MySQL URL 在命令环境中显式提供）：

```bash
cd backend && .venv/bin/python -m pytest -q tests/meal_logs/test_meal_log_mysql_concurrency.py::test_revert_keeps_food_reused_after_its_snapshot --require-mysql --ci-strict-skips
cd backend && .venv/bin/python -m pytest -q tests/meal_logs -m 'not mysql'
cd backend && .venv/bin/python scripts/run_ci_test_group.py --mysql-suite=service-concurrency -q --durations=10 -rs --junitxml=.artifacts/pytest/pr-146-service.xml --ci-selection-report=.artifacts/pytest/pr-146-service.json
npm run backend:typecheck
git diff --check
```

## 8. Playwright P0 后续优化

本轮按用户授权优化浏览器测试，未改业务实现或后端策略。

| 项目 | 落地结果 |
| --- | --- |
| 记餐闭环 | mock 按浏览器 context 保存新记录；断言准确食物、餐次、单次 POST、列表更新和刷新后唯一记录。 |
| 登录恢复 | 在刷新前监听 refresh 响应，明确断言 200，并保留 Cookie、localStorage 与首页检查。 |
| Member AI | 从旧入口不存在改为读取会话、实际撤销自己的结果、原卡更新与焦点保持；禁止请求 Owner 配置。 |
| AI 重复断言 | P0 保留撤销、恢复与过期流程；七种文案枚举由组件测试承担，删除单按钮排列的无效循环。 |
| 模型设置 | 核心保留 Escape、自动保存真实 payload、测试和切页恢复；输入边界复用组件测试。 |
| 平板 | 核心项目从 1180×820 改为 768×1024，覆盖真实平板 CSS；替换两平台的三张基线。 |
| 响应式专项 | 独立 `e2e:responsive` 命令，六种尺寸各自建 context；默认 CI 不执行该按需专项。 |
| mock 严格性 | 模型配置未知接口进入统一未处理请求清单；AI 共用该清单；HTTP 错误和 console 不再宽泛忽略。 |
| 精简 | 移除无调用场景的用量、配置冲突、搜索重建等 mock 分支；AI fixture 移出 spec；成功截图改为显式启用。 |

核心 P0 为 5 场景 × 3 视口，共 15 项；响应式专项为 6 项。零重试、失败 trace/截图/视频和核心视觉对比继续保留。新餐食可读与未知设置接口登记的两条回归先在旧 mock 上失败，修复后通过，且另校验 context 间数据不泄漏。

本地实际执行：

```bash
npm --prefix frontend test -- scripts/p0-api-mocks-boundary.test.mjs src/features/family-model-settings/ModelAudioOptions.test.tsx src/features/family-model-settings/ModelIntegerField.test.tsx src/features/family-model-settings/FamilyModelSettingsWorkspace.test.tsx src/components/ai/AiResultCards.test.tsx
npm run frontend:build
npm --prefix frontend run e2e:p0 -- --update-snapshots=missing
npm --prefix frontend run e2e:p0 -- --grep navigates --update-snapshots=none
npm --prefix frontend run e2e:p0 -- --update-snapshots=none
npm --prefix frontend run e2e:responsive
npm --prefix frontend run e2e:p0 -- --list --reporter=line
npm --prefix frontend run e2e:responsive -- --list --reporter=line
git diff --check
```

相关 Vitest 75 项通过，生产构建及预算通过。macOS 核心 P0 最终 15 项通过（16.6 秒）；响应式专项 6 项通过（6.0 秒）。首次生成三张新基线按 Playwright 规则报告缺失，同时发现食物选择器会在异步搜索完成前匹配“按名称新建”，已收紧为已有食物选项后验证通过。上述时间是本地本轮样本，不与 GHA 时间直接比较或作为受控性能提升百分比。

核心实测视口：375×812、768×1024、1440×960。专项实测视口：375×812、390×844、430×932、768×1024、1024×768、1440×900。人工检查新增平板登录、首页、记餐基线；未宣称测试覆盖真实后端写入、服务端 Member policy 或真实设备软键盘。

Linux 补充验证：使用官方 `mcr.microsoft.com/playwright:v1.60.0-noble` 的 ARM64 容器和独立、不含本地配置的构建副本，生成并人工检查三张 Linux 平板基线，再以 `--update-snapshots=none` 执行完整 P0：15 项通过（20.3 秒）。原有手机、桌面的两平台基线未改。容器已自动清理。AMD64 镜像下载约 9 分钟仍未完成，已停止该额外下载；本轮没有执行 GitHub AMD64 runner 的线上验收，也未推送更改。

```bash
docker run --rm --platform linux/arm64 --ipc=host -e CI=1 -v /Users/zyf/IdeaProjects/Culina/.artifacts/p0-optimization/linux:/work -w /work mcr.microsoft.com/playwright:v1.60.0-noble sh -c 'npm ci --no-audit --no-fund && npm run e2e:p0 -- --project=tablet-768x1024 --grep "signs in|navigates" --update-snapshots=missing'
docker run --rm --platform linux/arm64 --ipc=host -e CI=1 -v /Users/zyf/IdeaProjects/Culina/.artifacts/p0-optimization/linux:/work -w /work mcr.microsoft.com/playwright:v1.60.0-noble npm run e2e:p0 -- --update-snapshots=none
```

本轮 P0 日志保存在 `.artifacts/p0-optimization/macos-p0.log`、`.artifacts/p0-optimization/linux-baseline.log`、`.artifacts/p0-optimization/linux-arm-p0.log`；基线生成阶段的预期缺图失败不计为最终验收通过。

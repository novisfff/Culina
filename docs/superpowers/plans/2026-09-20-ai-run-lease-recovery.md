# AI Run Lease Recovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. 本任务按用户项目边界在当前会话就地执行，不创建 worktree、子代理、提交或 PR。

**Goal:** 自动回收失联 AI Run 并安全释放会话，不自动重发模型请求。

**Architecture:** 数据库独立租约表决定执行所有权；Session 与 checkpoint 写入受 fence 保护；定时回收器只投影持久化业务事实。显式重试沿用既有 Draft 恢复入口。

**Tech Stack:** FastAPI、SQLAlchemy 2、Alembic、MySQL、LangGraph、pytest。

**Spec:** `docs/superpowers/specs/2026-09-20-ai-run-lease-recovery-design.md`

## Global Constraints

- 默认租约 90 秒、心跳 15 秒、回收扫描 10 秒。
- 不自动重发模型，不执行恢复时的领域写入，不修改其他用户文件。
- 没有专用 MySQL 测试库时不能把 SQLite 测试当作并发验收。

### Task 1: Lease model and ownership primitives

Files: `backend/app/models/domain.py`, `backend/app/services/ai_operations/execution_lease.py`, `backend/alembic/versions/c5d6e7f8a9b0_add_ai_run_execution_leases.py`, `backend/tests/ai_infra/test_run_execution_lease.py`.

Interfaces: `claim_execution(db, family_id, run_id, resume_token=None) -> ExecutionLease`; `renew_execution(db, lease) -> bool`; `release_execution(db, lease) -> None`; `ExecutionFence(db, lease).install()/check()/remove()`.

- [x] 写唯一领取、过期拒绝、token 失效、跨家庭测试，执行以下命令观察缺失能力失败：
```bash
cd backend && .venv/bin/python -m pytest -q tests/ai_infra/test_run_execution_lease.py
```
- [x] 用 run_id 主键、锁后校验与 CAS 实现上述接口；迁移挂到 b4c5d6e7f8a9。
- [x] 补 SQLAlchemy flush/commit/DML 和行锁前 fence；测试旧拥有者写入整体回滚。

### Task 2: Conservative recovery and watchdog

Files: `backend/app/services/ai_operations/run_recovery.py`, `backend/app/services/ai_operations/execution_worker.py`, `backend/app/main.py`, `backend/app/core/config.py`, `backend/tests/ai_infra/test_run_recovery.py`.

Interface: `recover_expired_runs(db, limit=50, family_id=None) -> int`; `RunRecoveryWorker.start()/stop()`.

- [x] 先测试 running/cancelling/待审批/待输入/已有 Operation/未知模型结果/历史无租约记录。
- [x] 在单事务中撤销拥有权并投影状态；从已有 Timeline 和 Operation 读取事实，绝不调 provider。
- [x] 挂接周期扫描与配置校验，测试健康租约和普通等待状态不受启动扫描影响。

### Task 3: Runner, checkpoint and provider integration

Files: `backend/app/ai/workflows/runner.py`, `backend/app/ai/workflows/checkpoint.py`, `backend/app/ai/workflows/runner_support/stream_bridge.py`, `backend/app/ai/workflows/runner_support/*resume_preparer.py`, `backend/app/ai/runtime/{execution_guard,openai_chat,openai_responses,dashscope_chat}.py`.

Interface: execution scope owns lease, heartbeat and fence; checkpoint saver receives the same immutable lease; provider dispatch runs a bound pre-send guard.

- [x] 增加同步/流式完整执行及失效后迟到回调测试。
- [x] 执行范围覆盖首次聊天、审批恢复、补充信息恢复，断开 SSE 不释放仍在执行的租约。
- [x] 图节点提交早于 checkpoint，异常先回滚；结束后停止心跳并按拥有者/token 释放。
- [x] Provider 前先提交已有合法事务，再记录发送边界；业务会话和 checkpoint 禁止过期写入。

### Task 4: Integration verification and documentation

- [x] 执行新测试与 workspace streaming/chat/approval/human input/cancellation/runtime failure/checkpoint 相关测试。
- [x] 补 MySQL 锁竞争测试并在有专用测试库时执行；否则记录跳过。
- [x] 执行 Alembic heads、迁移升降级测试、前端 AI 契约测试和 git diff --check。
- [x] 更新 AI 规范与部署说明，记录首次升级停止旧 worker 的要求、恢复时限和验证结果。


## 实施补充

- Provider 使用每次调用独立的 `ContextVar` guard，不修改可能共享的 Provider 对象；guard 覆盖 fallback 与实际发送边界。
- 独立错误收口 Session 继承执行身份；没有领取成功的 worker 不得调用错误持久化去覆盖其他拥有者。
- 未安全收口的异常保留租约直到回收；安全完成后才释放所有权。取消回收复用待交互取消逻辑，同时收口未回答的输入和待审批草稿。
- 内存 SQLite 的 StaticPool 只有一个物理连接，独立 checkpoint Session 的关闭会干扰其他 Session 的事务；增加事务级共享锁回归用例及隔离。该锁仅处理测试连接共享问题，不能替代 MySQL fencing/并发测试。
- 原 `test_family_llm_runtime` 用 `__new__` 跳过 Runner 初始化；改用真实 service/runner 构造，保留原 revision snapshot 断言。

## 实际验证命令

这次涉及 Run 所有执行入口、持久化迁移及并发隔离，因此定向回归后扩大到 AI 分类测试；没有执行全后端或全前端门禁。

```bash
cd backend
.venv/bin/python -m pytest -q tests/ai_infra tests/ai_runtime tests/ai_evals tests/model_usage/test_llm_provider_contract.py tests/model_usage/test_provider_send_inventory.py tests/core/test_migration_smoke.py --tb=short
.venv/bin/python -m alembic heads
.venv/bin/python -m alembic upgrade b4c5d6e7f8a9:head --sql
.venv/bin/python -m alembic downgrade c5d6e7f8a9b0:b4c5d6e7f8a9 --sql
```

```bash
npm --prefix frontend test -- src/components/ai/aiRunStateModel.test.ts src/components/ai/aiStateMatrix.test.ts src/hooks/aiRunCancellationState.test.ts src/components/ai/aiApprovalState.test.ts src/lib/aiWorkspaceContracts.test.ts
git diff --check
```

- 新增租约、回收、checkpoint、独立错误收口、共享连接事务等失败用例均先确认失败，再实现修复。
- 完整 API 回归覆盖原始路径：残留 running → 新消息 409 → cancelling → 扫描后 cancelled → 显式 retry 成功；另覆盖新消息解除阻塞和迟到旧 worker 不覆盖恢复/新 Run。
- 迁移 head 为 `c5d6e7f8a9b0`；新迁移 SQLite 升降级/索引/默认值测试已执行，MySQL 升降级 DDL 已离线生成检查。
- 前端五个 AI 状态/契约测试文件：19 项通过；无前端生产代码修改。
- MySQL 环境缺口：`CULINA_TEST_MYSQL_URL` 未配置，Docker daemon 不可连接。真实 InnoDB 锁竞争、跨 Session 心跳与图 checkpoint 验证用例已添加，但本地跳过；未对用户业务数据库执行迁移、未调用真实模型、未部署。
- 最终 AI 分类测试：1229 passed、12 skipped、268 subtests passed（79.40 秒）；skipped 不算并发通过。
- 收尾补充独立导入回归，随后重新执行租约/回收/API/迁移/family runtime 定向组：44 passed。
- `compileall` 和 `git diff --check` 通过。未提交、未创建新分支或 PR，用户原有 model-usage 前端改动保留。


收尾额外执行：

```bash
cd backend
.venv/bin/python -m compileall -q app
.venv/bin/python -m pytest -q tests/ai_infra/test_run_execution_lease.py tests/ai_infra/test_run_recovery.py tests/ai_infra/test_run_recovery_integration.py tests/ai_infra/test_run_execution_migration.py tests/ai_infra/test_family_llm_runtime.py --tb=short
.venv/bin/python -m pytest -q tests/ai_infra/test_run_execution_mysql.py tests/ai_infra/test_human_input_resume_mysql_concurrency.py -rs
```

最后一条命令明确跳过 9 项（5 项新租约竞争/心跳/checkpoint + 4 项既有恢复竞争），原因均为没有专用 MySQL URL。另曾尝试 `docker info --format '{{.ServerVersion}}'`，结果为 daemon 不可连接；未启动或改动用户数据库。

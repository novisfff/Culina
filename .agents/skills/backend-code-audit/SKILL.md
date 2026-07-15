---
name: backend-code-audit
description: Use when reviewing Culina backend diffs, pull requests, FastAPI routes, SQLAlchemy models or queries, Alembic migrations, services, repositories, serializers, permissions, media flows, AI runtime or approval changes, and backend test coverage for correctness and data-boundary risk.
---

# Culina 后端代码审计

## 审计边界

默认只读审计，不修改代码、数据库、migration、提交或 PR。用户明确要求修复后再进入实现。

输出使用简体中文、findings-first、按严重度排序。只报告有代码证据、可触发场景和实际影响的问题；不把通用建议、纯命名偏好或无法证明的猜测写成 finding。

涉及 AI workspace、Skill、Tool、Runtime、草稿、审批或 provider 时，必须读取 `docs/ai-assistant-standards.md`。涉及跨端响应和 UI 状态时同步检查前端类型、client、view model 与 contract 测试。

## 建立当前事实

先读取：

- `docs/backend-code-standards.md`。
- 用户指定范围、当前 diff 或 PR 最新 head；PR 更新后重新确认 head。
- 受影响 route、deps、schema、model、service、repo、serializer、migration 和测试。
- 事务辅助、权限依赖、枚举、活动日志及同业务域既有实现。
- 跨端变更对应的 `frontend/src/api/types.ts`、API client 和消费者。
- AI 变更对应的 Skill catalog、`skill.yaml`、tools、orchestrator、runner、approval service 和 `ai_infra` 测试。

先区分 diff 新增问题、既有问题和被本次改动放大的问题。既有缺陷只有直接影响本次变更时才报告，并明确它不是本 diff 首次引入。

## 审计流程

1. **锁定范围**：记录 base/head、指定文件或未提交改动，不混入无关工作区文件。
2. **追踪入口**：从 route 和依赖进入 schema、service/repo、事务、serializer 和测试。
3. **写出数据不变量**：当前用户、membership、`family_id`、对象归属、状态迁移和审计字段。
4. **还原写入时间线**：读取、锁定、复核、写入、commit、外部副作用、失败回滚和重放。
5. **检查跨端契约**：字段、枚举、日期、媒体 URL、单位、卡片、草稿和错误恢复结构。
6. **检查兼容与迁移**：已有数据、并行版本、部署顺序、Alembic head 和回滚风险。
7. **验证失败路径**：无权限、跨家庭、重复请求、并发冲突、stale version、子步骤失败和外部服务失败。
8. **形成 finding**：提供紧凑行号、触发步骤、证据、数据/用户影响和修复方向。

无法说明查询条件、事务顺序或运行状态如何触发时，先继续追踪，不把理论风险写成确定缺陷。

## 认证、权限与家庭隔离

- 身份必须来自 `get_current_auth`、`get_current_user`、`get_current_membership` 或 `require_owner`，不能信任请求体的 `family_id`、用户 ID、角色或审计字段。
- 所有家庭业务查询、更新、删除和批量操作先按当前 membership 的 `family_id` 过滤，再按对象 ID 查找。
- 子资源接口必须反查父对象/会话并执行同一家庭与所有权规则，不能只凭子资源 ID 访问。
- Owner 专属操作显式使用 Owner 检查；“当前用户属于家庭”不等于 Owner。
- 批量 ID、媒体 ID、草稿 ID、审批 ID 和关联对象全部校验属于同一家庭；不能只验证其中一个样本。
- 不存在与无权限的错误行为保持现有安全风格，避免通过状态差异枚举其他家庭资源。
- AI 主会话默认创建者私有；公开会话的继续对话、审批、取消公开和删除权限与稳定契约一致。

## SQLAlchemy 查询与数据访问

- 查询是否包含完整隔离条件、状态条件和必要排序；`Session.get()`、关系导航和批量语句是否绕过 family scope。
- update/delete 的 where 条件是否同时约束对象 ID 与 `family_id`；rowcount 是否被正确处理。
- repo 承担可复用数据访问，service 承担业务规则；route 和 serializer 不复制复杂查询或触发隐式业务流程。
- 关系加载、serializer 访问和循环查询是否造成 N+1、关闭 session 后懒加载失败或不同响应路径结果不一致。
- 金额、数量、单位换算和库存使用精确类型及统一 service，不把 Decimal 静默转成不安全浮点。
- 列表、搜索和统计的筛选、排序、分页与总数是否基于同一数据集合。

## 事务、并发与幂等

- 同一用户动作产生的多表变更位于同一事务，使用 `commit_session` 或当前事务辅助；任一子步骤失败整体 rollback。
- service 不在流程中途提前 commit，route 也不在多个 service 结果之间留下部分正式写入。
- 库存、审批、批量处理、导入和状态迁移先按 `family_id` 过滤目标，再按稳定全局顺序锁定；锁后重新读取并复核数量、状态、版本和归属。
- 不在 route 临时散落 `with_for_update()`；优先复用现有 locking service，检查锁顺序是否可能死锁。
- 幂等键/请求 ID 必须定义：同键同 payload 返回同一语义结果；同键不同 payload 返回结构化冲突；两者都不能二次写入。
- stale version、锁冲突和幂等键复用保留机器可读错误码与恢复方向，不静默重试或改写用户输入。
- 外部媒体、对象存储和 provider 调用与数据库事务的边界明确；失败时有补偿、清理、幂等恢复或可观测残留。
- 活动日志、`created_by`、`updated_by` 与业务写入一致提交，不出现主数据成功但日志/操作者缺失。

构造至少以下时间线：正常提交、同键重放、同键不同 payload、两个请求竞争同一目标、stale version、最后一步失败。

## Schema、模型、迁移与序列化

- 持久化字段、表、索引、约束或枚举存储变化必须新增 Alembic migration，不修改已合入旧 migration。
- migration 与 ORM model、Pydantic schema、serializer、API、测试和前端类型同步。
- 新非空字段有安全 server default/backfill/约束收紧顺序；已有数据不会因部署顺序或旧应用版本写入失败。
- MySQL 类型、索引长度、唯一约束、外键、级联和枚举变更与生产兼容；检查多个 Alembic head。
- migration 不依赖应用层随时可能变化的 model；数据迁移可重复判断、失败可定位。
- response_model/serializer 只输出稳定字段，不暴露 ORM 内部状态、关系加载副作用或数据库枚举实现。
- 日期、家庭本地时间、媒体 URL、单位和 Decimal 序列化复用现有 service/serializer 规则。
- optional、nullable、缺省、空列表和空字符串在请求、数据库和响应三层语义一致。

## 业务规则、活动日志与根因修复

- 菜谱/自做菜同步、库存扣减、单位换算、可做性、餐食记录等规则复用现有 service，不在新 route 重写近似逻辑。
- 用户可见新增、编辑、删除、邀请和切换维护审计字段并通过 activity service 记录“谁、何时、做了什么”。
- 状态迁移检查当前状态与允许边，不允许客户端直接跳到最终状态。
- bug 修复落在真实根因：权限、契约、状态机、事务、数据模型或调用链；不在末端增加静默吞错、后置修正或按异常字符串分支。
- 必要兜底具有具体、可测试、可观测的触发条件，不绕过认证、家庭隔离、审批、schema 或事务，并同时保留根因测试。

## 媒体与文件

- 上传前校验类型、大小和内容；对象 key、asset、variant 和绑定均包含当前 `family_id`。
- 读取、绑定、替换、批量操作和 AI 使用媒体时校验 asset 归属与目标实体归属。
- 复用 `backend/app/services/media.py` 与 `backend/app/repos/media.py`，不手写公共 URL 或绕过 MinIO 流程。
- 数据库失败、对象存储失败和 variant 生成失败不会留下跨家庭可见、永久孤儿或错误绑定。
- AI 生成图作为独立 media asset，不覆盖用户上传原图；删除与替换规则保留用户资产。
- SVG、图片解码和外部下载不引入脚本、路径、SSRF、超大文件或资源耗尽风险。

## AI Skill、Tool 与 Runtime

### 当前架构

- 默认路径是 `WorkspaceOrchestratorAgent` + scoped Skill injection + 同一 provider tool loop；不要重新引入 Planner、`ToolCallingSkill` 或单 active Skill 路径。
- `injected_skill_keys`、注入历史、Profile、tool budget 和 completion 状态在恢复后保持一致。
- 普通 assistant 文本和 provider tool call 是当前模型输出协议；不要恢复 `<visible_text>`、`<structured_result>` 等旧解析。

### Skill 与工具权限

- catalog Skill 的 `SKILL.md`、`skill.yaml`、references/workflows、scripts 和 registry 声明一致；routing、handoff、attachment 和 script_files 在加载期校验。
- 未注入 Skill 只获得基础 control 工具；注入后仅暴露其允许的 read/draft/control 能力。
- `write` 工具永远不暴露给模型；`allowed_tools`、tool side effect 和 `requires_confirmation` 三层一致。
- Script 只做隔离纯计算，不接收 DB session、家庭上下文、token 或 executor，不访问网络/文件系统或绕过 import 限制。
- `workspace.read_artifact` 只读取当前家庭和会话的完整 artifact；摘要索引不能被模型猜测补全为完整 payload。

### 草稿、审批与正式写入

- 正式写入固定经过 `draft tool -> draft capture -> AITaskDraft -> approval -> service commit`。
- 草稿必须来自 draft tool 的真实校验输出；模型文本、UI card 或未经 tool 验证的 payload 不能伪造正式草稿。
- `approval_policy: draft_then_confirm`、`draft_types`、draft tool 和 `requires_confirmation=True` 保持一致。
- 用户确认后由 `AIApplicationService` / `services/ai_operations` 写入，模型不参与 commit 决策。
- 拒绝、取消、过期、冲突和 partial success 持久化真实状态，不被最终 assistant 文本覆盖成成功。
- 审批失败/stale `baseUpdatedAt` 返回结构化 `currentValue` 与 `recoveryHint`，保留原始失败原因并要求重新确认。

### Typed continuation 与恢复

- continuation 只接受 schema 声明的 `workflowId`、`stepKey`、`reasonCode`、目标/恢复 Skill、draft type 和严格 state。
- 来源 Skill 的 handoff、Profile 允许目标、draft tool schema 与 `state_schemas.py` 完全一致；Markdown 不能扩展字段合同。
- 只有审批与业务 commit 都成功后生成 ready continuation；拒绝或冲突不得自动推进下一草稿。
- 同一 approval 重放时 artifact、业务实体、注入 key 和注入历史去重，保证 exactly-once resume。
- 恢复权限或预算失败时保留已经成功的业务 commit，标记 continuation failed，不重复写业务表。
- 旧 `afterApproval` 只读兼容历史数据；新 schema、provider payload 和持久化路径不得继续写入。

### 会话与运行

- 主 AI 会话默认创建者私有；公开后家庭成员权限与创建者取消公开/删除权限分离。
- message、run、approval、artifact、debug 和流接口都从子资源反查 conversation 并执行同一访问检查。
- 同一 conversation 只允许一个 active run；不同会话可并行，状态、SSE 和缓存不串线。
- cancellation、human input resume、approval resume 和重连不会重复消息、重复 draft 或错误完成 run。

## 测试审计

- 权限：未认证、非成员、跨家庭、非 Owner、公开/私有会话。
- 写入：正常、验证失败、任一子步骤失败、rollback、活动日志和审计字段。
- 并发：同键重放、同键不同 payload、锁冲突、stale version、稳定锁顺序。
- 迁移：已有数据、空表、重复运行判断、upgrade 后关键读写。
- 媒体：跨家庭绑定、对象存储失败、variant 失败、清理与用户原图保留。
- AI：tool scope、draft capture、审批拒绝/冲突、continuation exactly-once、会话权限、SSE/消息持久化和预算边界。
- serializer/contract：精确响应结构、日期、单位、media URL、错误码和前端消费者。

Mock 不能代替真正需要验证的数据库约束、事务回滚、权限依赖和 API response。测试通过只证明覆盖到的路径。

## 严重度

- `P0`：跨家庭数据泄露/误写、认证或 Owner 绕过、未经审批正式写入、不可恢复数据破坏、生产服务整体不可用。
- `P1`：主要 API 失败、事务/幂等不一致、破坏性迁移风险、schema/serializer 跨端漂移、AI 审批或恢复可绕过。
- `P2`：局部业务边界、并发/失败路径缺陷、审计日志遗漏、媒体清理问题、明显分层耦合造成近期回归风险。
- `P3`：有实际维护成本的轻微一致性或测试缺口；纯命名、格式和个人偏好通常不报。

严重度按影响和可触发性，不按修改行数。服务启动/构建失败通常为 P1；只有已经导致生产整体不可用才是 P0。

## Finding 契约

每条 finding 必须包含：

```md
- [P1] 简短结论 — `backend/app/path.py:123`
  触发场景：请求、权限、数据状态或并发顺序。
  证据与影响：当前代码为何违反不变量，会产生什么数据或用户后果。
  修复方向：指出应恢复的权限、事务、schema 或状态机合同。
```

- 行号落在最能证明问题的 changed line 或紧邻上下文。
- 同一根因合并为一条 finding，列出必要消费者，不重复报症状。
- Open Questions 只列会改变结论的问题；没有 finding 时明确“未发现阻断性后端问题”，并列残余风险。

## 验证与报告

按风险选择只读验证：

- 定向 pytest：`cd backend && .venv/bin/python -m pytest <path>`。
- 后端 service 集：`npm run backend:test:service`。
- AI infra：`npm run backend:test:ai`；AI 评测：`npm run backend:test:ai-evals`。
- 搜索：`npm run backend:test:search`。
- 全量质量：`npm run backend:quality`。
- migration：检查 `alembic heads`，在可用本地库执行 `npm run backend:migrate`。
- 跨端 contract：补对应前端 Vitest/构建检查。

最终分开列出“实际执行”与“建议/未执行”。绿 CI、单个 happy path 或 migration 可生成都不能替代权限、事务、并发和语义审计。

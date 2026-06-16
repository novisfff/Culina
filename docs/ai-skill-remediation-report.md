# AI Skill 基础操作整改报告

更新时间：2026-06-16

## 1. 整改结论

本轮整改已把 AI Workspace 从“主要能生成推荐和新增草稿”的能力，推进到覆盖家庭饮食核心对象基础操作的 `draft -> approval -> commit` 模型。

已覆盖的核心对象包括：

- 食材档案 `Ingredient`
- 库存批次 `InventoryItem`
- 食物资料 `Food`
- 菜谱 `Recipe`
- 餐食计划 `FoodPlanItem`
- 购物清单 `ShoppingListItem`
- 餐食记录 `MealLog`
- 菜谱烹饪、库存扣减、计划完成和餐食记录联动

AI 仍不拥有直接写正式业务表的权限。模型只能通过已声明 Tool 读取上下文、生成可确认草稿；正式写入必须由用户审批后由后端确定性 Service 执行。

## 2. 主要代码整改

### 2.1 Skill 能力补齐

- 新增 `ingredient_profile` Skill，支持食材搜索、读取、创建和更新。
- 新增 `recipe_cook` Skill，支持菜谱烹饪预览、库存扣减、计划完成和餐食记录生成。
- 扩展 `meal_plan`、`shopping_list`、`recipe_draft`、`food_profile`、`meal_log` Skill，使其描述与真实提交行为一致。
- 所有 Skill 文档强调只生成草稿，不声称已完成正式写入。

### 2.2 Tool 和草稿协议整改

- 为 food、ingredient、recipe、meal plan、shopping、meal log 等核心对象补齐真实搜索条件和 `read_by_id`。
- `meal_plan` 和 `shopping_list` 从纯新增草稿升级为 operation draft，支持 `create`、`update`、`delete` 和状态操作。
- `recipe`、`food_profile`、`ingredient_profile`、`meal_log` 支持操作语义明确的草稿。
- Tool JSON schema 已与运行时校验对齐：
  - `meal_plan` 支持 `set_status`。
  - `shopping_list` 支持 `set_done`。
  - `recipe.create_draft` 可接收菜谱新增草稿和菜谱操作草稿。
- 修改、删除和状态变更必须携带真实业务 ID 与 `baseUpdatedAt`。

### 2.3 审批和正式写入拆分

`workspace_service.py` 已收敛为兼容 facade，审批和写入职责拆到 `backend/app/services/ai_operations/`：

- `approval_config.py`：审批类型、按钮和文案推导。
- `approval_requests.py`：草稿和审批对象创建、失败重试审批创建。
- `approval_values.py`：确认表单字段与 shape 校验。
- `approval_decisions.py`：审批决策事务编排、正式写入、失败重试、结果卡和 artifact 持久化。
- `drafts.py`：草稿归一化、确认阶段结构校验和草稿摘要。
- `recovery.py`：失败摘要、当前值读取和恢复提示。
- `messages.py`：审批 part、结果卡和 confirmed artifact 消息同步。
- `executor.py` 与各领域 executor：正式业务写入。
- `composite.py`：复合审批协议校验、依赖解析、拓扑执行和同事务回滚。

Workflow 侧也拆出：

- `conversations.py`
- `plan_metadata.py`
- `result_cards.py`
- `run_lifecycle.py`
- `timeline.py`

### 2.4 安全边界整改

- Planner 仍只负责选择 Skill，不直接执行写入。
- Skill 只能调用 `allowed_tools` 中声明的 Tool。
- Tool executor 会拒绝未声明 Tool、禁止 Tool 和不允许的 side effect。
- 用户确认前只写 AI 草稿、审批请求、消息和 run 记录，不写正式业务表。
- 用户拒绝后不校验业务 payload，也不产生业务副作用。
- 跨家庭、跨用户、跨对象引用由 Tool normalize 和正式执行 Service 双层校验。
- 正式提交阶段通过 `baseUpdatedAt` 防止覆盖他人更新。

### 2.5 前端体验整改

- 审批面板支持 recipe、recipe_cook、meal_plan、shopping_list、meal_log、food_profile、ingredient_profile、inventory_operation、composite_operation 的结构化预览。
- 修改和状态变更展示 before / after；失败重试展示当前值和恢复提示。
- 审批成功后追加操作结果卡，帮助用户知道写入了什么、下一步去哪里看。
- 桌面和移动端共用欢迎建议配置，覆盖新增食材、食材入库、修改计划、完成购物项、修改菜谱、记录餐食和开始烹饪。
- 诊断信息不再常驻为侧栏卡片，改为点击桌面 AI 状态胶囊后打开隐藏弹窗，降低普通用户干扰。

### 2.6 可观测性整改

- run 级 `context_summary` 记录 routing、skill、clarification、approval 等基础指标。
- 新增 `GET /api/ai/quality-metrics` 家庭维度只读聚合接口。
- 诊断弹窗展示最近运行状态、意图、路由 Skill、澄清原因、审批结果和 Skill 诊断分布。

## 3. 复合审批边界

`composite_operation.v1` 已作为正式后端审批合同接入，支持：

- 领域白名单。
- step 结构校验。
- 依赖图无环校验。
- 拓扑执行顺序。
- `$step.entityId` 声明依赖引用解析。
- 同事务执行和失败回滚。

当前决策是不向 Skill 或自然语言直接开放 `composite_operation` 生成入口。它先作为后端合同和未来受控组合 draft tool 的基础保留，避免模型在缺少专用提示、字段约束和回滚体验时生成任意复合写入。

## 4. 对 AI 助手使用的影响

用户现在可以通过自然语言完成更多基础操作：

- “新增鸡胸肉食材，默认冷冻保存。”
- “把今天买的鸡蛋 2 盒录入库存。”
- “把明天晚餐改成番茄炒蛋。”
- “把购物清单里的鸡蛋标记为已买。”
- “把番茄炒蛋菜谱改成 3 人份。”
- “记录今晚吃了番茄炒蛋和米饭。”
- “开始做番茄炒蛋，先检查库存并准备扣减。”

体验变化：

- AI 会更频繁要求确认具体目标，尤其是修改、删除、标记完成等动作。
- 模糊目标会要求用户消歧，不再靠名称猜测写入。
- 修改和删除会显示当前值、草稿值和影响范围。
- 如果确认时业务对象已被别人改过，系统会失败并生成可恢复的重试审批，而不是静默覆盖。
- 确认成功后会出现结果卡，说明写入对象和数量。

仍保留的限制：

- AI 不直接管理家庭成员、权限、账号设置。
- AI 不提供医疗或营养诊断式承诺。
- 食材、食物、餐食记录删除仍未作为本轮基础能力开放。
- 库存批次资料修改未开放；库存支持入库、消耗和销毁。
- 复合审批不开放给模型自由生成。

## 5. 验证结果

本轮关键验证包括：

- `backend/.venv/bin/python -m pytest backend/tests/test_ai_agent_infra.py -q`
  - 结果：`146 passed, 42 subtests passed`
- `npm --prefix frontend run test -- src/components/ai/AiWorkspace.test.tsx src/lib/aiWorkspaceContracts.test.ts src/components/ai/AiResultCards.test.tsx src/components/ai/aiWelcomeSuggestions.test.ts`
  - 结果：`42 passed`
- `npm --prefix frontend run check:size`
  - 结果：通过
- `npm --prefix frontend run build`
  - 结果：通过；存在 bundle budget warnings，命令退出码为 0

新增关键证明：

- `test_ai_approval_business_writes_record_audit_fields_and_activity_logs`
  - 覆盖 8 个写入域的审计字段、`AIUserApproval`、`AIOperation` 和 `ActivityLog`。
- `test_target_bound_operation_approvals_create_retry_on_stale_base_updated_at`
  - 覆盖食材、食物、菜谱、餐食计划、购物清单、餐食记录和做菜的正式目标并发冲突恢复。
- `test_operation_draft_tools_reject_cross_family_targets`
  - 覆盖 operation draft 跨家庭和跨用户目标拒绝。

## 6. 后续建议

- 若要开放真正的自然语言复合写入，应新增专用 composite draft tool，而不是让模型直接生成 `composite_operation.v1`。
- 若继续扩展删除能力，应先补业务 API、权限、活动日志、前端审批展示和四象限测试。
- `AiWorkspace` bundle 已有预算 warning，后续可继续拆分诊断弹窗、审批面板和复合预览 chunk。

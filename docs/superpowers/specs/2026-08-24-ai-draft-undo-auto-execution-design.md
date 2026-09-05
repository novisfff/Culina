# AI Draft 撤销与低风险自动执行设计

日期：2026-08-24

状态：已确认；2026-08-28 按产品决定移除用户设置并改为 catalog 默认开启

范围：AI Draft 捕获与路由、人工审批、低风险自动执行、AI Operation 审计、领域撤销、AI 工作区结果卡、服务端默认授权

## 1. 背景

Culina 当前对模型产生的所有正式业务写入统一采用 `draft -> approval -> service commit`。这个边界保证了模型不能直接写业务数据，但也带来两个产品问题：

1. 用户确认 Draft 并完成写入后，AI 结果卡没有统一撤销入口；发生误操作时只能自行进入业务页面修正。
2. 收藏、评分、小规模购物清单维护等低风险、意图明确的操作仍要求逐次确认，确认成本高于操作本身。

本设计将两个问题成套处理：

- 对已经提交的 AI Operation 提供有条件、可审计的一小时补偿式撤销；
- 模型仍然只生成 Draft，由服务端基于明确意图证据、默认开放的动作白名单、有效 membership、批量限制、版本和撤销能力决定自动执行或人工确认。

撤销能力和自动执行资格是两个独立维度。一个操作可以始终确认但支持撤销，也可以因为缺少可靠撤销适配器而永远不能自动执行。

## 2. 当前实现事实

设计以当前源码为实现事实：

1. `backend/app/ai/tools/catalog/common.py` 为 Draft Tool 统一设置 `requires_confirmation=True`。
2. `backend/app/ai/skills/loader.py` 只接受 `none | draft_then_confirm`。
3. `backend/app/ai/workflows/orchestrator/draft_capture.py` 捕获 Draft 后固定进入 `ApprovalRequired`。
4. `backend/app/ai/workflows/runner_support/progressive_draft_publisher.py` 会立即持久化 Draft 和 Approval、发布待确认卡并将 Run 置为 `waiting_approval`。
5. 正式写入集中在 `backend/app/services/ai_operations/approval_decisions.py`，再分发到现有领域 Service。
6. `AIOperation.approval_request_id` 当前非空，Operation 无法表达没有用户审批的策略自动执行。
7. `AIOperation` 尚未保存执行模式、授权快照、策略版本、撤销适配器、底层操作引用和撤销状态。
8. 库存入库/盘点已有 `InventoryOperation` 前后快照、版本检查、权限和整笔撤销。
9. 快速餐食记录已有 `MealLogRecordOperation` 撤销账本；普通 AI 餐食新增尚未完整接入该账本。
10. 收藏、评分、购物清单安全操作和餐食计划新增尚无统一 AI 撤销上下文。
11. `Food`、`MealLog`、`ShoppingListItem` 已有 `row_version`；`FoodPlanItem` 只有时间戳，没有乐观版本列。
12. `frontend/src/components/ai/AiResultCards.tsx` 的 Operation Result 固定显示“已按确认执行”，没有执行来源、撤销截止时间或冲突状态。
13. 当前普通消息完成主要刷新 AI 查询；自动业务写入如果复用该路径，会留下陈旧的 React Query 业务缓存。
14. 家庭公开会话允许其他成员贡献；执行人必须来自发出当前消息、创建当前 Run 的成员，不能借用会话创建人或 Owner 身份。

## 3. 目标

本设计必须实现：

1. 人工确认和策略自动执行调用同一个 Commit Coordinator 与领域 Service。
2. 模型仍然不能获得正式 Write Tool，也不能自行判定风险等级或执行权限。
3. 只有用户明确发出操作指令时才可能自动执行；隐含或推断意图始终进入人工路径。
4. 使用定义明确的意图清晰度档位，不使用未校准的连续 `confidence` 分数。
5. 首批自动执行收藏、餐食评分、受限购物清单、安全的餐食记录新增和餐食计划新增。
6. 五类白名单动作由服务端 catalog 默认开启，不再要求成员或 Owner 逐项配置。
7. 自动执行前必须验证目标、关键字段来源、批量、版本、权限和撤销适配器。
8. 人工确认和自动执行的结果都可以按实际适配器能力提供一小时撤销。
9. 撤销是新的补偿操作，不改写真实审批事实，也不覆盖后续正常修改。
10. 自动执行、执行失败和撤销都能从持久化消息、刷新和幂等重试恢复真实状态；活动 chat 请求中的自动结果继续使用既有 SSE，普通撤销请求使用 HTTP 响应更新发起端。
11. 自动执行与撤销都正确更新活动日志、持久化消息、Artifact 和业务缓存，并使用各自真实存在的传输通道返回结果。
12. 结果卡符合 Culina 的中文、移动优先、低维护和可访问性规范，且不暴露已移除的配置入口。

## 4. 非目标

本次不包含：

- 让模型直接调用正式业务 Write Tool；
- 让模型自己声明 `autoExecute=true` 或决定动作风险；
- 通过连续置信度阈值授权执行；
- 根据隐含意图自动写入；
- Shadow Mode、灰度发布或样本门槛；
- 做菜操作的整组撤销；
- 通用硬删除恢复；
- 复杂媒体或参与人更新的通用撤销；
- Composite 的整组撤销；
- Continuation 整条链的一键撤销；
- 为自动执行开放库存入库、盘点、消耗、丢弃或做菜；
- 修改普通页面现有 15 分钟领域撤销窗口；
- 引入通用 JSON 回滚器、事件溯源框架、任务队列或新微服务。

## 5. 已确认的产品规则

| 主题 | 规则 |
| --- | --- |
| 自动执行硬条件 | 用户必须明确发出操作指令 |
| 隐含意图 | 即使模型认为非常确定，也只能建议或生成待确认 Draft |
| 模型信号 | 使用离散 `intent_clarity` 和结构化证据，不使用 `confidence` |
| 风险归属 | 风险白名单和最终执行权完全由服务端控制 |
| 首批自动执行 | 收藏、餐食评分、受限购物清单、简单餐食记录新增、简单餐食计划新增 |
| 默认授权 | 五类动作均由服务端 catalog 默认开启，来源记为 `catalog_default` |
| 用户设置 | 不提供个人或家庭开关；旧设置行不参与执行判定 |
| 购物批量 | 新增或恢复最多 5 项；修改一次只允许 1 项 |
| 餐食批量 | 评分最多 5 个食物项；新增记录最多 5 个 Food |
| 计划批量 | 新增计划最多 5 项 |
| 自动连锁 | 每个用户消息最多自动执行一个 Draft；Composite 与 Continuation 不自动执行 |
| 撤销窗口 | 正式提交成功后 1 小时，服务端时间为准 |
| 撤销权限 | 原执行人或当前家庭 Owner |
| 撤销冲突 | 目标后来被修改或引用时拒绝，不覆盖较新状态 |
| 审批事实 | 用户审批保持不可变；撤销不把 Approval 改成 rejected/pending |
| 发布方式 | 系统尚未上线，直接按目标机制实现，不做 Shadow 或灰度 |

## 6. 方案比较与选择

### 6.1 方案 A：在 Progressive Publisher 中伪造自动批准

捕获 Draft 后，如果模型声明低风险，就创建 Approval 并立即标记为 approved，再复用现有审批执行路径。

优点是改动小。缺点是数据库会记录一条用户从未做出的批准，审计、指标、恢复和撤销语义都会失真；模型信号也会直接获得执行权。

不采用。

### 6.2 方案 B：策略决策层 + 公共 Commit Coordinator + 领域撤销适配器

模型输出 Draft 和意图证据；服务端策略决定 `manual_confirmation | policy_auto | policy_no_change`；人工与自动路径共用 Commit Coordinator；Approval 只用于真实人工决定；AIOperation 独立记录执行来源和撤销能力。

优点是审批、执行和撤销事实清楚，能复用现有领域 Service 和撤销账本，也能按动作逐步扩展。

采用本方案。

### 6.3 方案 C：全业务事件溯源与反向命令

把所有业务写入重构为事件和反向事件，从底层统一撤销。

长期能力强，但会扩大到所有领域写入、历史迁移和查询模型，明显超出本需求。

不采用。

## 7. 总体架构

```text
模型生成 Draft + Intent Evidence
  -> Draft Tool 校验与归一化
  -> 服务端 AutoExecutionPolicy
     ├─ manual_confirmation
     │    -> AITaskDraft + AIApprovalRequest
     │    -> waiting_approval
     │    -> 用户真实决定
     └─ policy_auto
          -> 事务内授权/版本/限制复核
  -> DraftCommitCoordinator
  -> 现有领域 Service 正式写入
  -> AIOperation + Result Card + Revert Context
  -> 活动 chat 请求：post-commit message_part
  -> 普通 mutation：HTTP 结果响应
  -> 业务缓存失效
```

主要组件：

- `IntentEvidenceValidator`：验证意图档位、当前消息引用和可信上下文来源。
- `AutoExecutionPolicyRegistry`：按 Draft 类型与 action 注册确定性策略。
- `DraftRoutingCoordinator`：返回人工确认、自动执行、无需变更或失败结果。
- `DraftCommitCoordinator`：统一人工与自动正式写入。
- `AIRevertAdapterRegistry`：按适配器 key 执行领域条件式补偿。
- `AutoExecutionAuthorizationResolver`：只按服务端 catalog 解析默认授权，不读取用户设置。
- `AI operation result contract`：统一持久化卡片、SSE 与缓存标签。

## 8. 意图清晰度与证据

### 8.1 `intent_clarity`

只允许四个档位：

| 档位 | 定义 | 自动执行资格 |
| --- | --- | --- |
| `explicit_complete` | 用户明确要求操作，目标和该动作的关键参数均由原话完整给出 | 可成为候选 |
| `explicit_context_resolved` | 用户明确要求操作；指代通过当前卡片、本轮 Tool 结果或可信 Artifact 唯一解析，且没有关键默认值 | 可成为候选 |
| `explicit_incomplete` | 用户明确要求操作，但关键字段缺失、目标不唯一、指令冲突或必须补入关键默认值 | 不可自动 |
| `inferred` | 用户没有直接要求执行，模型根据表达推测可能想做 | 不可自动 |

例子：

- “给今天午餐的番茄炒蛋打 5 分”是 `explicit_complete`。
- 当前打开唯一 Food 卡片时说“收藏这个”是 `explicit_context_resolved`。
- “把牛奶加入购物清单”但定量模式缺数量/单位，是 `explicit_incomplete`。
- “这道菜真不错”不能推断成收藏或五星评分，属于 `inferred`。

四档定义、上述边界和“不得自行升级档位”的规则必须来自一份共享的模型可见说明，同时进入首批 Draft Tool 的 JSON Schema `description` 和四个相关 Skill 的运行指令。只向模型暴露四个枚举字符串不构成有效契约；模型没有填写或无法按定义填写证据时，Draft 仍可人工确认，但不能自动执行。

### 8.2 证据结构

首批 Draft Tool Schema 增加可选 `intentEvidence`：

```json
{
  "intentClarity": "explicit_complete",
  "sourceQuotes": [
    {
      "fields": ["action", "rating"],
      "text": "给番茄炒蛋打 5 分"
    }
  ],
  "resolutionSources": [
    {
      "fields": ["targetId"],
      "kind": "tool_result",
      "referenceId": "tool-call-id",
      "entityId": "meal-log-id",
      "rowVersion": 3
    }
  ],
  "ambiguityCodes": [],
  "defaultedFields": []
}
```

`intentEvidence` 是 Draft Tool 输入中的传输字段，不属于任何领域业务 payload。Draft Tool 在调用现有领域 normalizer 前必须先把它与业务字段分离：normalizer 只生成规范化业务 Draft，捕获层从原始 Tool input 读取证据，再把“规范化业务 Draft + 原始证据 + 服务端可信来源”交给路由层。路由层保存服务端验证后的 `AITaskDraft.intent_evidence_json`；不得假设 normalizer 会原样保留模型输入，也不得从 handler 重建后的 `output["draft"]` 反推证据。

`resolutionSources.kind` 使用服务端枚举：

- `current_ui_context`
- `tool_result`
- `conversation_artifact`

`sourceQuotes` 经 Unicode NFC 和确定性空白标准化后，必须能在当前用户消息中找到。`fields` 只表示模型声称该原话覆盖哪些字段，不构成值证明。服务端必须针对首批字段使用确定性 canonical matcher，从 quote 中解析动作方向、评分、数量、单位、日期、餐次等事实，并与规范化 Draft 的实际值逐项比较；例如“打 4 分”不能证明 `rating=5`，“买 1 盒”不能证明 `quantity=10`。解析失败或值不一致时，该字段未验证，只能人工确认。

`resolutionSources` 的引用 ID、实体 ID、家庭归属和版本必须出现在服务端持有的可信上下文中，而且可信来源中的实体和值必须与规范化 Draft 对应字段一致。可信上下文只保存各 Tool/Artifact 显式允许用于首批 matcher 的 canonical facts，不把任意输出 JSON 当授权事实；模型仅重复一个真实 ID 不能证明另一个 payload 值。相对日期只允许由当前消息和家庭时区的确定性词典解析，餐次、收藏方向和恢复方向同样使用固定词典；不调用第二个模型充当授权解析器。

数组证据使用与规范化 payload 一致的零基具体路径，例如 `foods[0].servings`、`foods[1].servings`；文档中的 `foods[].servings` 仅是集合简写，不能一次证明所有元素。服务端逐项生成期望路径和值，一段 quote 可以覆盖多个路径，但每个路径都必须独立比较成功。

模型声明 `defaultedFields=[]` 不构成证明。服务端按动作关键字段要求重新检查每个值是否来自用户原话或可信来源，并把验证后的字段、canonical 值与失败码作为服务端拥有的结果持久化。除现有失败码外，值无法解析和解析值不一致分别使用稳定码 `source_value_unverifiable`、`source_value_mismatch`。证据缺失、格式错误或无法验证时，Draft 仍可进入人工确认，但不能自动执行。

对 `meal_log.simple_create` 和 `meal_plan.simple_create`，语义字段 `action` 也是关键证据：当前用户消息必须明确要求“记录/新增这餐”或“加入/安排到计划”。即使日期、餐次、Food 和份量等业务字段全部齐全，单纯陈述已经吃过什么、打算吃什么或描述一个安排，也不能由服务端推断为新增指令，只能进入人工确认。

证据 Schema 对数组长度、文本长度和字段数量设置固定上限，拒绝无限载荷。自由文本解释不参与授权。

## 9. 自动执行全局门禁

`AutoExecutionPolicy` 只返回：

```text
auto_execute
manual_confirmation
no_change
```

`auto_execute` 与免确认返回的 `no_change` 都必须同时满足以下门禁；未授权时即使目标已经一致也仍进入现有人工路径：

1. `intent_clarity` 为 `explicit_complete` 或 `explicit_context_resolved`。
2. 操作要求来自当前用户消息。
3. 所有关键字段都有已验证来源。
4. `ambiguityCodes` 不含当前动作的阻断项。
5. 没有使用关键默认值。
6. 动作在服务端首批白名单内。
7. 当前动作由服务端 catalog 默认开放。
8. 当前成员仍具有领域写入权限。
9. 目标属于当前家庭且身份唯一。
10. 批量和字段变更不超过服务端硬限制。
11. 正式写入前的版本仍有效。
12. 已注册可靠撤销适配器。
13. 不含媒体、外部副作用或未开放字段。
14. 不属于 Composite 或 Continuation。
15. 当前 Run 尚未尝试其他自动执行。

所有目标已经处于所需状态时返回 `no_change`，不创建 AIOperation，也不伪造一次完成写入。批量 Draft 只有部分目标已经满足时不做静默的部分提交，首批统一降级人工确认。

建议的稳定 `policy_reason_codes` 至少包括：

- `intent_not_explicit`
- `intent_evidence_missing`
- `source_quote_mismatch`
- `source_value_unverifiable`
- `source_value_mismatch`
- `resolution_source_untrusted`
- `critical_default_used`
- `ambiguity_present`
- `action_not_allowed`
- `batch_limit_exceeded`
- `revert_adapter_missing`
- `composite_not_allowed`
- `continuation_not_allowed`
- `auto_execution_already_attempted`
- `target_already_satisfied`
- `target_stale`
- `domain_constraint_failed`

这些 code 用于审计、测试和诊断，不作为发布门槛。

## 10. 首批动作策略矩阵

### 10.1 收藏状态：`food.set_favorite`

允许：

- `draft_type=food_profile`
- `action=set_favorite`
- 仅一个当前家庭已有 Food
- payload 只含 `favorite: boolean`
- `baseUpdatedAt` 和目标版本有效
- 动作存在于服务端 catalog

状态已经一致时返回 `no_change`。Food 其他资料、媒体或库存字段出现时降级人工确认。

### 10.2 餐食评分：`meal_log.rate_food`

允许：

- `draft_type=meal_log`
- `action=rate_food`
- 目标 MealLog 和 MealLogFood 唯一、版本有效
- 操作者是记录创建人或参与人
- 一次最多 5 个食物项
- 每个评分值或取消评分均由用户明确表达
- 只修改评分，不修改组成、详情、参与人、媒体或库存
- 动作存在于服务端 catalog

评分允许现有领域范围 `0.5..5`，取消评分使用明确的 `null` 语义。

### 10.3 购物清单：`shopping_list.safe_write`

允许三种互斥模式，不允许在一份自动 Draft 中混合：

- 新增：最多 5 项；采购对象必须精确匹配当前家庭真实 Ingredient 或 ready-like Food。
- 修改：一次 1 项；归一化前后 diff 只能改变数量、单位或备注，不能替换采购对象。
- 恢复待买：最多 5 项；只允许 `set_done(done=false)`，目标必须唯一。

购物证据字段不能使用一份固定集合，必须按规范化 Draft 形态和每项动作动态生成：

- 普通 `shopping_list.v1` 新增：验证语义 `action`，并逐项验证 `items[i].ingredient_id | items[i].food_id`；只有服务端确认目标为定量对象时，才额外验证该项 `quantity`、`unit`。
- `shopping_list_operation.v1` 的 create：逐项验证 `operations[i].action`、`operations[i].payload.ingredient_id | food_id`；create 没有 `targetId`，定量要求仍按服务端目标动态加入。
- update：验证 `operations[0].action`、`operations[0].targetId`，以及归一化 diff 中实际改变的 `quantity | unit | reason`；未改变字段不要求证据，也不能夹带未声明变更。
- 恢复待买：逐项验证 `operations[i].action`、`operations[i].targetId` 和 `operations[i].payload.done=false`，不要求数量或单位来源。

数组下标和字段名以 normalizer 输出的 canonical 结构为准，证据验证器不得把普通新增误当成 operation Draft，也不得要求 create 中不存在的 `targetId`。

定量对象的数量和单位必须来自用户原话或可信 Artifact；不定量 Ingredient 可以使用系统固定“需要补充”语义。

以下情况始终人工确认：

- 删除；
- `set_done(done=true)`；
- 完成采购、部分采购或库存入库；
- 自动创建 Ingredient/Food 档案；
- 候选歧义；
- 超过 5 项；
- Composite、Continuation 或混合操作。

该动作与其硬限制由服务端 catalog 默认开放；仍按当前 membership 和购物清单领域权限校验。

### 10.4 简单餐食记录新增：`meal_log.simple_create`

允许：

- 只创建一条新 MealLog；
- 当前用户消息明确要求记录或新增这餐，`action` 有可验证的原话证据；
- 最多 5 个当前家庭已有 Food；
- 日期、餐次和每个 Food 的份量来源明确；
- 参与人严格等于当前成员；
- `deductStock=false`；
- 无媒体；
- 无 `planItemId`，不完成或关联计划；
- 无 Continuation；
- 动作存在于服务端 catalog。

用户明确表达的备注、心情或评分可以随新增一起保存；未表达时只使用领域固定空值。不得根据当前时钟猜测餐次，也不得把缺失份量补成 1。

“今天”“明天”“今晚”等可以通过家庭时区和固定产品词典解析；“刚吃了”但没有餐次不能按当前时刻推断为午餐或晚餐。

### 10.5 简单餐食计划新增：`meal_plan.simple_create`

允许：

- 只新增 FoodPlanItem；
- 当前用户消息明确要求加入或安排到餐食计划，`action` 有可验证的原话证据；
- 最多 5 个当前家庭已有 Food；
- 日期和餐次来源明确；
- `user_id` 固定为当前成员；
- 不更新、删除或改变计划状态；
- 不联动购物清单；
- 不带 Continuation；
- 动作存在于服务端 catalog。

完全相同的 `user + date + meal_type + food` 已存在时返回 `no_change`；同一餐次的不同 Food 可以作为多个计划项。

## 11. 默认授权模型

服务端代码目录是唯一的免确认授权来源。五个 action key 默认开启，resolver 对目录内动作返回 `enabled=true`、`source=catalog_default`；目录外动作返回 `action_not_allowed`。授权快照固定保存 `source`、`action_key`、`catalog_version` 和 `policy_version`，重试时重新解析并要求完全一致。

默认授权不等于绕过权限。当前发言成员必须仍有有效 membership，领域 Service 继续校验家庭归属、操作者资格、Owner 能力（若领域本身要求）、目标版本和业务限制。catalog 只能缩小免确认范围，模型、请求体和数据库设置都不能新增动作或提高上限。

早期实现已经创建的 `AIAutoExecutionPreference`、`AIFamilyAutoExecutionPolicy` 及其设置接口暂时保留为兼容代码和历史数据，本次不做 schema 清理。策略解析和 commit/retry 都不读取或锁定这些行；旧行无论开启、关闭或 notice 过期均不影响执行，也不再提供用户可见入口。

## 12. 持久化模型

### 12.1 `AITaskDraft`

新增：

- `intent_clarity`
- `intent_evidence_json`
- `payload_hash`：服务端对该 version 的规范化业务 payload 计算的 canonical SHA-256；不包含 `intentEvidence`，同一 version 内不可变
- `execution_route`：`manual_confirmation | policy_auto | policy_no_change`
- `policy_key`
- `policy_version`
- `policy_reason_codes`
- `policy_evaluated_at`

`ai_metadata` 继续保存普通模型元数据，不承担安全审计。

Draft 状态统一为：

```text
pending_confirmation
executed
no_change
rejected
expired
execution_failed
pending_retry
reverted
```

状态流：

```text
pending_confirmation
  ├─ rejected
  ├─ expired
  └─ executed
       └─ reverted

policy_auto
  ├─ executed -> reverted
  ├─ pending_confirmation   # 最终门禁不再满足
  └─ execution_failed       # 正式执行冲突或失败

policy_no_change
  └─ no_change
```

`no_change` 是持久化终态：保存 Draft、受控结果消息和 Artifact，但不创建 Approval 或 AIOperation，也不能记为 `executed`。刷新或 SSE 重连从该持久化结果恢复“已是目标状态”卡片。

### 12.2 `AIApprovalRequest` 与 `AIUserApproval`

- 只有人工路径创建 AIApprovalRequest。
- AIUserApproval 只表示真实用户决定。
- 用户批准后执行失败，Approval 仍保持 `approved`。
- 后续撤销，Approval 仍保持 `approved`。
- 拒绝和过期继续使用现有真实状态。

### 12.3 `AIOperation`

调整和新增：

- `approval_request_id` 改为可空，外键删除规则改为 `SET NULL`；
- `run_id`；
- `actor_user_id`；
- `execution_mode`：`manual_approval | policy_auto`；
- `authorization_source`：`approval_request | catalog_default`；历史行仍可保留旧值；
- `authorization_snapshot_json`；
- `policy_key`、`policy_version`、`policy_reason_codes`；
- `committed_payload_json`；
- `result_json`；
- `error_code`、`error_message`、`failed_at`；
- `revert_adapter_key`，不支持撤销时为空；
- `revert_context_json`，不支持撤销时为空；
- `revertible_until`，不支持撤销时为空；
- `revert_request_id`，可空且唯一；
- `reverted_at`、`reverted_by`；
- `revert_result_json`；
- `revert_blocked_at`、`revert_blocked_code`。

Operation 状态：

```text
pending -> completed -> reverted
        -> failed
```

超过一小时不改变 `completed` 状态，只使 `revert_availability=expired`。不可逆的版本或依赖冲突记录 `revert_blocked_*`，Operation 仍保持 `completed`。临时网络或数据库错误不写永久 blocked。

`revert_context_json` 必须是适配器拥有、带 schema version 的最小上下文。通用代码不得直接回放任意 JSON。

### 12.4 `AIAgentRun`

新增：

- `auto_execution_attempted`
- `auto_operation_id`，`no_change` 时为空

最终策略通过后锁定 Run 并设置 attempted；`policy_no_change` 也会占用本轮唯一的免确认路由名额。领域执行失败同样计为本轮已尝试，阻止同一用户消息继续自动写第二笔。

### 12.5 领域模型

- `FoodPlanItem` 增加 `row_version` 并启用 SQLAlchemy version column。
- `InventoryOperationType` 增加 `consume`、`dispose`。
- 现有 InventoryOperation 和 MealLogRecordOperation 创建服务允许调用方显式传入撤销截止时间；非 AI 调用保持当前 15 分钟默认。

## 13. Runtime 与事务

### 13.1 Skill 与 Tool 契约

Skill approval policy 扩展为：

```text
none
draft_then_confirm
draft_then_policy
```

首批相关 Draft Tool 使用 `draft_then_policy`。Loader 只有在对应 Draft 类型存在已注册服务端策略时才允许加载。其他 Draft 继续 `draft_then_confirm`。

Draft Tool 的 `requires_confirmation` 仍保持真值，语义是必须停在服务端 commit gate；不得通过将其设为 false 绕过 Draft 捕获。模型面对的工具仍然没有正式写权限。

### 13.2 路由结果

Draft 捕获不再固定等于 ApprovalRequired，而是返回：

```text
DraftRouteOutcome
  waiting_approval
  auto_executed
  no_change
  execution_failed
```

DraftRoutingCoordinator 在所有路径先持久化 Draft。Progressive Publisher 和最终的 `AssistantResultPersister` 都只在路由结果为 `waiting_approval` 时创建、关联或补齐 Approval 并发布确认卡；不能再用“Draft 缺少 Approval”作为补建条件。自动与 `no_change` 路径不发布 pending 卡，也不会在最终结果持久化时被补建 Approval，避免卡片闪烁、用户点击竞态和伪审批。`no_change` 直接持久化受控结果消息和 Artifact。

### 13.3 公共 Commit Coordinator

`approval_decisions.py` 中的领域执行部分提取为公共 `DraftCommitCoordinator`：

- 人工路径先记录真实决定，再调用 Coordinator；
- 自动路径通过最终门禁后直接调用 Coordinator；
- Coordinator 统一负责 operation 幂等、领域执行、结果序列化、撤销上下文、Artifact、活动日志和缓存标签；
- 每个领域仍由现有 Service 负责权限、锁、事务内业务校验和正式写入。

### 13.4 自动执行事务

```text
从原始 Tool input 分离 Intent Evidence
  -> 归一化不含 evidence 的领域 Draft
  -> 对规范化 payload 逐字段验证 Intent Evidence
  -> 策略预判
  -> 持久化 Draft
  -> 锁 Run 与 Draft
  -> 重新解析 catalog 默认授权并最终复核
  -> 标记 auto_execution_attempted
  -> 若全部目标已满足，持久化 no_change 结果并提交
  -> 创建 pending AIOperation
  -> nested transaction 执行领域 Service
  -> 生成 revert context
  -> Operation completed + Draft executed
  -> 持久化 result message/artifact
  -> 提交事务
  -> 发布 SSE 与缓存失效
```

相对锁顺序遵循既有 AI Run 取消规格：

```text
AIAgentRun
  -> AIApprovalRequest（如存在）
  -> AITaskDraft
  -> AIOperation
  -> 领域 Service 固定锁顺序
```

默认授权不产生设置行锁；遗留设置接口不参与 AI commit 锁顺序。

### 13.5 幂等

- Draft 继续使用现有 idempotency key。
- AIOperation idempotency key 由 `draft_id + draft_version` 派生，与执行模式无关。
- 同一版 Draft 最多正式提交一次。
- `POST /api/ai/runs/{run_id}/retry` 在调用现有 prompt 重试前，先以原 Run 锁定并查找唯一关联 Draft。若 Draft 为策略自动路径的 `pending_retry`，必须在同一 Run 上直接恢复该 Draft，不调用模型、不创建新 Run、消息或 Draft。
- 直接恢复只接受原执行人、当前有效 membership、完全相同的 Draft ID/version/payload hash，并重新检查取消、catalog/policy 版本、目标版本和领域权限；随后使用同一 Operation idempotency key 调用 `DraftCommitCoordinator`。并发或重复请求最多产生一次领域写入。
- Runner 重试发现 completed/reverted Operation 或 `no_change` Draft 时，同样在进入模型前重放持久化结果，不重新调用领域 Service 或策略。
- 只有临时数据库/连接失败进入上述 `pending_retry` 恢复；确定的目标版本或领域冲突保持 `execution_failed`，需要刷新业务数据并生成新 Draft/version，不能把原失败 Operation 换成一次新写入。
- 人工审批路径的 `pending_retry` 继续使用现有 retry Approval 恢复，不进入策略自动恢复，也不得退回 prompt 重放。只有完全没有关联 `pending_retry` Draft 的普通 failed/fallback/cancelled Run 保留现有“重新调用模型并创建新 Run”的行为，三条路径不得混用。
- 撤销使用 operation 状态和 `revert_request_id` 保证幂等。

### 13.6 失败处理

- 证据或策略不满足：正常降级为人工确认，不作为系统错误。
- 最终授权或限制不满足：在正式写入前降级人工确认。
- 目标版本冲突：nested transaction 整笔回滚，Operation `failed`，Draft `execution_failed`，不发布过期确认卡。
- 临时数据库错误：Draft `pending_retry`，只允许完全相同载荷的显式幂等重试。
- 任一失败：不推进 Continuation，不调用下一 Draft。
- 自动执行结果无法安全落盘时，服务端先独立提交结构化阻断事实，再将脱敏的 `status=failed` 结果交给无工具的模型调用，仅允许模型解释现状；模型不得判断成功、重试或提交。解释调用失败时使用固定安全兜底，整体仍保持 fail-closed。
- 事务提交成功但 SSE 断开：重连从持久化消息、Draft 和 Operation 恢复。

### 13.7 与取消状态机的关系

- 自动执行前锁定 Run 并复核不存在已生效的取消命令。
- 取消先取得 Run 锁时，不开始业务写入。
- 自动 Commit 已开始后收到取消命令时，不回滚已经开始的正式业务事务；提交真实结果，随后按取消规格停止其余回复。
- 自动 Draft 本身不启动 Continuation，因此取消后不会出现新的连锁写入。

## 14. 撤销协调器

统一接口：

```text
POST /api/ai/operations/{operation_id}/revert
```

处理步骤：

1. 以当前 membership 的 `family_id` 加载并 `FOR UPDATE` 锁定 AIOperation。
2. 校验当前用户是原执行人或当前 Owner。
3. 权限通过后才处理已撤销/永久阻塞重放和全局 `revert_request_id` 复用。
4. 对同一 Operation 的相同请求返回已保存结果；对其他 Operation 的复用返回冲突。
5. 检查 status、适配器、一小时截止时间和 blocked 状态。
6. 由适配器按领域固定顺序锁定目标。
7. 检查写入后版本、当前值和下游依赖。
8. 在同一事务执行全部补偿。
9. 更新 AIOperation、Draft、活动日志、结果消息、Artifact 和缓存标签。
10. 提交后在普通 POST 响应中返回已更新的持久化 result card、投影、`cache_scopes` 和新鲜 `server_now`；发起端立即原位替换并刷新查询。首批不为撤销新增跨请求 SSE 广播通道，其他客户端在下一次消息 refetch/reconnect 时读取持久化结果。

一小时边界为 `now <= revertible_until` 仍允许；`now > revertible_until` 过期。批量操作全量成功或全量失败。

撤销成功是该 AIOperation 的终态，本次不提供“重做”或对撤销再撤销；用户需要恢复目标状态时，应发出一条新的明确业务指令并形成新的 Operation。

稳定错误码：

- `operation_not_revertible`
- `revert_expired`
- `revert_forbidden`
- `revert_target_changed`
- `revert_dependency_exists`
- `revert_adapter_version_unsupported`
- `revert_request_id_reused`

默认授权策略的后续变化不影响已完成 Operation 的撤销资格。用户离开家庭后不能再访问；当前 Owner 仍可按领域条件撤销。

## 15. 首批撤销适配器

### 15.1 `food.favorite.v1`

上下文：

- `foodId`
- `beforeFavorite`
- `afterFavorite`
- `afterRowVersion`

撤销时锁 Food，检查家庭、存在性、row version 和当前 favorite 均等于写入后值，再恢复旧值。

### 15.2 `meal_log.rating.v1`

上下文：

- `mealLogId`
- `afterMealLogRowVersion`
- `entries[]`：entry ID、旧评分、写入后评分

按现有 MealLog 锁顺序锁定相关 Food 和 MealLog；检查父版本、entry 归属和当前评分；全部恢复后只 bump 一次 MealLog row version。

### 15.3 `shopping_list.safe_write.v1`

- 新增：保存所有新购物项 ID 和写入后版本；全部未修改、未完成、未用于入库时整体删除。
- 修改：保存允许字段的前后值和写入后版本；只恢复数量、单位和备注。
- 恢复待买：保存原 `done=true`、写入后 `done=false` 和版本；未再次修改时恢复。

所有实体按稳定 ID 顺序锁定，任一冲突整批拒绝。

### 15.4 `meal_log.simple_create.v1`

AI 简单餐食新增在同一事务创建 MealLogRecordOperation，AIOperation 只保存底层 operation ID。领域账本使用 AI 传入的一小时截止时间。

撤销要求创建出的 MealLog、MealLogFood 和相关记录仍符合领域账本的写入后版本与依赖约束。该路径不会包含库存扣减、媒体、计划完成或新 Food。

### 15.5 `meal_plan.simple_create.v1`

保存新 FoodPlanItem ID 和写入后 row version。撤销要求所有项目：

- 仍存在；
- 仍为 `planned`；
- `meal_log_id` 为空；
- 未被编辑；
- 未产生其他领域依赖。

成功后整体删除并同步清理/更新搜索索引。

### 15.6 `inventory.operation_ref.v1`

用于始终确认但可撤销的：

- 库存入库；
- 盘点；
- 单独消耗；
- 单独丢弃。

直接消耗和丢弃必须扩展为生成 InventoryOperation 与前后快照行，不再只修改计数。AIOperation 保存底层 InventoryOperation ID；AI 调用使用一小时截止时间，普通页面仍使用原 15 分钟默认。

## 16. 暂不实现的撤销

### 16.1 做菜

做菜同时影响 InventoryItem、Ingredient collection、MealLog/MealLogFood、FoodPlanItem、RecipeCookLog，并可能创建自制 Food。可靠撤销需要独立 RecipeCookOperation 账本和反向依赖检查，本次不实现。

### 16.2 硬删除

硬删除只有在具体实体采用软删除或拥有完整、可验证的依赖快照时才能恢复。本次不提供通用删除撤销。

### 16.3 媒体和参与人复杂更新

只有完整 operation 适配器能够恢复同一 Draft 的全部字段和媒体绑定，不能只恢复其中一部分。本次不实现。

### 16.4 Composite 与 Continuation

Composite 将来只有所有子步骤都产生可撤销上下文时，才能按依赖逆序原子恢复。Continuation 跨多个独立提交，只能分别撤销仍可撤销的 Operation。本次不实现整组或整链撤销。

没有适配器的人工确认结果显示“前往页面修正”，不显示虚假撤销按钮。

## 17. API 契约

### 17.1 遗留设置接口

```text
GET /api/ai/auto-execution/settings
PUT /api/ai/auto-execution/preferences/{action_key}
PUT /api/ai/auto-execution/family-policies/{action_key}
```

这些接口和原响应结构暂时保留，避免在本次产品调整中混入删表与 API 清理，但不再属于用户可见产品契约。任何 PUT 产生的偏好或家庭策略行都不参与自动执行判定；新前端不调用这些接口，也不展示对应页面或开关。后续删除须单独处理 schema、兼容和数据清理。

### 17.2 撤销

```text
POST /api/ai/operations/{operation_id}/revert
```

请求：

```json
{
  "client_request_id": "client-generated-id"
}
```

响应包含：

- 最新 Operation UI 投影；
- 更新后的持久化 result card；
- `cache_scopes`；
- `server_now`。

同一请求重放返回第一次成功/永久阻塞结果；一个已记录的 client request ID 用于其他 Operation 返回 409。以上重放和复用判断只能在原执行人/当前 Owner 权限校验通过后进行，不能让无权限调用者读取或探测历史结果。

`revert_target_changed`、`revert_dependency_exists` 或 `revert_adapter_version_unsupported` 会把 Operation 持久化为永久 blocked。对应 409 的 `detail` 除 `code`、`message` 外，还必须返回最新 `projection`、`result_card`、`cache_scopes`、`server_now` 和 `replayed`；前端用它立即替换原卡片并移除失效的撤销按钮。临时错误不返回伪造的 blocked 投影。

### 17.3 Result UI 投影

统一结果卡投影只向前端提供：

- `draft_id`
- `operation_id`，`no_change` 时为空
- `result_status`：`completed | no_change | failed | reverted`
- `execution_mode`：`manual_approval | policy_auto | policy_no_change`
- `operation_status`，没有 AIOperation 时为空
- `execution_explanation`
- `revert_availability`
- `revertible_until`
- `revert_blocked_code`
- `server_now`
- `entities`
- `cache_scopes`

不返回完整授权快照、模型证据、提交 payload 或领域撤销 context。`no_change` 使用 `result_status=no_change`、`execution_mode=policy_no_change`、`operation_id=null` 和 `revert_availability=unsupported`；它仍有稳定 `draft_id`，可以刷新和重连恢复。

`server_now` 是传输时钟，不是持久化状态。创建结果时可以保存当时投影，但每次 SSE/HTTP 返回以及消息列表 rehydration 都必须用同一响应内新鲜的服务端时间覆盖 card 中的历史值；前端不得拿数据库里旧的 `server_now` 重新校准倒计时。`revertible_until` 才是稳定持久化截止时间。

`revert_availability` 枚举：

```text
available
expired
unsupported
blocked
reverted
```

## 18. SSE、消息与缓存

活动 `/api/ai/chat/stream` 请求中的待确认、策略自动执行、执行失败和 `no_change` 继续复用现有 SSE `message_part`，其 data 使用 `message_id`、`conversation_id`、`run_id` 和持久化 `part`。不新增 `operation_completed`、`operation_failed`、`operation_reverted` 或 `draft_no_change` 顶层 SSE 事件；结果种类由 part 内的 `result_status` 和 `execution_mode` 表达，直接进入现有 `onMessagePart -> applyStreamPart` 合并链。

人工审批和撤销是独立 HTTP mutation，不处在上述 chat generator 中。它们在事务提交后返回完整、已持久化的 result card/part 与 `cache_scopes`，发起端使用响应原位替换并 refetch AI 查询；首批不承诺把该变化实时广播给其他已打开客户端。其他客户端通过下一次查询、页面刷新或 stream reconnect 读取同一持久化 part。

所有路径使用同一 AI Result message part 外壳；真实写入内嵌 Operation 投影，`no_change` 使用可空 operation ID。自动路径不能在 commit 前发出成功 part。

Result payload 携带服务端受控 `cache_scopes`。前端新增统一 `invalidateAfterAiOperationSettled`，按受影响领域刷新：

- Food / 收藏；
- MealLog / 历史；
- MealPlan；
- ShoppingList；
- Inventory；
- AI conversation/messages/operations。

SSE 重连只读取持久化结果，不触发 Coordinator。所有消息读取都为 result card 注入本次响应的新鲜 `server_now`。`no_change` 只刷新 AI conversation/messages，不失效业务查询；撤销后更新原消息 part，刷新页面仍显示“已撤销”。

## 19. 前端体验

不提供自动执行配置页面、个人开关或家庭开关。以下用户可见入口全部移除：

- AI 工作区桌面标题栏“自动执行”；
- AI 工作区手机顶部“设置”；
- 家庭页面桌面和手机“AI 自动执行”；
- Operation Result Card 的“管理自动执行设置”。

旧持久化导航中的 `aiView=autoExecution` 必须安全回退到 AI 对话，且新导航不再持久化该子视图。遗留设置组件和 API client 可以暂留为未挂载兼容代码，但不能从任何产品路径访问。

## 20. Result Card 与撤销交互

AI Result 根据状态显示：

| 状态 | 眉题 |
| --- | --- |
| 人工确认成功 | 已按你的确认执行 |
| 自动执行成功 | 已自动执行 |
| 无需变更 | 已是目标状态 |
| 已撤销 | 已撤销 |
| 执行失败 | 未完成操作 |

自动执行完成后，服务端只持久化结构化操作结果卡（状态、实体、撤销能力等），不再生成固定的用户可见说明。`policy_auto` 的操作结果作为普通工具结果回传给 Orchestrator，由模型结合真实执行结果生成自然语言回复；模型不得直接结束回合或复制服务端模板。结果卡的 `actionSummary` 仅在没有模型说明时回退为卡片标题。

不展示置信度、内部策略详情或配置入口。

可撤销卡显示：

- “可在 1 小时内撤销”；
- 绝对截止时间，例如“可撤销至 15:42”；
- “撤销”按钮；
- “查看详情”入口。

撤销直接执行，不增加确认弹窗，也不乐观显示成功。成功后原卡片原位变为“已撤销”，使用 `aria-live=polite` 宣布，不抢焦点。

不可撤销状态：

- 过期：“撤销时间已过，可前往页面修改”；
- 版本变化：“相关内容后来被修改，无法安全撤销”；
- 依赖出现：“该内容已被后续操作使用”；
- 不支持：“此操作需要前往页面修正”。

`no_change` 虽在传输契约中使用 `revert_availability=unsupported`，但它不是一次需要撤销或修正的写入。View Model 必须先按 `result_status=no_change` 返回“相关内容已经是你要求的状态”，不显示撤销、过期、不支持或“前往页面修正”提示。

永久版本/依赖冲突写入 blocked 后，前端从结构化 409 立即应用最新 result card，不再展示无效按钮；临时网络错误保留重试。离线时不把撤销排队到后台。

移动端按钮自动换行且不横向滚动；倒计时按分钟更新，不每秒跳动。初次流式结果、撤销响应和刷新后的消息读取都使用各自响应中的新鲜服务端时间计算偏移；服务端权限和最终撤销检查始终为准。

所有视觉值复用现有 token、`StateBlock`、`StatusBadge` 和按钮体系，不新增任意色值、阴影或圆角。

## 21. 数据库迁移

新增一份完整 Alembic migration：

1. 创建 `ai_auto_execution_preferences`。
2. 创建 `ai_family_auto_execution_policies`。
3. 扩展 `ai_task_drafts` 意图和策略字段。
4. 扩展 `ai_operations` 执行、Run、策略、结果和撤销字段。
5. 将 `ai_operations.approval_request_id` 改为 nullable，重建 `SET NULL` 外键。
6. 扩展 `ai_agent_runs` 单轮自动执行字段。
7. 为 `food_plan_items` 添加 `row_version` 和 server default。
8. 更新非原生 Enum/约束以接受 InventoryOperationType `consume | dispose`。
9. 添加家庭、状态、截止时间、动作 key、Run 和唯一幂等索引。

数据迁移：

- 现有 AIOperation 回填 `execution_mode=manual_approval`、`authorization_source=approval_request`。
- 尽可能从 AIUserApproval、Approval 审计字段和 Draft 创建人回填 actor。
- 无法可靠确定的遗留 actor 保持 nullable；新 Coordinator 强制新行 actor 非空。
- 现有 Draft 回填 `execution_route=manual_confirmation`；遗留行的意图证据和策略字段允许为空，新捕获行由 Routing Coordinator 完整写入。
- Draft `confirmed -> executed`。
- Draft `confirmation_failed -> execution_failed`。
- 现有撤销截止时间不修改。
- 既有偏好和家庭策略数据不参与默认授权；本次产品调整无需新增 migration。

不修改旧 migration。Migration 必须支持 MySQL upgrade/downgrade，并保持单一 Alembic head。

## 22. 错误与安全边界

- 所有设置、Draft、Approval、Operation、撤销和领域查询必须以当前 membership 的 `family_id` 隔离。
- 不信任请求体中的 family、actor、Owner 或权限字段。
- 自动执行 actor 固定为当前用户消息/Run 创建人。
- 公开会话的 actor 和领域权限始终取当前发言成员，不继承会话 Owner 身份。
- 自动执行不会绕过领域 Service 的 membership、Owner、归属和版本检查。
- 引用文本和模型声明不是授权；服务端 catalog、当前 membership 和领域状态才是授权依据。
- 目标在策略判断后变化时必须失败，不按旧快照继续写。
- 自动执行不包含媒体、文件生成、外部通知或第三方副作用。
- 结果卡不能在提交前声称完成。
- 撤销不能覆盖后续修改，也不能部分恢复批量操作。
- 取消、失败、拒绝、过期、撤销和无需变更使用不同状态，不互相冒充。

## 23. 测试策略

### 23.1 策略单元测试

覆盖所有允许与拒绝规则：

- 四档 intent clarity；
- 缺失/伪造 quote；
- quote 字段名正确但评分、数量/单位、日期、餐次或动作方向与规范化 payload 不一致；
- 不可信/过期 resolution source；
- 普通购物新增、operation create、update、restore 的具体字段形态和定量条件；
- 关键默认值；
- 简单餐食/计划业务字段齐全但当前消息没有明确新增指令；
- ambiguity code；
- catalog 内动作默认授权、目录外动作拒绝；
- 缺少设置行以及旧关闭/旧 notice 设置行均不影响 catalog 默认授权；
- 批量边界 1、5、6；
- 缺少适配器；
- Composite、Continuation；
- 同一 Run 第二笔；
- 目标过期和 no-change。

按五个动作 key 覆盖字段白名单与边界：购物混合/删除/缺数量，餐食库存/媒体/额外参与人/缺份量，计划更新/状态/缺日期等。

### 23.2 后端集成测试

验证：

- 自动成功不创建 AIApprovalRequest 或 AIUserApproval；
- 人工降级恰好创建一份审批且不提前写业务数据；
- 人工和自动进入同一 Commit Coordinator；
- actor 来自当前消息/Run；
- 四个真实 Draft normalizer 之后 evidence 仍通过独立 envelope 被验证和持久化，且不进入领域 payload；
- 幂等重试不重复写入；
- `pending_retry` 在进入模型前恢复相同 Run/Draft/version/payload hash，provider 调用次数为 0，且不创建新 Draft；
- 冲突整笔回滚；
- 失败不推进 Continuation；
- SSE 重连只恢复持久化结果；
- `no_change` 不创建 Approval/AIOperation、占用本轮名额并可在刷新后恢复；
- 取消与自动 commit 的锁后复核语义；
- 业务缓存标签完整。

### 23.3 撤销测试

每个首批适配器覆盖：

- 原执行人；
- Owner；
- 其他成员 403；
- 一小时包含边界；
- 过期；
- row version 变化；
- 下游依赖；
- 批量原子性；
- 已撤销幂等重放；
- 无权限调用者即使复用已成功或永久阻塞的 request ID 也先得到 403；
- client request ID 跨 Operation 复用；
- 永久 blocked 与临时错误；
- 活动日志、message、artifact、HTTP result response 和 cache scopes；其他客户端 refetch 后读取同一撤销终态。

库存额外覆盖入库、盘点、消耗和丢弃的前后快照恢复，以及非 AI 调用仍为 15 分钟。

### 23.4 前端测试

覆盖：

- 桌面与手机均不出现自动执行配置入口；
- 旧 `aiView=autoExecution` 导航安全回退到对话且不再持久化；
- 人工、自动、无需变更、失败、已撤销卡片；
- available、expired、unsupported、blocked、reverted；
- 请求期间不乐观成功；
- 离线不排队；
- 键盘、switch、aria-live 和焦点；
- 业务与 AI React Query 缓存失效；
- SSE 重连和持久化卡片恢复；
- result part 通过既有 `message_part` 消费链合并；
- 永久撤销 409 立即替换 blocked 卡片，`no_change` 不显示“前往页面修正”；
- 创建 30 分钟后刷新和截止边界使用响应级新鲜 `server_now`，不会重置或延长倒计时。

### 23.5 验证命令

实施完成后至少执行：

```bash
# 定向后端测试后再跑全量质量
npm run backend:quality

# Alembic 单头与 MySQL upgrade/downgrade/upgrade
backend/.venv/bin/alembic heads
npm run backend:migrate

# 定向 Vitest 后再跑前端质量、构建和 token 检查
npm run frontend:quality
npm run frontend:build
npm --prefix frontend run check:style-tokens

# 关键响应式路径
npm run frontend:e2e:p0
```

人工验收记录实际手机和桌面视口；样式 token 报告必须人工审阅新增命中，不能仅依据退出码。

## 24. 实施范围与顺序约束

本次实现包含：

- 数据模型、Alembic migration 和跨端契约；
- 意图证据与策略注册表；
- catalog 默认授权与遗留设置隔离；
- Draft routing 与公共 Commit Coordinator；
- 五类首批自动执行；
- 收藏、评分、购物、简单餐食、简单计划撤销；
- 库存入库、盘点、消耗、丢弃的 AI 撤销；
- Result Card、SSE、消息和缓存；
- AI 标准、Skill contract 和测试。

本次明确不实现第 4 节与第 16 节列出的非目标。

实施必须先完成数据模型、公共 Coordinator 和撤销底座，再开放任何策略自动执行。不能以临时分支绕过 Approval 或在前端隐藏确认卡来模拟完成。

## 25. 验收标准

满足以下条件才算完成：

1. 五类 catalog 白名单动作无需任何设置行即获得 `catalog_default` 授权，旧关闭记录也不改变结果。
2. 明确、白名单且可撤销的首批动作不创建审批，恰好执行一次。
3. 隐含、缺字段、超限、目录外动作、无适配器或连锁动作不自动执行。
4. 自动路径的数据库审计中不存在伪造用户批准。
5. 人工与自动路径的领域写入和结果契约一致。
6. 五类首批自动执行动作，以及始终确认但已纳入的库存操作，在一小时内且状态未变化时可以整笔撤销。
7. 后续修改或依赖出现时撤销返回明确冲突，不覆盖数据。
8. 刷新、重连、重试和重复撤销都不产生重复写入。
9. 公开会话使用当前发言成员的 membership、领域权限和 actor。
10. 前端准确区分人工、自动、无需变更、失败、过期、阻塞和已撤销。
11. 业务缓存不会因自动执行或撤销保持陈旧。
12. MySQL migration、后端质量、前端质量、构建、样式检查和关键响应式验证均通过并有新鲜证据。

## 26. 已关闭的设计决策

本规格没有待定产品项：

- 首批动作、档位、catalog 默认授权、批量限制均已确认；
- 撤销窗口、权限和冲突语义已确认；
- 首批撤销适配器和明确排除项已确认；
- Runtime、事务、幂等、UI、API、迁移和测试边界已确认；
- 发布方式已确认直接实现，不使用 Shadow Mode 或灰度。

任何扩大到做菜撤销、硬删除恢复、复杂媒体/参与人恢复、Composite 整组撤销或 Continuation 整链撤销的需求，都必须作为新的设计范围重新评估。

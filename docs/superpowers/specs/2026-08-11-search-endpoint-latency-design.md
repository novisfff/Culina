# 搜索端到端延迟优化设计

## 1. 状态与目标

本设计已确认采用“SQL 优化 + 并行召回 + embedding 用量事务内部优化”的方案。

目标是在不改变召回、排序、分页、权限、降级和模型用量治理合同的前提下，将当前参考环境中 `/api/search?q=西红柿` 的稳定冷查询总延迟尽量压到 `3s` 内。这里的冷查询表示不使用搜索结果缓存或 query embedding 缓存；数据库连接池和应用进程可以处于正常运行后的稳定状态。

当单次 embedding provider HTTP 自身超过 `1.5s` 时，验收必须分别报告 provider 时间和本地可控时间，不把外部异常抖动伪装成本地回归。

## 2. 当前证据

当前参考数据的搜索响应包含 `77` 个合并候选、分页返回 `20` 个结果。已有只读剖析得到：

- 浏览器 `11.79s` 几乎全部是等待服务端首字节，Service Worker 不是耗时来源。
- 最近一次交互式 embedding 账本记录约为：reserve/dispatch 前置阶段 `2s`、provider `1s`、settle `1s`。
- 中文 compact fallback 单条扫描 SQL 约 `1.33s`，会读取最多 `800` 个完整 `SearchDocument` ORM 实体。
- 当前前 `20` 个结果的业务信号回载产生 `23` 次 SQL，约 `1.53s`。
- Qdrant 普通实体与私人 meal-plan 两次查询约 `0.42s`。
- `160` 个候选的纯本地排序 p95 为 `0.282ms`，不是优化对象。

## 3. 不可改变的合同

- 家庭数据继续按可信 membership 的 `family_id` 隔离；私人 meal-plan 继续按 `user_id` 隔离。
- 关键词、语义、业务信号、置信分层和稳定 tie-break 的含义不变。
- 所有通过语义阈值或关键词证据进入的候选仍在分页前完成同一套业务排序，不通过裁剪候选换性能。
- embedding 仍按每个真实 provider send 计量，不增加查询向量缓存或结果缓存。
- model usage 的 reserve、首次 dispatch 和 settle 保持三个独立事务。
- 首次 dispatch 仍须在 provider send 前提交 durable `dispatching` intent，并按当前 policy pointer 重验 hard limit。
- provider send 后的 settlement 仍在返回搜索响应前同步完成；不改成异步结算。
- 不记录原始查询、候选正文、实体 ID、家庭 ID或用户 ID。
- 本轮不增加数据库列、索引或 Alembic migration。

## 4. 总体数据流

混合搜索开启时，搜索链路调整为：

```text
分析查询
├─ 主请求线程：精确名召回 → 关键词召回
└─ 有界语义执行器：metered embedding → Qdrant 普通实体/私人计划召回
等待两路召回完成
→ 合并并复核候选
→ 批量加载业务信号
→ 唯一本地排序
→ 可选 rerank
→ 分页实体序列化
```

语义分支不得使用调用方的 SQLAlchemy `Session`。它只使用 embedding adapter 自己创建的独立 model-usage session 和 Qdrant HTTP，因此可与主线程中的关键词 SQL 安全并行。

模块级语义执行器使用固定 worker 上限，避免每个请求无限创建线程。执行器饱和时允许语义任务排队；关键词路径仍正常执行，最终请求等待本次语义任务完成或按现有异常合同降级。

## 5. 关键词召回优化

### 5.1 compact fallback 投影

`_search_compact_documents` 不再查询完整 `SearchDocument` ORM 对象，只投影：

- `entity_type`
- `entity_id`
- `title_text`
- `keyword_text`
- `detail_text`

compact 归一化、字段命中判断、扫描上限、排序和匹配理由保持不变。`semantic_text`、`metadata_json`、embedding 元数据和其他未使用列不得从 MySQL 传输到应用进程。

### 5.2 精确名召回

四种 scope 的精确名查询暂时保持原有权限和排序合同。本轮只记录其总阶段耗时，不用跨表 `UNION` 重写实体查询，以免引入 meal-plan 私有边界和不同更新时间列的行为漂移。

## 6. 业务信号批量化

### 6.1 食物最近使用与今日餐型

对请求中的全部 `food_ids` 使用一次聚合查询：

```text
meal_log_foods
JOIN meal_logs
WHERE meal_logs.family_id = :family_id
  AND meal_log_foods.food_id IN :food_ids
GROUP BY meal_log_foods.food_id
SELECT food_id, MAX(meal_logs.date)
```

`days_since_used` 和 `never_used` 继续由相同日期语义推导。`target_meal_type` 只查询家庭当天实际存在的 `meal_type`，不再加载全量历史 meal logs。

### 6.2 菜谱最近使用

只针对候选 `recipe_ids` 执行两次聚合：

- `meal_log_foods → meal_logs → foods.recipe_id` 的最后食用日期。
- `recipe_cook_logs.recipe_id` 的最后烹饪日期。

应用层对两个日期取最大值，等价于现有 `recipe_recommendation_usage_maps` 对 meal-log 和 cook-log 事件的合并结果。搜索排序当前只消费 `last_used_at`，不额外计算未使用的 90 天计数。

### 6.3 菜谱可做性上下文

为本次所有候选菜谱一次性加载：

- 菜谱及其 `ingredient_items`。
- 关联 `Ingredient` 映射。
- 可用精确库存批次映射。
- presence-only 食材状态映射。

`build_cook_inventory_plan` 和 `recipe_availability_summary` 增加可选的预加载上下文参数。提供上下文时不得再次按菜谱查询 Ingredient 或 presence state；未提供时保持原有调用行为。单位换算、缺口计算和 `UnitConversionError` 处理不变。

## 7. Model Usage 事务内部优化

### 7.1 保留事务边界

reserve、dispatch、settle 不合并。策略可以在 reserve 后、首次 dispatch 前更新；dispatch 必须重新锁定 current policy pointer 并执行现有重验。

### 7.2 reserve 复用同事务 admission 状态

`ModelUsageFacade.reserve` 当前在同一事务中先为 monitoring fail-open proof 读取并锁定 policy、解析 subject、选择 price snapshot，随后 `reserve_usage_in_session` 再次读取同一批状态。

新增仅在当前 SQLAlchemy transaction 内有效的 `PreparedUsageAdmission`：

- 包含现有 `DispatchEligibilityProof`。
- 携带已锁定的 current policy、已解析 subject 和 immutable price snapshot。
- 绑定 family、capability、provider、model、variant、attempt identity 和计量 estimate fingerprint。

`reserve_usage_in_session` 接受该可选 admission，并严格校验其身份与当前调用一致；一致时复用 policy、subject 和 price。所有其他直接调用保持原路径。事务回滚后 admission 不得缓存、持久化或跨请求复用。

### 7.3 counter 批量锁定

新增 `lock_or_create_counters`：

- 按 `dimension_key` 排序，一次 `SELECT ... IN (...) FOR UPDATE` 锁定已存在 counter。
- 只有首次家庭/能力初始化缺少 counter 时，才使用现有唯一约束和 savepoint 逐项 claim 缺失行。
- 返回顺序与 `contract_counter_keys` 一致。

稳定家庭的 embedding reserve 从“每个 counter 一次查询”变为一次批量锁定，不改变 counter 值、版本或竞争语义。

### 7.4 dispatch 的 monitoring 快路径

dispatch 始终锁 current policy pointer、current policy 和 reservation。只有 `hard_limit_enabled=true` 时才读取 capability limits 并锁 counters 执行额度重验。

`hard_limit_enabled=false` 时，现有 `_current_policy_error` 本来无条件返回允许；该路径跳过未被读取或修改的 limits/counters，但仍写入 `dispatch_policy_version_id`、`dispatching_at` 和 recovery identity，并在 provider send 前提交事务。

settlement 的 event claim、counter 更新、watermark、alert 和 unique identity 继续保持现有单事务合同。本轮不通过削弱 settlement 工作换延迟。

## 8. 可观测性

新增结构化无正文阶段耗时：

- `exact_name_ms`
- `keyword_ms`
- `embedding_total_ms`
- `qdrant_ms`
- `candidate_hydration_ms`
- `business_signals_ms`
- `local_ranking_ms`
- `rerank_ms`
- `entity_serialization_ms`
- `search_total_ms`
- keyword/semantic/merged/paged candidate counts

embedding adapter 单独记录：

- `usage_reserve_ms`
- `usage_dispatch_ms`
- `provider_http_ms`
- `usage_settle_ms`

日志只记录 capability、provider、model 和数值指标，不记录 query、输入文本、request payload、家庭/用户/实体 identity。

## 9. 错误与降级

- embedding、model usage 或 Qdrant 的既有异常仍转换为当前 `degraded` 与稳定 `degradation_code`。
- 语义 future 的异常必须在主请求线程统一解析，不允许遗留后台 provider send。
- keyword SQL 失败继续遵循当前 MySQL fulltext → LIKE/compact fallback 行为。
- 批量业务聚合失败不得静默返回空业务信号；保持请求失败，避免错误排序被伪装为成功。
- `UnitConversionError` 仍只跳过对应菜谱的 availability 信号，不影响其他候选。

## 10. 测试

### 10.1 搜索合同

- compact fallback 在字段投影前后返回相同候选、分数、字段和 match mode。
- 同一固定关键词/语义 hit 和业务数据下，优化前后的完整结果顺序、分数、理由、total 和分页一致。
- meal-plan 用户隔离、无 user_id 时排除私人向量、embedding/Qdrant 降级合同继续通过。

### 10.2 SQL 与批量上下文

- compact fallback 的 SELECT 不包含 `semantic_text` 或 `metadata_json`。
- 多个 food candidate 的最近使用和今日餐型使用固定数量聚合查询。
- 多个 recipe candidate 的 usage 与 availability 不随菜谱数量线性增加 Ingredient/presence 查询。
- 聚合结果与现有内存算法覆盖：从未使用、同餐多 food、同菜谱多个 food、meal-log 与 cook-log 日期竞争、presence-only 食材和单位换算失败。

### 10.3 并行召回

- 用 barrier 控制的测试证明关键词分支与语义分支发生时间重叠。
- 两个分支完成顺序相反时结果仍完全确定。
- 语义异常完成时仍等待其终态并返回当前降级结果，不发生后台补发。

### 10.4 Model Usage

- prepared admission 与普通 reserve 生成相同 reservation、meter、counter 和 proof identity。
- admission identity 不匹配时 fail closed。
- stable counter 路径只执行一次批量 counter lock；缺行、并发 claim 和唯一冲突仍正确。
- monitoring dispatch 跳过 limits/counters，但 hard-limit dispatch 仍锁定并按新策略阻止或允许。
- policy update 与 dispatch 的先后顺序、同 attempt 重放、不同 fingerprint、commit failure、fail-open 和 settlement 测试保持通过。

## 11. 性能验收

自动测试固定查询次数和确定性，不以共享 CI 的绝对毫秒数作为硬门禁。

当前参考环境使用同一家庭、用户、scope、`limit=20`、`offset=0` 和查询“西红柿”进行验收：

1. 重启或重载后先用非搜索只读请求建立正常数据库连接池，不预热搜索结果或 embedding。
2. 连续执行 `5` 次真实 hybrid 搜索，每次都产生独立 query embedding 计量。
3. 记录完整 Timing 与全部阶段耗时。
4. 当 `provider_http_ms <= 1500` 时，总延迟中位数目标 `<= 3000ms`，并报告 p95/最大值。
5. 若未达到目标，必须用阶段日志指出剩余主导阶段；不得用缓存、候选裁剪、异步 settlement 或关闭 hybrid 使数字达标。

## 12. 交付边界

本轮只修改搜索召回/业务信号、inventory availability 的可选预加载接口、model usage 内部读取/锁定效率、无正文耗时日志及其测试。前端 API contract、数据库 schema、部署变量、排序权重、语义阈值和 rerank 配置均不变。

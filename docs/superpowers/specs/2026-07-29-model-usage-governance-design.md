# Culina 统一模型用量统计与额度治理设计

日期：2026-07-29

状态：九节设计已逐节确认并完成内部自审，等待用户书面复核

## 1. 背景

Culina 需要为个人与家庭提供统一的模型用量统计，并在家庭预算开启后提供可解释、可并发执行的额度治理。首版必须同时覆盖七类远程模型能力：

1. LLM 与视觉理解；
2. Embedding；
3. Rerank；
4. STT；
5. TTS；
6. 实时语音；
7. 图片生成。

当前系统只有局部 LLM Token 诊断，不具备用量账本或额度治理能力：

- AIRunLLMExchange 保存部分 model、input/output/total/cached Token 和 estimated cost，但它属于 trace 诊断数据；
- ai_trace_capture_llm_exchanges 默认关闭；
- trace 默认只保留 7 天，不能支撑自然月统计、13 个月原始记录或长期月度汇总；
- ai_quality.py 聚合的是当前用户可访问的会话，不等价于严格个人归因，也不等价于完整家庭用量；
- Embedding、Rerank、STT、TTS 和实时语音没有持久化用量；
- AIImageGenerationJob 记录业务 job，但没有标准化模型、meter、价格快照或家庭预算；
- provider SDK 当前可能执行隐式 retry，无法保证一次真实 attempt 对应一个可核查结算；
- embedding 后台 batch 可能跨家庭，不满足家庭归因和预算隔离；
- 当前通知中心主要组合图片和搜索索引任务，没有持久化模型预算提醒后端。

新设计不能扩展 trace 充当正式账本，也不能只在前端对已有零散字段求和。计量、价格、预算和补偿必须形成独立、稳定、无内容的基础能力。

## 2. 目标

本设计实现以下目标：

1. 统一统计个人和家庭的七类模型用量。
2. 为每次真实 provider attempt 保存可核查的 meter、价格快照、归因和结算状态。
3. 支持 Owner 查看家庭聚合，普通成员查看个人聚合和粗粒度家庭预算状态。
4. 支持家庭月度人民币预算、固定软提醒、可选硬限额和可选能力护栏。
5. 硬限额下通过原子 reservation 防止并发超卖。
6. 对 streaming、异步 job、显式 retry、取消、provider timeout 和业务保存失败进行正确结算或补偿。
7. 价格使用系统级版本化目录，由受控 CLI 发布，历史 event 保存人民币价格快照。
8. 原始记录至少保留 13 个完整月，月度汇总长期保留。
9. 账本和日志不保存 prompt、回复、query、文档、录音、图片、向量或其他家庭内容。
10. 首次正式开放前同时完成七类能力接入，不做灰度、双写或按能力分批上线。

本系统面向运营统计和配额治理，不承诺财务级开票、支付结算或供应商账单对账精度。

## 3. 非目标

首版不包含：

- 向家庭收费、充值、支付、退款或开票；
- 财务会计总账或税务处理；
- 成员个人预算或个人硬额度；
- 邮件、短信、PWA Push 或第三方消息提醒；
- 超级管理员价格后台；
- 家庭自定义时区或账期；
- 历史 trace、旧图片 job 或 provider 控制台数据回填；
- 逐笔家庭调用流水页面；
- prompt、response、query、文档或媒体内容审计；
- 动态实时汇率；
- 因后续调价自动重算历史；
- Celery、Redis、新微服务或独立计量网关；
- 家庭白名单、百分比 rollout、shadow accounting、双写观察期或按能力灰度；
- 任意日期范围报表；
- 模型调用之外的本地工具、脚本、本地排序、Qdrant、MinIO 或 SVG 成本核算。

## 4. 已确认的产品规则

| 主题 | 规则 |
| --- | --- |
| 产品等级 | 运营统计与配额治理，不做财务级计费 |
| 个人归因 | 用户直接触发归个人；后台和系统触发只归家庭 system |
| Owner 权限 | 可看家庭、成员、system、能力、provider/model 聚合 |
| 成员权限 | 只看自己和粗粒度家庭预算状态 |
| 家庭预算 | 北京时间自然月人民币预算，可为空 |
| 软提醒 | Owner 可开启；阈值固定为 80%、100%、110% |
| 硬限额 | Owner 可开启，默认关闭 |
| 能力护栏 | 可选；首版每个能力最多一个成本或原生 meter 护栏 |
| 成员额度 | 首版不支持 |
| 限额策略 | 按能力降级，不一刀切 |
| 未知价格 | 监控模式允许并标记；硬限额模式在 dispatch 前拒绝 |
| 价格维护 | 系统级版本化目录，运维通过受控 CLI 发布 |
| 历史数据 | 不回填，从新账本 tracking_started_at 起统计 |
| 账期 | Asia/Shanghai 自然月 |
| 页面入口 | 家庭工作区中的独立“模型用量”页面 |
| 提醒渠道 | 应用内通知和使用现场提示 |
| 账本故障 | 监控模式 fail-open；硬限额在 dispatch 前 fail-closed |
| 保留期 | 原始记录至少 13 个完整月；月度汇总长期保留 |
| 正式首发 | 七类能力同时接入，不做灰度 |

## 5. 选择的架构

采用“统一账本与额度策略内核 + 七类薄适配器”。

不选择以下方案：

- 扩展 AI trace：trace 可关闭、保留期短、只覆盖局部 LLM，无法作为预算事实；
- 超级模型网关：七类协议、streaming、WebSocket、异步图片和后台 embedding 差异过大，强塞进单一网关会形成新的高耦合中心；
- 独立计量微服务：当前部署、规模和事务需求不需要额外网络边界。

标准调用链：

    认证请求、job、session 或服务端业务对象
        → 能力 adapter 构造可信 UsageContext
        → estimator 生成最坏或保守 reservation
        → usage core 原子 reserve
        → 标记 dispatching
        → provider call
        → settle、release 或 uncertain
        → event、meter、counter、alert
        → maintenance reconcile、adjustment、rollup、retention

核心组件：

1. Usage Core：上下文校验、价格选择、reservation、结算、幂等和错误码。
2. Policy Engine：家庭预算、能力护栏、降级决策和硬限额。
3. Price Catalog：版本化 rate、model alias、FX 和 CNY 快照。
4. Capability Adapters：把七类 provider 请求与响应转换为标准 meter。
5. Ledger：追加式 event、meter 和 adjustment。
6. Aggregation：counter、当前月聚合和长期 monthly rollup。
7. Maintenance：uncertain 补偿、counter audit、alert repair、rollup 和清理。
8. API/UI：个人和家庭聚合、策略设置、计量健康与提醒。

## 6. 核心不变量

### 6.1 归因与数据边界

- family_id 只能来自当前认证 membership、持久化 job、实时 session 或服务端已校验业务对象。
- 不信任请求体、provider metadata 或模型输出中的 family_id、user_id、Owner 身份或权限。
- 用户直接操作使用 subject_type=user 和当前 user_id。
- 后台索引、清理和系统任务使用 subject_type=system，不伪装成最后编辑成员。
- 一个 embedding provider batch 只能包含一个 family_id；跨家庭输入必须先拆批。
- 用量 service 使用独立 SQLAlchemy session，不复用或提交调用方业务事务。
- 家庭删除级联删除该家庭账本；成员退出不删除家庭历史。

### 6.2 Attempt 与结算

- 只有已经进入 provider dispatch 的真实 attempt 才形成正式 event。
- 预算阻止、参数校验失败或过期但从未 dispatch 的 reservation 不形成 event。
- provider 已接收但明确保证未计费的 attempt 形成 provider_outcome=not_billed 的零费用 event，保留 retry 和审计事实。
- provider 可能执行或已产生用量时，必须 settle 或进入 uncertain，不能假定免费。
- 每个真实 dispatch attempt 最多形成一个正式 event。
- 显式 retry 使用新的 attempt key、reservation 和 event。
- 同 attempt key、同 fingerprint 重放返回原结果。
- 同 attempt key、不同 fingerprint 返回稳定冲突。
- event 追加式不可修改；修正使用 adjustment。
- provider 实际费用高于 reservation 时仍按真实值结算，并阻止后续请求。
- streaming、用户取消和客户端断开不代表费用为零。

### 6.3 金额与内容

- 所有价格、汇率、meter 小数和成本使用 Decimal/Numeric，不使用 float 做治理判断。
- 历史 event 保存 source currency、source rate、人工审核 FX 和 CNY 单价快照。
- 价格发布后不自动重算历史。
- 账本、日志、API、CLI 和 rollup 不保存 prompt、回复、query、文档、TTS 文本、STT 转写、录音、图片、媒体 URL 或 embedding 向量。
- Usage receipt 只返回 ID、状态、meter、成本和错误码，不返回业务内容。
- trace 开关、保留或清理不影响正式账本。

## 7. 标准能力与 meter

Capability 使用受控枚举：

- llm
- embedding
- rerank
- stt
- tts
- realtime_audio
- image_generation

Meter 同样使用受控枚举。首版至少支持：

- input_tokens
- cached_input_tokens
- output_tokens
- total_tokens
- embedding_tokens
- rerank_requests
- rerank_documents
- audio_input_seconds
- audio_output_seconds
- audio_input_tokens
- audio_output_tokens
- tts_characters
- tts_tokens
- generated_images

Provider 特有 meter 必须先加入中央枚举、价格 schema、adapter contract、API 映射和测试，不能以任意字符串直接入账。

不同能力的原生 meter 不跨能力相加。跨能力比较只使用 CNY 成本，同时保留原生 meter 供核查。

## 8. 数据模型

### 8.1 价格目录

model_usage_price_versions：

- 版本 ID、版本号、状态；
- effective_from、reviewed_at；
- source_ref、change_note；
- operator、change_ticket；
- manifest checksum；
- created_at、updated_at。

model_usage_price_rates：

- price_version_id；
- provider、billing_model、capability；
- 非空 variant_key；
- meter、unit_quantity；
- unit_price、source_currency；
- fx_to_cny、unit_price_cny；
- 经过校验的 reported model aliases；
- 唯一 rate identity。

Published price version 和 rate 不可修改。被 reservation 或 event 引用后禁止删除。

### 8.2 家庭策略

model_usage_family_policies：

- family_id 唯一；
- monthly_budget_cny，可空；
- alerts_enabled；
- hard_limit_enabled；
- policy_version；
- tracking_started_at；
- created_at、updated_at。

规则：

- hard_limit_enabled 要求 monthly_budget_cny 大于零；
- capability guardrail 只能在 monthly_budget_cny 大于零时配置；
- hard_limit_enabled=false 时，家庭预算和 capability guardrail 只生成状态与提醒，不阻止 provider；
- hard_limit_enabled=true 时，家庭预算和 capability guardrail 同时进入 reserve 判定；
- 固定提醒阈值不存为自由输入；
- 更新必须携带 base_version；
- 保存成功 policy_version 加一；
- 活动日志只记录“更新了模型预算设置”，不写预算金额。

model_usage_capability_limits：

- family_id、policy_version、capability；
- limit_kind 为 cost 或 meter；
- meter 在 cost 限制时为空，在 meter 限制时为受控原生 meter；
- limit_value；
- enabled；
- 每个 capability 首版最多一个 active guardrail。

### 8.3 强一致 counter

model_usage_period_counters：

- family_id；
- 北京时间 period_start、period_end；
- counter_kind：family_cost、capability_cost 或 capability_meter；
- capability、meter；
- 非空 dimension_key；
- settled_value，只累计正式 event；
- reserved_value，只累计 active reservation；
- adjustment_value，只累计追加式 adjustment delta；
- version；
- health_status；
- last_verified_at；
- created_at、updated_at。

唯一键使用 family_id、period_start 和 dimension_key。MySQL nullable unique 不能作为逻辑唯一性保证。

### 8.4 Reservation

model_usage_reservations：

- id、attempt_key、fingerprint；
- family_id、subject_type、subject_user_id；
- capability、provider、requested_model、billing_model、variant_key；
- policy_version；
- price_version_id；
- period_start、period_end；
- reserved_cost_cny；
- status；
- provider_request_id；
- reserved_at、dispatching_at、expires_at、updated_at；
- usage_event_id，可关联 billed 或 not_billed event；
- error_code。

model_usage_reservation_meters：

- reservation_id；
- meter；
- reserved_quantity；
- unit price 和 CNY 价格快照；
- meter_key 唯一。

Reservation 状态：

- reserved
- dispatching
- settled
- released
- uncertain

### 8.5 Event 与 meter

model_usage_events：

- id、reservation_id、attempt_key、fingerprint；
- family_id、subject_type、subject_user_id；
- capability、provider；
- requested_model、reported_model、billing_model、variant_key；
- price_version_id；
- period_start、period_end；
- provider_outcome：succeeded、failed_billed、not_billed、unknown；
- measurement_status：exact、estimated、unpriced；
- source_cost、source_currency、fx_to_cny、cost_cny；
- provider_request_id；
- dispatched_at、completed_at、created_at；
- estimation_reason、stable_error_code；
- 不含业务内容。

model_usage_event_meters：

- event_id；
- meter；
- quantity；
- quantity_source：provider、server_measured、estimated；
- unit_quantity；
- source unit price、currency、FX、CNY unit price 快照；
- cost_cny；
- meter_key 唯一。

### 8.6 Adjustment

model_usage_adjustments 保存追加式修正：

- adjustment group ID 和 line ID；
- idempotency_key、fingerprint；
- family_id、period；
- source event 或 reservation；
- capability、meter；
- meter_delta；
- cost_delta_cny；
- reason_code、operator、change_ticket、evidence_ref；
- created_at。

Adjustment 与 counter 更新同一事务。负 adjustment 不删除历史 event 或历史提醒。

### 8.7 Monthly rollup

model_usage_monthly_rollups：

- family_id、period；
- rollup_kind 和非空 dimension_key；
- subject、capability、provider/model、meter 等规范化维度；
- exact、estimated、unpriced、uncertain、unmeasured 数量；
- meter total、cost total；
- source event count、source adjustment count；
- revision、source watermark、checksum；
- computed_at。

rollup_kind 至少包含：

- family_total；
- subject_total；
- capability_total；
- provider_model_total；
- meter_total；
- daily_capability_cost。

daily_capability_cost 长期保存每个账期的按日趋势，因此 13 个月后清理原始 event 不会让历史页面丢失日趋势。相同输入必须产生相同汇总和 checksum。旧账期后续收到 adjustment 时增加 revision，不重复累计。

### 8.8 Alert

model_usage_alerts：

- family_id、period、policy_version、threshold；
- budget 和 settled 快照；
- severity、created_at；
- family、period、policy_version、threshold 唯一。

model_usage_alert_receipts：

- alert_id、Owner user_id；
- seen_at、dismissed_at；
- alert_id、user_id 唯一。

普通成员不创建金额提醒 receipt。

### 8.9 Measurement incident

model_usage_measurement_incidents：

- family_id 可空；
- capability 可空；
- mode、cause_code；
- started_at、recovered_at；
- known_affected_attempt_count 可空；
- coverage：exact_scope、partial_scope、unknown_scope；
- source_instance；
- created_at、updated_at。

这张表表达计量完整度，不生成虚构用量或费用。数据库故障期间进程先打开本地 outage latch 并写结构化日志，恢复后刷入 incident；恢复前重启时由运维依据日志通过 CLI 补录。

### 8.10 外键、保留与删除

- 家庭业务表统一按 family_id 隔离并在家庭删除时级联。
- subject identity 使用稳定 key；成员退出后聚合显示“已退出成员”。
- 用户将来彻底删除时可以 SET NULL，但不把昵称或联系方式复制到账本。
- 原始 event、meter、reservation、adjustment、alert、receipt 和 incident 至少保留 13 个完整账期。
- price version/rate 只要被历史引用就长期保留。
- monthly rollup 长期保留，直到家庭删除。

## 9. 价格选择与 CLI

### 9.1 清单格式

价格清单使用 JSON，所有 Decimal 以字符串表达。清单包含：

- catalogVersion；
- effectiveFrom；
- reviewedAt；
- sourceRef；
- changeNote；
- fxRates；
- modelAliases；
- rates。

Rate identity 为 provider、billing model、capability、variant 和 meter。硬限额不允许依赖匹配任意模型的通配 rate。

### 9.2 价格选择

Reserve 时根据请求使用的 provider、billing model、capability、variant、meter 和当前时间选择价格，并锁定：

- price version；
- source rate；
- source currency；
- 人工 FX；
- CNY unit price；
- 账期。

Settle 使用 reservation 锁定的价格，不因为调用过程中发布新版本而改变。

Provider 返回版本化模型名时通过显式 alias 映射。若一个已经按已知 requested billing model 完成 priced reservation 的 attempt 返回未知 alias：

- 当前 attempt 使用 reservation 时锁定的 meter 和价格做 measurement_status=estimated 的结算，并记录 model alias 异常；
- 监控模式下后续同类调用仍可继续，但必须保持 estimated/measurement warning；
- 硬限额下已 dispatch 的当前 attempt 不能撤销，后续同类调用被拒绝，直到 alias 和价格目录补全；
- 如果 reservation 本身因为缺少价格而是 unpriced，event 继续保持 unpriced，不能借用相近模型价格。

### 9.3 价格 CLI

新增 backend/scripts/manage_model_usage_prices.py，使用当前 argparse 风格，业务逻辑位于可测试 service。

命令：

- validate：schema、Decimal、时区、枚举、alias、重复键、FX 和 unit 校验；
- diff：只读显示新增、变更、停止覆盖和 capability coverage；
- publish：校验 checksum 后原子发布；
- list、show：查看版本；
- coverage：对比七类实际配置，输出 covered、disabled、missing，支持 JSON；
- cancel：只取消未生效且未被引用的版本。

Publish 必须提供 operator、change-ticket、file 和 confirm-checksum。已发布版本不能就地修改；回滚通过新版本完成。

Publish 默认拒绝让任何当前已启用 provider/model/variant/meter 变成 missing。运维应先补全 rate 或先关闭对应 provider 配置；运行期 provider 静默返回未知 alias 仍按前述 measurement warning 和 hard-limit 拒绝规则处理。

### 9.4 Adjustment CLI

backend/scripts/maintain_model_usage.py 提供 adjustment preview/apply：

- preview 输出家庭、账期、能力、counter、rollup 和提醒影响及 checksum；
- apply 要求 confirm-checksum、operator、change ticket 和 evidence ref；
- 同 idempotency key 相同 fingerprint 重放返回原结果；
- 同 key 不同 fingerprint 拒绝；
- 无可靠证据的计量缺口只记录 incident，不编造 adjustment。

## 10. Usage Core

### 10.1 标准上下文

Capability adapter 构造不含内容的 UsageContext：

- family_id；
- subject_type、subject_user_id；
- capability；
- provider；
- requested_model、billing_model、variant_key；
- operation_kind；
- attempt_key；
- 业务来源只使用受控枚举，例如 interactive、background_index、image_job；
- 可选的已校验 job/session/run ID；
- 不包含 prompt、query、文本、文档或媒体。

### 10.2 Reserve

Estimator 根据明确请求上限生成保守 meter：

- LLM 使用输入估算和明确 output token cap；
- realtime 使用未来 30 秒 lease；
- 图片使用张数、尺寸和质量；
- STT 使用服务端测得时长；
- TTS 使用实际发送的最终文本计量；
- Embedding 和 Rerank 使用真实 batch/candidate 大小。

Reserve 流程：

1. 校验可信归因和 capability contract；
2. 选择并锁定价格与账期；
3. 按 family cost → capability cost → capability meter 顺序锁 counter；
4. 检查：

       settled + reserved + adjustments + new reservation <= limit

5. 创建 reservation 和 meter；
6. 更新 reserved counter；
7. 独立事务提交；
8. 返回允许、拒绝或监控模式未定价结果。

未知价格：

- 监控模式允许，reservation 标记 unpriced；
- 硬限额模式在 provider dispatch 前返回 price unavailable。

账本完全不可用：

- 监控模式 fail-open、打开 outage latch 并记录 incident；
- 硬限额模式 fail-closed，provider 不得被调用。

### 10.3 Dispatch

调用 provider 前将 reservation 从 reserved 原子改为 dispatching。状态写入失败时：

- 监控模式按 fail-open 规则记录计量故障；
- 硬限额不得发送 provider 请求。

SDK 隐式 retry 必须关闭。每个业务显式 retry 创建新的 attempt key。

### 10.4 Settle

Provider 返回后，adapter 生成不含内容的标准 meter：

- provider 精确 usage 优先；
- 服务端可测事实次之；
- 稳定 estimator 最后；
- 不能把缺失 usage 当成零。

Settle 在一个独立事务中：

1. 锁 reservation 和对应 counters；
2. 复核 idempotency；
3. 创建唯一 event 和 meter；
4. 从 reserved counter 移除预留；
5. 将真实 cost/meter 加入 settled；
6. 更新 reservation 为 settled；
7. 评估预算阈值并原子创建 alerts；
8. 返回 usage receipt。

若 provider 明确拒绝且保证无计费，创建 provider_outcome=not_billed 的 event、释放预留并将 reservation 标为 released。若 provider 是否执行不明确，进入 uncertain。

Settle 失败不能撤销已经产生的 provider 费用。返回给业务侧的结果不应因为计量写入失败而伪装成 provider 未执行；maintenance 负责补偿，受影响 hard-limit counter 在无法确认时 fail-closed。

### 10.5 Uncertain

- dispatching 超过 provider timeout 加宽限期后转 uncertain；
- 如果 provider 支持 request ID 查询，只查询原 attempt 状态，不重新生成；
- 24 小时内保持预留占用；
- provider 明确未执行时 release，并保留 not_billed 结果；
- provider 返回用量时正常 settle；
- 24 小时仍不确定时按 reservation 和锁定价格生成 provider_outcome=unknown、measurement_status=estimated 的 event；
- 后续精确数据通过 adjustment 修正。

### 10.6 独立事务

用量事务不提交或回滚调用方业务事务：

- provider 已执行但 MinIO、Qdrant 或业务写入失败，usage 仍结算；
- 调用方业务事务回滚不删除 usage；
- usage reserve/settle 不能顺带提交未批准 Draft 或其他业务修改。

## 11. 七类能力接入

| 能力 | 主要入口 | 归因 | 主要 meter | 限额后行为 |
| --- | --- | --- | --- | --- |
| LLM/视觉 | openai_chat、openai_responses 和 provider round | 当前用户或明确 system workflow | input、cached input、output Token | 使用轻量模型或阻止；不得无 output cap 调用 |
| Embedding | 查询 embedding、vector indexing、search jobs | 查询归用户；索引归家庭 system | embedding Token | 查询回退关键词；后台 job 为 budget_blocked |
| Rerank | search/rerank | 当前用户 | 请求数、候选文档数 | 回退本地排序 |
| STT | ai_audio API/service | 当前用户 | 服务端测得输入音频秒数或 provider 音频 Token | 提示改用文字输入 |
| TTS | ai_audio service | 当前用户 | 最终发送文本字符/Token，或输出音频秒数 | 保留文字结果，不生成语音 |
| 实时语音 | realtime session/turn/segment | 当前用户 | 输入/输出音频秒数或音频 Token | 不续租并友好结束；中间 LLM 单独计量 |
| 图片生成 | generation/job | job 发起用户 | 张数及 size/quality variant | 不调用 provider，job 返回预算错误 |

### 11.1 LLM 与视觉

- 每个真实 provider round 单独 reservation 和 event；
- Chat Completions 与 Responses 都接入；
- streaming 完成、取消或断开都结算已发生用量；
- tool/script 本身不计模型费用；
- max_retries 设为 0，显式 retry 分开计量；
- 硬限额要求 provider 请求有明确 output token cap；
- trace 完全关闭时仍产生 usage。

### 11.2 Embedding

- 调度前按 family_id 拆 batch；
- 查询 embedding 归当前用户；
- 后台索引归家庭 system；
- provider 成功但 Qdrant 写入失败不能重做 embedding；
- budget_blocked 不增加 provider attempt_count；
- 新账期或策略放宽后，后台索引可以用新 attempt 安全重排队。

### 11.3 Rerank

- provider 被预算阻止或明确失败时使用本地排序；
- 本地 fallback 不计模型用量；
- 执行情况未知时进入 uncertain，同时可返回本地结果；
- ledger 不保存 query 或候选文档。

### 11.4 STT

- 时长由服务端解析，不信任客户端；
- 超大小、超时长和格式错误在 dispatch 前拒绝；
- 转写内容不入账本；
- provider 已执行但后续业务处理失败仍结算。

### 11.5 TTS

- 按真正发送给 provider 的清洗后文本计量；
- 空文本在 dispatch 前拒绝；
- 本地音频缓存命中且没有 provider 调用时不产生 event；
- provider 成功但媒体保存失败不能重新合成；
- 失败不影响文字结果。

### 11.6 实时语音

- 使用 turn/segment 和未来 30 秒 lease；
- 建立 WebSocket 连接本身不形成用量 event；
- 每个 session/segment/lease sequence 生成稳定 attempt key，每个已 dispatch 的结算单元最多一个 event；
- provider 返回 session 累计 usage 时，adapter 保存单调 watermark 并只结算本 lease 的增量，不能重复累计；
- 续租前重新 reserve；
- 不续租时停止发送后续远程音频；
- 输入、输出音频分别结算；
- 内部 STT/TTS 计入 realtime_audio；
- 中间明确 LLM 调用仍计入 llm，不能双算；
- session 跨月时新 lease 使用新账期。

### 11.7 图片生成

- reserve 发生在 provider attempt_count 增加之前；
- 预算阻止不调用 provider；
- provider 成功、MinIO 或业务绑定失败时 usage 已结算；
- 媒体保存或绑定补偿不得重新生成；
- reference image、prompt、生成图片和媒体 URL 不进入 ledger。

## 12. 预算、提醒与降级

### 12.1 家庭预算

- 月度人民币预算作用于 family cost counter；
- hard limit 默认关闭；
- 没有预算时仍统计但不提醒或限制；
- Owner 可以开启固定 80%、100%、110% 提醒；
- reminder 由 settled + adjustments 跨线触发，不由普通 reservation 触发；
- 同 family、period、policy version、threshold 唯一；
- 一次大额 settlement 跨越多个阈值时可写入各阈值事实，通知中心优先呈现最高的当前关注状态。

### 12.2 能力护栏

每个能力首版最多一个 active 护栏：

- capability cost；
- 或该能力支持的一个原生 meter。

家庭总预算和能力护栏都必须通过。任何一个失败都按该能力的降级规则处理。

### 12.3 稳定错误码

至少包括：

- model_usage_budget_exceeded
- model_usage_capability_limit_exceeded
- model_usage_price_unavailable
- model_usage_ledger_unavailable
- model_usage_reservation_conflict
- model_usage_attempt_conflict
- model_usage_settlement_pending
- model_usage_policy_conflict

前端由中央 options/model 映射中文文案，不在各调用点散落字符串判断。

### 12.4 使用现场提示

- Rerank：模型排序额度达到限制，本次已改用基础排序。
- TTS：语音生成暂不可用，文字内容不受影响。
- STT：语音转文字额度不足，请改用文字输入。
- 图片：本次没有向服务商发起请求。
- LLM 降级：当前使用较轻量模型，回答质量可能不同。
- 硬限额下 ledger 不可用：无法确认额度，为避免超出预算，本次未发起模型调用。

普通成员提示不得包含家庭金额。

## 13. API 与权限

### 13.1 个人接口

- GET /api/model-usage/me/overview
- GET /api/model-usage/me/breakdown

返回当前用户在当前家庭的个人聚合、原生 meter、成本和计量健康，以及粗粒度家庭预算状态。

### 13.2 Owner 接口

- GET /api/model-usage/family/overview
- GET /api/model-usage/family/breakdown
- GET /api/model-usage/family/policy
- PUT /api/model-usage/family/policy

Owner 可以按 capability、provider/model、member/system 聚合，但首版不提供逐笔调用流水。

### 13.3 Alert 接口

- GET /api/model-usage/alerts
- POST /api/model-usage/alerts/{id}/seen
- POST /api/model-usage/alerts/{id}/dismiss

每个 Owner 的 seen/dismiss 独立。普通成员不接收金额提醒。

### 13.4 权限

普通成员可以看到：

- 自己的成本、meter、capability 和 model 聚合；
- 自己的 exact、estimated、unpriced、uncertain 状态；
- 家庭预算粗粒度状态；
- 当前能力是否受到家庭策略影响。

普通成员不能看到：

- 家庭预算金额或百分比；
- 家庭总成本；
- 其他成员或 system 聚合；
- capability limit 数值；
- Owner 提醒记录。

Owner 的用量权限不扩展成私有内容权限。Owner 不能通过 usage API 读取其他成员 conversation、source、trace、query 或 media。

### 13.5 Policy OCC

PUT 请求携带 base_version。版本过期返回 409，并包含 currentPolicy 和稳定 recoveryHint。前端保留草稿，允许用户查看最新设置后重新应用，不能静默覆盖。

### 13.6 响应 contract

- Decimal 以字符串返回；
- 小于一分钱但大于零不返回为零；
- estimated、unpriced、uncertain、pending 和 unmeasured 可以同时表达；
- 普通成员响应中越权字段应不存在，而不只是 null；
- query key 必须包含 familyId、scope、period 和 groupBy。

Measurement health 至少表达：

- exact
- estimated
- unpriced
- uncertain
- pending
- unmeasured

## 14. 应用内提醒

通知中心把现有 AppNotificationJob 重构为可辨识联合：

- background_task
- model_usage_alert

通知中心标题改为“通知”，按“需要关注 / 正在处理 / 最近完成”组织。

- 模型提醒每 60 秒刷新；
- 窗口 focus 时 refetch；
- 首版不增加 SSE；
- 点击提醒进入对应家庭、账期和模型用量页面；
- dismissed 提醒不重复显示；
- 普通成员不收到金额提醒；
- 使用现场限额提示不依赖通知轮询。

## 15. 模型用量页面

### 15.1 入口与账期

- 家庭工作区增加独立“模型用量”页面；
- 默认当前北京时间自然月；
- 支持按月查看历史；
- 首版不支持任意日期范围；
- 首月显示 tracking_started_at 和“本月数据不包含此前调用”。

Owner 顶部提供“家庭 / 我的”切换；普通成员只进入“我的用量”。

### 15.2 Owner 家庭视图

信息顺序：

1. 本月预算摘要；
2. 最重要的需要关注状态；
3. 七类能力用量；
4. 按天趋势和 capability、provider/model、member/system 聚合；
5. 计量完整度。

预算摘要分别展示：

- settled + adjustments 的已记录费用；
- 当前 reserved；
- uncertain 或待核查；
- hard limit 是否开启；
- exact、estimated、unpriced、unmeasured 状态。

Progress 只表示已记录费用，不把预留伪装成已消费；额度判断仍包含 reserved。

金额格式：

- 零显示 ¥0.00；
- 大于零但不足一分钱显示小于 ¥0.01；
- 估算使用约等于符号；
- 未定价显示“未定价”，不显示 ¥0.00。

### 15.3 普通成员视图

显示个人成本、meter、capability/model 聚合和计量状态。家庭只显示：

- 额度充足；
- 接近上限；
- 达到提醒线；
- 部分功能可能降级；
- 计量服务暂时异常。

不返回家庭金额、百分比、其他成员或 system 数据。

### 15.4 预算设置

- 桌面使用右侧抽屉；
- 手机使用全屏设置视图；
- 字段包含月预算、应用内提醒、hard limit 和可选能力护栏；
- hard limit 开启前显示未知价格和 ledger 故障的影响；
- 当前 active 配置存在价格缺口时，Owner 仍可在一次明确确认后保存 hard limit；缺价路径从保存生效起直接拒绝，不会静默放行；
- 保存使用 base_version；
- busy 阻止重复提交；
- 失败保留草稿；
- 409 提供恢复路径。

### 15.5 响应式与视觉

- 手机使用独立信息排序，不是桌面表格压缩；
- 手机模型聚合使用列表，不强迫横向滚动；
- 无常驻主 CTA，不增加遮挡内容的悬浮按钮；
- 使用 Culina 暖白、轻边框和规范卡片层级；
- 橙色只用于当前选择、保存和关键确认；
- 不做企业监控大屏、巨大 KPI、发光渐变或厚重阴影；
- 状态使用文字、图标和语义色，不只靠颜色；
- 图表提供文本摘要或列表；
- 数字使用稳定数字样式；
- 处理 safe area、键盘、长模型名、200% 文本缩放和 reduced motion。

目标视口：

- 360 × 800；
- 390 × 844；
- 768 × 1024；
- 1440 × 900。

### 15.6 页面状态

必须覆盖：

- 首次 loading；
- 背景刷新；
- 有旧数据的刷新失败；
- 完全错误；
- empty；
- partial month；
- estimated；
- unpriced；
- uncertain；
- unmeasured；
- hard-limit active；
- policy conflict；
- 无家庭上下文；
- 家庭切换；
- 离线缓存和恢复。

家庭切换时取消或隔离旧请求，不能短暂显示上一家庭数据。

## 16. 聚合、补偿和保留

### 16.1 当前月与历史月

- 当前月预算摘要读取强一致 counter；
- 当前月 breakdown 从有索引的 event、meter、adjustment 聚合，可短缓存；
- 历史月份读取 monthly rollup；
- rollup 不作为 hard-limit 实时判断来源。

### 16.2 Maintenance worker

新增 ModelUsageMaintenanceWorker，通过 FastAPI lifespan 启停，沿用当前图片和搜索 worker 形态，不新增微服务。

要求：

- 独立 session；
- 短批次、短事务；
- 单任务异常不终止 worker；
- 多实例通过 SKIP LOCKED、唯一键和幂等安全竞争；
- MySQL named lock 只能作为减少重复工作的优化；
- worker 不发起新的模型生成，只查询已有 provider request 状态；
- shutdown 完成当前短批次后退出。

默认任务：

| 任务 | 频率 | 职责 |
| --- | ---: | --- |
| incident_flush | 每 15 秒或恢复后立即 | 持久化 outage latch |
| reservation_reconcile | 每 30 秒 | 释放未 dispatch 过期预留、标记失联 dispatch |
| uncertain_reconcile | 每 5 分钟 | 查询已有 attempt；24 小时后保守结算 |
| alert_repair | 每 5 分钟 | 修复遗漏阈值提醒 |
| rollup_refresh | 每 15 分钟 | 刷新 dirty family/period |
| counter_audit | 每小时 | 对账 ledger、adjustment、active reservation |
| price_coverage_check | 启动、发布后、每日 | 检查七类价格覆盖 |
| retention_prune | 北京时间每日 03:30 | 校验后清理完整账期 |

### 16.3 Counter audit

校验：

    counter settled_value = settled event cost
    counter adjustment_value = adjustment delta
    counter reserved_value = active reservation cost

额度判断使用 settled_value + adjustment_value + reserved_value；三个来源保持独立，避免 adjustment 被重复计入。

发现差异后按固定锁顺序二次复核。Counter 是派生数据，可以在锁内从 ledger 重建；event 不可修改。无法安全修复时：

- hard limit 对受影响范围 fail-closed；
- monitoring fail-open 并显示 measurement incident。

### 16.4 Rollup

- 根据 event 和 adjustment 确定性重建；
- 保存 source count、watermark、revision 和 checksum；
- adjustment 到达旧账期时重建对应 revision；
- 不因重建重新选价；
- unpriced、estimated 和 unmeasured 事实长期保留。

### 16.5 Retention

只按完整账期清理。账期结束已满 13 个月后才有资格。

清理前要求：

- 无 reserved、dispatching、uncertain；
- 所有聚合维度 rollup 存在；
- event、adjustment 数量一致；
- cost、meter、unpriced 和 health 汇总一致；
- checksum 一致。

任一失败时整个 family/period 不删除。支持 dry-run、verify-only、family、period 和 batch-size。Price history 与 monthly rollup 不随原始事件清理。

## 17. 可观测性与隐私

第一版不引入新的 Prometheus 栈，使用：

- Python 标准 logging 的稳定结构化事件；
- maintain_model_usage.py health；
- Owner measurement health；
- 部署环境现有日志采集。

稳定指标语义：

- model_usage_budget_decisions_total
- model_usage_provider_attempts_total
- model_usage_reservations_current
- model_usage_settlement_lag_seconds
- model_usage_uncertain_current
- model_usage_unpriced_events_total
- model_usage_fail_open_total
- model_usage_attempt_conflicts_total
- model_usage_counter_drift_total
- model_usage_rollup_lag_seconds
- model_usage_maintenance_runs_total
- model_usage_price_coverage_missing

family_id、user_id、event ID 和完整动态 model ID 不作为高基数指标标签。

日志允许 provider、billing model、capability、meter、内部记录 ID、attempt key hash、状态、稳定错误码和数值用量。禁止记录任何业务内容、凭据、Authorization header 或可能带内容的 provider 原始错误响应。

Health CLI 输出价格覆盖、最近 event、未定价数量、最老 active/uncertain reservation、counter drift、rollup lag、打开的 incidents 和 retention 状态；支持 JSON 和非健康非零退出码。

现有 /api/health 继续只承担进程 liveness，不因价格缺口、rollup 延迟或计量 incident 返回失败并触发无意义的容器重启。首次启动的 MODEL_USAGE_REQUIRED preflight 可以阻止错误部署；运行期健康问题通过 capability 决策、health CLI、结构化日志和页面 measurement health 表达。

## 18. Migration 与首次部署

### 18.1 Alembic

新增正常 revision，不修改旧 migration。按外键依赖创建价格、policy、counter、reservation、event、adjustment、rollup、alert 和 incident 表。

- 时间存 UTC，账期按 Asia/Shanghai 计算；
- source price、FX、CNY unit price 和 cost 使用 Numeric(30, 12)；
- 可含小数的 meter quantity 使用 Numeric(30, 6)，Token、字符和图片数量在 service 层额外校验为整数；
- 规范 dimension_key 避免 MySQL nullable unique 陷阱；
- 当前家庭初始化默认 policy；
- 新家庭在创建事务中同步创建 policy；
- 不回填历史用量。

默认 policy：

- monthly_budget_cny 为空；
- alerts_enabled=true；
- hard_limit_enabled=false；
- policy_version=1；
- tracking_started_at 为迁移或家庭创建时间；
- 无 capability guardrail。

### 18.2 正式环境配置

- MODEL_USAGE_REQUIRED=true；
- MODEL_USAGE_MAINTENANCE_ENABLED=true；
- MODEL_USAGE_DEFAULT_HARD_LIMIT=false；
- required capability 固定为七类。

不提供允许生产 provider 绕过 ledger 的普通总开关。

### 18.3 一次性首发顺序

1. 构建同时包含 migration、CLI、core、七类 adapter、API 和 worker 的制品；
2. 保持系统未对外开放，确认无跨版本运行中 provider attempt；
3. 备份或确认数据库可重建；
4. upgrade head；
5. 校验默认 policy 和无历史 usage 回填；
6. validate、diff、publish 首个价格目录；
7. coverage 要求七类全覆盖；
8. 运行 schema、价格、adapter、retry、账期和 worker preflight；
9. 启动 backend；
10. 使用测试家庭完成七类最小真实 provider smoke；
11. 验证个人/家庭聚合、权限、meter、价格快照和 health；
12. 启动 frontend 并完成四类视口验收；
13. 全部门禁通过后正式开放访问。

系统未上线，因此不实现家庭 allowlist、百分比 rollout、双写、shadow event、cohort 或按能力分阶段开放。

### 18.4 故障恢复

- 单能力问题：关闭对应 provider，使用既定 fallback；
- 价格错误：发布新版本，历史必要修正走 adjustment；
- counter/ledger 问题：monitoring fail-open 并记 incident，hard-limit fail-closed；
- backend 问题：暂停访问或关闭 provider，向前修复；
- 绝不回滚到可以调用 provider 但没有 usage adapter 的旧版本；
- 有正式 usage 数据后不把 Alembic downgrade 作为常规恢复方式。

## 19. 测试与验收

### 19.1 测试层级

- 纯领域测试：价格、Decimal、账期、状态机、estimator；
- service 测试：reserve、settle、adjustment、counter、rollup；
- MySQL 8.4 集成：行锁、SKIP LOCKED、唯一性、并发、Numeric；
- provider contract：本地 fake HTTP/WebSocket；
- API：权限、IDOR、family scope、OCC 和 response schema；
- 前端：view model、query key、缓存、组件状态和无障碍；
- E2E：Owner、普通成员、通知、设置和移动端；
- 运维：CLI、worker、incident、rollup 和 prune；
- 首发：七类真实 provider 最小 smoke。

SQLite 结果不能替代 MySQL 并发和 migration 验证。

### 19.2 核心并发门禁

家庭预算 ¥100、50 个并发请求各预留 ¥3：

- 恰好 33 个成功；
- 17 个被拒绝；
- reserved 合计 ¥99；
- 无超卖、负 counter、重复 reservation 或静默放行。

实际费用高于预留时必须真实结算，之后阻止新调用。负 adjustment 更新 counter 和 rollup，但不删除历史 event 或提醒。

### 19.3 Crash 与幂等

覆盖以下崩溃点：

- reserve 后、dispatch 前；
- dispatch 标记后、请求发送前；
- 请求发送后、响应前；
- provider 成功后、settle 前；
- settle 提交后、业务响应前；
- provider 成功后调用方业务回滚；
- adjustment 提交后 CLI 输出前；
- rollup/prune 事务中途失败。

预期不重复 provider call、不重复结算、不漏记已发生费用，uncertain 可补偿。

### 19.4 七类共同矩阵

每个 capability 都覆盖：

- exact、estimated、unpriced；
- 预算充足、家庭预算不足、capability cost/meter 不足；
- monitoring ledger fail-open；
- hard-limit ledger fail-closed；
- provider 明确未执行；
- provider timeout/uncertain；
- streaming 或异步取消；
- attempt 重放；
- 显式 retry；
- adjustment；
- 跨家庭隔离；
- 内容和凭据不落账本、日志、API 或 CLI。

能力特有验收包括：

- LLM 多 round、streaming、缓存 Token、output cap；
- Embedding 个人查询/system 索引、跨家庭拆批、Qdrant 失败不重做；
- Rerank 本地 fallback；
- STT 服务端时长；
- TTS 最终文本 meter 和媒体失败不重做；
- realtime lease、续租、断线、跨月和 LLM 分账；
- 图片预算阻止 attempt_count 不增加、MinIO/绑定失败不重新生成。

### 19.5 权限与隐私

至少使用两个家庭、多名成员和退出成员测试：

- 请求体 family/user 伪造无效；
- Owner 只在当前家庭有效；
- 普通成员响应不存在家庭金额字段；
- Owner 聚合不能下钻私有内容；
- usage 子资源 IDOR 返回 404/403 的稳定安全行为；
- family 删除级联，成员退出保留历史；
- embedding、rollup、prune、alerts 全部保持 family scope。

使用秘密标记扫描 usage tables、logs、CLI 和 API，确认 prompt、response、query、文档、转写、TTS 文本、图片提示词、媒体 URL 和 API Key 完全不存在。

### 19.6 Policy、Alert 与 UI

- base_version 成功和 409；
- 保存失败保留草稿；
- 79% 无提醒，跨 80/100/110 分别唯一；
- reservation 不提醒；
- adjustment 和 policy version 重新评估；
- 每个 Owner receipt 独立；
- 普通成员无金额通知；
- loading、refreshing、stale、empty、partial、error、estimated、unpriced、uncertain、unmeasured、hard-limit、conflict、offline 全覆盖；
- 360×800、390×844、768×1024、1440×900；
- 键盘、焦点、屏幕阅读器、200% 缩放、reduced motion 和无横向溢出。

### 19.7 Rollup、Retention 与 CLI

- 相同输入相同 checksum；
- late adjustment 增加 revision；
- 多 worker 不重复；
- 未满 13 个完整月不删；
- rollup/checksum/active reservation 任一不满足时零删除；
- dry-run、verify-only 和失败重放；
- price validate/diff/publish/coverage/cancel；
- checksum、重叠版本、alias 循环、缺 FX 和 secret redaction；
- health、reconcile、audit、rollup、prune、adjustment preview/apply。

### 19.8 Migration 与性能

在 MySQL 8.4 的现有 head 数据库上：

1. seed 当前家庭、成员、trace、图片和搜索 job；
2. upgrade；
3. 验证 schema、索引、外键、默认 policy；
4. 确认旧业务数据未改写、usage 为空；
5. 创建新家庭并验证 policy 同事务；
6. reserve、settle、rollup；
7. family cascade；
8. 在可抛弃且无正式 usage 的库中验证 downgrade/upgrade。

对核心查询运行 EXPLAIN。参考环境使用单家庭单月 100,000 events、平均 3–5 meter、13 个月原始数据验证：

- reserve/settle 事务 p95 目标不超过 150 ms；
- current overview p95 目标不超过 300 ms；
- current breakdown p95 目标不超过 1 秒；
- historical rollup p95 目标不超过 500 ms；
- 正确性、查询计划和查询次数是自动门禁，绝对耗时在首发参考环境验收。

### 19.9 验证命令

实施完成后至少运行：

    cd backend
    .venv/bin/python -m pytest tests/model_usage -q
    cd ..
    npm run backend:quality
    npm run frontend:quality
    npm run frontend:build
    npm --prefix frontend run check:style-tokens
    npm run frontend:smoke
    npm run frontend:e2e:p0
    npm run db:up
    npm run backend:migrate

另外执行 MySQL 专项并发、price coverage、maintenance health、Alembic disposable upgrade/downgrade/upgrade、四类真实视口人工验收和七类真实 provider smoke。

### 19.10 Definition of Done

只有同时满足以下条件才可正式开放：

- 七类 adapter 和共享矩阵全部通过；
- 50 并发 reservation 不超卖；
- attempt replay/retry 不重不漏；
- provider 成功、业务失败仍结算；
- monitoring fail-open 形成 incident；
- hard-limit ledger 故障不调用 provider；
- hard-limit unknown price 不调用 provider；
- price coverage 七类全绿；
- counter audit 零漂移；
- rollup checksum 一致；
- retention 校验失败零删除；
- 普通成员无家庭金额或其他成员数据；
- Owner 无法推断私有内容；
- ledger/log/API/CLI 无业务内容；
- 四类视口、200% 缩放和无障碍可用；
- policy OCC 和 alerts 并发去重成立；
- migration 从当前 head 成功；
- 仓库质量命令通过；
- 七类真实 provider smoke 通过；
- 无未解决 P0/P1 正确性、权限或数据边界问题；
- 无 provider 发送点绕过 usage adapter。

## 20. 首发验收报告

首次开放前生成不含秘密的机器可读报告，记录：

- Git commit；
- Alembic revision；
- backend/frontend build 标识；
- price version 和 checksum；
- 七类 coverage；
- 七类 provider/model/variant；
- smoke 结果和 usage event ID；
- meter exact/estimated 状态；
- personal/family 归因结果；
- Owner/member 权限结果；
- maintenance health；
- 执行时间和操作者。

报告不记录 prompt、response、query、文档、录音、转写、图片、媒体 URL 或 API Key。

## 21. 设计完成条件

本规格已经明确：

- 产品范围、权限和隐私边界；
- 统一内核与七类 adapter 架构；
- 价格、ledger、reservation、event、adjustment 和 rollup；
- 并发、失败、retry、uncertain 和补偿语义；
- API、提醒和移动优先页面；
- CLI、maintenance、计量健康和 retention；
- 无灰度的首次部署顺序；
- 完整自动化与真实首发验收。

下一步在书面规格获得用户复核后，使用 writing-plans 生成逐文件、逐测试、可按小步提交执行的实施计划。本规格批准本身不授权实现代码。

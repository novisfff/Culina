# Culina 统一模型用量统计与额度治理设计

日期：2026-07-29

状态：设计与外部评审修订已获用户书面确认；已进入实施计划阶段

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
2. 为每个持久化 dispatch intent 及其可确认的 provider attempt 保存 meter、可用的价格快照或未定价状态、归因、执行确定性和结算状态。
3. 支持 Owner 查看家庭聚合，普通成员查看个人聚合和粗粒度家庭预算状态。
4. 支持家庭月度人民币预算、固定软提醒、可选硬限额和可选能力护栏。
5. 硬限额下通过原子 reservation 防止并发超卖。
6. 对 streaming、异步 job、显式 retry、取消、provider timeout 和业务保存失败进行分级恢复；无法确认第三方执行事实时保守标记 unknown，不伪装成精确结果。
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
- 对不支持幂等键且不能按客户端请求 ID 查询的第三方 provider 承诺外部调用 exactly-once、严格不误记或严格不漏记。

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
| 外部一致性 | 按 provider 恢复能力分级；无幂等/查询能力时不自动重试 ambiguous attempt，只能保守标记 unknown |
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
- 用户直接操作使用 attribution_kind=user 和当前认证 user_id，由 Usage Core 解析当前家庭内稳定 model_usage_subject。
- 后台索引、清理和系统任务使用 attribution_kind=system，解析家庭 system subject，不伪装成最后编辑成员。
- 一个 embedding provider batch 只能包含一个 family_id；跨家庭输入必须先拆批。
- 用量 service 使用独立 SQLAlchemy session，不复用或提交调用方业务事务。
- 家庭删除级联删除该家庭账本；成员退出不删除家庭历史。

### 6.2 Attempt 与结算

- attempt_key 和 client_attempt_id 在 reserve 前生成，并在一次逻辑 provider attempt 内保持稳定。
- dispatching 表示“发送意图已经持久化”，不证明请求字节已经离开进程，也不证明 provider 已接收。
- 预算阻止、参数校验失败或过期但从未进入 dispatching 的 reservation 不形成 event。
- 进入 dispatching 后最终形成一条 event；event 的 execution_certainty 明确区分 confirmed_executed、confirmed_not_executed 和 unknown。
- provider 已确认未执行时，形成 execution_certainty=confirmed_not_executed、provider_outcome=not_billed 的零费用 event。
- provider 已确认执行但明确不计费时，形成 execution_certainty=confirmed_executed、provider_outcome=not_billed 的零费用 event；“未计费”不能反推“未执行”。
- provider 可能执行或已产生用量时，必须 settle 或进入 uncertain，不能假定免费。
- 每个 dispatch intent 最多形成一个正式 event；execution_certainty=unknown 的 event 不能被描述成已确认真实调用。
- 业务明确发起新的、可能产生新费用的 retry 时，使用新的 attempt key、reservation 和 event。
- 支持 provider 幂等键时，对同一外部 attempt 的 transport recovery 复用原 attempt key 和 provider_idempotency_key；它不是新的计费 retry。
- 同 attempt key、同 fingerprint 重放返回原结果。
- 同 attempt key、不同 fingerprint 返回稳定冲突。
- event 追加式不可修改；修正使用 adjustment。
- provider 实际费用高于 reservation 时仍按真实值结算，并阻止后续请求。
- streaming、用户取消和客户端断开不代表费用为零。

Provider adapter 必须声明 recovery_mode：

- idempotency_key：provider 接受稳定幂等键；相同 payload fingerprint 可以安全恢复同一外部 attempt；
- queryable_request：provider 接受 dispatch 前已持久化的 client_attempt_id 作为查询相关 ID，并可以按它查询执行结果；
- idempotency_and_queryable：同时满足上述两项，resend 和只读 query 分别遵循各自截止时间；
- none：既无幂等键也无法可靠查询。

只有在请求发送前已经持久化、且 provider 接受并可查询的相关 ID 才能让 adapter 声明 queryable_request 或 idempotency_and_queryable。仅能使用 provider 接收后才返回的 provider_request_id，不足以覆盖“请求已执行但该 ID 尚未落库”的崩溃窗口；该窗口仍按 recovery_mode=none 处理。

Adapter contract 按支持的机制分别声明 provider 保证的 idempotency_window_seconds、query_window_seconds 及对应官方依据，并为 idempotency resend 声明不晚于 24 小时的 automatic_resend_deadline_seconds。resend deadline 还必须受用户操作/job 的业务截止时间约束，不能因为 provider 幂等窗口很长就在用户操作结束后首次触发迟到生成；只读 query 不受 resend deadline 限制，但仍受 provider query window 限制。对应幂等键或查询窗口过期后，系统不得继续假定该机制的恢复保证有效；没有剩余可用机制的 attempt 按 recovery_mode=none 的 unknown 规则处理。

对于 recovery_mode=none，系统明确不承诺同时做到“不重复调用、不漏记费用、不误记费用”。崩溃可能发生在发送意图持久化之后、真实 socket send 之前，也可能发生在 provider 执行之后、本地拿到 request ID 或响应之前。系统只保证：

- 不对 ambiguous attempt 执行无人值守的自动 provider retry；
- 保留 unknown 状态和原 reservation；
- 24 小时后可以为了额度治理进行保守 estimated settlement；
- UI、API 和 rollup 明确标记 execution_certainty=unknown 与 measurement_status=estimated；
- 不把该估算称为 provider 已确认费用。

### 6.3 金额与内容

- 所有价格、汇率、meter 小数和成本使用 Decimal/Numeric，不使用 float 做治理判断。
- 价格目录把 source price × FX 量化为 12 位小数时使用 ROUND_HALF_UP。
- 精确结算先以完整 Decimal 计算 quantity / unit_quantity × unit_price_cny，不对中间比例舍入；最终每条 billable meter cost 量化为 12 位小数时使用 ROUND_HALF_UP，event cost 是这些已量化 line cost 的精确和。
- Reservation 先使用保守 quantity，再把每条非负 billable line cost 以 ROUND_CEILING 量化到 12 位小数，避免定点量化造成低于估算的预留。
- Counter 和 limit 比较始终使用完整 Numeric(30, 12)，不能先四舍五入到分。
- 两位小数、约等于和小于一分钱只属于 API/UI 展示，不参与 reserve、settle、adjustment 或 alert 判断。
- 历史 event 保存 source currency、source rate、人工审核 FX 和 CNY 单价快照。
- 价格发布后不自动重算历史。
- 账本、日志、API、CLI 和 rollup 不保存 prompt、回复、query、文档、TTS 文本、STT 转写、录音、图片、媒体 URL 或 embedding 向量。
- attempt fingerprint 使用服务端秘密 HMAC 对规范化请求指纹计算，绝不保存或记录可被离线字典反推的裸内容哈希；provider_idempotency_key 使用独立随机值，不从业务内容派生。
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
- uncached_input_tokens
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
- request_units

Provider 特有 meter 必须先加入中央枚举、价格 schema、adapter contract、API 映射和测试，不能以任意字符串直接入账。

每条 meter line 必须声明 meter_role：

- billable：参与 reservation 和 event 成本计算；
- informational：只用于展示、核查或 provider 原始总量，不参与成本。

每个 price version 下的 provider、billing model、capability、variant 必须声明唯一 billing_scheme_key 和唯一 billable meter 集合。Adapter 负责把 provider 原始 usage 归一化成不重叠的 billable quantity：

- total_tokens 默认 informational；只有 provider 确实只按 total Token 定价，并且 input、cached input、output 全部 informational 时，total_tokens 才能 billable；
- provider 的 input_tokens 如果包含 cached input，且 cached input 有独立价格，则原始 input_tokens 为 informational，billable quantity 使用 uncached_input_tokens = input_tokens - cached_input_tokens，再加独立的 cached_input_tokens；adapter 必须拒绝 cached_input_tokens 大于 input_tokens 的异常响应，不能结算成负数；
- provider 不区分 cached 价格时，input_tokens 可以 billable，cached_input_tokens 只能 informational；
- 同一音频维度的 seconds 和 audio tokens 不能因为 provider 同时返回而自动同时计费；billing scheme 必须选定真实收费维度；
- provider 固定请求费使用 billable request_units，quantity 固定为 1，不允许绕过 meter line 直接塞入 event 总成本；
- generated_images、request_units 等与 Token 不存在包含关系的真实独立费用可以与 Token meter 同时 billable。

Priced reservation/event 的成本不变量：

    reservation.reserved_cost_cny
      = sum(reservation billable meter reserved_cost_cny)

    event.cost_cny
      = sum(event billable meter cost_cny)

Informational meter 的 cost_cny 必须为空，不得拥有可执行 price rate。Pricing status 与 measurement status 正交：同一 reservation/event 可以同时是 estimated 和 unpriced。只要 billing scheme 的任一必需 billable rate 缺失，整体 pricing_status 就是 unpriced、总成本为空；已知 rate 的 line 可以保留快照和 line cost，缺价 line 保留 quantity 和角色但 rate/cost 为空，不能把已知部分之和伪装成完整总成本或零。Adjustment 是 event 之后的独立 delta，不改变单个 priced event 的上述求和不变量。

不同能力的原生 meter 不跨能力相加。跨能力比较只使用 CNY 成本，同时保留 informational meter 供核查。

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
- billing_scheme_key；
- meter、meter_role、unit_quantity；
- billable rate 的 unit_price、source_currency；
- billable rate 的 fx_to_cny、unit_price_cny；
- 经过校验的 reported model aliases；
- 唯一 rate identity。

Published price version 和 rate 不可修改；首版永久保留，不因引用它们的 raw reservation/event 被清理而删除。只有未生效且从未被引用的 draft/cancelled version 才可按 CLI 规则清理。

### 8.2 稳定归因主体

model_usage_subjects：

- id 和随机、不可反查的 subject_key；
- family_id；
- subject_type：user 或 system；
- user_id，可空并在账号彻底删除时 SET NULL；
- anonymized_label 可空；账号彻底删除时按家庭事务性分配不含 PII 的稳定标签；
- 非空 dimension_key；
- created_at、unlinked_at；
- family/user 和 family/system 的逻辑唯一约束。

非空 anonymized_label 在家庭内唯一；分配时锁家庭 subject 序列，避免并发账号删除得到重复标签。

规则：

- subject_key 使用独立随机 ID，不直接包含 user_id，也不使用可被业务侧反查的明文拼接；
- 同一用户在同一家庭退出再加入时复用原 subject；不同家庭使用不同 subject；
- 每个家庭只有一个 system subject；
- reservation、event、adjustment 和 rollup 引用 subject_id/subject_key，不把 subject_user_id 复制到原始账本；
- 个人 API 通过当前 family_id + user_id 解析 subject，再查询该 subject 的聚合；
- 成员退出但账号仍存在时，UI 根据 membership 状态显示“已退出成员”；
- 账号彻底删除后 subject.user_id 置空，但不同已删除用户的随机 subject_key 仍彼此不同；Owner UI 使用持久化 anonymized_label（例如“已删除成员 1”“已删除成员 2”），不向 API 客户端暴露 subject_key，也不在每次查询时重新编号；
- subject 与长期 rollup 一起保留到家庭删除，不按 13 个月原始数据规则清理。

### 8.3 家庭策略

model_usage_family_policies：

- family_id 唯一；
- current_policy_version_id；
- tracking_started_at；
- created_at、updated_at。

model_usage_policy_versions：

- id、family_id；
- version_number，在家庭内单调递增且唯一；
- monthly_budget_cny，可空；
- alerts_enabled；
- hard_limit_enabled；
- budget_alert_revision；
- policy_checksum；
- created_by_subject_id、created_at、effective_at；
- 版本写入后不可修改。

model_usage_capability_limits：

- family_id、policy_version_id、capability；
- limit_kind 为 cost 或 meter；
- meter 在 cost 限制时为空，在 meter 限制时为受控原生 meter；
- limit_value；
- enabled；
- 每个 policy version/capability 首版最多一个 active guardrail；
- 与 policy version 一起不可变。

策略更新规则：

- hard_limit_enabled 要求 monthly_budget_cny 大于零；
- capability guardrail 只能在 monthly_budget_cny 大于零时配置；
- hard_limit_enabled=false 时，家庭预算和 capability guardrail 只生成状态与提醒，不阻止 provider；
- hard_limit_enabled=true 时，家庭预算和 capability guardrail 同时进入 reserve 判定；
- 固定提醒阈值不存为自由输入；
- 更新必须携带 base_version_number；
- 更新时锁定 model_usage_family_policies，复核 current version；
- 在一个事务中插入新的 immutable policy version、复制或写入该版本的 capability limits，再更新 current_policy_version_id；
- reservation 使用 reserve 时的 policy_version_id；以后修改家庭策略不改变已有 reservation 的判断快照；
- policy version 和其 capability limit 只在家庭删除时级联，不按 13 个月原始用量保留期清理；
- 活动日志只记录“更新了模型预算设置”，不写预算金额。

### 8.4 强一致 counter

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

### 8.5 Reservation

model_usage_reservations：

- id、attempt_key、client_attempt_id、fingerprint；
- family_id、subject_id、subject_key；
- capability、provider、requested_model、billing_model、variant_key；
- recovery_mode、idempotency_window_seconds、query_window_seconds、automatic_resend_deadline_at；不适用的窗口为空；
- provider_idempotency_key，可空；
- policy_version_id；
- pricing_status：priced、unpriced；任一必需 billable rate 缺失时整体为 unpriced；
- price_version_id；priced 时必填，unpriced 时可空，也可以指向存在部分 rate 的调用时版本；
- period_start、period_end；
- reserved_cost_cny；pricing_status=unpriced 时为空，不能写零；
- status；
- provider_request_id；
- reserved_at、dispatching_at、provider_acknowledged_at、expires_at、updated_at；
- error_code。

model_usage_reservation_meters：

- reservation_id；
- meter、meter_role；
- reserved_quantity；
- billable meter 的 unit price 和 CNY 价格快照；
- reserved_cost_cny；informational meter 或缺少 rate 的 unpriced billable meter 必须为空；
- meter_key 唯一。

Reservation 状态：

- reserved
- dispatching
- settled
- released
- uncertain

### 8.6 Event 与 meter

model_usage_events：

- id、reservation_id；只有 fail-open receipt recovery 时 reservation_id 可以为空；非空 reservation_id 唯一，reservation 不再反向保存 usage_event_id，避免循环外键；
- recovery_source：reservation、fail_open_receipt；
- attempt_key、fingerprint；
- family_id、subject_id、subject_key；
- capability、provider；
- requested_model、reported_model、billing_model、variant_key；
- pricing_status：priced、unpriced；
- price_version_id；priced 且 provider_outcome 不是 not_billed 时必填；unpriced 时可空，也可以指向存在部分 rate 的调用时版本；
- period_start、period_end；
- provider_outcome：succeeded、failed_billed、not_billed、unknown；
- execution_certainty：confirmed_executed、confirmed_not_executed、unknown；
- measurement_status：exact、estimated；它只表示 meter/执行事实的测量精度，不承担定价状态；
- provider_reported_source_cost、provider_reported_source_currency 可空，仅作 informational reconciliation；它们不进入 event cost、counter、限额或提醒，差异只能经受控 adjustment 处理；
- cost_cny；priced event 的 cost_cny 始终由各 billable meter line 求和，unpriced event 的总 cost_cny 为空；source currency、rate 和 FX 逐 meter 保存，避免多 rate event 使用含糊的根级价格字段；
- provider_request_id；
- dispatched_at、completed_at、created_at；
- estimation_reason、stable_error_code；
- 不含业务内容。

Outcome/certainty 组合受状态机约束：succeeded 和 failed_billed 必须是 confirmed_executed；unknown 必须配 unknown；not_billed 可以配 confirmed_not_executed，也可以表示“已执行但明确免计费”的 confirmed_executed。not_billed 是已确定的零成本结果，因此 event 使用 pricing_status=priced、总 cost_cny 为精确零，即使原 reservation unpriced 也不需要借用价格；price_version_id 可以为空，所有保留的用量 meter 作为 informational 事实，不产生 billable line。该例外不能用于掩盖缺价或缺失 usage。

model_usage_event_meters：

- event_id；
- meter、meter_role；
- quantity；
- quantity_source：provider、server_measured、estimated；
- unit_quantity；
- billable meter 的 source unit price、currency、FX、CNY unit price 快照；
- cost_cny；informational meter 或缺少 rate 的 unpriced billable meter 必须为空；
- meter_key 唯一。

### 8.7 Adjustment

model_usage_adjustments 保存追加式修正：

- adjustment group ID 和 line ID；
- idempotency_key、fingerprint；
- family_id、subject_id、subject_key、period；
- 必填 source_event_id，可选 source_reservation_id；没有可引用 event 的计量缺口只能记录 incident，不能直接创建 adjustment；
- capability、meter；
- meter_delta；
- cost_delta_cny；
- resolution_kind：meter_correction、pricing_correction、execution_resolution；
- resulting_provider_outcome、resulting_execution_certainty、resulting_measurement_status、resulting_pricing_status，按 resolution_kind 可空；
- pricing resolution 使用的完整 meter price snapshot、snapshot checksum 和 resolved_cost_cny，按 resolution_kind 可空；
- reason_code、operator、change_ticket、evidence_ref；
- created_at。

Adjustment 与 counter 更新同一事务。它既可以保存 meter/cost delta，也可以在可靠 provider 证据到达后追加 provider outcome、执行确定性、测量精度或定价状态的解析结果；原 event 保持不可修改，聚合按 event 加有序 adjustment 推导 effective state。unpriced → priced 的解析必须携带调用时或 provider 证据支持的完整 meter 价格快照和 resolved_cost_cny，cost_delta 等于新解析成本相对先前已计入 counter 成本的差额；不能使用 adjustment 时的当前价格目录追溯定价。负 adjustment 在锁内降低 adjustment_value，提交后立即释放相应家庭/能力额度供后续 reservation 使用；它不删除历史 event 或提醒，也不自动重放此前被阻止的用户调用。后台 budget_blocked 索引 job 可以在正常重新评估周期中重新排队。

Adjustment 接受窗口：

- source event 所在账期仍处于 correction_status=open 时，可以创建逐事件 adjustment；
- 原始数据清理前，rollup 可以根据新 adjustment 增加 revision；
- family_total rollup 不再处于 correction_status=open，或已标记 adjustment_closed_at 后，所有该 family/period 的逐事件 adjustment 都返回 model_usage_adjustment_window_closed；
- 首版不永久保留 event tombstone，也不支持直接修改已关闭 rollup dimension；
- 13 个月后才到达的 provider 修正只保留在外部运维工单，不写入 Culina 历史用量，不改变长期 rollup。

### 8.8 Monthly rollup

model_usage_monthly_rollups：

- family_id、period；
- rollup_kind 和非空 dimension_key；
- subject、capability、provider/model、meter 等规范化维度；
- effective exact、estimated、unpriced、uncertain、unresolved_unknown_execution_count、unresolved_known_unmeasured_count；
- has_unknown_measurement_gap；
- meter total、cost total；
- source event count、source adjustment count、source incident count；
- revision、source watermark、checksum；
- correction_status：open、pruning、closed；
- adjustment_closed_at、raw_data_pruned_at；
- computed_at。

rollup_kind 至少包含：

- family_total；
- subject_total；
- capability_total；
- provider_model_total；
- meter_total；
- daily_capability_cost。

daily_capability_cost 长期保存每个账期的按日趋势，因此 13 个月后清理原始 event 不会让历史页面丢失日趋势。状态类汇总使用 event 加 adjustment 推导出的 effective state：例如 unknown estimated event 被可靠证据解析后，不再计入 unresolved_unknown_execution_count。相同输入必须产生相同汇总和 checksum。correction_status=open 期间收到 adjustment 时增加 revision，不重复累计；原始数据通过清理校验后，family_total row 先记录最终 checksum 并关闭 adjustment 窗口，原始行全量删除后再标记 raw_data_pruned_at；此后该账期 rollup 不再从已删除原始数据重建或修改。

### 8.9 Alert

model_usage_alerts：

- family_id、period、policy_version_id、budget_alert_revision、threshold；
- budget、settled_value、adjustment_value 和 effective_spend 快照；
- severity、created_at；
- family、period、budget_alert_revision、threshold 唯一。

model_usage_alert_receipts：

- alert_id、Owner user_id；
- seen_at、dismissed_at；
- alert_id、user_id 唯一。

普通成员不创建金额提醒 receipt。

### 8.10 Measurement incident

model_usage_measurement_incidents：

- incident_key，幂等且唯一；
- family_id 可空；
- subject_id、subject_key 可空；
- capability 可空；
- period_start、period_end；
- mode、cause_code；
- started_at、recovered_at；
- coverage：exact_scope、partial_scope、unknown_scope；
- source_instance；
- created_at、updated_at。

model_usage_measurement_incident_attempts 保存最小化的已知受影响 attempt：

- incident_id、非空 family_id、subject_id 可空、capability 可空；
- client_attempt_id；
- recovery_status：unresolved、recovered；
- recovered_event_id 可空；
- created_at、resolved_at；
- family/client_attempt_id 逻辑唯一。

这张表表达计量完整度，不生成虚构用量或费用。跨北京时间账期的故障在持久化时切成逐账期 incident fragment，每个 fragment 使用稳定 incident_key，因此 family/period 清理不会误删仍被其他账期依赖的事实。数据库故障期间进程先打开本地 outage latch 并写结构化日志，恢复后刷入 incident；恢复前重启时由运维依据日志通过 CLI 补录。

归因规则：

- 只有能够从可靠日志或 provider 记录恢复稳定 family/attempt identity、但无法恢复 meter/cost 时，才创建 incident attempt；subject/capability 只写证据能支持的值，知道 family 但不知道 subject 时不得分配到个人；
- known_unmeasured_attempt_count 不是不可核查的手填整数，而是当前 scope 下 recovery_status=unresolved 的 incident attempt 行数；
- 完整脱敏 ProviderUsageReceipt 后来恢复 meter/cost 时，应在创建/关联 event 的同一事务把对应 incident attempt 标为 recovered，因此不再计入 known unmeasured；
- exact_scope 表示受影响 family 和 attempt 集合均可枚举，每个已知 attempt 都有明细；
- partial_scope 可以保存已经确定的 incident attempt，但同时设置 measurement gap，表示仍有无法枚举的未知部分；
- unknown_scope 不创建 incident attempt，也不向任何家庭、成员或 capability 分配具体次数或金额；它只表示 started_at 到 recovered_at 的全局或未知范围缺口；
- tracking_started_at 已开始且与 unknown_scope incident 时间重叠的家庭账期可以返回 measurement_gap=true，但 known_unmeasured_attempt_count 不因此增加；
- 任何 coverage 都不得从 reservation 上限反推出未知缺口金额。
- 如果进程内 latch 与外部结构化日志同时丢失，系统无法在事后证明该 gap 曾发生；规格不宣称可以恢复不可观测的故障。正式部署必须保留 fail-open 结构化日志，health 页面只表达已经被 latch、日志或人工记录识别的 incident。
- 影响 correction_status=pruning/closed 账期的迟到 incident 不再修改已关闭 rollup；它只保留在外部运维工单。Retention preflight 必须先确认没有待刷入该 family/period 的 latch 或 incident fragment。

### 8.11 外键、保留与删除

- 家庭业务表统一按 family_id 隔离并在家庭删除时级联。
- subject identity 使用 model_usage_subjects 的稳定随机 key；成员退出后聚合显示“已退出成员”。
- 用户账号彻底删除时只断开 subject.user_id；不同已删除用户不会因为 user_id 均为 NULL 而合并。
- 原始 event、meter、reservation、period counter、adjustment、alert、alert receipt、incident 和 incident attempt 至少保留 13 个完整账期。
- family_id 为空且 coverage=unknown_scope 的全局 incident 不随单个家庭账期清理；它们不含家庭内容，首版长期保留，以便解释已经写入历史 rollup 的全局 gap。
- published price version/rate 首版永久保留，即使原始 event 已清理也不回收。
- model_usage_subjects、policy version 和 capability limit 随长期 rollup 保留，只在家庭删除时级联。
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

Rate identity 为 provider、billing model、capability、variant、billing_scheme_key 和 meter。硬限额不允许依赖匹配任意模型的通配 rate。

### 9.2 价格选择

Reserve 时根据请求使用的 provider、billing model、capability、variant、meter 和当前时间选择价格，并锁定：

- price version；
- billing_scheme_key 和完整 billable meter 集合；
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

- validate：schema、Decimal、时区、枚举、alias、重复键、FX、unit、billing scheme 和 meter overlap 校验；
- diff：只读显示新增、变更、停止覆盖和 capability coverage；
- publish：校验 checksum 后原子发布；
- list、show：查看版本；
- coverage：对比七类实际配置，输出 covered、disabled、missing，支持 JSON；
- cancel：只取消未生效且未被引用的版本。

Publish 必须提供 operator、change-ticket、file 和 confirm-checksum。已发布版本不能就地修改；回滚通过新版本完成。

Publish 默认拒绝让任何当前已启用 provider/model/variant/meter 变成 missing。运维应先补全 rate 或先关闭对应 provider 配置；运行期 provider 静默返回未知 alias 仍按前述 measurement warning 和 hard-limit 拒绝规则处理。

Validate 必须拒绝：

- 同一 billing scheme 中 total_tokens 与其 input/output 组成项同时 billable；
- input_tokens 已包含 cached input 时，input_tokens 与 cached_input_tokens 同时按全量计费；
- 声明 input 包含 cached 的 scheme 没有使用 uncached_input_tokens，或 adapter 没有校验 cached_input_tokens <= input_tokens；
- 同一真实音频用量因为 provider 同时返回 seconds 和 audio tokens 而被重复计费；
- informational meter 配置 unit price；
- 一个 provider/model/capability/variant 在同一时间落入多个 billing scheme；
- event 固定费用没有使用 request_units 表达；
- adapter 声明的 billable meter 与价格目录 billable 集合不完全一致。

### 9.4 Adjustment CLI

backend/scripts/maintain_model_usage.py 提供 adjustment preview/apply：

- preview 输出家庭、账期、能力、counter、rollup 和提醒影响及 checksum；
- apply 要求 confirm-checksum、operator、change ticket 和 evidence ref；
- 同 idempotency key 相同 fingerprint 重放返回原结果；
- 同 key 不同 fingerprint 拒绝；
- source period 已关闭 adjustment 窗口时 preview 和 apply 都返回 model_usage_adjustment_window_closed；
- 无可靠证据的计量缺口只记录 incident，不编造 adjustment。

## 10. Usage Core

### 10.1 标准上下文

Capability adapter 构造不含内容的 UsageContext：

- family_id；
- attribution_kind；
- attribution_kind=user 时携带由认证上下文得到的 actor_user_id，core 随即解析为 subject_id/subject_key；
- attribution_kind=system 时解析家庭唯一 system subject；
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

账本写入不可用时，fail-open 资格不能来自请求体或可能过期的普通进程缓存：

- 只有本次 reserve 已从可信服务端状态解析出当前 immutable policy version、确认 hard_limit_enabled=false，随后 reservation/ledger 写入失败时，才按监控模式 fail-open、打开 outage latch 并记录 incident；
- 当前 policy 无法读取或无法证明仍是 current 时一律 fail-closed；
- hard limit 已开启时 fail-closed，provider 不得被调用。

因此“完全没有 reservation 的 fail-open”只覆盖本次操作已经可靠解析监控策略、但后续 ledger 写入失败的窗口，不允许用陈旧策略缓存绕过刚开启的 hard limit。

### 10.3 Dispatch

调用 provider 前将 reservation 从 reserved 原子改为 dispatching，并在同一事务持久化 client_attempt_id、recovery_mode 和可用的 provider_idempotency_key。dispatching 只表示 durable send intent，不表示 provider 已接收。状态写入失败时：

- 监控模式按 fail-open 规则记录计量故障；
- 硬限额不得发送 provider 请求。

SDK 隐式 retry 必须关闭。

- recovery_mode 为 idempotency_key 或 idempotency_and_queryable，且同时未超过 provider idempotency window 和 adapter automatic resend deadline 时，同 payload fingerprint 的 transport recovery 可以携带原 provider_idempotency_key 恢复同一 attempt；
- recovery_mode 为 queryable_request 或 idempotency_and_queryable，且仍在查询窗口内时，只按 dispatch 前已持久化并被 provider 接受的 client_attempt_id 查询，不依赖尚未可靠落库的 provider_request_id，也不重发生成请求；
- recovery_mode=none 时，只要是否发送或是否执行存在歧义，就不执行无人值守自动 retry；
- provider 明确确认原 attempt 未执行后，业务重试使用新的 attempt key；
- 用户或业务明确要求可能产生新费用的 retry，同样使用新的 attempt key。

provider_acknowledged_at 只有在 adapter 获得 provider 明确认领、request ID 或可验证响应后填写。它能提高诊断精度，但不被当作跨系统原子性证明。

### 10.4 Settle

Provider 返回后，adapter 生成不含内容的标准 meter：

- provider 精确 usage 优先；
- 服务端可测事实次之；
- 稳定 estimator 最后；
- 不能把缺失 usage 当成零；
- adapter 按 reservation 锁定的 billing scheme 区分 billable 与 informational；
- cached、total 和 audio 等包含关系在 adapter 内归一化，不能交给聚合层猜测；
- adapter 输出的 billable meter 集合必须与锁定价格版本完全一致，否则进入 settlement pending/measurement error，不能静默漏项或重复计费；provider 明确 not_billed 是唯一例外，此时保留的 meter 全部降为 informational、总成本为精确零。

Settle 在一个独立事务中：

1. 锁 reservation 和对应 counters；
2. 复核 idempotency；
3. 对 priced billable meter 计算成本，并验证 event.cost_cny 等于 billable meter cost 之和；缺价 billable meter 只保留 quantity、rate/cost 为空，整体 pricing_status=unpriced 且总成本为空；
4. 创建唯一 event 和 meter；
5. 从 reserved counter 移除预留；
6. 将真实 cost/meter 加入 settled；
7. 更新 reservation 为 settled；
8. 评估预算阈值并原子创建 alerts；
9. 返回 usage receipt。

若 provider 明确拒绝且保证无计费，创建 provider_outcome=not_billed 的 event、释放预留并将 reservation 标为 released；adapter 根据证据把 execution_certainty 设为 confirmed_not_executed 或 confirmed_executed，不能把“无计费”统一写成“未执行”。若 provider 是否执行不明确，进入 uncertain。

Settle 失败不能撤销已经产生的 provider 费用。返回给业务侧的结果不应因为计量写入失败而伪装成 provider 未执行；maintenance 负责补偿，受影响 hard-limit counter 在无法确认时 fail-closed。

Provider 返回可用的执行或 usage 证据后，adapter 先构造脱敏 ProviderUsageReceipt。允许字段仅包括已知的 family_id/subject_key、attempt_key、HMAC fingerprint、client_attempt_id、provider request ID、provider outcome、execution certainty、measurement status、reported/billing model、billable/informational meter、时间，以及可选的调用时 price_version_id、完整 meter 价格快照和 snapshot checksum；它不含 user_id 或业务输入输出。DB settle 失败时：

1. receipt 进入有界进程内重试队列，并写入允许字段的结构化日志；
2. 进程存活时优先用原 receipt 精确 settle；
3. 进程重启后，优先按 provider recovery_mode 查询原 attempt；
4. 运维日志确实保留完整脱敏 receipt 时，只有 reservation 的走 settle/reconcile，已经有 estimated event 的走 adjustment，fail-open 无 reservation 且无 event 的走下述 recovered event；
5. receipt 已丢失且 provider 不可查询时，24 小时后只能按 reservation 降级为 execution_certainty=unknown、measurement_status=estimated。

标准日志和进程内队列不是财务级 durable WAL，规格不宣称它们能在主机丢失时保证 exact recovery。

监控模式在 reserve DB 完全不可用时可能没有 reservation。恢复后若取得完整、可信且带稳定 family/subject/attempt identity 的 ProviderUsageReceipt，reconcile 可以在一个事务中创建 recovery_source=fail_open_receipt、reservation_id 为空的 recovered event 并更新 counter。该路径同样要求 attempt key/fingerprint 幂等和 billable meter 求和：receipt 内有调用时缓存、能校验 immutable price version 且带 checksum 的完整价格快照时才可恢复成本；没有可靠价格快照时仍可按 receipt 精确恢复 meter 和 execution certainty，但 pricing_status=unpriced、总成本为空，不能用恢复时的当前目录追溯定价。receipt 不完整时不能凭日志片段虚构 event，只能按证据范围创建 measurement incident。

### 10.5 Uncertain

- dispatching 超过 provider timeout 加宽限期后转 uncertain；
- recovery_mode 为 idempotency_key 或 idempotency_and_queryable，且 idempotency window/resend deadline 均未过期时，可以用同一 provider_idempotency_key 恢复同一外部 attempt；
- recovery_mode 为 queryable_request 或 idempotency_and_queryable，且查询窗口未过期时，只按 dispatch 前持久化的 client_attempt_id 查询，不重新生成；
- 某一机制的 provider window 过期后停用该机制；所有已声明机制都不可用时按 recovery_mode=none 处理，不继续重发或声称可查询；
- recovery_mode=none 时不自动重发；
- 24 小时内保持预留占用；
- provider 明确未执行时 release，并保留 not_billed 结果；
- provider 返回用量时正常 settle；
- 24 小时仍不确定时按 reservation quantity 生成 provider_outcome=unknown、execution_certainty=unknown、measurement_status=estimated 的 event；priced reservation 使用锁定价格，unpriced reservation 同时保持 pricing_status=unpriced、总成本为空；
- 该 event 是额度治理的保守估算，可能包含“发送意图已持久化但请求实际未离开进程”的假阳性；
- 24 小时是 reservation 占用转保守结算的治理期限，不等于 provider idempotency/query window。保守 event 创建后不再重新发送可能首次触发生成的同 key 请求；queryable 保证仍有效时可以继续只读查询原 attempt，或接收迟到结果。取得可靠结果后只能追加 adjustment 和解析 effective state，不能创建第二条 event；
- 后续可靠数据通过 adjustment 修正 meter/cost，并解析 effective execution certainty 和 measurement status。

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

- 每个 provider round dispatch intent 单独 reservation 和 event；
- Chat Completions 与 Responses 都接入；
- streaming 完成、取消或断开都结算已发生用量；
- tool/script 本身不计模型费用；
- max_retries 设为 0，显式 retry 分开计量；
- 硬限额要求 provider 请求有明确 output token cap；
- trace 完全关闭时仍产生 usage。
- 原模型在 dispatch 前因预算或 capability limit 被拒绝时，轻量 fallback 必须使用新的 attempt key、独立 reservation、fallback model/variant 和对应价格；可以共享 logical_operation_id，但不能复用被拒绝 reservation；
- 原模型已经 dispatch 且 execution certainty 为 unknown 时，不自动再调用轻量模型，避免同一用户操作产生无法识别的双重外部执行；
- provider 已确认原模型未执行后，才可以用新 attempt key 尝试 fallback。

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
- 同 family、period、budget_alert_revision、threshold 唯一；
- 一次大额 settlement 跨越多个阈值时可写入各阈值事实，通知中心优先呈现最高的当前关注状态。

budget_alert_revision 只在以下情况递增：

- monthly_budget_cny 发生变化；
- alerts_enabled 从 false 重新开启为 true。

只修改 hard limit、capability guardrail 或其他与家庭预算提醒无关的字段时，budget_alert_revision 保持不变，因此不会重新发送 80%、100%、110% 提醒。新 budget alert revision 生效时，如果当前费用已经超过阈值，alert repair 只补发当前最高阈值的一条提醒；之后再跨越更高阈值时正常提醒。关闭提醒期间不创建通知，重新开启时按新的 revision 重新评估一次。

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
- model_usage_adjustment_window_closed

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
- 自己正交的 exact/estimated 测量状态、priced/unpriced 定价状态，以及 uncertain/measurement gap 健康状态；
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

PUT 请求携带 base_version_number。版本过期返回 409，并包含 currentPolicy、currentVersionNumber 和稳定 recoveryHint。前端保留草稿，允许用户查看最新设置后重新应用，不能静默覆盖。GET policy 返回当前 immutable version 的完整预算、alerts、hard limit 和 capability guardrail 内容；历史 reservation 和 alert 通过 policy_version_id 可恢复当时的完整判断条件。

### 13.6 响应 contract

- Decimal 以字符串返回；
- 小于一分钱但大于零不返回为零；
- 聚合同时返回 knownPricedCostCny、pricingComplete 和 unpricedEventCount；pricingComplete=false 时不提供一个伪装成完整值的 totalCostCny；
- estimated、unpriced、uncertain、pending、known unmeasured 和 unknown measurement gap 可以同时表达；
- 普通成员响应中越权字段应不存在，而不只是 null；
- query key 必须包含 familyId、scope、period 和 groupBy。

Measurement health 至少表达；测量精度、定价状态和结算健康为正交字段，不能压成一个互斥枚举：

- exact
- estimated
- unpriced
- uncertain
- unresolvedUnknownExecutionAttemptCount 和对应 conservativeEstimatedCost；
- pending
- knownUnmeasuredAttemptCount，只包含可精确归因的 attempt；
- measurementGap，布尔值；
- measurementGapScope 和 gapIntervals；

当 coverage=unknown_scope 时，API 只能返回 measurementGap=true 和对应时间窗，不能给当前家庭或当前用户填入虚构的 unmeasured 次数、Token、金额或 capability 分布。

uncertain 表示尚未完成结算的 active reservation；unresolvedUnknownExecutionAttemptCount 表示已经在 24 小时后做保守结算、但 effective execution certainty 仍为 unknown 的 event。两者不能混成同一个数字；后续 adjustment 解析执行事实后，该 event 不再计入 unresolved 数量。

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
- exact、estimated、unpriced、known unmeasured 和 unknown measurement gap 状态。

Known unmeasured 可以显示可恢复的具体 attempt 数；unknown measurement gap 只显示“该时间段计量可能不完整”，不显示次数、金额或个人归因。监控模式存在 measurement gap 时，预算卡必须说明当前已记录费用可能低于真实费用。

effective execution_certainty=unknown 的保守结算单独显示“执行情况未知的保守估算”，不能放进已确认费用文案；它仍参与治理 counter，后续可靠证据通过 adjustment 修正并解除 unresolved 标记。

Progress 只表示已记录费用，不把预留伪装成已消费；额度判断仍包含 reserved。

金额格式：

- 零显示 ¥0.00；
- 大于零但不足一分钱显示小于 ¥0.01；
- 估算使用约等于符号；
- 全部未定价时显示“未定价”，不显示 ¥0.00；priced 与 unpriced 混合时显示“已记录 ¥X，另有未定价用量”，不能把已知部分包装成完整总额。

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
- 保存使用 base_version_number；
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
- known unmeasured；
- unknown measurement gap；
- hard-limit active；
- policy conflict；
- 无家庭上下文；
- 家庭切换；
- 离线缓存和恢复。

家庭切换时取消或隔离旧请求，不能短暂显示上一家庭数据。

## 16. 聚合、补偿和保留

### 16.1 当前月与历史月

- 当前月预算摘要读取强一致 counter；
- 当前月 breakdown 从有索引的 event、meter、adjustment 和 measurement incident 聚合，可短缓存；
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

    counter settled_value = priced settled event cost
    counter adjustment_value = adjustment delta
    counter reserved_value = active reservation cost

额度判断使用 settled_value + adjustment_value + reserved_value；三个来源保持独立，避免 adjustment 被重复计入。

发现差异后按固定锁顺序二次复核。Counter 是派生数据，可以在锁内从 ledger 重建；event 不可修改。无法安全修复时：

- hard limit 对受影响范围 fail-closed；
- monitoring fail-open 并显示 measurement incident。

### 16.4 Rollup

- 根据 event、adjustment 和重叠 measurement incident 确定性重建；
- 保存 source count、watermark、revision 和 checksum；
- correction_status=open 期间 adjustment 到达旧账期时重建对应 revision；
- 不因重建重新选价；
- effective unpriced、estimated、unresolved_unknown_execution_count、unresolved_known_unmeasured_count 和 has_unknown_measurement_gap 事实长期保留；
- unknown_scope incident 只能把重叠账期标记 has_unknown_measurement_gap=true，不能增加家庭或成员 count/cost；
- raw data prune 前先把该 family/period 从 open 原子改为 pruning 并关闭 adjustment 窗口；原始行删除完成后改为 closed。关闭后的长期 rollup 是最终运营统计，不再声明可由原始 event 重建。

### 16.5 Retention

只按完整账期清理。账期结束已满 13 个月后才有资格。

清理前要求：

- 无 reserved、dispatching、uncertain；
- 没有待刷入该 family/period 的 outage latch、ProviderUsageReceipt 或 incident fragment；
- 所有聚合维度 rollup 存在；
- event、adjustment、incident 数量或重叠标记一致；
- cost、meter、unpriced 和 health 汇总一致；
- checksum 一致。

任一校验失败时整个 family/period 不删除。校验成功后：

1. 锁 family_total rollup，固化最终 source counts/checksum，写 adjustment_closed_at，并把 correction_status 改为 pruning；
2. pruning 状态立即拒绝新的 adjustment、迟到 receipt recovery、incident fragment 和 alert repair；正常 reserve 不允许写入非当前账期；
3. 按固定外键安全顺序分批删除原始行：alert receipt → alert → incident attempt → adjustment → event meter → event → reservation meter → reservation → period counter → 家庭级 incident fragment；跨账期 incident 已在持久化时切片，family_id 为空的全局 unknown_scope incident 不在此步骤删除；
4. 中途失败时保持 pruning，下一次任务根据已固化的最终 checksum 和剩余行继续删除，不重新开放 adjustment；
5. 原始行全部删除后写 raw_data_pruned_at，并把 correction_status 改为 closed；
6. 如果进程在最后一批删除后、状态更新前崩溃，worker 通过“pruning 且无剩余原始行”完成最终状态转换。

因此不会出现原始数据已经部分删除但 correction_status 仍为 open。支持 dry-run、verify-only、family、period 和 batch-size。Price history 与 monthly rollup 不随原始事件清理。

## 17. 可观测性与隐私

第一版不引入新的 Prometheus 栈，使用：

- Python 标准 logging 的稳定结构化事件；
- maintain_model_usage.py health；
- Owner measurement health；
- 部署环境现有日志采集。

稳定指标语义：

- model_usage_budget_decisions_total
- model_usage_dispatch_intents_total
- model_usage_provider_acknowledged_total
- model_usage_unresolved_unknown_execution_current
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

普通结构化日志允许 provider、billing model、capability、meter、内部记录 ID、attempt key hash、状态、稳定错误码和数值用量。专用 ProviderUsageReceipt 日志事件还可包含恢复所必需的 family_id、随机 subject_key、client_attempt_id、provider request ID 和调用时价格快照，但必须使用严格 allowlist schema、受限访问和不少于“24 小时 uncertain 窗口 + 最大 provider recovery window”的生产日志保留期。禁止记录任何业务内容、user_id、凭据、Authorization header 或可能带内容的 provider 原始错误响应。

即使配置了上述日志保留期，普通部署日志仍不等于跨主机、跨存储故障的财务级 durable WAL；日志不可用时按 estimated 或 measurement gap 语义降级，不宣称精确恢复。

Health CLI 输出价格覆盖、最近 event、未定价数量、最老 active/uncertain reservation、counter drift、rollup lag、打开的 incidents 和 retention 状态；支持 JSON 和非健康非零退出码。

现有 /api/health 继续只承担进程 liveness，不因价格缺口、rollup 延迟或计量 incident 返回失败并触发无意义的容器重启。首次启动的 MODEL_USAGE_REQUIRED preflight 可以阻止错误部署；运行期健康问题通过 capability 决策、health CLI、结构化日志和页面 measurement health 表达。

## 18. Migration 与首次部署

### 18.1 Alembic

新增正常 revision，不修改旧 migration。按外键依赖创建价格、稳定 subjects、family policy/current pointer、immutable policy versions、capability limits、counter、reservation、event、adjustment、rollup、alert、incident 和 incident attempt 表。

- 时间存 UTC，账期按 Asia/Shanghai 计算；
- source price、FX、CNY unit price 和 cost 使用 Numeric(30, 12)；
- 可含小数的 meter quantity 使用 Numeric(30, 6)，Token、字符和图片数量在 service 层额外校验为整数；
- 规范 dimension_key 避免 MySQL nullable unique 陷阱；
- 当前家庭初始化默认 policy；
- 当前家庭初始化唯一 system subject，并为已有有效 membership 创建或复用 user subject；
- 新家庭在创建事务中同步创建 policy；
- 新 membership 创建或重新激活时创建或复用该 family/user subject；
- 不回填历史用量。

默认 policy：

- monthly_budget_cny 为空；
- alerts_enabled=true；
- hard_limit_enabled=false；
- immutable version_number=1；
- budget_alert_revision=1；
- model_usage_family_policies.current_policy_version_id 指向 version 1；
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
8. 运行 schema、价格、adapter、recovery_mode、recovery_window/automatic resend deadline 边界、retry、账期和 worker preflight；每个启用 adapter 都必须给出恢复模式，任何非 none 模式还必须有可验证的 provider 依据和正数窗口；
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

实际费用高于预留时必须真实结算，之后阻止新调用。负 adjustment 更新 counter 和 rollup、提交后释放后续可用额度，但不删除历史 event/提醒，也不自动重放此前被阻止的用户调用。

金额测试必须覆盖：

- budget 与 counter 使用完整 12 位小数，不先按分舍入；
- source price × FX 和精确 line cost 使用 ROUND_HALF_UP；
- reservation line cost 使用 ROUND_CEILING；
- 小于 ¥0.01 的正成本仍参与限额；
- event cost 等于已量化 billable line cost 之和；
- UI 两位小数格式化不反向影响服务端预算判断。

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

分 recovery mode 验收：

- idempotency_key：同 provider_idempotency_key 的恢复不产生第二次外部执行或第二条 event；
- queryable_request：只按 dispatch 前持久化且 provider 接受的 client_attempt_id 查询原 attempt，查询结果与原 reservation 结算；仅有事后 provider_request_id 时不能错误声明该模式；
- idempotency_and_queryable：同时满足 resend 不重复执行和按预持久化 client_attempt_id 只读查询两套 contract；
- none：ambiguous 后不自动重发，24 小时后只产生 execution_certainty=unknown 的保守 estimated event；
- idempotency/queryable 的 recovery window 临界点和过期后一律降级到 none 语义，不在窗口外继续重发或查询并宣称有保证；
- recovery/query window 长于 24 小时时，保守 event 创建后只能继续只读查询或接收迟到结果，不能再发送可能首次触发生成的请求；可靠结果只能形成 adjustment，不能形成第二条 event；
- 所有 mode 都必须保证同 attempt key 不重复创建 reservation、event 或 counter 变更；
- 对 recovery_mode=none 不断言外部 exactly-once，也不把 unknown estimated 断言为“不漏记、不误记”；
- provider 成功且精确 receipt 可恢复时按精确值结算；receipt 无法恢复且 provider 不可查询时允许降级为 estimated；
- settle DB 失败但进程存活时从脱敏 ProviderUsageReceipt 精确重试；
- receipt 丢失且 provider 不可查询时不得继续显示 exact；
- receipt 有精确 meter 但没有可校验的调用时价格快照时，measurement_status=exact 可以成立，但 pricing_status 必须是 unpriced、总 cost 为空；
- estimated/unknown event 后续取得可靠证据时，adjustment 同时修正 delta 和 effective state，解除 unresolved unknown；

### 19.4 七类共同矩阵

每个 capability 都覆盖：

- exact/estimated 测量状态与 priced/unpriced 定价状态的全部适用组合；
- billable/informational meter 角色；
- priced event.cost_cny 严格等于 billable meter 成本之和；
- informational meter 即使有数量也不产生费用；
- unpriced billable meter 保留 quantity，但 line/event cost 为空而不是零；
- provider_reported_source_cost 只参与差异核查，不直接进入 counter、限额、提醒或 event cost；
- 预算充足、家庭预算不足、capability cost/meter 不足；
- monitoring ledger fail-open；
- hard-limit ledger fail-closed；
- policy 无法读取/证明 current 时 fail-closed；只有本次已解析 current monitoring policy 后 ledger 写失败，才允许无 reservation fail-open；
- exact_scope incident 为每个可枚举 attempt 保存无内容明细，只在证据支持时归到 subject；knownUnmeasuredAttemptCount 等于 unresolved 明细数；
- receipt 恢复 event 与 incident attempt 标记 recovered 在同一事务完成，knownUnmeasuredAttemptCount 不重复保留；
- unknown_scope incident 只产生 measurementGap 和时间窗，任何家庭/成员 count、meter、cost 均不增加；
- 完整 fail-open receipt 创建 reservation_id 为空且幂等的 recovered event；无调用时价格快照时只恢复 meter 并标记 unpriced；
- provider 明确未执行；
- provider 已执行但明确免计费，不能误写成 confirmed_not_executed；
- provider timeout/uncertain；
- streaming 或异步取消；
- attempt 重放；
- 显式 retry；
- adjustment；
- 跨家庭隔离；
- 内容和凭据不落账本、日志、API 或 CLI。

能力特有验收包括：

- LLM 多 round、streaming、缓存 Token、output cap；
- LLM 原模型 pre-dispatch 被拒绝时 fallback 使用新 attempt/reservation；原 attempt unknown 时不自动 fallback；
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
- 同一成员退出再加入复用原 subject；不同家庭使用不同 subject；
- 两个用户彻底删除后 user_id 均为空，但历史 rollup 仍通过不同随机 subject_key 分开，API 不泄露 subject_key；
- embedding、rollup、prune、alerts 全部保持 family scope。

使用秘密标记扫描 usage tables、logs、CLI 和 API，确认 prompt、response、query、文档、转写、TTS 文本、图片提示词、媒体 URL 和 API Key 完全不存在。

### 19.6 Policy、Alert 与 UI

- base_version_number 成功和 409；
- 每次更新生成新的 immutable policy version，旧 reservation/alert 仍可恢复旧预算、hard limit、alerts 和 guardrail；
- 只改 hard limit/guardrail 不重复预算提醒；改预算或重新开启 alerts 使用新的 budget_alert_revision；
- 保存失败保留草稿；
- 79% 无提醒，跨 80/100/110 分别唯一；
- reservation 不提醒；
- adjustment 在当前 budget alert revision 下重新评估；新 policy 按 budget_alert_revision 规则决定是否形成新的提醒基准；
- 每个 Owner receipt 独立；
- 普通成员无金额通知；
- loading、refreshing、stale、empty、partial、error、estimated、unpriced、uncertain、known-unmeasured、measurement-gap、hard-limit、conflict、offline 全覆盖；
- known unmeasured 与 unknown measurement gap 使用不同文案和字段，unknown gap 不显示虚构次数或金额；
- 360×800、390×844、768×1024、1440×900；
- 键盘、焦点、屏幕阅读器、200% 缩放、reduced motion 和无横向溢出。

### 19.7 Rollup、Retention 与 CLI

- 相同输入相同 checksum；
- late adjustment 增加 revision；
- adjustment 可以解析 unknown/estimated 的 effective state，且 event 原行保持不变；
- correction_status=open 时允许有 source event 的 adjustment；pruning/closed 时返回 model_usage_adjustment_window_closed；
- 原始数据清理后不接受逐事件或直接修改 rollup 的 adjustment；
- pruning/closed 账期同样拒绝迟到 receipt recovery、incident fragment 和 alert repair，不产生孤立原始行；
- 多 worker 不重复；
- 未满 13 个完整月不删；
- rollup/checksum/active reservation 任一不满足时零删除；
- dry-run、verify-only 和失败重放；
- pruning 中途失败后从剩余原始行继续，最终转 closed；
- 跨月 incident 按账期稳定切片；存在待刷 latch/receipt/incident 时不允许进入 pruning；
- price validate/diff/publish/coverage/cancel；
- checksum、重叠版本、alias 循环、缺 FX 和 secret redaction；
- total 与组成 Token、cached 与全量 input、audio seconds 与 audio tokens 的重叠 billable scheme 被 validate 拒绝；
- request_units 固定费与非重叠 Token/图片费用可以正确组合；
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
- 账本 attempt replay 不重复 reservation、event 或 counter；
- 支持幂等/查询的 provider 通过对应恢复 contract；
- 不支持恢复的 provider 在 ambiguous 状态不自动重发，并明确呈现 unknown estimated；
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
- 各 adapter recovery_mode、provider 窗口、automatic resend deadline 和依据版本；
- smoke 结果和 usage event ID；
- meter exact/estimated 状态和 priced/unpriced 定价状态；
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

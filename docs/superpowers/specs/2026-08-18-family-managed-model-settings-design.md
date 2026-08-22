# Culina 家庭级模型服务与价格配置设计

日期：2026-08-18

状态：已确认；进入实施计划

## 1. 背景

Culina 当前通过后端进程启动时加载的 `Settings` 和部署环境变量统一配置模型能力。配置覆盖主对话模型、图片生成、语音、实时语音、搜索 Embedding、Rerank 和对应 Provider 凭据。所有家庭共享同一组配置，运行时工厂直接读取全局 `Settings`，模型用量价格目录也由系统级静态 manifest/CLI 发布。

新的产品要求是让每个家庭独立使用自己的 Provider、Base URL、API Key、模型和价格，并且只允许该家庭 Owner 管理。普通成员只能使用已启用能力，不能读取 Provider 配置、Base URL 或凭据。配置不从旧 `.env` 迁移；功能上线后所有家庭均从“未配置”状态开始。

这不是把环境变量简单搬进一个数据库 JSON 或前端表单。它同时改变以下稳定边界：

- 模型运行时从进程级配置改为家庭级配置解析；
- 七类模型用量和价格从全局 variant/catalog 改为家庭级 variant/catalog；
- Provider API Key 成为高敏感家庭数据；
- 任意公网和内网 Base URL 引入 SSRF、DNS rebinding 和网络出站控制；
- Embedding 从全局单 collection 改为家庭级不可变索引 profile；
- 所有异步 job、run 和实时 session 必须固定配置身份，同时正确响应 Key 轮换；
- 家庭 Owner 设置需要新增独立、移动优先的复杂配置工作区。

## 2. 当前实现事实

设计以当前源码为实现事实：

1. `backend/app/core/config.py` 中的模型字段由 Pydantic Settings 在进程启动时加载，并由 `get_settings()` 进程内缓存。
2. `backend/app/ai/runtime/factory.py`、图片生成、AI Audio、Embedding、Rerank 和 Qdrant store 都直接读取全局 Settings。
3. 用户权限只有家庭 `Owner` 与 `Member`，没有平台超级管理员角色；`require_owner` 已是家庭管理能力的稳定权限边界。
4. `ModelUsagePriceVersion` 和 `ModelUsagePriceRate` 当前是系统级目录；`configured_variants(settings)` 从全局 Settings 枚举启用的 provider/model variant。
5. 模型用量治理已覆盖 LLM、Embedding、Rerank、STT、TTS、实时语音和图片生成，具有 reservation、dispatch、settlement、uncertain、预算、硬限额和追加式历史快照。
6. Qdrant 当前使用一个全局 collection；collection 只能使用一种向量维度，point payload 再用 `family_id` 过滤。
7. 搜索文档已经保存 `embedding_model` 和 `embedding_dimensions`，后台索引 job 已按 `family_id` 归因并进入模型用量治理。
8. 家庭页面已有“家庭工具”区域及独立“模型用量”工作区，但没有模型服务配置入口。
9. 前端新增复杂业务能力应进入 `frontend/src/features/<domain>/`，不能继续扩大 `App.tsx` 或把完整表单塞入 `FamilySettings.tsx`。

## 3. 目标

本设计必须实现：

1. 每个家庭拥有独立模型服务配置，只有当前家庭 Owner 可以创建、查看、修改、发布和轮换凭据。
2. 同一家庭可以为不同能力绑定不同 Provider、Base URL、API Key 和模型。
3. 同一份 Provider 凭据可以被家庭内多个能力复用，不重复保存 Key。
4. 覆盖七类受治理能力：LLM、图片生成、STT、TTS、实时语音、Embedding 和 Rerank。
5. 支持 OpenAI、DashScope、任意 OpenAI-compatible 公网服务，以及部署白名单内的 Ollama/vLLM 等内网服务。
6. 所有真实模型调用继续经过现有模型用量 reservation、dispatch、settlement、预算、硬限额和告警链路。
7. 家庭 Owner 可以配置每个模型 variant 的价格，并通过不可变价格版本立即影响后续调用。
8. 历史 event、reservation 和 run 永久保留调用时的配置与价格身份，不因后续修改回算。
9. Embedding 索引身份不可原地修改；Key 可以轮换，Rerank 可以修改，更换 Embedding 只能通过完整重建和原子切换。
10. 取消模型 Provider 相关 `.env` 配置，不迁移或继承旧值，也不保留运行时环境变量 fallback。
11. 配置、凭据、价格、索引和 API 全部严格按当前 membership 的 `family_id` 隔离。
12. 手机端与桌面端都能清楚完成配置、价格维护、发布、失败恢复和搜索重建。

## 4. 非目标

本次不包含：

- 把 Qdrant、数据库、MinIO、JWT、凭据加密主密钥或私网白名单改成家庭配置；
- 让 Member 查看或修改 Provider、模型、Base URL、价格或凭据；
- 向家庭收费、充值、支付、退款、开票或对接供应商账单；
- 自动抓取 Provider 官方价格或动态汇率；
- 让 Owner 任意定义新的 capability、meter、计量单位或 adapter 协议；
- 对旧 `.env` 模型配置、旧 Provider 凭据或历史未计量调用执行导入；
- 让不同家庭共享可编辑的 Provider 凭据；
- 允许家庭绕过模型用量、预算或硬限额治理；
- 在后台静默执行可能计费的“连通性测试”；
- 因家庭模型配置改变而修改 AI draft、approval 或正式业务写入边界；
- 引入 Redis、Celery、独立模型网关或新的微服务。

## 5. 已确认的产品规则

| 主题 | 规则 |
| --- | --- |
| 配置作用域 | 每个家庭独立配置 |
| 管理权限 | 仅当前家庭 Owner；多个 Owner 权限相同 |
| Member 能力 | 可以使用已启用能力，不可访问配置接口 |
| Provider 组合 | 各能力可以绑定不同 Provider 与凭据 |
| 自定义服务 | 允许任意 OpenAI-compatible Base URL |
| 内网服务 | 支持部署白名单内的 Ollama/vLLM 等目标 |
| 模型用量 | BYOK 调用仍全部纳入用量、预算、硬限额和告警 |
| 模型价格 | 家庭 Owner 自行配置并可发布新价格版本 |
| 调价语义 | 新价格立即影响新调用；历史不回算 |
| 搜索配置 | Embedding 索引身份不可原地修改 |
| 搜索例外 | Key 可轮换，Rerank 可修改；换 Embedding 走全量重建 |
| Qdrant | 平台托管，按家庭搜索 profile 使用独立 collection |
| 旧配置 | 不迁移 `.env`，所有家庭初始未配置 |
| 发布范围 | 七类能力全部完成后统一开放，不保留环境变量双轨运行 |

## 6. 方案比较与选择

### 6.1 方案 A：直接在 `families` 保存当前配置 JSON

优点是表少、读取快、实现表面简单。缺点是 Key、配置、价格和索引状态混在一起；无法安全保留历史快照；并发 Owner 会互相覆盖；Key 轮换会改写历史；异步任务不能可靠恢复；搜索重建也难以表达候选与当前 profile。

不采用。

### 6.2 方案 B：每个能力独立保存完整 Provider 与 Key

优点是每条能力配置自包含。缺点是同一 Key 会被重复加密保存；轮换必须修改多个位置；无法稳定识别同一 Provider 账户；Provider 网络策略和审计重复；容易让能力配置与价格 variant 漂移。

不采用。

### 6.3 方案 C：凭据档案 + 能力绑定 + 不可变配置/价格版本

Provider 档案负责协议、Base URL 和凭据；配置 revision 负责把具体能力与档案、模型、选项绑定；价格 version 负责该 revision 的完整可计费 rate；搜索 profile 单独表达不可变向量索引身份。

优点：

- Key 只保存一次并可单独轮换；
- 配置与价格都有可审计历史；
- run/job 可以固定 revision；
- 发布可以执行完整 price coverage 校验；
- 搜索重建可以保留旧 profile 直到新 profile 完整可用；
- 多实例运行不依赖进程重启或 Redis 广播。

代价是表和状态机更多，但这些状态本来就存在于业务语义中，显式建模比隐藏在 JSON/fallback 中更安全。

采用方案 C。

## 7. 术语与能力矩阵

### 7.1 稳定术语

- Provider Profile：家庭内可复用的 Provider 连接档案。
- Provider Profile Version：档案协议、Base URL 和非秘密选项的不可变版本。
- Secret Version：Provider API Key 的加密版本。
- Capability Binding：一个模型能力对 Provider profile version、模型和能力选项的绑定。
- Configuration Revision：家庭完整能力绑定集合的不可变版本。
- Price Version：家庭完整模型价格目录的不可变版本。
- Search Profile：Embedding 索引空间的不可变身份及其 Qdrant collection。
- Active Pointer：家庭当前配置、当前价格和当前搜索 profile 的数据库指针。

### 7.2 能力与 variant

| Capability | Variant | 主要家庭配置 |
| --- | --- | --- |
| `llm` | `primary` | profile、model、max output tokens、vision、prompt cache |
| `llm` | `fallback` | 可选 profile、model、max output tokens |
| `image_generation` | `text` | profile、model、输出格式默认值 |
| `image_generation` | `reference` | profile、model、参考图支持 |
| `stt` | `default` | profile、model、语言提示、热词默认值 |
| `tts` | `default` | profile、model、voice、输出格式默认值 |
| `realtime_audio` | `default` | profile、model、voice、协议类型 |
| `embedding` | `search` | profile、model、dimensions |
| `rerank` | `search` | profile、model |

Provider adapter kind 使用服务端受控枚举，例如：

- `openai_compatible_http`
- `openai_realtime`
- `dashscope_http`
- `dashscope_realtime`

Ollama/vLLM 等自建模型使用其真实兼容的 adapter kind；“自定义 Provider”不是绕过协议校验的万能 adapter。

## 8. 配置边界

### 8.1 家庭可配置

- 能力是否启用；
- Provider profile 名称；
- adapter kind；
- HTTP/WebSocket Base URL；
- API Key；
- Provider 需要的家庭级非秘密字段，例如 DashScope workspace/region；
- 模型名与受支持的 reported model alias；
- LLM 主模型与 fallback；
- 视觉、prompt cache、max output token 等能力选项；
- STT 默认语言/热词、TTS voice/格式、实时语音 voice 等用户级默认值；
- Embedding 模型与 dimensions；
- Rerank 模型；
- 每个启用 variant 的 billing scheme 和价格。

### 8.2 仍由部署控制

- MySQL、JWT、MinIO 与 Qdrant 连接；
- 凭据加密主密钥 keyring；
- Provider 网络私网白名单与出站安全策略；
- Provider 请求超时上限、上传大小、音频时长和并发上限；
- trace 开关、脱敏模式、保留期和 payload 大小；
- 模型用量 receipt 完整性 keyring、维护任务和队列大小；
- 搜索本地排序算法、阈值、候选上限和固定 Rerank instruction；
- Qdrant retired collection 保留期；
- 允许的 adapter/capability/billing scheme/meter registry。

部署控制项不是模型 Provider 配置，不通过家庭设置暴露。私网白名单可以通过部署 secret/config 配置，但家庭 Owner 不能修改或放宽。

## 9. 总体架构

```text
家庭 Owner 设置工作区
  -> 家庭配置草稿
  -> schema / 权限 / URL / adapter / price coverage 校验
  -> 原子发布 Configuration Revision + Price Version
  -> 更新 Family Active Pointers

业务请求、AI run、图片 job、语音 session、搜索 job
  -> 可信 family_id
  -> FamilyModelConfigurationResolver
  -> capability binding + current secret
  -> Model Usage 选择家庭 price snapshot、reserve / dispatch authorization
  -> ProviderNetworkPolicy
  -> capability adapter
  -> settle / uncertain / failure
```

新增后端域位于：

```text
backend/app/services/family_model_settings/
  drafts.py
  publishing.py
  resolver.py
  credentials.py
  network_policy.py
  validation.py
  connection_tests.py
  search_profiles.py
  errors.py

backend/app/repos/family_model_settings/
backend/app/schemas/family_model_settings.py
backend/app/api/family_model_settings.py
```

运行时 adapter 保留在各自现有模块。配置域不接管 Provider 调用，只提供经过验证、家庭隔离的解析结果。

## 10. 数据模型

所有在线配置表使用字符串 ID、UTC 时间、`created_by/updated_by` 和明确外键。所有查询必须同时带 `family_id`，不能仅凭全局 ID 读取。仅删除后仍需执行的资源 tombstone 使用非级联 snapshot ID，具体边界见 10.12。

### 10.1 `family_model_settings`

每个家庭最多一行，作为并发串行化和当前指针：

- `family_id`，主键并外键到 `families`；
- `active_config_revision_id`，可空；
- `active_price_version_id`，可空；
- `active_search_profile_id`，可空；
- `version_number`，Owner 修改与发布的乐观并发版本；
- `created_at/updated_at/created_by/updated_by`。

发布、价格切换、搜索 profile 切换、Key 轮换和共享草稿保存都先锁定本行，以便多个 Owner、后台重建完成回调和并发 dispatch 获得确定顺序。迁移为所有既有家庭回填空 settings 行，家庭 bootstrap 在创建 Family 的同一事务创建 settings 行；两条路径都不读取旧 `.env`。因此首次并发保存草稿也有稳定锁目标，不能用“查不到 draft 后直接 INSERT”代替串行化。

### 10.2 `family_model_provider_profiles`

家庭内可复用 Provider 档案的稳定身份：

- `id`、`family_id`；
- `display_name`；
- `credential_scope_checksum`，创建后不可变；
- `current_profile_version_id`；
- `current_secret_version_id`，仅显式 `no_auth` scope 可空；
- `status`：`active | disabled | archived`；
- `version_number`；
- 审计字段。

Provider profile 表示固定 credential scope，而不是可以任意改 endpoint 的可变账号槽。Scope 至少包含 adapter/auth scheme、标准化 HTTP/WebSocket authority 与 base path，以及 workspace、region、project 等决定凭据适用范围的 adapter 字段。API Key scope 的档案创建必须在一个数据库事务内同时写入首个 profile version、首个 secret version 和两个 current pointer；显式 `no_auth` scope 同事务写 version 且 secret pointer 为 NULL。在档案被配置发布引用前不会参与 dispatch。

PATCH 只允许 display name、状态和 adapter 明确定义为 scope 外的非秘密选项。任何会改变 `credential_scope_checksum` 的修改都返回 `family_model_provider_scope_change_requires_new_profile`，Owner 必须创建包含新 endpoint 与新 Key 的 profile，再通过配置发布切换 binding。Key 轮换也只能在同一 scope 内推进 secret pointer。这样旧 profile 始终保留 endpoint A/key A，新 profile 原子承载 endpoint B/key B，不存在把 key B 发给 A 或 key A 发给 B 的过渡窗口。

档案删除使用 `archived`。被当前配置、历史 revision、价格、run 或 job 引用时不得物理删除。

### 10.3 `family_model_provider_profile_versions`

不可变非秘密连接快照：

- `id`、`family_id`、`profile_id`、`version_number`；
- `adapter_kind`；
- `api_base_url`；
- `websocket_base_url`，可空；
- `options_json`，仅保存 adapter schema 允许的非秘密字段；
- `credential_scope_checksum`，必须等于所属 profile 固定值；
- `endpoint_fingerprint`；
- `created_at/created_by`。

只允许 scope 外选项创建新 version，且新 version 的 scope checksum 必须与 profile 固定值一致。Base URL、WebSocket URL、adapter/auth kind、workspace、region、project 或其他 credential scope 字段变化必须创建新 profile，不能 PATCH 原 profile，也不能原地更新被引用 version。

### 10.4 `family_model_secret_versions`

API Key 的写入专用密文：

- `id`、`family_id`、`profile_id`、`version_number`；
- `encryption_key_id`；
- `nonce`、`ciphertext`、`auth_tag`；
- `secret_fingerprint`，使用服务端 HMAC，不保存裸哈希；
- `status`：`active | revoked | destroyed`；
- `created_at/created_by/revoked_at/destroyed_at`。

任何响应 schema 都不包含 nonce、ciphertext、tag 或可还原 Key 的字段。接口只返回 `configured=true`、版本号、更新时间和安全指纹标识。

Key 轮换在 profile 固定 credential scope 内创建新 secret version 并更新 profile 指针。旧版本立即停止用于新的 dispatch；已建立的外部连接不会被数据库事务虚假撤销。超过既定恢复窗口，且不存在引用该 secret version 的 `dispatching`、`uncertain` 或可恢复 reservation 后，维护任务把旧 ciphertext 清空并标记 `destroyed`，保留指纹与审计事实。

### 10.5 `family_model_config_drafts`

家庭共享的服务端草稿：

- `family_id`，唯一；
- `base_config_revision_id`，可空；
- `draft_version_number`；
- `payload_json`，使用严格 Pydantic schema 校验；
- `validation_status`、`validation_errors_json`；
- `updated_at/updated_by`。

草稿不是运行时真相，不能被 provider resolver 使用。多个 Owner 保存时必须携带 `base_draft_version_number`。保存事务先锁定稳定存在的 `family_model_settings` 行，再以 `FOR UPDATE` 读取 draft、锁后复核版本并创建或更新；也可以使用带版本谓词的条件 UPDATE，但必须对首次创建使用同一个 settings 锁。冲突返回当前草稿版本和恢复方向，不能由两个并发 Owner 都通过同一 base version 后互相覆盖。

### 10.6 `family_model_config_revisions`

完整、不可变的已发布配置：

- `id`、`family_id`、`version_number`；
- `base_revision_id`，可空；
- `config_checksum`；
- `status`：`published | superseded`；
- `search_profile_id`，可空；
- `change_note`；
- `published_at/published_by`。

历史 revision 不删除、不修改。家庭删除时与家庭数据一起级联清理。

### 10.7 `family_model_capability_bindings`

revision 的规范化能力行：

- `id`、`family_id`、`config_revision_id`；
- `capability`、`variant_key`；
- `enabled`；
- `provider_profile_id`；
- `provider_profile_version_id`；
- `requested_model`；
- `options_json`；
- `billing_scheme_key`；
- `identity_checksum`。

数据库唯一约束：

```text
(config_revision_id, capability, variant_key)
```

`options_json` 必须按 capability schema 解析，不能保存任意未经验证字典。Key 不进入 binding 或 checksum。

### 10.8 家庭价格版本

复用现有 `model_usage_price_versions` 和 `model_usage_price_rates`，扩展为家庭可归属版本：

- `model_usage_price_versions.family_id`，新家庭版本必填；
- `config_revision_id`：`purpose=active` 时必填，价格单独发布时指向当前配置；
- `search_profile_id`：`purpose=search_rebuild_candidate` 时必填，此时 `config_revision_id` 为空；
- `base_price_version_id`；
- `published_by`；
- `purpose`：`active | search_rebuild_candidate | legacy_global`。

现有历史全局版本保持 `family_id=NULL` 和 `purpose=legacy_global`，仅供既有 reservation/event 外键引用，不参与新调用解析。旧全局 `version_number` 可继续作为内部全局唯一序号；家庭 UI 使用发布时间和变更说明，不依赖连续全局编号。

数据库和 service 同时强制 purpose 归属约束：`active` 必须有 `family_id + config_revision_id` 且无 candidate search profile；`search_rebuild_candidate` 必须有 `family_id + search_profile_id` 且无 config revision，并且只包含该 candidate Embedding variant 的完整 rate；`legacy_global` 只能用于既有全局历史。这样避免 config revision 与 price version 形成循环外键，也禁止 candidate 价格意外成为普通 active 目录。

Rate 仍使用现有 provider、billing model、capability、variant、billing scheme、meter、unit quantity、source currency、FX 和 CNY 单价快照。

### 10.9 `family_search_profiles`

Embedding 索引空间的不可变身份：

- `id`、`family_id`；
- `provider_profile_id`、`provider_profile_version_id`；
- `adapter_kind`、`embedding_model`、`dimensions`、`distance`；
- `document_builder_version`；
- `index_identity_checksum`；
- `qdrant_collection`，服务端生成；
- `status`：`provisioning | active | failed | superseded | retired`；
- `total_documents/indexed_documents/failed_documents`；
- `created_at/created_by/activated_at/retired_at`。

`index_identity_checksum` 包含 adapter、endpoint identity、model、dimensions、distance 和 document builder version，不包含 API Key。相同 identity 的 Key 轮换不触发重建；Base URL 或上述任一 identity 字段变化必须创建 replacement profile。

Qdrant collection 名称使用不可猜测 profile ID 的规范化形式，不直接暴露家庭名称或可读 family ID。

### 10.10 运行快照引用

以下持久化对象增加配置身份：

- `AIAgentRun.config_revision_id`；
- `AIRunLLMExchange.config_revision_id`、`provider_profile_id`、`provider_profile_version_id`，均为 nullable 内部诊断字段，历史行保持可读且 Member API 不返回；
- `AIImageGenerationJob.config_revision_id`；
- 搜索索引 job 增加 `search_profile_id`、`config_revision_id` 与显式 `price_version_id`；active 首次 provisioning/增量 job 创建时锁 settings 并快照当时的 active config/price，replacement 重建使用 candidate profile 与 candidate price，不能从 profile 创建时的固定价格读取；
- 实时语音 session state 保存 `config_revision_id`、binding identity 和当前 provider attempt；
- 需要跨请求恢复的音频任务保存 `config_revision_id`；
- 模型用量 reservation/event 继续保存 price version、provider/model/variant 和 price snapshot；
- 模型用量 reservation 在首次 dispatch authorization 时保存 `credential_secret_version_id`，用于恢复审计和安全销毁判断，但任何用户 API 都不返回该字段。

业务对象保存 revision ID，不保存 API Key。Secret 在首次 provider dispatch 前通过 profile 当前 secret 指针解析。

### 10.11 `family_model_operation_receipts`

可重试 Owner 写请求的安全结果记录：

- `id`、`family_id`、`operation`、`idempotency_key`；
- `request_fingerprint`、`request_fingerprint_key_id`；
- `status`：`pending | completed`；
- `result_id`、`response_json`，只保存可返回的脱敏结果；
- `created_at/updated_at/completed_at`。

唯一约束为 `(family_id, operation, idempotency_key)`。同键同 fingerprint 的 completed 行在版本校验前重放；同键不同 fingerprint 冲突。普通数据库写的 receipt 与业务结果同事务完成，不产生“业务已提交但 receipt 丢失”的窗口。必须先提交 claim 才能调用外部 Provider 的能力测试，则 pending receipt 与稳定 usage attempt 绑定；重放只恢复/查询该 attempt，不能再次发送。

### 10.12 `family_model_resource_operations`

Qdrant collection 的创建、补建索引 job 与删除使用耐久资源操作表，而不是 commit 后的进程内 enqueue：

- `id`、`operation_type`：`ensure_search_profile_collection | delete_search_profile_collection`；
- `resource_key`，与 operation type 组成幂等唯一键；
- `family_id_snapshot`、`search_profile_id_snapshot`、`qdrant_collection_snapshot`；
- `payload_json`，只包含重建/清理所需的非秘密不可变参数；
- `status`：`pending | running | retry_wait | completed | failed`；
- `attempt_count`、`available_at`、`lease_owner`、`lease_expires_at`、`last_error_code`；
- `created_at/updated_at/completed_at`。

这些 snapshot 不能依赖会随 Family/profile 级联删除而消失的必需外键；`family_id_snapshot` 只用于审计与纵深隔离，不允许反向恢复已删除家庭。创建或 replacement 事务与 profile 同时插入 ensure operation；retire 和家庭删除事务先写 delete tombstone，再允许删除数据库实体。Worker 幂等 ensure/delete collection，成功 ensure 后幂等补齐 document jobs；进程重启扫描 `pending`、过期 `running` 和到期 `retry_wait`，外部资源成功达到目标状态后才标记 completed。

## 11. 凭据加密与轮换

### 11.1 加密边界

部署必须提供独立的凭据加密 keyring，例如：

```text
FAMILY_MODEL_CREDENTIAL_ACTIVE_KEY_ID
FAMILY_MODEL_CREDENTIAL_KEYS_JSON
```

它们属于部署安全基础设施，不是模型配置。生产环境缺失时后端启动失败；测试环境使用显式测试 keyring，不能回退到 JWT secret 或硬编码默认值。

加密使用经认证加密（AEAD），每条 secret 使用独立随机 nonce。`family_id`、`profile_id`、`secret_version_id` 和 key ID 作为 associated data，防止跨家庭或跨记录移动 ciphertext 后仍可解密。日志、trace、异常和 API 永不包含明文 Key。

### 11.2 轮换语义

Key 轮换是独立 Owner 动作：

1. 校验 Owner、当前密码重新认证和 profile 家庭归属，计算不含明文 Key 的服务端 HMAC request fingerprint；
2. 先 claim/replay operation receipt；completed 且 fingerprint 相同则返回原安全结果，不再检查旧 settings version；
3. 只有新 claim owner 才锁定 `family_model_settings` 与 provider profile，复核 settings 版本、profile 固定 credential scope 和当前指针；
4. 加密写入新 secret version并原子切换 `current_secret_version_id`；
5. 旧 secret 进入 `revoked`；
6. 在同一事务完成不含秘密的活动日志和 receipt；
7. 同键不同 fingerprint 返回稳定冲突，并发相同请求等待或读取最终 completed receipt。

Key 轮换不改变 endpoint、credential scope、模型、价格或搜索 identity。若新凭据只适用于不同 endpoint/scope，必须创建新 Provider profile 并通过配置发布切换，不能借轮换或 PATCH 混合两个 scope。新 dispatch 使用新 Key；已提交的 provider send 不因轮换回滚。尚未首次 dispatch 的持久化任务在发送前解析当前 Key，因此不会继续使用被撤销 Key。

## 12. Provider 网络安全

所有 LLM、图片、音频、Embedding、Rerank、模型列表探测和 provider 返回媒体下载统一经过 `ProviderNetworkPolicy`。各 adapter 不得自行绕过。

### 12.1 URL 基础规则

- 只允许 `https` 公网目标；
- `http` 仅允许部署私网白名单精确命中的目标；
- 禁止 URL userinfo、fragment、空 host、模糊 Unicode host 和非法端口；
- 标准化 IDNA、scheme、host、port 和 base path 后保存；
- API Key 只能进入 header，禁止通过 Base URL query/userinfo 保存；
- 禁止自动跟随重定向；必须跟随时逐跳执行完整策略并限制跳数；
- Provider 返回的图片/音频 URL 必须同样校验，默认只允许同源或 adapter 声明的媒体 host。

### 12.2 公网与私网解析

公网目标在保存、测试和每次连接前解析全部 A/AAAA 记录。任一解析结果落入回环、私网、链路本地、组播、保留网段、云元数据地址或部署拒绝网段时拒绝请求。

内网目标必须同时满足：

- host/IP 与端口精确命中部署白名单；
- DNS 解析后的每个地址仍命中允许网段；
- WebSocket 与 HTTP 分别声明允许协议；
- 白名单不能由家庭 Owner 修改。

生产部署优先通过受控 egress proxy 或能固定解析/连接目标的 transport 执行请求，以抵御 DNS rebinding。仅在应用层保存时校验 URL 不足以满足本设计。

### 12.3 响应与日志

- 对 provider response 设置字节上限和内容类型校验；
- 禁止把 provider 原始认证错误、响应 header 或 request body直接返回前端；
- 运维日志可以记录脱敏 host、adapter、状态码类别、耗时和配置 revision，但不记录 Key、URL query、家庭内容或 provider 完整响应；
- Owner UI 只显示安全错误码和恢复建议。

## 13. 草稿、校验与发布

### 13.1 草稿保存

Owner 可以保存不完整草稿。草稿保存只做 schema、安全 URL 和家庭归属校验，不影响运行时。API Key 不进入配置草稿；它只存在于 Provider create 或同 scope rotate 的写入专用命令，不能通过 GET 把旧 Key 填回表单。

保存固定锁顺序为 settings 行、draft 行，再执行锁后版本校验和写入。迁移与 Family bootstrap 保证 settings 行稳定存在；真实 MySQL 并发测试必须覆盖两个 Owner 用相同 base version 更新、首次并发创建以及唯一约束竞争，不能只用顺序 stale 测试代替。

### 13.2 强制发布校验

发布前服务端必须重新校验：

1. 当前用户仍是该家庭 Owner；
2. `base_config_revision_id`、draft version 和 settings version 未过期；
3. 所有启用 binding 引用当前家庭 profile/version；
4. binding 的 profile version 与 secret 都属于同一 profile 固定 credential scope，adapter 支持对应 capability；
5. Provider URL 满足当前网络策略；
6. profile 存在 active secret；本地无鉴权模型必须使用显式 `no_auth` adapter policy，不能用空 Key 猜测；
7. model、dimensions 和 capability options 完整合法；
8. 主 LLM、图片、音频和搜索 fallback 不形成循环；
9. 每个 active variant 都有完整、互不重叠的 billable meter 价格；
10. 当前硬限额与能力 guardrail 可以对这些 variant 保守预留；
11. Embedding identity 变更未绕过 search replacement 流程；
12. 配置和价格 checksum 与待确认摘要一致。

发布失败只更新草稿验证结果，不创建半成品 active revision。

### 13.3 原子发布事务

正常配置发布固定顺序：

1. 在进入版本校验前 claim/replay operation receipt；只有新 claim owner 继续；
2. 锁定 `family_model_settings`；
3. 复核 base revision、draft version 和当前 active pointers；
4. 复核所有 binding 未跨越 profile 固定 credential scope；
5. 创建 config revision 与 capability bindings；
6. 创建引用该 config revision 的完整 active price version 与 rates；
7. 复核 price coverage；
8. 更新 active config/price pointer 与 settings version；
9. 清除或基于新 revision 重置草稿；
10. 对首次 Embedding provisioning 在同一事务创建 search profile 和 `ensure_search_profile_collection` resource operation；
11. 写入活动日志并完成 operation receipt；
12. 提交后由耐久 worker 消费 resource operation，不依赖 commit 后进程内 enqueue。

任何数据库步骤失败时整体回滚。Qdrant 或 Provider 不能参加数据库事务，因此搜索 profile 使用独立可恢复状态机和事务内 outbox，不能在事务失败后伪装成功，也不能在数据库 commit 与 enqueue 之间留下永久 `provisioning` 的 crash gap。

### 13.4 并发语义

- 所有带 idempotency key 的写入都先在认证、Owner 与 family scope 校验后计算 fingerprint，并在 settings/base version 校验前 claim/replay receipt；
- completed receipt 且同 fingerprint 立即返回原安全结果，即使成功请求的响应丢失后当前版本已经推进；
- 同 base version、相同 checksum 的新发布只允许一个 claim owner 执行，竞争请求读取最终 receipt；
- 同 base version、不同 checksum 返回稳定冲突；
- 同 idempotency key、不同 fingerprint 返回稳定的 idempotency conflict；敏感字段只进入服务端 HMAC fingerprint，不保存 Key 或密码；receipt 保存 fingerprint key ID，重放用该 key 重新计算，相关 key 在 receipt 保留期内不得移除；
- 并发 Owner 只有一个事务能推进 active pointer；
- 冲突响应包含当前 revision/version 和“刷新后重新应用草稿”的恢复提示，不返回其他 Owner 输入的 Key；
- 配置发布不会撤销已获得 dispatch authorization 的外部调用；尚未首次 dispatch 的任务按其业务取消规则和当前 secret 状态处理。

## 14. 连通性测试

测试分为两类，不能混为一谈：

### 14.1 非计费连接检查

在 adapter 明确提供非计费模型列表、认证探测或 metadata endpoint 时，可以对草稿执行：

- 网络策略检查；
- TLS/连接检查；
- 认证检查；
- 模型是否可见的提示性检查。

结果保存为脱敏测试记录，不保存 provider payload。Provider 没有安全探测 endpoint 时显示“尚未执行真实调用”，不能为了绿勾静默生成 token、图片或音频。

### 14.2 真实能力测试

真实生成只能在配置和价格已发布后由 Owner 明确触发：

- UI 显示该测试可能产生费用；
- 通过正常模型用量 reserve/dispatch/settlement；
- 受当前预算和硬限额控制；
- 使用最小、无家庭隐私的固定测试输入；
- 结果只用于验证能力，不写入正式菜谱、库存、餐食或媒体绑定。

不允许建立绕过计量的“测试调用”旁路。

## 15. 运行时配置解析

新增 `FamilyModelConfigurationResolver`，接口语义为：

```text
resolve_active(family_id, capability, variant)
resolve_revision(family_id, config_revision_id, capability, variant)
resolve_search_profile(family_id, search_profile_id)
```

返回不可变 DTO，包含 adapter、endpoint、model、能力选项、provider/billing identity、配置 revision 和临时解密的 secret；不返回 ORM 对象。价格由模型用量 Price Catalog 在每次 attempt reserve 时按该 config revision 单独选择，不能由配置 resolver 绕过账本固定。

核心规则：

- `family_id` 只能来自认证 membership、持久化 run/job/session 或已验证业务对象；
- 无 active revision 时返回 `family_model_settings_not_configured`；
- binding disabled 时返回 `family_model_capability_disabled`；
- 解密或网络策略失败时 fail-closed，provider 不得被调用；
- 不读取模型 Provider 环境变量，也不使用全局默认模型 fallback；
- secret 只在首次 dispatch 前短时解密，不进入持久化 job payload、LangGraph state、trace 或 cache；
- adapter 完成请求后释放包含 secret 的 DTO 引用，不跨请求长期缓存。

### 15.1 缓存与多实例

不新增 Redis。每次入口先读取家庭 settings active revision/version；不可变 revision 可按 `(family_id, revision_id)` 做进程内缓存。Active pointer 不做无限期缓存，因此发布后各实例无需重启即可看到新配置。

Secret 明文不进入共享配置缓存。可以缓存加密行和元数据，但每次 dispatch 仍需复核当前 secret pointer/status。

### 15.2 Run、job 与 session 快照

- 新 run/job/session 创建时固定 config revision、capability binding 和 provider/model identity；
- config 后续发布不改写已创建对象；
- Key 轮换不改变业务 identity，首次 dispatch 总是解析 profile 当前 secret；
- 已经建立的 streaming/WebSocket 连接继续到完成、用户取消或超时；发布/轮换不能宣称撤销已发送调用；
- 禁用能力后不再创建新任务；未 dispatch 的普通排队任务按能力定义取消，已 dispatch attempt 按现有 uncertain/settlement 规则收口；
- approval 恢复后的正式业务 commit 不重新调用模型，因此不要求旧 Key 继续存在。

## 16. 模型用量与家庭价格

### 16.1 家庭级 configured variants

当前 `configured_variants(settings)` 改为基于已解析 config revision 生成：

```text
configured_variants(family_id, config_revision_id)
```

每个 variant 必须声明现有中央 capability、variant key、billing scheme、billable meters、produced meters 和 adapter recovery contract。家庭只能从 adapter 支持的 billing scheme 中选择，不能任意把重叠 meter 都标为 billable。

### 16.2 价格输入

Owner 为每个启用 variant 配置：

- billing scheme；
- 各 billable meter 的 `unit_quantity`；
- `unit_price`；
- source currency；
- 非 CNY 时的人工 `fx_to_cny`；
- 可选 reported model alias；
- 变更说明。

常见 UI 单位可以显示为“每 100 万 Token”“每 1 千字符”“每分钟”“每张图片”，后端仍保存中央 meter 与精确 unit quantity。价格和 FX 使用 Decimal/Numeric，禁止 float。允许零价格以支持本地模型，但 UI 必须提示零价格不会消耗成本预算，必要时应配置 meter guardrail。

### 16.3 价格发布

配置发布时必须原子创建覆盖全部 active variant 的完整价格版本。Owner 后续可以只修改价格：

1. 以当前 active price version 为 base，计算 request fingerprint 并在版本校验前 claim/replay operation receipt；
2. 只有新 claim owner 才锁 settings、复核 base 并创建完整新版本，不做稀疏覆盖；
3. 校验当前 active config 全覆盖；
4. 更新 active price pointer、活动日志并在同一事务完成 receipt；
5. 新调用以及之后创建的 active Embedding query/index job 立即使用新版本；成功后响应丢失的重试返回原 receipt。

历史版本不可编辑、取消或删除，只要 reservation/event 引用就永久保留。历史 event 使用调用时的价格快照，不因新价格、FX 或 alias 回算。

### 16.4 Dispatch 线性化

模型用量 attempt 在 reserve 时按其固定 config revision 选择价格：当前 active config 使用当前 active price version；历史 config revision 的排队任务使用该 revision 最新且完整的家庭价格版本。Reservation 固定 price version 和 rate snapshot，首次 dispatch authorization 在锁定家庭 policy/reservation 时复核：

- config revision；
- provider/profile/model/variant；
- reservation 已固定的 price version；
- price rate snapshot；
- current policy version。

价格发布先提交时，之后为当前 active config 创建的新 reservation 使用新价格；已有 reservation、历史 config revision 的任务和已经 dispatch 的 attempt 保留原价格。不能用新价格反向改写已预留或已执行调用。配置切换后的旧 revision 仍至少保留其发布时完整价格，因此排队任务不会因当前目录只覆盖新模型而变成无法结算。

Active Embedding 也遵循同一线性化边界：查询 reservation 和增量/首次索引 job 创建时在短数据库事务内锁定 `family_model_settings`，把当时的 `active_config_revision_id` 与 `active_price_version_id` 写入 reservation/request/job，提交并释放锁后才调用 Provider；不得从 `family_search_profiles` 创建时保存的 config/price 身份选择 active 价格。价格发布和这些创建动作使用同一 settings 锁，因此调价前已经创建的 job 保留旧快照，调价提交后创建的 job/查询使用新快照。Candidate replacement 不是 active 调用，继续固定 candidate profile 的 `search_rebuild_candidate` price version。

### 16.5 未定价与未知计量

- 启用 hard limit 时，缺少完整价格或无法保守估算的 variant 不允许发布；
- 监控模式也要求发布价格，但 provider 未返回可靠 usage 时按现有 unknown/estimated 规则记录；
- 本地无费用模型可以显式价格为零，不能通过“缺价”表达免费；
- 用户价格是 Culina 预算估算，不宣称等于 Provider 官方账单。

## 17. 搜索 Embedding 与 Rerank

### 17.1 首次配置

家庭首次发布 Embedding 配置时在同一数据库事务创建 `provisioning` search profile 与 `ensure_search_profile_collection` resource operation；耐久 worker 幂等创建独立 Qdrant collection，并在成功后补齐索引 job。搜索行为为：

- MySQL 关键词和本地排序继续可用；
- profile 未 active 前不发送查询 Embedding；
- UI 显示索引进度和失败数；
- 后台按家庭拆分 embedding batch；active job 创建时从 settings 快照当前 active config/price，不能沿用 profile 创建时价格；
- 全部必要文档完成、维度校验和 collection 检查通过后，原子切换 active search profile；
- 激活失败时保持关键词路径，不把 profile 显示为成功。

### 17.2 不可变索引身份

Active profile 以下字段不可原地修改：

- adapter kind；
- Provider endpoint identity；
- embedding model；
- dimensions；
- distance；
- document builder version。

允许而不重建：

- API Key 轮换；
- 同 identity 的凭据恢复；
- 暂停 Embedding 查询并在不改变 identity 的前提下重新启用；
- Rerank profile/model/价格修改；
- Rerank 开启或关闭。

### 17.3 更换 Embedding

更换不是普通编辑，而是危险操作“重建搜索索引”：

1. Owner 新建 replacement profile 草稿；
2. 服务端统计待索引文档数并按候选价格估算最低/保守成本；
3. Owner 明确确认完整重建；
4. 在同一事务创建不可变 candidate search profile、只覆盖该 Embedding variant 的 `search_rebuild_candidate` price version，以及 `ensure_search_profile_collection` resource operation；
5. 耐久 worker 幂等创建新 collection 并补齐 candidate jobs，新 collection 并行全量构建，旧 profile 继续服务查询；
6. 重建 job 受现有家庭预算、硬限额和能力 guardrail 控制；
7. 失败或 budget blocked 时可在同一 candidate profile 上恢复，不创建重复 collection；
8. 完整验证后锁定 family settings，复核当前 active search profile 仍是本次 replacement 的 base；以切换当下的 active config revision 为基础，只替换 Embedding binding，并把当前完整 active 价格与 candidate Embedding rates 合并成新的 `purpose=active` 价格版本；原子切换 config、price 和 search profile 指针；candidate price version 继续只作为重建 job 的历史价格事实；
9. 旧 profile 标记 superseded，保留部署定义的恢复期；
10. 恢复期后 maintenance 先在事务内写 `delete_search_profile_collection` tombstone，再由 worker 幂等删除旧 collection；外部删除成功后才把 operation 标记 completed 并收口 profile 状态。

任何失败都不得让查询落入半成品 collection。重建期间对 LLM、图片、语音、Rerank 或价格的发布不会被切换覆盖；如果 active search base 已被其他 replacement 改变，本次切换返回 stale conflict，不自动覆盖。切换事务与正在执行的查询存在自然边界：已解析旧 profile 的请求可以完成，新请求使用新 profile。

### 17.4 Collection 与 point 隔离

- 每个 search profile 使用独立 collection，天然允许不同 dimensions；
- point payload 仍保存 `family_id`、`search_profile_id`、entity type/id 作为纵深校验；
- vector store 方法必须显式接收 search profile，不再从全局 Settings 读取 collection；
- 家庭删除事务在级联删除 profile 前按 collection 写入不依赖这些外键的 cleanup tombstone；profile retired 和孤儿 collection 同样由耐久 resource operation worker 执行；
- Worker 扫描 pending、过期 lease 和 retry_wait，进程可在数据库提交、collection 创建/删除或补建 jobs 的任一点退出并安全恢复；
- Qdrant API Key 与 URL 始终是平台基础设施配置，家庭无权读取。

## 18. API 设计

路由使用当前认证 membership 推导家庭，不接受请求体 `family_id`。

### 18.1 Owner 配置 API

路由定义为：

```text
GET    /api/family/model-settings
GET    /api/family/model-settings/draft
PUT    /api/family/model-settings/draft
POST   /api/family/model-settings/draft/validate
POST   /api/family/model-settings/publish

POST   /api/family/model-settings/provider-profiles
PATCH  /api/family/model-settings/provider-profiles/{profile_id}
POST   /api/family/model-settings/provider-profiles/{profile_id}/rotate-key
POST   /api/family/model-settings/provider-profiles/{profile_id}/connection-check

POST   /api/family/model-settings/capabilities/{capability}/test

GET    /api/family/model-settings/prices
PUT    /api/family/model-settings/prices/draft
POST   /api/family/model-settings/prices/publish

POST   /api/family/model-settings/search/replacements
GET    /api/family/model-settings/search/replacements/{profile_id}
POST   /api/family/model-settings/search/replacements/{profile_id}/retry
POST   /api/family/model-settings/search/replacements/{profile_id}/cancel
```

所有路由使用 `require_owner`。读取不存在或跨家庭 ID 统一返回 404；普通 Member 返回 403。Provider profile、draft、revision、price version 和 search profile 的子资源查询都带当前 `family_id`。

Provider PATCH 不接受 credential scope 变化。Owner 更换 adapter、auth scope、Base URL/WebSocket URL、workspace、region 或 project 时，客户端必须创建同时包含新 endpoint 与写入专用 Key 的新 profile，再在草稿中改绑；服务端仍独立复核 checksum，不能依赖前端隐藏字段。

### 18.2 Member 安全状态 API

现有 AI status 可以返回成员可见的粗粒度状态：

```json
{
  "configured": true,
  "capabilities": {
    "llm": "available",
    "image_generation": "unavailable",
    "stt": "available"
  }
}
```

Member 响应不得包含 provider、model、Base URL、profile ID、价格或 credential metadata。Owner 的模型用量页面可以继续查看其家庭的 provider/model 聚合。

### 18.3 写请求并发与敏感确认

- 草稿、发布、价格发布、Key 轮换和搜索重建都携带 base version/idempotency key；
- Key 轮换、首次发布和搜索重建要求当前密码重新认证；
- Owner/family scope 校验后先 claim/replay idempotency receipt，只有新 claim 才校验 base version 并执行事务；
- 相同 idempotency key 与相同 fingerprint 返回原结果，不执行第二次外部测试、重建或发布；成功响应丢失后也不能先返回 stale conflict；
- 同键不同 payload 返回稳定冲突；
- API schema `extra="forbid"`，禁止透传未知 adapter 选项。

## 19. 前端信息架构

### 19.1 页面入口

在家庭工作区“家庭工具”中增加 Owner 专属“AI 服务”入口，与“模型用量”并列。Member 不显示配置入口；成员在使用现场遇到未配置能力时显示“该能力尚未由家庭主理人配置”，不展示技术字段。

模型配置是独立工作区，不放入现有 FamilySettings 大弹窗，也不继续扩大 `FamilySettings.tsx`。

目录定义为：

```text
frontend/src/features/family-model-settings/
  FamilyModelSettingsWorkspace.tsx
  FamilyModelSettingsDesktopView.tsx
  FamilyModelSettingsMobilePage.tsx
  useFamilyModelSettingsQueries.ts
  useFamilyModelSettingsState.ts
  useFamilyModelSettingsActions.ts
  familyModelSettingsModel.ts
  familyModelSettingsOptions.ts
  ProviderProfileEditor.tsx
  CapabilityBindingEditor.tsx
  ModelPriceEditor.tsx
  SearchProfilePanel.tsx
  PublishReview.tsx
```

### 19.2 页面任务

页面按家庭任务而非技术环境变量组织：

1. 服务概览：各能力的已配置、未配置、需处理和测试状态；
2. Provider 档案：名称、类型、Base URL、Key 状态和轮换；
3. 能力配置：对话、图片、语音和搜索分别绑定档案与模型；
4. 模型价格：按模型和用户可理解单位编辑；
5. 搜索索引：显示锁定 identity、进度、失败、重试和重建入口；
6. 发布复核：列出将启用/关闭的能力、价格覆盖和搜索影响。

页面保持一个最强主操作：编辑阶段是“检查配置”，复核阶段是“发布配置”。保存草稿、取消和测试使用次级层级。危险的搜索重建独立确认，默认焦点不落在危险按钮。

### 19.3 响应式

- 桌面使用独立 settings workspace，可采用侧栏分区与主内容编辑；
- 手机使用独立全屏 page，按单个任务逐页进入 Provider、能力、价格和发布复核；
- 桌面与手机共享 query、actions、state、model 和验证，不共享大段 JSX；
- 手机 footer 只保留当前步骤主次操作，处理安全区、软键盘和唯一滚动容器；
- 平板使用受控宽度 workspace/drawer，不呈现窄手机弹窗。

### 19.4 敏感字段与状态

- Key 输入只在“创建档案”或“轮换同一 scope 凭据”任务出现，并且始终为空；现有档案普通编辑不显示 Key 字段；
- endpoint、adapter 或其他 credential scope 字段变化时，Provider 编辑器切换到“创建新档案并改绑”流程，并要求在同一创建请求输入适用于新 scope 的 Key；原档案 PATCH 不提交这些字段；
- 不提供复制、显示原 Key 或从响应恢复输入值；
- 浏览器 localStorage/sessionStorage 不保存 Key、Base URL 草稿或价格草稿；
- 提交失败保留当前 React 表单状态，但刷新后只恢复服务端非秘密草稿；
- loading、empty、validation error、publish conflict、busy、disabled、budget blocked、search provisioning/failed 都有独立可见状态；
- 后台刷新失败时保留旧配置元数据并标记可能陈旧，不清空表单；
- 发布或轮换进行中禁止重复提交、关闭敏感确认和路由跳转，完成后精确失效家庭 model settings、model usage 和 AI status query。

### 19.5 Query 与缓存

新增 query key 必须包含真实家庭隔离维度，例如：

```text
familyModelSettingsRoot(familyId)
familyModelSettings(familyId)
familyModelSettingsDraft(familyId)
familyModelPriceVersions(familyId)
familySearchProfile(familyId)
```

Mutation 失效统一进入 `cacheInvalidation.ts`。Member 不启用 Owner 配置 query；不能先请求再靠 UI 隐藏 403。

现有模型用量前端必须区分 personal/Member 与 Owner family 契约：personal 只允许 `capability | meter | daily_capability_cost` 分组，不发送 provider/model filter，request log 类型和渲染结构上都不包含 provider、model、provider request ID 或价格；`provider_model` 与 `subject` 仅 Owner family scope 可用。从 family 切到 me 时若当前分组或筛选只属于 Owner，先清空筛选并重置为 `capability`，避免向收紧后的 personal API 发送 422 请求。

## 20. `.env` 与部署切换

### 20.1 删除的 Provider 配置

以下类别从 `Settings`、Docker Compose、README、测试默认值和运行时读取中删除：

- `AI_PROVIDER/AI_API_BASE/AI_API_KEY/AI_MODEL` 及主/fallback 模型参数；
- `AI_IMAGE_REFERENCE_*`、`AI_IMAGE_TEXT_*`；
- `AI_STT_*`、`AI_TTS_*`、`AI_REALTIME_*` 中的 Provider、Base URL、Key、model 和家庭默认选项；
- `DASHSCOPE_API_KEY/WORKSPACE_ID/REGION/HTTP_API_BASE/WEBSOCKET_API_BASE`；
- `SEARCH_EMBEDDING_PROVIDER/API_BASE/API_KEY/MODEL/DIMENSIONS`；
- `SEARCH_RERANK_PROVIDER/API_BASE/API_KEY/MODEL/INSTRUCT`。

搜索固定 instruction 和算法参数进入受测试的代码常量/产品配置；安全超时与资源上限归部署基础设施设置，不作为家庭 Provider 默认值。

### 20.2 保留的部署配置

- `QDRANT_URL/QDRANT_API_KEY` 与 collection 命名前缀；
- 凭据 AEAD keyring；
- Provider 私网 target allowlist 与 egress proxy；
- trace、安全大小/时长/并发上限；
- `MODEL_USAGE_*` 完整性、维护和队列配置；
- 数据库、JWT、MinIO 和日志配置。

### 20.3 无迁移切换

- Alembic 仍创建新 schema，但不读取或导入旧环境变量；
- 所有 `family_model_settings.active_config_revision_id` 初始为 NULL；
- 旧全局价格版本仅保留历史引用，不作为家庭默认；
- 功能上线后，未配置家庭的真实模型能力 fail-closed；
- 不提供“暂时读取旧 `.env`”的 compatibility fallback；
- 测试必须显式构造家庭配置 fixture，不能因开发机 `.env` 意外访问真实 Provider。

## 21. 错误与降级

新增稳定错误码至少包括：

- `family_model_settings_not_configured`
- `family_model_capability_disabled`
- `family_model_settings_version_conflict`
- `family_model_draft_invalid`
- `family_model_price_incomplete`
- `family_model_billing_scheme_unsupported`
- `family_model_endpoint_blocked`
- `family_model_credentials_missing`
- `family_model_credentials_invalid`
- `family_model_secret_unavailable`
- `family_model_provider_protocol_unsupported`
- `family_model_provider_scope_change_requires_new_profile`
- `family_model_operation_in_progress`
- `family_search_profile_locked`
- `family_search_rebuild_in_progress`
- `family_search_rebuild_budget_blocked`
- `family_search_rebuild_failed`

降级规则：

- LLM 未配置时 AI 工作台显示 Owner 配置提示，不返回模拟业务答案；
- 图片、STT、TTS 和实时语音单独不可用，不拖垮普通业务页面；
- Embedding 未配置、provisioning 或失败时使用 MySQL 关键词 + 本地排序；
- Rerank 未配置或失败时使用完整本地排序；
- 用量治理、凭据解密或 endpoint policy 失败时 fail-closed，不绕过预算或安全边界；
- Provider timeout/uncertain 继续使用现有 adapter recovery 和账本语义，不能因配置来自数据库就自动重发。

前端只显示安全、可恢复的中文提示；原始 provider response、内部 URL、Key 指纹和堆栈不进入成员可见错误。

## 22. 审计与可观测性

- 配置发布、价格发布、Key 轮换、能力测试、搜索重建创建/重试/切换都记录 actor、family、revision/profile/version、时间和结果；
- 家庭活动日志只使用脱敏摘要，例如“更新了家庭 AI 服务配置”“轮换了模型服务凭据”，不包含 Provider host、模型价格或 Key；
- Owner 配置历史可以查看变更类型和操作者，但不能查看历史 Key；
- trace 与 LLM exchange 保存 `config_revision_id`、`provider_profile_id`、`provider_profile_version_id`、provider/model identity 和 usage receipt，不保存 secret，也不向 Member API 暴露内部 profile ID；
- Member 模型用量 API 不通过 provider/model 分组泄露家庭连接信息；Owner 保留家庭级 provider/model 诊断权限；
- 日志脱敏器增加 `authorization`、`api-key`、自定义鉴权 header、secret/ciphertext/nonce 等字段覆盖；
- 指标至少覆盖 resolver failure、decrypt failure、endpoint blocked、publish conflict、price coverage failure、search profile progress 和 per-capability provider failure。

## 23. 测试策略

### 23.1 后端配置与权限

- Owner 正常读取/保存/发布；
- Member 全部配置 API 403；
- 跨家庭 profile/draft/revision/price/search profile 返回 404；
- 请求体伪造 family/actor/secret metadata 被拒绝；
- 多 Owner stale draft、stale publish、同键重放和同键不同 payload；
- 真实 MySQL 下两个 Owner 用同一 base draft version 并发更新及首次并发创建，只有一个成功推进；
- 发布、调价、轮换和 replacement 成功但响应丢失后，同 key/fingerprint 在版本推进后仍重放 completed receipt；
- 发布中任一子步骤失败整体回滚；
- 活动日志和审计字段正确且不含敏感值。

### 23.2 凭据与网络

- AEAD associated data 防止 ciphertext 跨家庭/跨 profile 移动；
- API 和日志不返回明文、ciphertext、nonce 或认证 header；
- Key 轮换后新 dispatch 使用新 Key，旧 Key 不再解析；
- endpoint/adapter/workspace/region 等 scope 变化 PATCH 被拒绝；新 endpoint B/key B 通过新 profile 切换，任何时点都不会出现 endpoint A/key B 或 endpoint B/key A；
- 公网 HTTPS、非法 scheme、userinfo、fragment、异常端口；
- IPv4/IPv6 回环、私网、链路本地、云元数据和保留地址；
- DNS 多地址、rebind、CNAME、重定向和 provider 媒体下载；
- 白名单内 Ollama/vLLM HTTP/WebSocket 与白名单外拒绝。

### 23.3 运行时与计量

- 七类能力都按 family/revision 解析，不读取环境变量；
- 不同家庭并发使用不同 Provider/Key/model 不串线；
- run/job/session 快照与后续 config 发布隔离；
- price-only 发布的线性化边界，包括调价后 active Embedding 查询和增量索引使用新 price snapshot、既有 job 保留旧 snapshot；
- LLM exchange ORM/migration 与写入路径统一保存 nullable config/profile version identity，历史行兼容；
- complete/missing/zero/custom currency price；
- hard limit、guardrail、unknown usage、provider timeout 和 ambiguous attempt；
- 真实能力测试进入正常账本且不能绕过预算。

### 23.4 搜索

- 不同 dimensions 的家庭使用不同 collection；
- point payload 和数据库查询继续按 family/profile 隔离；
- active embedding identity 普通 PATCH 被拒绝；
- Key 轮换不重建；Rerank 修改不重建；
- replacement profile 全量构建、失败、重试、budget blocked、原子切换；
- 重建期间修改其他能力或价格，最终切换只替换 Embedding，不恢复旧配置；
- 两个 replacement 竞争时，只有 base search profile 仍匹配的一方可以切换；
- 切换失败继续使用旧 profile；
- profile 创建/replacement 数据库提交后、collection ensure/enqueue 前进程退出可由 resource operation 恢复；
- retired collection 延迟清理和家庭删除前 cleanup tombstone；实体级联删除后仍能取得 collection snapshot 并重试；
- 未配置/provisioning/失败时关键词与本地排序降级。

### 23.5 前端

- Owner/Member 入口和 query enabled 权限；
- Provider、能力、价格、发布复核和搜索重建流程；
- Key write-only、普通编辑不含 Key、创建/轮换失败后不进入浏览器存储；
- loading/empty/error/busy/conflict/blocked/provisioning/failed；
- 缓存失效和家庭切换不泄露上一家庭草稿；
- 模型用量从 family 切到 me 会清除 Owner-only 分组/筛选，personal 请求和 UI 不包含 provider/model/provider request ID/价格；
- 桌面、平板、手机布局、软键盘、安全区、滚动、焦点与 Escape/backdrop；
- 敏感确认与危险重建默认焦点；
- 简体中文、触控尺寸和非颜色状态表达。

### 23.6 验证命令

实施阶段至少执行：

```bash
npm run backend:migrate
npm run backend:test:service
npm run backend:test:ai
npm run backend:test:search
npm run backend:quality

npm run frontend:quality
npm run frontend:build
npm --prefix frontend run check:style-tokens
npm run frontend:e2e:p0
```

还需要使用 fake provider/transport 覆盖每类协议；普通测试默认没有任何真实家庭 Provider 配置，禁止访问公网或开发机 `.env`。

## 24. 实施拆分与发布边界

这是一个统一终态设计，但实现按可验证边界拆分：

1. Schema、加密、网络策略、Owner API 和配置发布内核；
2. 家庭 price catalog 与模型用量 family variant 解析；
3. LLM runtime 与 AI run 快照；
4. 图片、STT、TTS 和实时语音；
5. Embedding/Rerank、家庭 search profile 和独立 Qdrant collection；
6. 前端家庭 AI 设置工作区与移动页面；
7. 环境变量删除、文档、全量回归和统一开放。

可以分 PR 实现，但上线前不允许出现某些家庭调用数据库配置、另一些能力静默读取 `.env` 的混合终态。功能入口在七类能力、价格、搜索和安全测试全部完成前保持不可用；最终发布一次性取消旧 Provider 环境变量路径。

## 25. 验收标准

满足以下全部条件才视为完成：

1. 新部署不设置任何模型 Provider 环境变量也可正常启动；
2. 未配置家庭的所有模型能力返回稳定未配置状态，不调用外部 Provider；
3. 两个家庭可并发使用完全不同的 Provider、Key、模型和价格，数据库、缓存、job、账本与 Qdrant 不串线；
4. Member 无法通过 API、状态、模型用量分组、错误或前端缓存获得 Provider、Base URL 或凭据；
5. Key 只加密保存且可轮换，任何 API/日志/trace 不泄露；
6. Provider credential scope 不可 PATCH；endpoint 与 Key 更换通过新 profile 原子绑定，不存在跨 scope 混用窗口；
7. 任意公网和白名单内网 Base URL 经过统一可测试的出站策略；
8. 七类真实模型调用全部进入现有用量、预算、硬限额和告警；
9. 家庭价格版本立即作用于包括 active Embedding 在内的新 dispatch/job，历史调用保持旧快照；
10. active Embedding identity 不能普通编辑，replacement 重建成功前继续使用旧索引；
11. Qdrant collection 支持家庭间不同 dimensions，且 collection/point/cleanup 均按家庭 profile 隔离；创建、删除与家庭级联删除具备耐久 outbox/tombstone 恢复；
12. 桌面、平板和手机都能完成配置、发布、调价、轮换和搜索恢复；
13. `Settings`、Docker Compose、README 和测试不再包含或读取旧模型 Provider 配置；
14. Alembic、后端定向/全量测试、前端质量/构建/样式报告和关键移动路径全部通过并完成人工审阅。

## 26. 明确无开放项

本规格已固定产品范围、权限、Provider 自定义能力、内网支持、用量治理、自定义价格、调价语义、搜索不可变边界和无迁移切换。实施计划不得重新引入以下未批准捷径：

- 全局默认 Provider；
- `.env` fallback；
- Member 可编辑配置；
- 绕过模型用量的测试调用；
- 共享单一 Qdrant collection 支持不同 dimensions；
- 原地修改 active Embedding identity；
- 用明文、可逆前端值或日志保存 API Key；
- 用稀疏价格覆盖或后续调价回算历史。

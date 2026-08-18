# Culina 家庭级模型服务与价格配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Culina 的七类模型能力从进程级 Provider 环境变量切换为家庭 Owner 管理的 Provider、凭据、模型与价格配置，并保证家庭隔离、用量治理、搜索索引切换和移动端操作完整可用。

**Architecture:** 后端以固定 credential scope 的 Provider profile、Secret version、不可变 Configuration revision、家庭 Price version 和不可变 Search profile 为运行时真相；所有调用先解析家庭与 revision，再经过模型用量 reserve/dispatch/settlement，并在首次 dispatch 授权时固定 credential secret version。Embedding 使用每个家庭 search profile 的独立 Qdrant collection、事务内资源 outbox 和可恢复全量重建状态机；前端使用独立家庭 AI 服务工作区，共享 query/actions/state/model，但桌面和手机分别实现信息架构。

**Tech Stack:** Python 3.12、FastAPI、SQLAlchemy 2、Alembic、MySQL 8.4、Pydantic 2、`cryptography==46.0.5` AES-GCM、httpx/WebSocket、Qdrant、pytest；React 18、TypeScript 5.7、React Query 5、Vitest、Testing Library、Playwright、Culina UI kit 与 canonical CSS tokens。

## Global Constraints

- 本计划以 `docs/superpowers/specs/2026-08-18-family-managed-model-settings-design.md` 为产品与架构真相源；实现发现产品语义冲突时先更新规格并取得复核，不在代码中静默改变保证。
- 只有当前 membership 的 `Owner` 可以读取或修改 Provider、Base URL、模型、价格和 credential metadata；Member 只能读取不含 provider/model/profile/price/credential 字段的粗粒度能力状态。
- 所有 profile、draft、revision、price、search profile、job、reservation 与子资源查询必须同时约束可信 `family_id`；请求体不接受 `family_id`、actor 或 secret metadata。
- 七类能力 `llm`、`image_generation`、`stt`、`tts`、`realtime_audio`、`embedding`、`rerank` 必须同一制品、同一 Alembic head 和同一发布门禁完成后统一开放。
- 不导入旧模型 `.env` 值，不保留运行时 fallback，不在未配置家庭返回模拟结果；所有新家庭和现有家庭的 active config 初始均为空。
- API Key 只接受写入，使用独立部署 keyring 和 AES-256-GCM 加密；明文、nonce、ciphertext、auth tag、认证 header、secret fingerprint 不进入用户响应、日志、trace、job payload 或浏览器存储。
- Secret 明文只在首次 dispatch permit 已持久化后短时解密；配置解析缓存不得保存明文。Key 轮换不改变 binding、价格或 search identity，新 dispatch 使用新 secret，已授权 dispatch 保留其固定 secret version。
- Provider profile 的 credential scope 创建后不可变；adapter/auth、HTTP/WebSocket endpoint、workspace、region、project 等变化必须用新 endpoint + 新 Key 创建新 profile 再发布改绑，PATCH/轮换不得产生跨 scope 的 endpoint/Key 组合。
- 任意 Provider HTTP/WebSocket/媒体下载都必须经过统一 URL、DNS、IP、重定向、响应大小和内容类型策略；adapter 不得直接创建绕过策略的 `httpx.Client` 或 WebSocket 连接。
- 所有真实调用和真实能力测试继续经过现有 reserve/dispatch/settlement、预算、hard limit、guardrail、alert、uncertain 和 recovery 语义；不建立未计量旁路。
- 家庭价格使用完整不可变版本、`Decimal`/`Numeric(30,12)` 金额和 `Numeric(30,6)` 数量；价格在 reservation 创建时固定，新价格不修改历史 reservation/event。
- `purpose=active` price version 必须引用同家庭 config revision；`purpose=search_rebuild_candidate` 只能引用同家庭 candidate search profile 且只包含该 Embedding variant；旧全局版本只保留 `legacy_global` 历史引用。
- Active Embedding identity 不可 PATCH；adapter、endpoint identity、model、dimensions、distance 或 document builder version 改变必须新建 replacement profile、独立 collection、全量重建并原子切换。
- 搜索切换必须以切换当下的 active config/price 为基线，只替换 Embedding binding/rates；重建期间发布的 LLM、图片、语音、Rerank 或价格变更不得被旧草稿恢复。
- Active Embedding 查询和增量/首次索引 job 创建时从 settings 共同快照 config/price；普通调价后创建的调用立即使用新价格，candidate 重建继续固定 candidate price。
- Qdrant ensure/delete 与数据库 profile 状态通过事务内 `family_model_resource_operations` 衔接；家庭删除先写不级联的 collection tombstone，进程重启可恢复任何外部副作用窗口。
- 写请求使用 base version、idempotency key 和 request fingerprint；认证/Owner/family scope 后先 claim/replay receipt，只有新 claim 才检查 base version、锁 `family_model_settings` 并写入；同键同 fingerprint 返回原结果，同键不同 fingerprint 返回稳定冲突。
- 每个家庭迁移/bootstrap 后都有稳定 settings 锁行；共享草稿先锁 settings、再锁后读取 draft 并校验 version，首次并发创建也不能无锁 INSERT。
- Personal 模型用量与 Owner family 诊断使用分离的后端/前端类型；personal 请求不允许 provider/model 分组或筛选，响应与 DOM 不包含 provider/model/request ID/每请求价格。
- Pydantic 写 schema 使用 `ConfigDict(extra="forbid")`；adapter、capability、variant、billing scheme 和 meter 均来自服务端 registry，不能由 Owner 定义新协议或计量单位。
- UI 文案使用简体中文；一个任务容器只有一个最强主 CTA；Key 始终空输入；刷新失败保留旧非秘密数据并标记陈旧；敏感提交 busy 时阻止关闭、重复提交和路由离开。
- UI 使用 canonical `--bg (#FAF8F5)`、`--surface-2 (rgba(255,255,255,0.98))`、`--accent (#D26B33)`、`--text (#2F251E)`、`--line-soft`、`--radius-md (20px)`、`--control-height (44px)` 与手机 `--control-height-touch (48px)`；不得复制当前实现中偏移的随机值。
- 桌面、平板、手机共享 data/actions/state/model；手机使用独立全屏 page，处理安全区、软键盘、唯一滚动容器和 sticky footer，不把桌面 JSX 直接压缩。
- 每个 Task 按红—绿—重构执行。计划中的提交命令是未来执行检查点；只有用户明确授权提交时才运行 `git commit`。不得使用 `git add -A`，只暂存 Task 列出的文件。
- 每个 Task 结束运行 focused tests 和 `git diff --check`；最终 Task 再运行 migration、全量后端、全量前端、样式报告、P0 E2E、目标视口和 fake-provider protocol suite。

---

## Dependency Map

```mermaid
flowchart LR
    A["1. Schema and immutable identities"] --> B["2. Credential encryption and rotation"]
    A --> C["3. Adapter registry and network policy"]
    A --> D["4. Draft/profile repositories and Owner API"]
    B --> D
    C --> D
    D --> E["5. Validation and atomic publish"]
    E --> F["6. Family prices and usage linearization"]
    F --> G["7. LLM runtime snapshots"]
    F --> H["8. Image jobs"]
    F --> I["9. Audio and realtime"]
    F --> J["10. Search profile storage"]
    J --> K["11. Search rebuild and activation"]
    G --> L["12. Safe status, tests, maintenance"]
    H --> L
    I --> L
    K --> L
    E --> M["13. Frontend contracts and state"]
    L --> M
    M --> N["14. Desktop/mobile workspace"]
    N --> O["15. Env removal and cutover"]
    O --> P["16. Full verification"]
```

## File Structure and Responsibilities

### New backend files

- `backend/app/models/family_model_settings.py`: family settings pointers, provider/profile/secret/config/search identities, per-profile search-document state, idempotency receipts and durable resource operations.
- `backend/app/repos/family_model_settings/profiles.py`: family-scoped profile/version/secret lookups and row locks.
- `backend/app/repos/family_model_settings/configurations.py`: draft, revision, binding and active-pointer reads.
- `backend/app/repos/family_model_settings/search_profiles.py`: profile/document/job progress queries.
- `backend/app/repos/family_model_settings/idempotency.py`: `(family_id, operation, idempotency_key)` claim/replay logic.
- `backend/app/repos/family_model_settings/resource_operations.py`: Qdrant ensure/delete outbox claims, leases and non-cascading cleanup snapshots.
- `backend/app/schemas/family_model_settings.py`: strict Owner request/response schemas and Member-safe status schemas.
- `backend/app/api/family_model_settings.py`: Owner routes only; authentication, HTTP mapping and transaction boundary.
- `backend/app/services/family_model_settings/types.py`: immutable resolver DTOs and command/result dataclasses.
- `backend/app/services/family_model_settings/errors.py`: stable domain errors and safe messages.
- `backend/app/services/family_model_settings/adapter_registry.py`: allowed adapter/capability/auth/billing contracts.
- `backend/app/services/family_model_settings/credentials.py`: keyring decode, AES-GCM, HMAC fingerprint, rotation and destruction eligibility.
- `backend/app/services/family_model_settings/network_policy.py`: URL normalization, DNS/IP/allowlist checks and authorized endpoints.
- `backend/app/services/family_model_settings/transport.py`: HTTP/WebSocket/media transport that consumes only authorized endpoints.
- `backend/app/services/family_model_settings/drafts.py`: shared server draft save/load and OCC.
- `backend/app/services/family_model_settings/validation.py`: strict capability/options/price/search validation and publish summary.
- `backend/app/services/family_model_settings/publishing.py`: atomic config + active price publication and replay.
- `backend/app/services/family_model_settings/prices.py`: family price drafts, complete version publication and merge helpers.
- `backend/app/services/family_model_settings/resolver.py`: family/revision/search resolution without plaintext caching.
- `backend/app/services/family_model_settings/connection_tests.py`: explicitly non-billable metadata/auth probes only.
- `backend/app/services/family_model_settings/search_profiles.py`: first provisioning, replacement, retry/cancel/activate state machine.
- `backend/app/services/family_model_settings/status.py`: Member-safe capability projection and Owner history summary.
- `backend/app/services/family_model_settings/maintenance.py`: revoked-secret destruction, durable Qdrant ensure/delete worker and family-delete tombstones.

### New frontend files

- `frontend/src/api/familyModelSettingsApi.ts`: typed request methods for Owner settings endpoints.
- `frontend/src/features/family-model-settings/familyModelSettingsModel.ts`: draft defaults, payload conversion, Decimal string validation, publish/search confirmation models and safe API error parsing.
- `frontend/src/features/family-model-settings/familyModelSettingsOptions.ts`: Chinese labels for capability, adapter, status, billing scheme and meter options.
- `frontend/src/features/family-model-settings/useFamilyModelSettingsQueries.ts`: Owner-only query composition and stale-data behavior.
- `frontend/src/features/family-model-settings/useFamilyModelSettingsState.ts`: section, selected profile, overlays, unsaved state and mobile navigation.
- `frontend/src/features/family-model-settings/useFamilyModelSettingsActions.ts`: save/validate/publish/rotate/test/rebuild mutations and exact invalidation.
- `frontend/src/features/family-model-settings/FamilyModelSettingsWorkspace.tsx`: hook composition only.
- `frontend/src/features/family-model-settings/FamilyModelSettingsDesktopView.tsx`: desktop sidebar and editor surface.
- `frontend/src/features/family-model-settings/FamilyModelSettingsMobilePage.tsx`: independent mobile full-screen task pages.
- `frontend/src/features/family-model-settings/ProviderProfileEditor.tsx`: write-only credential and endpoint form.
- `frontend/src/features/family-model-settings/CapabilityBindingEditor.tsx`: seven controlled capability editors.
- `frontend/src/features/family-model-settings/ModelPriceEditor.tsx`: complete price coverage editor using user-facing units.
- `frontend/src/features/family-model-settings/SearchProfilePanel.tsx`: locked identity, progress, retry/cancel and replacement confirmation.
- `frontend/src/features/family-model-settings/PublishReview.tsx`: checksum-bound enable/disable/price/search review.
- `frontend/src/styles/15-family-model-settings.css`: `.family-model-settings-*` desktop/tablet/mobile business layout only.

## Locked Cross-Task Interfaces

These names are implementation locks. If an implementation task changes one, it must update every consumer, test and this plan in the same review unit.

```python
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal, Mapping

FamilyModelCapability = Literal[
    "llm", "image_generation", "stt", "tts",
    "realtime_audio", "embedding", "rerank",
]
FamilyModelAdapterKind = Literal[
    "openai_compatible_http", "openai_realtime",
    "dashscope_http", "dashscope_realtime",
]
FamilyModelAuthMode = Literal["api_key", "no_auth"]

@dataclass(frozen=True, slots=True)
class CapabilityBindingIdentity:
    capability: FamilyModelCapability
    variant_key: str

@dataclass(frozen=True, slots=True)
class ResolvedProviderEndpoint:
    normalized_url: str
    scheme: Literal["https", "http", "wss", "ws"]
    host: str
    port: int
    base_path: str
    resolved_addresses: tuple[str, ...]
    private_target: bool

@dataclass(frozen=True, slots=True)
class ResolvedCapabilityBinding:
    family_id: str
    config_revision_id: str
    provider_profile_id: str
    provider_profile_version_id: str
    adapter_kind: FamilyModelAdapterKind
    auth_mode: FamilyModelAuthMode
    endpoint: ResolvedProviderEndpoint
    websocket_endpoint: ResolvedProviderEndpoint | None
    requested_model: str
    billing_model: str
    capability: FamilyModelCapability
    variant_key: str
    billing_scheme_key: str
    options: Mapping[str, object]

@dataclass(frozen=True, slots=True)
class ResolvedSearchProfile:
    family_id: str
    search_profile_id: str
    provider_profile_id: str
    provider_profile_version_id: str
    adapter_kind: FamilyModelAdapterKind
    auth_mode: FamilyModelAuthMode
    endpoint: ResolvedProviderEndpoint
    embedding_model: str
    dimensions: int
    distance: Literal["Cosine"]
    document_builder_version: str
    qdrant_collection: str

@dataclass(frozen=True, slots=True)
class ActiveModelPriceSnapshot:
    family_id: str
    config_revision_id: str
    price_version_id: str
    search_profile_id: str | None

@dataclass(frozen=True, slots=True)
class EmbeddingUsageSnapshot:
    config_revision_id: str | None
    price_version_id: str
    candidate: bool

@dataclass(frozen=True, slots=True)
class DispatchCredential:
    family_id: str
    provider_profile_id: str
    secret_version_id: str | None
    api_key: str | None

class FamilyModelConfigurationResolver:
    def resolve_active(
        self, family_id: str, capability: FamilyModelCapability, variant_key: str
    ) -> ResolvedCapabilityBinding: ...

    def resolve_revision(
        self, family_id: str, config_revision_id: str,
        capability: FamilyModelCapability, variant_key: str,
    ) -> ResolvedCapabilityBinding: ...

    def resolve_search_profile(
        self, family_id: str, search_profile_id: str
    ) -> ResolvedSearchProfile: ...

    def resolve_dispatch_credential(
        self, binding: ResolvedCapabilityBinding | ResolvedSearchProfile,
        credential_secret_version_id: str | None,
    ) -> DispatchCredential: ...

@dataclass(frozen=True, slots=True)
class FamilyPriceRateInput:
    capability: FamilyModelCapability
    variant_key: str
    meter: str
    unit_quantity: Decimal
    unit_price: Decimal
    source_currency: str
    fx_to_cny: Decimal
    reported_model_aliases: tuple[str, ...]

@dataclass(frozen=True, slots=True)
class PublishedFamilyModelConfiguration:
    family_id: str
    config_revision_id: str
    price_version_id: str
    settings_version_number: int
    config_checksum: str
    price_checksum: str
    search_profile_id: str | None
```

The resolver deliberately returns no plaintext in its normal metadata DTO. `resolve_dispatch_credential()` is called only after the durable dispatch permit contains `credential_secret_version_id`; this split is the concrete implementation of the specification's “first dispatch 前短时解密” rule.

```typescript
export type FamilyModelSettingsSection =
  | 'overview'
  | 'providers'
  | 'capabilities'
  | 'prices'
  | 'search'
  | 'review';

export type FamilyModelSettingsOverlay =
  | { kind: 'provider'; profileId: string | null }
  | { kind: 'rotate-key'; profileId: string }
  | { kind: 'publish-confirm' }
  | { kind: 'search-replacement' }
  | null;

export type FamilyModelSettingsViewState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | {
      state: 'ready';
      section: FamilyModelSettingsSection;
      stale: boolean;
      dirty: boolean;
      busyAction: null | 'save' | 'validate' | 'publish' | 'rotate' | 'test' | 'rebuild';
    };
```

## Task 1: Family configuration ORM schema and Alembic migration

**Files**

- Create: `backend/app/models/family_model_settings.py`
- Modify: `backend/app/models/model_usage.py`
- Modify: `backend/app/models/domain.py`
- Modify: `backend/app/models/__init__.py`
- Modify: `backend/app/db/base.py`
- Modify: `backend/app/core/enums.py`
- Modify: `backend/app/services/bootstrap.py`
- Create: `backend/alembic/versions/6a7b8c9d0e1f_add_family_model_settings.py`
- Create: `backend/tests/family_model_settings/test_models.py`
- Create: `backend/tests/family_model_settings/test_migration_mysql.py`
- Modify: `backend/tests/account/test_account_management.py`

**Interfaces**

- Consumes: current Alembic head `5f6a7b8c9d0e`, existing `MONEY=Numeric(30,12)`, `QUANTITY=Numeric(30,6)`, family/user/run/image/search/usage tables.
- Produces: all stable IDs and foreign keys consumed by every later task; every existing and newly created family has one settings lock row whose active pointers remain NULL, and no environment value is imported.
- Produces support tables `family_search_profile_documents` for parallel active/candidate vector state, `family_model_operation_receipts` for safe request replay and `family_model_resource_operations` for durable Qdrant ensure/delete. These are persistence mechanics required by the approved parallel-rebuild, idempotency and crash-recovery rules, not additional product surfaces.

- [ ] **Step 1: Add metadata tests for every table, family key, pointer and uniqueness guarantee.**

```python
EXPECTED_TABLES = {
    "family_model_settings",
    "family_model_provider_profiles",
    "family_model_provider_profile_versions",
    "family_model_secret_versions",
    "family_model_config_drafts",
    "family_model_config_revisions",
    "family_model_capability_bindings",
    "family_search_profiles",
    "family_search_profile_documents",
    "family_model_operation_receipts",
    "family_model_resource_operations",
}

def test_family_model_settings_metadata_contract() -> None:
    assert EXPECTED_TABLES <= set(Base.metadata.tables)
    settings = Base.metadata.tables["family_model_settings"]
    assert settings.c.active_config_revision_id.nullable is True
    assert settings.c.active_price_version_id.nullable is True
    assert settings.c.active_search_profile_id.nullable is True
    assert settings.c.version_number.nullable is False
    binding = Base.metadata.tables["family_model_capability_bindings"]
    assert unique_columns(binding, "uq_family_model_binding_revision_capability_variant") == {
        "config_revision_id", "capability", "variant_key"
    }
    receipt = Base.metadata.tables["family_model_operation_receipts"]
    assert unique_columns(receipt, "uq_family_model_operation_key") == {
        "family_id", "operation", "idempotency_key"
    }
    assert {"request_fingerprint", "request_fingerprint_key_id", "status", "response_json"} <= set(receipt.c)
    resource_operation = Base.metadata.tables["family_model_resource_operations"]
    assert unique_columns(resource_operation, "uq_family_model_resource_operation") == {
        "operation_type", "resource_key"
    }
    assert not resource_operation.c.family_id_snapshot.foreign_keys
```

- [ ] **Step 2: Run the metadata test and confirm the schema is absent.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_models.py -q`

Expected: FAIL listing missing `family_model_*` and `family_search_*` tables.

- [ ] **Step 3: Add controlled enums and the profile/secret/config/search ORM classes.**

```python
class FamilyModelProviderStatus(str, Enum):
    ACTIVE = "active"
    DISABLED = "disabled"
    ARCHIVED = "archived"

class FamilyModelSecretStatus(str, Enum):
    ACTIVE = "active"
    REVOKED = "revoked"
    DESTROYED = "destroyed"

class FamilyModelSearchProfileStatus(str, Enum):
    PROVISIONING = "provisioning"
    ACTIVE = "active"
    FAILED = "failed"
    SUPERSEDED = "superseded"
    RETIRED = "retired"

class FamilyModelSettings(Base):
    __tablename__ = "family_model_settings"
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), primary_key=True
    )
    active_config_revision_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    active_price_version_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    active_search_profile_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    version_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
```

The complete model file must define the eleven tables listed by `EXPECTED_TABLES`; every live family-owned child row carries `family_id`, immutable version rows have no `updated_at`, and current-pointer rows have explicit `version_number`. `FamilyModelProviderProfile.credential_scope_checksum` is non-null and immutable after creation, every profile version repeats the same checksum for database/service validation, and `current_secret_version_id` is nullable only for explicit `no_auth` scope. Resource-operation snapshots intentionally have no cascading Family/profile foreign key so cleanup survives entity deletion; they still carry opaque family/profile IDs for audit and worker scoping.

- [ ] **Step 4: Add database checks for immutable identities and purpose ownership.**

```python
def test_price_and_search_ownership_constraints() -> None:
    version = Base.metadata.tables["model_usage_price_versions"]
    assert {"family_id", "config_revision_id", "search_profile_id", "purpose"} <= set(version.c)
    profile_doc = Base.metadata.tables["family_search_profile_documents"]
    assert unique_columns(profile_doc, "uq_family_search_profile_document") == {
        "family_id", "search_profile_id", "search_document_id"
    }
    reservation = Base.metadata.tables["model_usage_reservations"]
    assert {
        "config_revision_id", "provider_profile_id", "provider_profile_version_id",
        "credential_secret_version_id", "search_profile_id",
    } <= set(reservation.c)
    exchange = Base.metadata.tables["ai_run_llm_exchanges"]
    assert {
        "config_revision_id", "provider_profile_id", "provider_profile_version_id",
    } <= set(exchange.c)
```

- [ ] **Step 5: Extend existing price, run, image, search-job, reservation and event identities.**

```python
class ModelUsagePriceVersion(Base):
    family_id: Mapped[str | None] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=True
    )
    config_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("family_model_config_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    search_profile_id: Mapped[str | None] = mapped_column(
        ForeignKey("family_search_profiles.id", ondelete="RESTRICT"), nullable=True
    )
    base_price_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_price_versions.id", ondelete="RESTRICT"), nullable=True
    )
    purpose: Mapped[str] = mapped_column(String(40), nullable=False)
    published_by: Mapped[str | None] = mapped_column(String(64), nullable=True)

class ModelUsageReservation(Base):
    config_revision_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    provider_profile_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    provider_profile_version_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    credential_secret_version_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    search_profile_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
```

Add `config_revision_id` to `AIAgentRun` and `AIImageGenerationJob`; add `search_profile_id`, `config_revision_id` and `price_version_id` to `SearchIndexJob`; add `config_revision_id` and `search_profile_id` to `ModelUsageEvent`. Add nullable `config_revision_id`, `provider_profile_id` and `provider_profile_version_id` to `AIRunLLMExchange`; Task 7 must use these exact names and must not add a second conditional migration. Keep historical columns nullable so existing rows remain readable.

- [ ] **Step 6: Register the model module and make metadata imports deterministic.**

```python
from app.models.domain import Base
from app.models import family_model_settings as _family_model_settings
from app.models import model_usage as _model_usage

__all__ = ["Base"]
```

- [ ] **Step 7: Write the migration without importing old Provider environment values.**

```python
revision = "6a7b8c9d0e1f"
down_revision = "5f6a7b8c9d0e"

def upgrade() -> None:
    create_family_model_identity_tables()
    extend_model_usage_price_tables()
    extend_runtime_snapshot_tables()
    op.execute(
        "UPDATE model_usage_price_versions "
        "SET purpose='legacy_global' WHERE purpose IS NULL"
    )
    backfill_empty_family_model_settings_rows()
    add_family_model_pointer_foreign_keys()
```

The migration helper bodies must use explicit `op.create_table`, `op.add_column`, `op.create_foreign_key`, indexes and checks. `backfill_empty_family_model_settings_rows()` inserts one settings row for every existing family with all active pointers NULL and a deterministic initial version; it must not read `Settings` or `.env`. `backend/app/services/bootstrap.py` creates the same empty settings row in the Family creation transaction so draft OCC always has a stable lock target.

- [ ] **Step 8: Add MySQL upgrade/downgrade coverage from the current head.**

```python
def test_family_model_migration_keeps_families_unconfigured(mysql_alembic_db) -> None:
    mysql_alembic_db.upgrade("5f6a7b8c9d0e")
    family_id = mysql_alembic_db.insert_family()
    mysql_alembic_db.upgrade("6a7b8c9d0e1f")
    row = mysql_alembic_db.row(
        "SELECT active_config_revision_id, active_price_version_id, "
        "active_search_profile_id FROM family_model_settings WHERE family_id=%s",
        (family_id,),
    )
    assert row == (None, None, None)
    assert mysql_alembic_db.scalar(
        "SELECT purpose FROM model_usage_price_versions LIMIT 1"
    ) in {None, "legacy_global"}
```

Run: `cd backend && CULINA_TEST_MYSQL_URL="$CULINA_TEST_MYSQL_URL" .venv/bin/python -m pytest tests/family_model_settings/test_migration_mysql.py -q`

Expected: PASS on MySQL 8.4. If the variable is absent, record SKIP and do not treat it as launch evidence.

Add an account/bootstrap test proving a newly created family receives exactly one empty settings row in the same transaction and a rollback cannot leave either side orphaned.

- [ ] **Step 9: Run schema tests and inspect the generated head.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_models.py tests/account/test_account_management.py -q && .venv/bin/alembic heads && cd .. && git diff --check`

Expected: tests PASS, exactly one head `6a7b8c9d0e1f`, diff check clean.

- [ ] **Step 10: Create the review checkpoint.**

```bash
git add backend/app/models/family_model_settings.py backend/app/models/model_usage.py backend/app/models/domain.py backend/app/models/__init__.py backend/app/db/base.py backend/app/core/enums.py backend/app/services/bootstrap.py backend/alembic/versions/6a7b8c9d0e1f_add_family_model_settings.py backend/tests/family_model_settings/test_models.py backend/tests/family_model_settings/test_migration_mysql.py backend/tests/account/test_account_management.py
git commit -m "feat: add family model settings schema"
```

Only run the commit command when the user has explicitly authorized commits.

## Task 2: Credential AEAD keyring, secret versions and safe rotation

**Files**

- Modify: `backend/requirements.txt`
- Modify: `backend/app/core/config.py`
- Create: `backend/app/services/family_model_settings/__init__.py`
- Create: `backend/app/services/family_model_settings/types.py`
- Create: `backend/app/services/family_model_settings/errors.py`
- Create: `backend/app/services/family_model_settings/credentials.py`
- Create: `backend/app/repos/family_model_settings/__init__.py`
- Create: `backend/app/repos/family_model_settings/profiles.py`
- Create: `backend/app/repos/family_model_settings/idempotency.py`
- Create: `backend/tests/family_model_settings/test_credentials.py`
- Create: `backend/tests/family_model_settings/test_operation_receipts.py`
- Create: `backend/tests/family_model_settings/test_secret_rotation.py`

**Interfaces**

- Consumes: `FamilyModelProviderProfile`, `FamilyModelSecretVersion`, `ModelUsageReservation` from Task 1 and existing `verify_password()`.
- Produces: `FamilyModelCredentialCipher.from_settings(settings)`, `create_secret_version()`, replay-first `claim_operation()`, `rotate_profile_secret()`, `resolve_dispatch_credential()` and `destroy_eligible_revoked_secrets()`.
- Security invariant: AAD is exactly `b"culina-family-model-secret-v1\0" + family_id + NUL + profile_id + NUL + secret_version_id + NUL + key_id`; AES-GCM tag is stored separately from ciphertext.

- [ ] **Step 1: Pin the direct cryptography dependency and add keyring validation tests.**

```python
def test_production_requires_family_model_credential_keyring() -> None:
    with pytest.raises(ValidationError, match="FAMILY_MODEL_CREDENTIAL"):
        Settings(
            environment="production",
            family_model_credential_active_key_id="",
            family_model_credential_keys_json="",
        )

def test_keyring_rejects_non_32_byte_keys() -> None:
    with pytest.raises(FamilyModelCredentialConfigurationError):
        decode_family_model_credential_keyring(
            active_key_id="k1",
            keys_json=SecretStr('{"k1":"c2hvcnQ="}'),
        )
```

- [ ] **Step 2: Run the keyring tests and confirm the settings/decoder are missing.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_credentials.py -q`

Expected: FAIL importing `decode_family_model_credential_keyring` or missing Settings fields.

- [ ] **Step 3: Add the direct dependency and deployment-only keyring settings.**

```text
cryptography==46.0.5
```

```python
family_model_credential_active_key_id: str = ""
family_model_credential_keys_json: SecretStr = SecretStr("")
family_model_revoked_secret_retention_hours: int = 24
```

Production validation requires a decodable active 32-byte key. Tests must set an explicit test keyring; no JWT-secret or hard-coded production fallback is allowed.

- [ ] **Step 4: Implement AES-256-GCM envelopes and keyed fingerprints.**

```python
@dataclass(frozen=True, slots=True)
class SecretEnvelope:
    encryption_key_id: str
    nonce: bytes
    ciphertext: bytes
    auth_tag: bytes
    secret_fingerprint: str

class FamilyModelCredentialCipher:
    def encrypt(self, *, family_id: str, profile_id: str, secret_version_id: str, plaintext: str) -> SecretEnvelope:
        nonce = os.urandom(12)
        aad = credential_aad(family_id, profile_id, secret_version_id, self.active_key_id)
        encrypted = AESGCM(self.keys[self.active_key_id]).encrypt(nonce, plaintext.encode("utf-8"), aad)
        return SecretEnvelope(
            encryption_key_id=self.active_key_id,
            nonce=nonce,
            ciphertext=encrypted[:-16],
            auth_tag=encrypted[-16:],
            secret_fingerprint=secret_fingerprint(self.keys[self.active_key_id], plaintext),
        )
```

`decrypt()` reconstructs `ciphertext + auth_tag`, rebuilds the same AAD, converts authentication failures to `family_model_secret_unavailable`, and never includes the exception body in logs.

- [ ] **Step 5: Prove ciphertext cannot move across family, profile, version or key ID.**

```python
@pytest.mark.parametrize("changed", ["family_id", "profile_id", "secret_version_id"])
def test_aead_rejects_cross_identity_ciphertext(cipher, encrypted_secret, changed) -> None:
    identity = encrypted_secret.identity | {changed: f"different-{changed}"}
    with pytest.raises(FamilyModelSecretUnavailable):
        cipher.decrypt(version=encrypted_secret.version, **identity)
```

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_credentials.py -q`

Expected: PASS; secret marker is absent from captured logs and exception text.

- [ ] **Step 6: Add receipt/rotation tests for password re-authentication, replay-before-OCC, scope safety and cross-family 404.**

```python
def test_rotate_key_switches_pointer_and_revokes_old_version(db, owner, profile) -> None:
    result = rotate_profile_secret(
        db,
        family_id=owner.family_id,
        profile_id=profile.id,
        actor_user_id=owner.id,
        current_password="OwnerPass123",
        base_settings_version=1,
        idempotency_key="rotate-1",
        new_api_key="sk-new-secret-marker",
    )
    assert result.secret_version_number == 2
    assert profile.current_secret_version_id == result.secret_version_id
    assert old_secret(profile).status == FamilyModelSecretStatus.REVOKED

def test_rotate_response_lost_replays_after_settings_version_advanced(db, owner, profile) -> None:
    command = rotate_command(owner, profile, base_settings_version=1, idempotency_key="rotate-lost")
    first = rotate_profile_secret(db, command)
    db.commit()  # simulate committed success whose HTTP response was lost
    replay = rotate_profile_secret(db, command)
    assert replay == first
    assert count_secret_versions(db, profile.id) == 2

def test_rotation_cannot_change_credential_scope(db, owner, profile) -> None:
    with pytest.raises(FamilyModelProviderScopeChangeRequiresNewProfile):
        rotate_profile_secret(db, rotate_command(owner, profile, api_base_url="https://new.example/v1"))
```

`test_operation_receipts.py` also changes the active HMAC key between success and replay and proves comparison uses the
receipt's stored key ID. It rejects removal of a still-referenced key, same-key/different-sensitive-payload reuse and an
unowned pending claim; none of these cases stores or logs the sensitive value.

- [ ] **Step 7: Implement rotation under stable locks and write-only results.**

```python
def rotate_profile_secret(db: Session, command: RotateProfileSecretCommand) -> RotatedSecretResult:
    verify_owner_password(db, user_id=command.actor_user_id, password=command.current_password)
    require_provider_profile(db, family_id=command.family_id, profile_id=command.profile_id)
    identity = command.idempotency_identity_with_hmac_fingerprint()
    claim = claim_operation(db, identity)
    if claim.completed:
        return RotatedSecretResult.model_validate(claim.response_json)
    settings_row = lock_family_model_settings(db, family_id=command.family_id)
    profile = lock_provider_profile(db, family_id=command.family_id, profile_id=command.profile_id)
    require_settings_version(settings_row, command.base_settings_version)
    require_unchanged_credential_scope(profile, command.credential_scope_checksum)
    new_version = create_secret_version(db, profile=profile, plaintext=command.new_api_key)
    revoke_current_secret(db, profile=profile)
    profile.current_secret_version_id = new_version.id
    settings_row.version_number += 1
    complete_operation(claim, result_id=new_version.id, response=write_only_secret_result(new_version))
    return write_only_secret_result(new_version)
```

Implement `claim_operation()` here because rotation is the first consumer; later tasks reuse it. After authentication/Owner and family-scoped target resolution, every operation computes a canonical request fingerprint. Sensitive values are included only through a server-keyed HMAC and are never stored in receipt payloads. The receipt stores `request_fingerprint_key_id`; replay first loads the receipt and recomputes with that key rather than today's active key, and deployment validation prevents removing a referenced key during receipt retention. Same key/fingerprint with `completed` returns immediately before settings/base-version validation; same key/different fingerprint returns a stable 409; a concurrent loser waits for or locks and reads the winner's final receipt instead of executing the operation again.

The response contains only `configured`, `secret_version_number`, `updated_at` and a non-sensitive short fingerprint label; it never returns encrypted fields. Rotation accepts no endpoint/auth/workspace/region fields and verifies the profile's fixed credential-scope checksum before advancing only the secret pointer.

- [ ] **Step 8: Implement dispatch-only decrypt and safe destruction eligibility.**

```python
BLOCKING_SECRET_STATUSES = {
    ModelUsageReservationStatus.DISPATCHING,
    ModelUsageReservationStatus.UNCERTAIN,
}

def secret_can_be_destroyed(db: Session, secret: FamilyModelSecretVersion, *, cutoff: datetime) -> bool:
    if secret.status is not FamilyModelSecretStatus.REVOKED or secret.revoked_at is None:
        return False
    if normalize_utc(secret.revoked_at) > cutoff:
        return False
    return not reservation_references_secret_in_statuses(
        db, family_id=secret.family_id, secret_version_id=secret.id,
        statuses=BLOCKING_SECRET_STATUSES,
    )
```

Destroying clears `nonce`, `ciphertext` and `auth_tag`, sets `destroyed_at/status`, and preserves only key ID, version number and HMAC fingerprint audit facts.

- [ ] **Step 9: Run credential and rotation tests.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_credentials.py tests/family_model_settings/test_operation_receipts.py tests/family_model_settings/test_secret_rotation.py -q && cd .. && git diff --check`

Expected: PASS; no plaintext marker in response serialization, logs or database debug representation.

- [ ] **Step 10: Create the review checkpoint.**

```bash
git add backend/requirements.txt backend/app/core/config.py backend/app/services/family_model_settings/__init__.py backend/app/services/family_model_settings/types.py backend/app/services/family_model_settings/errors.py backend/app/services/family_model_settings/credentials.py backend/app/repos/family_model_settings/__init__.py backend/app/repos/family_model_settings/profiles.py backend/app/repos/family_model_settings/idempotency.py backend/tests/family_model_settings/test_credentials.py backend/tests/family_model_settings/test_operation_receipts.py backend/tests/family_model_settings/test_secret_rotation.py
git commit -m "feat: encrypt family provider credentials"
```

Only run the commit command when the user has explicitly authorized commits.

## Task 3: Adapter registry, SSRF policy and pinned Provider transport

**Files**

- Create: `backend/app/services/family_model_settings/adapter_registry.py`
- Create: `backend/app/services/family_model_settings/network_policy.py`
- Create: `backend/app/services/family_model_settings/transport.py`
- Modify: `backend/app/core/config.py`
- Create: `backend/tests/family_model_settings/test_adapter_registry.py`
- Create: `backend/tests/family_model_settings/test_network_policy.py`
- Create: `backend/tests/family_model_settings/test_provider_transport.py`

**Interfaces**

- Consumes: controlled capability/adapter/auth types from Tasks 1–2.
- Produces: `adapter_definition(kind)`, `ProviderNetworkPolicy.authorize()`, `ProviderTransport.request()`, `ProviderTransport.connect_websocket()` and `ProviderTransport.download_media()`.
- Every adapter task later receives `ProviderTransport`; direct network calls become a provider-send inventory failure.

- [ ] **Step 1: Add registry tests for the exact adapter/capability/auth/billing matrix.**

```python
def test_adapter_registry_is_closed_and_explicit() -> None:
    openai_http = adapter_definition("openai_compatible_http")
    assert openai_http.capabilities == frozenset({
        "llm", "image_generation", "stt", "tts", "embedding", "rerank"
    })
    assert openai_http.auth_modes == frozenset({"api_key", "no_auth"})
    assert "realtime_audio" not in openai_http.capabilities
    assert adapter_definition("dashscope_realtime").capabilities == frozenset({"realtime_audio"})
    with pytest.raises(FamilyModelProviderProtocolUnsupported):
        adapter_definition("arbitrary_python_module")
```

- [ ] **Step 2: Define immutable adapter contracts including billing schemes and safe probes.**

```python
@dataclass(frozen=True, slots=True)
class AdapterDefinition:
    kind: FamilyModelAdapterKind
    capabilities: frozenset[FamilyModelCapability]
    auth_modes: frozenset[FamilyModelAuthMode]
    http_protocols: frozenset[str]
    billing_schemes: Mapping[FamilyModelCapability, tuple[str, ...]]
    free_probe_path: str | None
    media_host_policy: Literal["same_origin", "dashscope_declared_hosts", "inline_only"]
```

`no_auth` is valid only for `openai_compatible_http` on an allowlisted private target. Public endpoints and DashScope/OpenAI realtime require `api_key`.

- [ ] **Step 3: Add URL and DNS policy tests covering public, private, IPv4/IPv6 and malformed URLs.**

```python
@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "https://user:pass@example.com/v1",
    "https://example.com/v1#fragment",
    "http://public.example.com/v1",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://169.254.169.254/latest/meta-data",
])
def test_endpoint_policy_blocks_unsafe_targets(policy, url) -> None:
    with pytest.raises(FamilyModelEndpointBlocked):
        policy.authorize(url, protocol="http")

def test_allowlisted_private_http_requires_every_dns_answer_to_match(policy, resolver) -> None:
    resolver.answers = ("10.20.0.8", "203.0.113.9")
    with pytest.raises(FamilyModelEndpointBlocked):
        policy.authorize("http://ollama.internal:11434/v1", protocol="http")
```

- [ ] **Step 4: Add deployment-only network settings with strict JSON decoding.**

```python
family_model_private_target_allowlist_json: SecretStr = SecretStr('{"http":[],"websocket":[]}')
family_model_egress_proxy_url: str = ""
family_model_provider_connect_timeout_seconds: float = 10.0
family_model_provider_request_timeout_seconds: float = 180.0
family_model_provider_response_max_bytes: int = 8 * 1024 * 1024
family_model_provider_media_max_bytes: int = 30 * 1024 * 1024
family_model_provider_redirect_limit: int = 0
```

Allowlist entries use exact `{host, port, cidrs}` objects separately for HTTP and WebSocket. Owner input never changes these fields.

- [ ] **Step 5: Implement normalization and all-address classification.**

```python
def authorize(self, raw_url: str, *, protocol: Literal["http", "websocket"]) -> ResolvedProviderEndpoint:
    parsed = parse_and_normalize_provider_url(raw_url)
    require_allowed_scheme(parsed.scheme, protocol=protocol)
    addresses = tuple(sorted(set(self.resolver.resolve_all(parsed.host))))
    if not addresses:
        raise FamilyModelEndpointBlocked("family_model_endpoint_blocked")
    classifications = tuple(classify_ip(ip_address(value)) for value in addresses)
    private_target = any(item != "public" for item in classifications)
    if private_target:
        self.allowlist.require_exact_match(parsed, addresses=addresses, protocol=protocol)
    if any(item in FORBIDDEN_ADDRESS_CLASSES for item in classifications) and not private_target:
        raise FamilyModelEndpointBlocked("family_model_endpoint_blocked")
    return resolved_endpoint(parsed, addresses=addresses, private_target=private_target)
```

Normalize IDNA host, default port and base path; reject query/userinfo/fragment, ambiguous Unicode, zone IDs, empty host and invalid ports. A public hostname is rejected when any A/AAAA answer is non-public.

- [ ] **Step 6: Add transport tests proving every connection uses a freshly authorized, pinned address and no automatic redirect.**

```python
def test_transport_reauthorizes_before_each_connect(policy, dialer, transport) -> None:
    policy.resolver.answers = ("203.0.113.10",)
    transport.request("POST", "https://provider.example/v1/chat", json={})
    policy.resolver.answers = ("127.0.0.1",)
    with pytest.raises(FamilyModelEndpointBlocked):
        transport.request("POST", "https://provider.example/v1/chat", json={})
    assert dialer.connected_ips == ["203.0.113.10"]

def test_redirect_is_not_followed_without_validated_policy(transport, fake_http) -> None:
    fake_http.respond(302, headers={"location": "http://169.254.169.254/latest"})
    with pytest.raises(FamilyModelEndpointBlocked):
        transport.request("GET", "https://provider.example/models")
```

- [ ] **Step 7: Implement pinned HTTP/WebSocket dialers and bounded response readers.**

```python
class ProviderTransport:
    def request(self, method: str, url: str, *, headers: Mapping[str, str], json: object | None = None) -> ProviderResponse:
        endpoint = self.policy.authorize(url, protocol="http")
        return self.http_dialer.request(
            endpoint=endpoint,
            method=method,
            headers=safe_headers(headers),
            json=json,
            max_response_bytes=self.settings.family_model_provider_response_max_bytes,
            follow_redirects=False,
        )

    def download_media(self, url: str, *, source: ResolvedProviderEndpoint, adapter_kind: str) -> ProviderMedia:
        endpoint = self.policy.authorize_media(url, source=source, adapter_kind=adapter_kind)
        return self.http_dialer.download(
            endpoint=endpoint,
            max_bytes=self.settings.family_model_provider_media_max_bytes,
            allowed_content_types=ALLOWED_PROVIDER_MEDIA_TYPES,
        )
```

The production dialer connects to one address from `resolved_addresses` while preserving the normalized host for Host/SNI. If a deployment egress proxy is configured, it is the only outbound socket and receives the already-authorized normalized target. WebSocket uses the same re-resolution and pinning rules.

- [ ] **Step 8: Add a provider-send inventory test that rejects raw network constructors outside approved infrastructure.**

```python
ALLOWED_NETWORK_MODULES = {
    "app/services/family_model_settings/transport.py",
    "app/services/media.py",
    "app/services/search/vector_store.py",
}

def test_model_adapters_do_not_construct_raw_network_clients() -> None:
    violations = provider_network_constructor_inventory()
    assert violations == []
```

The inventory scans model adapter modules for `httpx.Client`, `httpx.AsyncClient`, `websockets.connect`, `requests.*` and provider SDK constructors, excluding only the declared infrastructure modules.

- [ ] **Step 9: Run registry, policy and transport tests.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_adapter_registry.py tests/family_model_settings/test_network_policy.py tests/family_model_settings/test_provider_transport.py -q && cd .. && git diff --check`

Expected: PASS, including DNS rebind, CNAME/multiple address, IPv6, redirect and media-host cases.

- [ ] **Step 10: Create the review checkpoint.**

```bash
git add backend/app/core/config.py backend/app/services/family_model_settings/adapter_registry.py backend/app/services/family_model_settings/network_policy.py backend/app/services/family_model_settings/transport.py backend/tests/family_model_settings/test_adapter_registry.py backend/tests/family_model_settings/test_network_policy.py backend/tests/family_model_settings/test_provider_transport.py
git commit -m "feat: secure family provider endpoints"
```

Only run the commit command when the user has explicitly authorized commits.

## Task 4: Strict schemas, family-scoped repositories, drafts and Owner profile APIs

**Files**

- Create: `backend/app/schemas/family_model_settings.py`
- Create: `backend/app/repos/family_model_settings/configurations.py`
- Modify: `backend/app/repos/family_model_settings/idempotency.py`
- Create: `backend/app/services/family_model_settings/drafts.py`
- Create: `backend/app/services/family_model_settings/connection_tests.py`
- Create: `backend/app/api/family_model_settings.py`
- Modify: `backend/app/api/router.py`
- Create: `backend/tests/family_model_settings/_support.py`
- Create: `backend/tests/family_model_settings/test_schemas.py`
- Create: `backend/tests/family_model_settings/test_profile_api.py`
- Create: `backend/tests/family_model_settings/test_draft_api.py`
- Create: `backend/tests/family_model_settings/test_draft_mysql_concurrency.py`
- Create: `backend/tests/family_model_settings/test_connection_checks.py`

**Interfaces**

- Consumes: profile/secret models, credential cipher, adapter registry and network policy from Tasks 1–3.
- Produces: strict request/response contracts, family-scoped profile/draft repos, the shared replay-first idempotency primitive and the non-publish Owner endpoints.
- Owner routes implemented here: settings GET, draft GET/PUT, provider POST/PATCH, rotate-key POST and connection-check POST. Validate/publish/price/search/capability-test routes are wired when their services exist in later tasks.

- [ ] **Step 1: Add strict schema tests for unknown fields, write-only keys and discriminated capability options.**

```python
def test_provider_request_forbids_server_owned_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        ProviderProfileCreateRequest.model_validate({
            "family_id": "other-family",
            "display_name": "家用模型",
            "adapter_kind": "openai_compatible_http",
            "auth_mode": "api_key",
            "api_base_url": "https://example.com/v1",
            "api_key": "secret",
            "arbitrary_option": True,
        })

def test_provider_response_has_no_encrypted_or_plain_secret_fields() -> None:
    assert {
        "api_key", "nonce", "ciphertext", "auth_tag", "secret_fingerprint"
    }.isdisjoint(ProviderProfileOut.model_fields)

def test_provider_patch_cannot_change_credential_scope() -> None:
    assert {
        "adapter_kind", "auth_mode", "api_base_url", "websocket_base_url",
        "workspace_id", "region", "project_id", "api_key",
    }.isdisjoint(ProviderProfilePatchRequest.model_fields)
```

Profile creation has a dedicated request carrying endpoint/auth scope and the write-only initial Key. Profile PATCH carries only display name, status and adapter-declared scope-external options. A different endpoint/auth/workspace/region/project always uses a new profile create request and later binding publication; attempting to smuggle scope fields returns 422 or `family_model_provider_scope_change_requires_new_profile`.

- [ ] **Step 2: Define the exact capability draft shapes and price input contract.**

```python
class LlmBindingDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capability: Literal["llm"]
    variant_key: Literal["primary", "fallback"]
    enabled: bool
    provider_profile_id: str | None = None
    requested_model: str = Field(default="", max_length=160)
    billing_scheme_key: Literal["llm-split-v1"] = "llm-split-v1"
    max_output_tokens: int = Field(ge=1, le=65536)
    supports_vision: bool = False
    prompt_cache_enabled: bool = True

class EmbeddingBindingDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capability: Literal["embedding"]
    variant_key: Literal["search"] = "search"
    enabled: bool
    provider_profile_id: str | None = None
    requested_model: str = Field(default="", max_length=160)
    billing_scheme_key: Literal["embedding-token-v1"] = "embedding-token-v1"
    dimensions: int = Field(ge=1, le=65536)
```

Add equally strict classes for image `text/reference`, STT, TTS, realtime audio and Rerank. Use a discriminated union on `capability`; validation rejects duplicate `(capability, variant_key)` identities.

- [ ] **Step 3: Run schema tests and confirm the request/response types do not exist.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_schemas.py -q`

Expected: FAIL on missing schema imports.

- [ ] **Step 4: Implement family-scoped repository methods; no method accepts an ID without `family_id`.**

```python
def get_provider_profile(
    db: Session, *, family_id: str, profile_id: str, for_update: bool = False
) -> FamilyModelProviderProfile | None:
    query = select(FamilyModelProviderProfile).where(
        FamilyModelProviderProfile.family_id == family_id,
        FamilyModelProviderProfile.id == profile_id,
    )
    return db.scalar(query.with_for_update() if for_update else query)

def get_config_draft(
    db: Session, *, family_id: str, for_update: bool = False
) -> FamilyModelConfigDraft | None:
    query = select(FamilyModelConfigDraft).where(
        FamilyModelConfigDraft.family_id == family_id
    )
    return db.scalar(query.with_for_update() if for_update else query)
```

Repository tests create two families with colliding-looking IDs and prove wrong-family reads return `None` for profile, version, secret, draft, revision, binding, price and search profile.

- [ ] **Step 5: Harden the shared idempotency claim/replay with savepoint loser handling.**

```python
def claim_operation(db: Session, identity: OperationIdentity) -> OperationClaim:
    existing = lock_operation_receipt(
        db,
        family_id=identity.family_id,
        operation=identity.operation,
        idempotency_key=identity.idempotency_key,
    )
    if existing is not None:
        require_same_fingerprint(existing, identity.request_fingerprint)
        if existing.status == "completed":
            return OperationClaim.replay(existing)
        raise FamilyModelOperationInProgress(existing.operation)
    try:
        with db.begin_nested():
            row = FamilyModelOperationReceipt.from_identity(identity)
            db.add(row)
            db.flush()
    except IntegrityError:
        row = require_locked_operation_receipt(db, identity)
        require_same_fingerprint(row, identity.request_fingerprint)
        if row.status == "completed":
            return OperationClaim.replay(row)
        raise FamilyModelOperationInProgress(row.operation)
    return OperationClaim.owned(row)
```

Never retry the user operation after losing the unique claim; wait for/lock and replay the winner. `claim_operation()`
returns only a newly owned claim or a completed replay. If a separately committed external-operation claim is still in
progress, it returns a stable in-progress error/recovery path; it never returns an unowned incomplete claim to a caller.
Callers check `claim.completed` before locking settings or validating a base version. The primitive rejects
same-key/different-fingerprint and must never hand an in-progress loser permission to execute.

- [ ] **Step 6: Add draft OCC tests for initial save, stale version, same replay, secret omission and real MySQL concurrency.**

```python
def test_stale_draft_save_returns_current_version(client, owner_headers, draft_payload) -> None:
    first = client.put(
        "/api/family/model-settings/draft",
        headers=owner_headers,
        json=draft_payload | {"base_draft_version_number": 0, "idempotency_key": "draft-1"},
    )
    assert first.status_code == 200
    stale = client.put(
        "/api/family/model-settings/draft",
        headers=owner_headers,
        json=draft_payload | {"base_draft_version_number": 0, "idempotency_key": "draft-2"},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "family_model_settings_version_conflict"
    assert stale.json()["detail"]["current_draft_version_number"] == 1
```

`test_draft_mysql_concurrency.py` opens independent MySQL sessions and uses a barrier to race two Owners with the same `base_draft_version_number`, both for an existing draft and first creation. Exactly one request advances the draft; the other returns the current version conflict instead of overwriting or surfacing a raw unique-constraint error. A sequential stale test is not sufficient evidence.

- [ ] **Step 7: Implement shared server draft persistence and sanitized serialization.**

```python
def save_config_draft(db: Session, command: SaveConfigDraftCommand) -> FamilyModelConfigDraft:
    lock_family_model_settings(db, family_id=command.family_id)
    row = get_config_draft(db, family_id=command.family_id, for_update=True)
    current_version = row.draft_version_number if row is not None else 0
    if command.base_draft_version_number != current_version:
        raise FamilyModelSettingsVersionConflict(current_draft_version_number=current_version)
    payload = FamilyModelConfigDraftPayload.model_validate(command.payload)
    serialized = payload.model_dump(mode="json", exclude_none=True)
    serialized = remove_write_only_secret_commands(serialized)
    if row is None:
        row = new_config_draft(command, serialized)
        db.add(row)
    else:
        row.payload_json = serialized
        row.draft_version_number += 1
        row.updated_by = command.actor_user_id
    db.flush()
    return row
```

Profile API keys are stored by the credential service, never inside `payload_json`. Draft GET returns active secret state only through referenced profile summaries.

The settings row exists for every family from Task 1 migration/bootstrap and is always the first lock. This serializes concurrent first INSERT as well as updates; after the lock is acquired, re-read and validate the draft version before writing.

- [ ] **Step 8: Add profile API permission, cross-family, archive and response-redaction tests.**

```python
@pytest.mark.parametrize("method,path", [
    ("get", "/api/family/model-settings"),
    ("get", "/api/family/model-settings/draft"),
    ("post", "/api/family/model-settings/provider-profiles"),
])
def test_member_cannot_access_owner_model_settings_api(client, member_headers, method, path) -> None:
    response = getattr(client, method)(path, headers=member_headers, json={} if method == "post" else None)
    assert response.status_code == 403

def test_profile_response_is_write_only_for_key(client, owner_headers) -> None:
    response = client.post("/api/family/model-settings/provider-profiles", headers=owner_headers, json=PROFILE_INPUT)
    encoded = response.text.lower()
    assert "secret-marker" not in encoded
    assert "ciphertext" not in encoded
    assert response.json()["credential"]["configured"] is True
```

- [ ] **Step 9: Implement profile POST/PATCH/archive semantics.**

```python
def create_provider_profile(db: Session, command: CreateProviderProfileCommand) -> FamilyModelProviderProfile:
    endpoint = command.network_policy.authorize(command.api_base_url, protocol="http")
    definition = adapter_definition(command.adapter_kind)
    definition.require_auth_mode(command.auth_mode, private_target=endpoint.private_target)
    scope = canonical_credential_scope(definition, endpoint=endpoint, command=command)
    profile = new_provider_profile(command, credential_scope_checksum=scope.checksum)
    version = new_profile_version(profile, endpoint=endpoint, options=command.options, scope=scope)
    db.add_all((profile, version))
    db.flush()
    profile.current_profile_version_id = version.id
    if command.auth_mode == "api_key":
        secret = create_secret_version(db, profile=profile, plaintext=require_value(command.api_key))
        profile.current_secret_version_id = secret.id
    db.flush()
    return profile
```

Create writes the profile, first immutable endpoint version, initial secret version and both current pointers in one transaction. A profile is never published or dispatchable with only one half present. PATCH recomputes the credential scope and rejects any change to adapter/auth kind, normalized HTTP/WebSocket authority/base path, workspace, region, project or other adapter-declared scope field with `family_model_provider_scope_change_requires_new_profile`; it may create a new version only for explicitly scope-external options. Endpoint A/key A therefore remain on the old profile while endpoint B/key B are created together on a new profile. Archive sets status and rejects archive when a current draft or active binding uses the profile.

- [ ] **Step 10: Add non-billable connection-check tests and implement safe probes.**

```python
def test_connection_check_never_calls_generation_endpoint(fake_transport, owner_client, profile) -> None:
    fake_transport.allow("GET", "/models", response={"data": []})
    result = owner_client.post(
        f"/api/family/model-settings/provider-profiles/{profile.id}/connection-check",
        json={"idempotency_key": "check-1"},
    )
    assert result.json()["status"] == "reachable"
    assert fake_transport.calls == [("GET", "/models")]
```

If the adapter has no declared free probe, return `status="not_supported"` and `detail="此服务没有可确认的免费连接检查；发布后可手动运行真实能力测试。"` without sending a request. Persist only status class, latency, profile version and timestamp in the operation receipt.

- [ ] **Step 11: Wire routes, stable errors and explicit transaction commits.**

```python
router = APIRouter(prefix="/api/family/model-settings", tags=["family-model-settings"])

@router.get("", response_model=FamilyModelSettingsOut)
def get_settings_view(
    auth: tuple = Depends(require_owner), db: Session = Depends(get_db)
) -> FamilyModelSettingsOut:
    _, membership = auth
    return serialize_owner_model_settings(db, family_id=membership.family_id)
```

Use `commit_session(db)` only after service success. Map missing/cross-family IDs to 404, stale/idempotency conflicts to 409, invalid schemas to 422, endpoint blocks to 422 and provider probe failures to safe 503 responses.

- [ ] **Step 12: Run focused backend API tests.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_schemas.py tests/family_model_settings/test_profile_api.py tests/family_model_settings/test_draft_api.py tests/family_model_settings/test_draft_mysql_concurrency.py tests/family_model_settings/test_connection_checks.py -q && cd .. && git diff --check`

Expected: PASS; secret marker scan finds no response/log occurrence.

- [ ] **Step 13: Create the review checkpoint.**

```bash
git add backend/app/schemas/family_model_settings.py backend/app/repos/family_model_settings/configurations.py backend/app/repos/family_model_settings/idempotency.py backend/app/services/family_model_settings/drafts.py backend/app/services/family_model_settings/connection_tests.py backend/app/api/family_model_settings.py backend/app/api/router.py backend/tests/family_model_settings/_support.py backend/tests/family_model_settings/test_schemas.py backend/tests/family_model_settings/test_profile_api.py backend/tests/family_model_settings/test_draft_api.py backend/tests/family_model_settings/test_draft_mysql_concurrency.py backend/tests/family_model_settings/test_connection_checks.py
git commit -m "feat: add family model settings owner APIs"
```

Only run the commit command when the user has explicitly authorized commits.

## Task 5: Publish validation, immutable revisions, optimistic concurrency and activity audit

**Files**

- Create: `backend/app/services/family_model_settings/validation.py`
- Create: `backend/app/services/family_model_settings/publishing.py`
- Modify: `backend/app/services/family_model_settings/drafts.py`
- Create: `backend/app/repos/family_model_settings/resource_operations.py`
- Modify: `backend/app/api/family_model_settings.py`
- Modify: `backend/app/schemas/family_model_settings.py`
- Create: `backend/tests/family_model_settings/test_validation.py`
- Create: `backend/tests/family_model_settings/test_publishing.py`
- Create: `backend/tests/family_model_settings/test_publish_api.py`
- Create: `backend/tests/family_model_settings/test_publishing_mysql_concurrency.py`

**Interfaces**

- Consumes: strict draft/profile types and repos from Task 4, adapter/network/credential contracts from Tasks 2–3.
- Produces: `validate_family_model_draft()`, `publish_family_model_configuration()` and the immutable `PublishedFamilyModelConfiguration` result.
- Publication does not perform a Provider or Qdrant call inside the database transaction. If it creates an initial search profile, it writes the idempotent Qdrant ensure operation in that same transaction.

- [ ] **Step 1: Add validation tests for every mandatory publication rule.**

```python
@pytest.mark.parametrize("mutation,code", [
    (remove_active_secret, "family_model_credentials_missing"),
    (bind_unsupported_adapter, "family_model_provider_protocol_unsupported"),
    (mix_profile_endpoint_and_secret_scope, "family_model_provider_scope_change_requires_new_profile"),
    (remove_llm_price_meter, "family_model_price_incomplete"),
    (use_unsupported_billing_scheme, "family_model_billing_scheme_unsupported"),
    (change_active_embedding_identity, "family_search_profile_locked"),
])
def test_publish_validation_returns_stable_code(valid_draft, mutation, code) -> None:
    result = validate_family_model_draft(mutation(valid_draft))
    assert result.valid is False
    assert code in {item.code for item in result.errors}
```

Also test duplicate identities, missing model/dimensions/options, fallback loops, cross-family profile/version, profile version/secret scope mismatch, blocked endpoint, `no_auth` on public URL, incomplete guardrail estimates and checksum mismatch.

- [ ] **Step 2: Implement canonical checksum generation without secret material.**

```python
def config_checksum(payload: ValidatedConfigPayload) -> str:
    canonical = {
        "bindings": [binding.checksum_record() for binding in sorted(
            payload.bindings, key=lambda item: (item.capability, item.variant_key)
        )],
        "profile_versions": sorted(payload.profile_version_ids),
        "search_profile_id": payload.search_profile_id,
    }
    return sha256(canonical_json_bytes(canonical)).hexdigest()

def price_checksum(rates: Sequence[ValidatedFamilyPriceRate]) -> str:
    return sha256(canonical_json_bytes([
        rate.checksum_record() for rate in sorted(rates, key=rate_sort_key)
    ])).hexdigest()
```

Checksums include configuration/price identities and exact Decimal strings; they exclude API Key, encrypted envelope, actor name and timestamps.

- [ ] **Step 3: Run validation tests and confirm failures point to missing implementation.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_validation.py -q`

Expected: FAIL importing validation service.

- [ ] **Step 4: Implement validation in the required deterministic order.**

```python
def validate_family_model_draft(db: Session, command: ValidateDraftCommand) -> DraftValidationResult:
    draft = require_config_draft(db, family_id=command.family_id)
    payload = FamilyModelConfigDraftPayload.model_validate(draft.payload_json)
    profiles = resolve_owned_profile_versions(db, family_id=command.family_id, bindings=payload.bindings)
    errors = [
        *validate_adapter_capabilities(payload, profiles),
        *validate_endpoint_policy(profiles, command.network_policy),
        *validate_credentials(profiles),
        *validate_binding_options(payload),
        *validate_fallback_graph(payload),
        *validate_price_coverage(payload),
        *validate_guardrail_reservability(db, family_id=command.family_id, payload=payload),
        *validate_embedding_transition(db, family_id=command.family_id, payload=payload),
    ]
    return build_validation_result(payload, errors=errors)
```

Draft validation may save safe error codes/field paths but must not create revisions, price versions or external calls.

- [ ] **Step 5: Add publication tests for all-or-nothing writes, same-key replay and stale conflicts.**

```python
def test_publish_rolls_back_when_price_rate_insert_fails(db, publish_command, monkeypatch) -> None:
    monkeypatch.setattr(publishing, "insert_family_price_rates", raise_integrity_error)
    with pytest.raises(IntegrityError):
        publish_family_model_configuration(db, publish_command)
    db.rollback()
    settings = get_family_model_settings(db, family_id=publish_command.family_id)
    assert settings.active_config_revision_id is None
    assert count_rows(db, FamilyModelConfigRevision) == 0
    assert count_rows(db, ModelUsagePriceVersion) == 0

def test_same_publish_key_and_checksum_replays_result(db, publish_command) -> None:
    first = publish_family_model_configuration(db, publish_command)
    db.commit()  # simulate successful commit with a lost HTTP response
    second = publish_family_model_configuration(db, publish_command)
    assert second == first
    assert count_rows(db, FamilyModelConfigRevision) == 1

def test_initial_embedding_publish_persists_ensure_operation_atomically(db, publish_command) -> None:
    result = publish_family_model_configuration(db, with_initial_embedding(publish_command))
    operation = get_resource_operation(db, result.search_profile_id, "ensure_search_profile_collection")
    assert operation.qdrant_collection_snapshot
    assert operation.status == "pending"
```

- [ ] **Step 6: Implement the locked publication transaction.**

```python
def publish_family_model_configuration(
    db: Session, command: PublishConfigurationCommand
) -> PublishedFamilyModelConfiguration:
    claim = claim_operation(db, command.idempotency_identity_with_hmac_fingerprint())
    if claim.completed:
        return PublishedFamilyModelConfiguration.model_validate(claim.response_json)
    settings = lock_family_model_settings(db, family_id=command.family_id)
    require_settings_version(settings, command.base_settings_version_number)
    draft = lock_config_draft(db, family_id=command.family_id)
    require_draft_version(draft, command.base_draft_version_number)
    validation = validate_family_model_draft(db, command.to_validation_command())
    validation.require_confirmed_checksums(command.config_checksum, command.price_checksum)
    search_profile = create_initial_search_profile_if_required(db, command, validation)
    if search_profile is not None:
        insert_ensure_collection_operation(db, search_profile=search_profile)
    revision = insert_config_revision(db, command, validation, search_profile=search_profile)
    insert_capability_bindings(db, revision=revision, bindings=validation.bindings)
    price = publish_complete_active_price_version(db, command, revision=revision, rates=validation.price_rates)
    supersede_previous_revision(db, settings.active_config_revision_id)
    settings.active_config_revision_id = revision.id
    settings.active_price_version_id = price.id
    settings.version_number += 1
    reset_draft_after_publish(draft, revision=revision, actor_id=command.actor_user_id)
    log_safe_configuration_activity(db, command, revision=revision)
    result = published_result(settings, revision=revision, price=price, search_profile=search_profile)
    complete_operation(claim, result_id=revision.id, response=result)
    return result
```

Authentication, Owner membership and family scope are established before this service. Receipt lookup/claim is deliberately before settings/base/draft version checks, so a committed success whose response was lost replays even after pointers have advanced. Only a new claim owner enters the lock/version/write path; same-key/different-fingerprint fails before mutation and sensitive confirmation fields use a server HMAC fingerprint.

For first Embedding configuration, create a `provisioning` search profile, collection name and `ensure_search_profile_collection` resource operation in the same transaction. The durable worker provision Qdrant after commit; no route-level in-memory enqueue is allowed. `active_search_profile_id` remains NULL until successful activation.

- [ ] **Step 7: Record redacted activity logs and test the exact summaries.**

```python
assert activity.summary == "更新了家庭 AI 服务配置"
assert activity.entity_type == "FamilyModelConfiguration"
assert provider_host not in activity.summary
assert model_name not in activity.summary
assert api_key_marker not in activity.summary
```

Price-only, rotation, real test and search replacement actions use separate safe summaries defined in their tasks.

- [ ] **Step 8: Implement validate and publish routes with password re-auth on first publication.**

```python
@router.post("/draft/validate", response_model=FamilyModelDraftValidationOut)
def validate_draft_route(payload: ValidateDraftRequest, auth=Depends(require_owner), db=Depends(get_db)):
    user, membership = auth
    return validate_family_model_draft(db, ValidateDraftCommand.from_request(
        family_id=membership.family_id, actor_user_id=user.id, payload=payload
    ))

@router.post("/publish", response_model=PublishedFamilyModelConfigurationOut)
def publish_route(payload: PublishFamilyModelSettingsRequest, auth=Depends(require_owner), db=Depends(get_db)):
    user, membership = auth
    if current_active_revision_id(db, family_id=membership.family_id) is None:
        verify_owner_password(db, user_id=user.id, password=payload.current_password)
    result = publish_family_model_configuration(db, PublishConfigurationCommand.from_request(
        family_id=membership.family_id, actor_user_id=user.id, payload=payload
    ))
    commit_session(db)
    return result
```

- [ ] **Step 9: Add MySQL concurrent Owner coverage.**

```python
def test_concurrent_owners_only_one_advances_active_pointer(mysql_sessions, publish_commands) -> None:
    results = run_concurrently(
        lambda index: publish_family_model_configuration(mysql_sessions[index], publish_commands[index]),
        count=2,
    )
    assert sum(item.succeeded for item in results) == 1
    assert {item.error_code for item in results if not item.succeeded} == {
        "family_model_settings_version_conflict"
    }
```

Also cover same key/same fingerprint replay after the winning transaction commits and advances versions, same key/different fingerprint conflict and lock rollback after injected failure.

- [ ] **Step 10: Run validation, publication and concurrency tests.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_validation.py tests/family_model_settings/test_publishing.py tests/family_model_settings/test_publish_api.py -q`

Run with MySQL: `cd backend && CULINA_TEST_MYSQL_URL="$CULINA_TEST_MYSQL_URL" .venv/bin/python -m pytest tests/family_model_settings/test_publishing_mysql_concurrency.py -q`

Expected: unit/API tests PASS; MySQL concurrency PASS in the required acceptance environment.

- [ ] **Step 11: Create the review checkpoint.**

```bash
git add backend/app/services/family_model_settings/validation.py backend/app/services/family_model_settings/publishing.py backend/app/services/family_model_settings/drafts.py backend/app/repos/family_model_settings/resource_operations.py backend/app/api/family_model_settings.py backend/app/schemas/family_model_settings.py backend/tests/family_model_settings/test_validation.py backend/tests/family_model_settings/test_publishing.py backend/tests/family_model_settings/test_publish_api.py backend/tests/family_model_settings/test_publishing_mysql_concurrency.py
git commit -m "feat: publish immutable family model configurations"
```

Only run the commit command when the user has explicitly authorized commits.

## Task 6: Family price versions, configured variants and usage reservation linearization

**Files**

- Create: `backend/app/services/family_model_settings/prices.py`
- Modify: `backend/app/services/model_usage/configured_variants.py`
- Modify: `backend/app/services/model_usage/pricing.py`
- Modify: `backend/app/repos/model_usage/catalog.py`
- Modify: `backend/app/services/model_usage/types.py`
- Modify: `backend/app/services/model_usage/reservations.py`
- Modify: `backend/app/services/model_usage/dispatch.py`
- Modify: `backend/app/services/model_usage/receipts.py`
- Modify: `backend/app/services/model_usage/settlement.py`
- Modify: `backend/app/services/model_usage/facade.py`
- Modify: `backend/app/api/family_model_settings.py`
- Modify: `backend/app/schemas/family_model_settings.py`
- Modify: `backend/app/api/model_usage.py`
- Create: `backend/tests/family_model_settings/test_family_prices.py`
- Create: `backend/tests/family_model_settings/test_price_api.py`
- Create: `backend/tests/model_usage/test_family_variant_resolution.py`
- Create: `backend/tests/model_usage/test_family_price_linearization.py`
- Modify: `backend/tests/model_usage/test_pricing_service.py`
- Modify: `backend/tests/model_usage/test_reservations.py`
- Modify: `backend/tests/model_usage/test_dispatch.py`

**Interfaces**

- Consumes: active config/binding models and adapter registry from Tasks 1–5.
- Produces: `configured_usage_variants(db, family_id, config_revision_id)`, family price selection, replay-safe price-only publish, `lock_active_model_price_snapshot()` for later active Embedding request/job creation, and permits fixed to configuration/profile/secret identities.
- Reservation price selection rule: current revision uses the active price pointer at the lock boundary; historical revisions use their newest complete `purpose=active` family version; candidate search jobs use their explicitly verified candidate price version.

- [ ] **Step 1: Extend `UsageContext`, reservation decisions and permits with immutable identities.**

```python
@dataclass(frozen=True, slots=True)
class UsageContext:
    attribution: UsageAttribution
    capability: ModelUsageCapability
    provider: str
    requested_model: str
    billing_model: str
    variant_key: str
    operation_kind: str
    attempt_key: str
    client_attempt_id: str
    config_revision_id: str | None
    provider_profile_id: str
    provider_profile_version_id: str
    search_profile_id: str | None = None
    explicit_price_version_id: str | None = None

@dataclass(frozen=True, slots=True)
class DispatchPermit:
    reservation_id: str | None
    config_revision_id: str | None
    provider_profile_id: str
    provider_profile_version_id: str
    credential_secret_version_id: str | None
    search_profile_id: str | None
```

Keep all existing fields in these dataclasses; add the listed fields and propagate them through receipts and event settlement.

- [ ] **Step 2: Add variant tests proving database bindings replace `Settings`.**

```python
def test_configured_variants_come_from_one_family_revision(db, family_configs) -> None:
    first = configured_usage_variants(db, family_id="family-a", config_revision_id="revision-a")
    second = configured_usage_variants(db, family_id="family-b", config_revision_id="revision-b")
    assert {(item.provider, item.billing_model) for item in first} == {("profile-a", "model-a")}
    assert {(item.provider, item.billing_model) for item in second} == {("profile-b", "model-b")}

def test_configured_variants_does_not_accept_settings() -> None:
    assert list(inspect.signature(configured_usage_variants).parameters) == [
        "db", "family_id", "config_revision_id"
    ]
```

- [ ] **Step 3: Replace the global Settings enumeration with binding + registry resolution.**

```python
def configured_usage_variants(
    db: Session, *, family_id: str, config_revision_id: str
) -> tuple[ConfiguredUsageVariant, ...]:
    bindings = list_enabled_bindings(
        db, family_id=family_id, config_revision_id=config_revision_id
    )
    return tuple(
        validate_configured_variant(
            configured_variant_from_binding(binding, adapter_definition_for_binding(binding))
        )
        for binding in bindings
    )
```

Use provider profile stable ID as ledger `provider`; use requested model as billing model unless a validated composite realtime identity is required. `variant_key` remains the stable binding variant (`primary`, `fallback`, `text`, `reference`, `default`, `search`) rather than encoding mutable options.

- [ ] **Step 4: Add family price selection tests for current, historical, candidate, zero and missing rates.**

```python
def test_price_selection_is_fixed_at_reservation(db, current_context, estimate) -> None:
    first = reserve_usage_in_session(db, current_context, estimate, fingerprint="a", at=NOW)
    publish_price_only_version(db, changed_prices(unit_price="2.0"))
    replay = reserve_usage_in_session(db, current_context, estimate, fingerprint="a", at=NOW)
    second = reserve_usage_in_session(db, replace(current_context, attempt_key="b"), estimate, fingerprint="b", at=NOW)
    assert replay.price_version_id == first.price_version_id
    assert second.price_version_id != first.price_version_id

def test_candidate_price_cannot_price_normal_llm_reservation(db, candidate_context, llm_estimate) -> None:
    with pytest.raises(ModelUsageContractError, match="candidate_price_scope_mismatch"):
        select_price_snapshot(db, candidate_context.for_capability(ModelUsageCapability.LLM), llm_estimate, at=NOW)

def test_price_publish_response_lost_replays_before_version_check(db, publish_price_command) -> None:
    first = publish_family_price_version(db, publish_price_command)
    db.commit()
    replay = publish_family_price_version(db, publish_price_command)
    assert replay == first
    assert count_active_price_versions(db, publish_price_command.family_id) == 2
```

- [ ] **Step 5: Implement family catalog selection and purpose ownership checks.**

```python
def family_price_version_for_context(db: Session, context: UsageContext) -> ModelUsagePriceVersion:
    if context.explicit_price_version_id is not None:
        if context.config_revision_id is None:
            return require_candidate_price_for_search_profile(
                db,
                family_id=context.attribution.family_id,
                price_version_id=context.explicit_price_version_id,
                search_profile_id=require_value(context.search_profile_id),
            )
        return require_complete_active_price_version(
            db,
            family_id=context.attribution.family_id,
            config_revision_id=context.config_revision_id,
            price_version_id=context.explicit_price_version_id,
        )
    return require_latest_complete_active_price(
        db,
        family_id=context.attribution.family_id,
        config_revision_id=require_value(context.config_revision_id),
    )
```

`select_price_snapshot()` no longer calls `current_published_version()` for new calls. Legacy-global lookup remains only for replay/settlement of existing rows that already store such a version.

An explicit price ID is not automatically a candidate: persisted active jobs/requests supply both a non-null config
revision and the exact active price snapshot, while candidate rebuild work has `config_revision_id=None` and must pass
the candidate ownership check. This distinction prevents a queued active Embedding job from silently repricing itself
when it eventually runs.

- [ ] **Step 6: Persist config/profile/search identities at reservation creation.**

```python
reservation = ModelUsageReservation(
    id=reservation_id,
    family_id=family_id,
    config_revision_id=context.config_revision_id,
    provider_profile_id=context.provider_profile_id,
    provider_profile_version_id=context.provider_profile_version_id,
    search_profile_id=context.search_profile_id,
    credential_secret_version_id=None,
    price_version_id=price.price_version_id,
    price_snapshot_checksum=price.checksum,
    provider=context.provider,
    requested_model=context.requested_model,
    billing_model=context.billing_model,
    variant_key=context.variant_key,
)
```

The unique attempt replay identity check now includes config revision, provider profile/version, search profile and explicit candidate price identity.

- [ ] **Step 7: Select and persist the current credential version inside first-dispatch authorization.**

```python
def authorize_reservation_credential(db: Session, reservation: ModelUsageReservation) -> str | None:
    binding = require_reservation_binding_identity(db, reservation)
    if binding.auth_mode == "no_auth":
        return None
    profile = lock_provider_profile(
        db, family_id=reservation.family_id, profile_id=reservation.provider_profile_id
    )
    secret = require_active_profile_secret(db, family_id=reservation.family_id, profile=profile)
    reservation.credential_secret_version_id = secret.id
    return secret.id
```

Call this after policy/counter locks and before transitioning `reserved -> dispatching`. The resulting permit carries the ID. A Key rotation that commits first wins for new dispatch; a dispatch transaction that commits first may finish with its fixed old secret.

- [ ] **Step 8: Add price draft/publish schemas and Owner API tests.**

```python
class PublishFamilyModelPricesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_settings_version_number: int = Field(ge=1)
    base_price_version_id: str
    idempotency_key: str = Field(min_length=8, max_length=160)
    confirm_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    change_note: str = Field(min_length=1, max_length=255)
    rates: list[FamilyModelPriceRateRequest]
```

GET `/prices` returns current complete rates and history summary; PUT `/prices/draft` saves a complete non-secret price draft; POST `/prices/publish` locks settings, validates current active config coverage, creates a full version and advances only `active_price_version_id/settings.version_number`.

Price publish uses the shared operation receipt. Owner/family scope is resolved first; same-key/same-fingerprint completed replay returns before base settings/price checks, and only a new claim owner may enter the settings lock and version validation path.

- [ ] **Step 9: Preserve old config prices and test price-only publication linearization.**

```python
def publish_family_price_version(db: Session, command: PublishPriceVersionCommand) -> PublishedPriceVersionResult:
    claim = claim_operation(db, command.idempotency_identity_with_hmac_fingerprint())
    if claim.completed:
        return PublishedPriceVersionResult.model_validate(claim.response_json)
    settings = lock_family_model_settings(db, family_id=command.family_id)
    require_settings_version(settings, command.base_settings_version_number)
    require_active_config(settings, command.config_revision_id)
    rates = validate_complete_family_rates(db, command)
    version = insert_price_version(
        db,
        family_id=command.family_id,
        config_revision_id=command.config_revision_id,
        purpose="active",
        base_price_version_id=command.base_price_version_id,
        rates=rates,
    )
    settings.active_price_version_id = version.id
    settings.version_number += 1
    log_activity_safe(db, family_id=command.family_id, actor_id=command.actor_user_id, summary="更新了家庭模型价格")
    result = published_price_result(settings, version)
    complete_operation(claim, result_id=version.id, response=result)
    return result
```

The receipt and price pointer commit in the same transaction. A concurrent same-key claim loser reads the completed winner; same key with a different fingerprint returns the stable idempotency conflict.

Add `lock_active_model_price_snapshot(db, family_id)` which locks the stable settings row and returns the exact active config/price IDs together. Active Embedding query reservations and active index jobs in Tasks 10–11 must call this helper at creation and persist both IDs. Candidate rebuilds continue to use their explicit candidate price and do not call this helper.

- [ ] **Step 10: Update policy coverage reads to use the family's active revision and price.**

```python
active_variants = configured_usage_variants(
    db,
    family_id=membership.family_id,
    config_revision_id=require_active_config_revision_id(db, membership.family_id),
)
coverage = family_price_coverage(
    db,
    family_id=membership.family_id,
    config_revision_id=config_revision_id,
    price_version_id=active_price_version_id,
    configured_variants=active_variants,
)
```

An unconfigured family has an empty variant set and cannot enable a hard limit that claims model capabilities are available.

- [ ] **Step 11: Run family price and model-usage tests.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_family_prices.py tests/family_model_settings/test_price_api.py tests/model_usage/test_family_variant_resolution.py tests/model_usage/test_family_price_linearization.py tests/model_usage/test_pricing_service.py tests/model_usage/test_reservations.py tests/model_usage/test_dispatch.py -q && cd .. && git diff --check`

Expected: PASS, including zero prices, manual FX, historical revision, candidate isolation, replay and rotation/dispatch ordering.

- [ ] **Step 12: Create the review checkpoint.**

```bash
git add backend/app/services/family_model_settings/prices.py backend/app/services/model_usage/configured_variants.py backend/app/services/model_usage/pricing.py backend/app/repos/model_usage/catalog.py backend/app/services/model_usage/types.py backend/app/services/model_usage/reservations.py backend/app/services/model_usage/dispatch.py backend/app/services/model_usage/receipts.py backend/app/services/model_usage/settlement.py backend/app/services/model_usage/facade.py backend/app/api/family_model_settings.py backend/app/schemas/family_model_settings.py backend/app/api/model_usage.py backend/tests/family_model_settings/test_family_prices.py backend/tests/family_model_settings/test_price_api.py backend/tests/model_usage/test_family_variant_resolution.py backend/tests/model_usage/test_family_price_linearization.py backend/tests/model_usage/test_pricing_service.py backend/tests/model_usage/test_reservations.py backend/tests/model_usage/test_dispatch.py
git commit -m "feat: price family model usage revisions"
```

Only run the commit command when the user has explicitly authorized commits.

## Task 7: Family resolver, LLM runtime factories and AI run revision snapshots

**Files**

- Create: `backend/app/services/family_model_settings/resolver.py`
- Modify: `backend/app/ai/runtime/factory.py`
- Modify: `backend/app/ai/runtime/provider.py`
- Modify: `backend/app/ai/runtime/openai_chat.py`
- Modify: `backend/app/ai/runtime/openai_responses.py`
- Modify: `backend/app/ai/workspace_service.py`
- Modify: `backend/app/ai/workflows/runner.py`
- Modify: `backend/app/ai/workflows/runner_support/user_message_preparer.py`
- Modify: `backend/app/ai/workflows/runner_support/runner_runtime_context.py`
- Modify: `backend/app/ai/workflows/runner_support/stream_bridge.py`
- Modify: `backend/app/ai/observability/llm_exchange.py`
- Modify: `backend/app/services/serializers.py`
- Create: `backend/tests/family_model_settings/test_resolver.py`
- Create: `backend/tests/ai_infra/test_family_llm_runtime.py`
- Modify: `backend/tests/model_usage/test_llm_provider_contract.py`
- Modify: `backend/tests/model_usage/test_llm_fallback.py`

**Interfaces**

- Consumes: immutable config/profile bindings and dispatch credential identity from Tasks 1–6.
- Produces: `FamilyModelConfigurationResolver`, `FamilyChatProviderFactory.for_active_family()` and `.for_run_revision()`, with no Provider `Settings` reads.
- Run rule: a new run persists config revision before graph execution; retry/regenerate/stream worker resolves that stored revision, while a later Key rotation is observed at first dispatch through the current profile secret pointer.

- [ ] **Step 1: Add resolver tests for active, historical, disabled, missing and cross-family states.**

```python
def test_resolve_active_returns_immutable_binding_without_secret(db, configured_family) -> None:
    resolved = FamilyModelConfigurationResolver(db).resolve_active(
        configured_family.id, "llm", "primary"
    )
    assert resolved.config_revision_id == configured_family.active_revision_id
    assert resolved.requested_model == "family-primary-model"
    assert not hasattr(resolved, "api_key")

@pytest.mark.parametrize("state,code", [
    ("unconfigured", "family_model_settings_not_configured"),
    ("disabled", "family_model_capability_disabled"),
    ("secret_destroyed", "family_model_secret_unavailable"),
])
def test_resolver_fails_closed(db, family_state, state, code) -> None:
    with pytest.raises(FamilyModelSettingsError) as error:
        family_state(state).resolve_llm()
    assert error.value.code == code
```

- [ ] **Step 2: Implement active-pointer reads without indefinite caching and immutable revision metadata caching.**

```python
class FamilyModelConfigurationResolver:
    def resolve_active(self, family_id: str, capability: str, variant_key: str) -> ResolvedCapabilityBinding:
        settings = require_family_model_settings(self.db, family_id=family_id)
        revision_id = require_value(settings.active_config_revision_id, "family_model_settings_not_configured")
        return self.resolve_revision(family_id, revision_id, capability, variant_key)

    @lru_cache(maxsize=512)
    def _immutable_binding(self, family_id: str, revision_id: str, capability: str, variant_key: str) -> ResolvedCapabilityBinding:
        binding = require_enabled_family_binding(
            self.db,
            family_id=family_id,
            config_revision_id=revision_id,
            capability=capability,
            variant_key=variant_key,
        )
        return resolve_binding_metadata(binding, network_policy=self.network_policy)
```

Do not cache the active pointer, current secret pointer or decrypted secret. If a process-level cache needs an explicit object, scope it to immutable `(family_id, revision_id, capability, variant_key)` rows and make tests clear it between databases.

- [ ] **Step 3: Add dispatch credential tests for current rotation and already-authorized old secret.**

```python
def test_decrypt_uses_secret_fixed_by_dispatch_permit(db, binding, permit, rotate_key) -> None:
    old_id = permit.credential_secret_version_id
    rotate_key(binding.provider_profile_id)
    credential = FamilyModelConfigurationResolver(db).resolve_dispatch_credential(binding, old_id)
    assert credential.secret_version_id == old_id
    assert credential.api_key == "old-key"

def test_new_dispatch_after_rotation_uses_new_secret(db, reserve_attempt, rotate_key) -> None:
    rotate_key(reserve_attempt.provider_profile_id)
    permit = reserve_attempt.prepare_dispatch()
    assert permit.credential_secret_version_id == rotate_key.new_secret_id
```

- [ ] **Step 4: Change chat provider factories to consume resolved bindings and deferred credential loaders.**

```python
class FamilyChatProviderFactory:
    def for_active_family(self, db: Session, *, family_id: str) -> FamilyChatProviderSelection:
        primary = self.resolver(db).resolve_active(family_id, "llm", "primary")
        fallback = self.resolver(db).optional_revision_variant(
            family_id, primary.config_revision_id, "llm", "fallback"
        )
        return self._build(primary=primary, fallback=fallback)

    def for_run_revision(self, db: Session, *, family_id: str, config_revision_id: str) -> FamilyChatProviderSelection:
        primary = self.resolver(db).resolve_revision(
            family_id, config_revision_id, "llm", "primary"
        )
        fallback = self.resolver(db).optional_revision_variant(
            family_id, config_revision_id, "llm", "fallback"
        )
        return self._build(primary=primary, fallback=fallback)
```

`build_chat_provider(settings)` and zero-argument `get_chat_provider()` are removed. Provider constructors receive binding metadata, `ProviderTransport`, `ModelUsageFacade`, receipt signer and `resolve_dispatch_credential` callback.

- [ ] **Step 5: Modify LLM adapters so decrypt occurs after `prepare_dispatch()`.**

```python
attempt = usage_adapter.begin_round(
    attribution=attribution,
    binding=resolved_binding,
    attempt_key=attempt_key,
    estimate=estimate,
    fingerprint=fingerprint,
)
permit = attempt.prepare_dispatch()
with credential_lease(resolved_binding, permit.credential_secret_version_id) as credential:
    response = provider_transport.request(
        "POST",
        chat_endpoint(resolved_binding),
        headers=authorization_headers(resolved_binding.auth_mode, credential.api_key),
        json=request_payload,
    )
```

The credential context clears its local reference in `finally`; the transport's safe log record contains only adapter kind, status class, latency and config revision.

- [ ] **Step 6: Add AI run tests for new-run snapshot, retry isolation and two-family concurrency.**

```python
def test_run_keeps_revision_after_family_publishes_new_model(ai_service, publish_new_model) -> None:
    run = ai_service.prepare_user_message(family_id="family-a", user_id="owner-a", message="晚餐吃什么")
    old_revision = run.config_revision_id
    publish_new_model(family_id="family-a", model="new-model")
    ai_service.execute_prepared_run(run.id)
    assert provider_call_for(run.id).model == "old-model"
    assert run.config_revision_id == old_revision

def test_parallel_families_never_share_provider_identity(run_parallel_family_chats) -> None:
    calls = run_parallel_family_chats()
    assert calls["family-a"].authorization == "Bearer key-a"
    assert calls["family-b"].authorization == "Bearer key-b"
```

- [ ] **Step 7: Persist revision before execution and reconstruct providers in worker paths.**

```python
selection = self.provider_factory.for_active_family(self.db, family_id=family_id)
run = AIAgentRun(
    id=client_run_id or create_id("agent_run"),
    family_id=family_id,
    config_revision_id=selection.config_revision_id,
    model=selection.primary.requested_model,
    status="running",
    created_by=user_id,
)
```

`AIApplicationService` no longer captures one global provider in `__init__`. `WorkspaceGraphRunner` and background stream reconstruction resolve from `run.config_revision_id`; injected test providers remain available only through an explicit test factory.

- [ ] **Step 8: Add trace/exchange metadata without exposing profile endpoints or secrets.**

```python
exchange = AIRunLLMExchange(
    family_id=run.family_id,
    run_id=run.id,
    config_revision_id=run.config_revision_id,
    provider_profile_id=resolved.provider_profile_id,
    provider_profile_version_id=resolved.provider_profile_version_id,
    model=resolved.requested_model,
)
```

Task 1 unconditionally adds these three nullable exchange columns to the ORM and migration. Use the exact field names above; do not pass a nonexistent generic `provider` field and do not add a conditional follow-up migration in this task. Add a persistence test that inserts a new exchange with all three identities and reads a historical row whose columns are NULL. Never store Base URL, profile display name or credential version in trace payload JSON, and never expose profile IDs through Member serializers.

- [ ] **Step 9: Implement the explicit Owner real LLM capability test through the normal ledger.**

```python
def run_llm_capability_test(context: CapabilityTestContext) -> CapabilityTestResult:
    provider = context.factory.for_revision_variant(
        context.family_id, context.config_revision_id, "llm", context.variant_key
    )
    result = provider.complete(
        system="只回复：连接正常",
        user="这是家庭 AI 服务的手动测试，不包含家庭资料。",
        attribution=context.owner_attribution(),
        operation_kind="family_model_capability_test",
    )
    return CapabilityTestResult(status="succeeded", safe_summary=result.text[:32])
```

The API requires `confirm_billable=true`, current active revision and an idempotency key. It can consume budget and must expose any hard-limit failure as the normal safe model-usage error.

- [ ] **Step 10: Run resolver, LLM runtime and fallback tests.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_resolver.py tests/ai_infra/test_family_llm_runtime.py tests/model_usage/test_llm_provider_contract.py tests/model_usage/test_llm_fallback.py -q && cd .. && git diff --check`

Expected: PASS; no code path reads `ai_provider`, `ai_api_key`, `ai_model` or `ai_fallback_model`.

- [ ] **Step 11: Create the review checkpoint.**

```bash
git add backend/app/services/family_model_settings/resolver.py backend/app/ai/runtime/factory.py backend/app/ai/runtime/provider.py backend/app/ai/runtime/openai_chat.py backend/app/ai/runtime/openai_responses.py backend/app/ai/workspace_service.py backend/app/ai/workflows/runner.py backend/app/ai/workflows/runner_support/user_message_preparer.py backend/app/ai/workflows/runner_support/runner_runtime_context.py backend/app/ai/workflows/runner_support/stream_bridge.py backend/app/ai/observability/llm_exchange.py backend/app/services/serializers.py backend/tests/family_model_settings/test_resolver.py backend/tests/ai_infra/test_family_llm_runtime.py backend/tests/model_usage/test_llm_provider_contract.py backend/tests/model_usage/test_llm_fallback.py
git commit -m "feat: resolve family llm runtime revisions"
```

Only run the commit command when the user has explicitly authorized commits.

## Task 8: Family image-generation bindings, durable job snapshots and safe media transport

**Files**

- Modify: `backend/app/ai/images/generation.py`
- Modify: `backend/app/ai/images/jobs.py`
- Modify: `backend/app/services/model_usage/adapters/image_generation.py`
- Modify: `backend/app/services/ai_operations/image_jobs.py`
- Modify: `backend/app/api/media.py`
- Modify: `backend/app/api/family_model_settings.py`
- Create: `backend/tests/family_model_settings/test_family_image_runtime.py`
- Modify: `backend/tests/model_usage/test_image_generation_adapter.py`
- Modify: `backend/tests/model_usage/test_image_job_usage.py`
- Modify: `backend/tests/ai_infra/test_recipe_drafts_and_images.py`

**Interfaces**

- Consumes: resolver/dispatch credential/transport from Tasks 3, 6 and 7.
- Produces: `ImageGenerationClient.for_binding()`, image jobs fixed to `config_revision_id`, and real `text/reference` capability tests.
- The image job stores request content as today but never stores endpoint, API Key or decrypted secret; provider-returned media URLs pass `download_media()`.

- [ ] **Step 1: Add job snapshot tests for both image variants and config changes.**

```python
@pytest.mark.parametrize("mode,variant", [
    (ImageGenerationMode.TEXT, "text"),
    (ImageGenerationMode.REFERENCE, "reference"),
])
def test_image_job_snapshots_family_revision(db, enqueue_image, mode, variant) -> None:
    job = enqueue_image(mode=mode)
    assert job.config_revision_id == active_config_revision_id(db, job.family_id)
    binding = resolve_job_image_binding(db, job)
    assert binding.variant_key == variant

def test_queued_image_uses_old_model_but_rotated_key(db, queued_job, publish_new_model, rotate_key) -> None:
    publish_new_model("new-image-model")
    rotate_key("new-key")
    process_image_job(queued_job.id)
    call = fake_image_provider.last_call
    assert call.model == "old-image-model"
    assert call.authorization == "Bearer new-key"
```

- [ ] **Step 2: Replace `_build_provider_config(mode)` with resolver-backed job selection.**

```python
def image_binding_for_job(db: Session, job: AIImageGenerationJob) -> ResolvedCapabilityBinding:
    return FamilyModelConfigurationResolver(db).resolve_revision(
        job.family_id,
        require_value(job.config_revision_id),
        "image_generation",
        ImageGenerationMode(job.request_payload["mode"]).value,
    )

class ImageGenerationClient:
    @classmethod
    def for_binding(cls, binding: ResolvedCapabilityBinding, dependencies: ImageProviderDependencies) -> "ImageGenerationClient":
        provider = image_provider_from_adapter(binding, dependencies=dependencies)
        return cls(text_provider=provider if binding.variant_key == "text" else None,
                   reference_provider=provider if binding.variant_key == "reference" else None)
```

Remove `get_settings()` and all `AI_IMAGE_*` reads from `generation.py` and `jobs.py`.

- [ ] **Step 3: Persist revision during enqueue and fail closed before accepting unavailable modes.**

```python
binding = resolver.resolve_active(
    family_id,
    "image_generation",
    request.mode.value,
)
job = AIImageGenerationJob(
    id=create_id("image-job"),
    family_id=family_id,
    user_id=user_id,
    config_revision_id=binding.config_revision_id,
    status="queued",
    request_payload=_request_to_payload(request),
)
```

Disabled or unconfigured image capability returns `family_model_capability_disabled` or `family_model_settings_not_configured` without queueing a job.

- [ ] **Step 4: Move provider sends and media downloads to `ProviderTransport`.**

```python
permit = usage_attempt.prepare_dispatch()
with credential_lease(binding, permit.credential_secret_version_id) as credential:
    response = transport.request(
        "POST",
        image_generation_endpoint(binding, request.mode),
        headers=image_auth_headers(binding, credential.api_key),
        json=image_request_payload(binding, request),
    )
image = parse_image_response(response)
if image.remote_url is not None:
    media = transport.download_media(
        image.remote_url,
        source=binding.endpoint,
        adapter_kind=binding.adapter_kind,
    )
```

Request inline/base64 output where supported. No `follow_redirects=True` remains in image code.

- [ ] **Step 5: Preserve uncertain/retry rules and attach revision metadata to usage.**

```python
attempt = adapter.begin_image(
    attribution=attribution,
    binding=binding,
    attempt_key=job.usage_attempt_key,
    request=request,
)
```

Provider success followed by media persistence/bind failure never sends a second image request. Retry is permitted only for confirmed-not-executed attempts or bind-only recovery, exactly as current behavior.

- [ ] **Step 6: Add and implement explicit real image capability tests.**

```python
@pytest.mark.parametrize("variant", ["text", "reference"])
def test_real_image_capability_test_is_metered(owner_client, variant, fake_provider) -> None:
    response = owner_client.post(
        f"/api/family/model-settings/capabilities/image_generation/test",
        json={
            "variant_key": variant,
            "confirm_billable": True,
            "idempotency_key": f"image-test-{variant}",
        },
    )
    assert response.status_code == 200
    assert usage_event_for_operation(f"image-test-{variant}").capability.value == "image_generation"
```

Use a fixed Culina test prompt and a bundled non-personal reference fixture. Generated media is kept only as a short-lived test result and is not attached to family business entities.

- [ ] **Step 7: Run image runtime, adapter and job recovery tests.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_family_image_runtime.py tests/model_usage/test_image_generation_adapter.py tests/model_usage/test_image_job_usage.py tests/ai_infra/test_recipe_drafts_and_images.py -q && cd .. && git diff --check`

Expected: PASS; provider media DNS/redirect tests use the shared transport and no `AI_IMAGE_*` read remains.

- [ ] **Step 8: Create the review checkpoint.**

```bash
git add backend/app/ai/images/generation.py backend/app/ai/images/jobs.py backend/app/services/model_usage/adapters/image_generation.py backend/app/services/ai_operations/image_jobs.py backend/app/api/media.py backend/app/api/family_model_settings.py backend/tests/family_model_settings/test_family_image_runtime.py backend/tests/model_usage/test_image_generation_adapter.py backend/tests/model_usage/test_image_job_usage.py backend/tests/ai_infra/test_recipe_drafts_and_images.py
git commit -m "feat: resolve family image generation settings"
```

Only run the commit command when the user has explicitly authorized commits.

## Task 9: Family STT, TTS and realtime-audio bindings with session snapshots

**Files**

- Modify: `backend/app/services/ai_audio/config.py`
- Modify: `backend/app/services/ai_audio/providers.py`
- Modify: `backend/app/services/ai_audio/openai_audio.py`
- Modify: `backend/app/services/ai_audio/dashscope_audio.py`
- Modify: `backend/app/services/ai_audio/service.py`
- Modify: `backend/app/services/ai_audio/realtime.py`
- Modify: `backend/app/services/ai_audio/cooking_voice_stream.py`
- Modify: `backend/app/schemas/ai_audio.py`
- Modify: `backend/app/api/ai_audio.py`
- Modify: `backend/app/services/model_usage/adapters/audio.py`
- Modify: `backend/app/services/model_usage/adapters/realtime_audio.py`
- Modify: `backend/app/api/family_model_settings.py`
- Create: `backend/tests/family_model_settings/test_family_audio_runtime.py`
- Modify: `backend/tests/ai_audio/test_ai_audio_service.py`
- Modify: `backend/tests/ai_audio/test_ai_audio_api.py`
- Modify: `backend/tests/model_usage/test_audio_adapter.py`
- Modify: `backend/tests/model_usage/test_realtime_audio_adapter.py`
- Modify: `backend/tests/model_usage/test_realtime_audio_mysql.py`

**Interfaces**

- Consumes: resolver, network transport, dispatch credential and usage identity from Tasks 3, 6 and 7.
- Produces: `AIAudioService(db, family_id, user_id)`, resolver-backed provider classes and realtime session state fixed to one config revision/binding.
- Client requests no longer select an arbitrary Provider. Voice/format/language inputs are validated user overrides only where the binding schema allows them.

- [ ] **Step 1: Add schema tests that remove client Provider selection and forbid raw Provider options.**

```python
def test_audio_requests_do_not_accept_provider_override() -> None:
    with pytest.raises(ValidationError):
        SpeechRequest.model_validate({
            "surface": "main_ai",
            "text": "测试",
            "provider": "other-provider",
        })

def test_realtime_request_forbids_model_and_endpoint() -> None:
    with pytest.raises(ValidationError):
        CookingRealtimeSessionRequest.model_validate({
            "recipe_id": "recipe-1",
            "cook_session_id": "cook-1",
            "session_revision": 1,
            "subject": {},
            "model": "override",
            "api_base": "http://127.0.0.1",
        })
```

- [ ] **Step 2: Add service tests for family-specific STT/TTS and current-secret dispatch.**

```python
def test_audio_service_resolves_capability_per_family(audio_services, fake_transport) -> None:
    audio_services["family-a"].synthesize(speech_request("家庭 A"))
    audio_services["family-b"].synthesize(speech_request("家庭 B"))
    assert fake_transport.calls[0].model == "tts-a"
    assert fake_transport.calls[0].authorization == "Bearer key-a"
    assert fake_transport.calls[1].model == "tts-b"
    assert fake_transport.calls[1].authorization == "Bearer key-b"
```

- [ ] **Step 3: Replace Settings-shaped provider constructors with resolved audio configs.**

```python
@dataclass(frozen=True, slots=True)
class ResolvedAudioProviderConfig:
    binding: ResolvedCapabilityBinding
    language_hint: str | None
    hotwords: tuple[str, ...]
    voice: str | None
    output_format: str | None

class AIAudioService:
    def __init__(self, db: Session, *, family_id: str, user_id: str, dependencies: AudioDependencies) -> None:
        self.db = db
        self.family_id = family_id
        self.user_id = user_id
        self.dependencies = dependencies

    def _binding(self, capability: Literal["stt", "tts", "realtime_audio"]) -> ResolvedCapabilityBinding:
        return self.dependencies.resolver(self.db).resolve_active(
            self.family_id, capability, "default"
        )
```

`dashscope_http_base()`, `dashscope_ws_base()` and key fallbacks stop accepting global `Settings`; URL construction consumes normalized resolved endpoints and validated adapter options.

- [ ] **Step 4: Decrypt after audio usage dispatch and route sends through shared transport.**

```python
attempt = adapter.begin_tts(request, binding=binding, sanitized_text=text, fingerprint=fingerprint)
permit = attempt.prepare_dispatch()
with credential_lease(binding, permit.credential_secret_version_id) as credential:
    response = transport.request(
        "POST",
        tts_endpoint(binding),
        headers=audio_auth_headers(binding, credential.api_key),
        json=tts_payload(binding, request, text),
    )
```

Apply the same order to STT and each realtime lease. Duration/character measurement and existing uncertain semantics remain unchanged.

- [ ] **Step 5: Extend realtime state with immutable revision and binding identity.**

```python
@dataclass(slots=True)
class RealtimeVoiceSessionState:
    session_id: str
    family_id: str
    user_id: str
    config_revision_id: str
    provider_profile_id: str
    provider_profile_version_id: str
    requested_model: str
    binding_identity_checksum: str
    current_provider_attempt_key: str | None
    expires_at: datetime
```

Keep all current recipe/cook/session fields. Creating a session resolves once and stores revision/binding metadata. Each lease authorizes the profile's current secret at dispatch. An already-established WebSocket can complete after publication/rotation; a new session uses current config.

- [ ] **Step 6: Make cooking-agent turns resolve the session's LLM revision.**

```python
service = AIApplicationService(
    db,
    provider_selection=family_chat_factory.for_run_revision(
        db,
        family_id=session.family_id,
        config_revision_id=session.config_revision_id,
    ),
)
```

Do not resolve the latest LLM revision inside an existing realtime session. Approval commits remain model-free and do not need a credential.

- [ ] **Step 7: Add real capability tests for STT, TTS and realtime audio through normal usage.**

```python
@pytest.mark.parametrize("capability", ["stt", "tts", "realtime_audio"])
def test_owner_audio_capability_test_is_metered(owner_client, capability, fake_audio_provider) -> None:
    response = owner_client.post(
        f"/api/family/model-settings/capabilities/{capability}/test",
        json={"confirm_billable": True, "idempotency_key": f"test-{capability}-1"},
    )
    assert response.status_code == 200
    event = usage_event_for_idempotency_key(f"test-{capability}-1")
    assert event.capability.value == capability
```

STT uses a bundled short PCM silence/tone fixture, TTS uses “连接测试”, and realtime opens one minimal lease/handshake then closes. Tests do not include family content or bind produced media.

- [ ] **Step 8: Preserve graceful degradation and safe status codes.**

```python
AUDIO_CAPABILITY_MESSAGES = {
    "family_model_settings_not_configured": "该语音能力尚未由家庭主理人配置。",
    "family_model_capability_disabled": "该语音能力当前未启用，可以继续使用文字。",
    "family_model_secret_unavailable": "家庭语音服务凭据暂不可用，请联系家庭主理人检查设置。",
}
```

Do not expose provider/model/Base URL in Member-facing errors. STT failure leaves text input available; TTS/realtime failure leaves textual AI responses available.

- [ ] **Step 9: Run audio API, service, adapter and realtime MySQL tests.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_family_audio_runtime.py tests/ai_audio/test_ai_audio_service.py tests/ai_audio/test_ai_audio_api.py tests/model_usage/test_audio_adapter.py tests/model_usage/test_realtime_audio_adapter.py -q`

Run with MySQL: `cd backend && CULINA_TEST_MYSQL_URL="$CULINA_TEST_MYSQL_URL" .venv/bin/python -m pytest tests/model_usage/test_realtime_audio_mysql.py -q`

Expected: PASS in acceptance environment; local absence of MySQL is reported as SKIP, not evidence.

- [ ] **Step 10: Create the review checkpoint.**

```bash
git add backend/app/services/ai_audio/config.py backend/app/services/ai_audio/providers.py backend/app/services/ai_audio/openai_audio.py backend/app/services/ai_audio/dashscope_audio.py backend/app/services/ai_audio/service.py backend/app/services/ai_audio/realtime.py backend/app/services/ai_audio/cooking_voice_stream.py backend/app/schemas/ai_audio.py backend/app/api/ai_audio.py backend/app/services/model_usage/adapters/audio.py backend/app/services/model_usage/adapters/realtime_audio.py backend/app/api/family_model_settings.py backend/tests/family_model_settings/test_family_audio_runtime.py backend/tests/ai_audio/test_ai_audio_service.py backend/tests/ai_audio/test_ai_audio_api.py backend/tests/model_usage/test_audio_adapter.py backend/tests/model_usage/test_realtime_audio_adapter.py backend/tests/model_usage/test_realtime_audio_mysql.py
git commit -m "feat: resolve family audio model settings"
```

Only run the commit command when the user has explicitly authorized commits.

## Task 10: Per-family search-profile document state and Qdrant collection selection

**Files**

- Create: `backend/app/repos/family_model_settings/search_profiles.py`
- Modify: `backend/app/services/search/vector_store.py`
- Modify: `backend/app/services/search/vector_indexing.py`
- Modify: `backend/app/services/search/indexing.py`
- Modify: `backend/app/services/search/jobs.py`
- Modify: `backend/app/services/search/documents.py`
- Modify: `backend/app/services/search/vector_cleanup.py`
- Modify: `backend/app/services/search/embeddings.py`
- Modify: `backend/app/services/model_usage/adapters/embedding.py`
- Create: `backend/tests/family_model_settings/test_search_profile_repository.py`
- Create: `backend/tests/search/test_profile_vector_store.py`
- Create: `backend/tests/search/test_profile_index_jobs.py`
- Modify: `backend/tests/search/test_vector_indexing.py`
- Modify: `backend/tests/search/test_search_jobs.py`
- Modify: `backend/tests/model_usage/test_embedding_adapter.py`
- Modify: `backend/tests/model_usage/test_embedding_mysql_handoff.py`

**Interfaces**

- Consumes: `FamilySearchProfile`, `FamilySearchProfileDocument`, snapshot fields and resolver from Tasks 1, 6 and 7.
- Produces: profile-explicit vector store/client/job interfaces that can maintain active and candidate indexes concurrently, while active jobs snapshot the switch-time settings config/price rather than profile-creation prices.
- `SearchDocument` remains the canonical MySQL text source. Vector lifecycle state moves to `FamilySearchProfileDocument`;
  its legacy single-profile vector columns remain only for schema downgrade compatibility and are neither read nor
  written after cutover. Dropping those columns is explicitly outside this feature's migration scope.

- [ ] **Step 1: Add repository tests for profile/document family isolation and progress counters.**

```python
def test_search_profile_document_identity_is_family_scoped(db, profile_a, profile_b, document_a) -> None:
    row = ensure_profile_document(
        db,
        family_id=profile_a.family_id,
        search_profile_id=profile_a.id,
        search_document_id=document_a.id,
        content_hash=document_a.content_hash,
    )
    assert get_profile_document(
        db,
        family_id=profile_b.family_id,
        search_profile_id=profile_a.id,
        search_document_id=document_a.id,
    ) is None
    assert row.status == "pending"
```

- [ ] **Step 2: Add vector-store tests for separate collections with different dimensions.**

```python
def test_qdrant_store_uses_explicit_profile_collection(fake_qdrant, settings) -> None:
    small = build_vector_store(settings, qdrant_collection="culina_fsp_small")
    large = build_vector_store(settings, qdrant_collection="culina_fsp_large")
    small.ensure_collection(vector_size=384)
    large.ensure_collection(vector_size=1536)
    assert fake_qdrant.collection_sizes == {
        "culina_fsp_small": 384,
        "culina_fsp_large": 1536,
    }

def test_vector_store_builder_requires_collection_argument() -> None:
    assert "qdrant_collection" in inspect.signature(build_vector_store).parameters
```

- [ ] **Step 3: Refactor vector store creation to retain only platform Qdrant infrastructure in Settings.**

```python
def build_vector_store(settings: Settings, *, qdrant_collection: str) -> VectorStore:
    if settings.search_vector_backend.strip().lower() != "qdrant":
        return DisabledVectorStore()
    if not qdrant_collection:
        raise VectorStoreUnavailableError("search profile collection required")
    return QdrantVectorStore(
        url=settings.qdrant_url,
        api_key=settings.qdrant_api_key,
        collection=qdrant_collection,
        timeout_seconds=settings.qdrant_timeout_seconds,
    )
```

Every `ensure_collection`, upsert, delete, scroll and search call operates on the store's explicit profile collection. Point payload includes `family_id`, `search_profile_id`, `entity_type`, `entity_id`, `content_hash` and builder version.

- [ ] **Step 4: Add profile-specific point payload and handoff tests.**

```python
def test_pending_handoff_targets_exact_profile(profile_document, search_profile, vector_store) -> None:
    handoff = prepare_profile_vector_handoff(profile_document, search_profile=search_profile)
    write_profile_vector_handoff(handoff, vector_store=vector_store)
    assert vector_store.last_payload["family_id"] == search_profile.family_id
    assert vector_store.last_payload["search_profile_id"] == search_profile.id
    assert vector_store.collection == search_profile.qdrant_collection
```

- [ ] **Step 5: Replace SearchDocument pending-vector state with per-profile state.**

```python
@dataclass(frozen=True, slots=True)
class SearchProfileDocumentSnapshot:
    profile_document_id: str
    family_id: str
    search_profile_id: str
    search_document_id: str
    entity_type: str
    entity_id: str
    semantic_text: str
    content_hash: str
    document_builder_version: str
    embedding_model: str
    embedding_dimensions: int

def persist_profile_pending_vector(
    row: FamilySearchProfileDocument,
    *,
    vector: list[float],
    snapshot: SearchProfileDocumentSnapshot,
    now: datetime,
) -> None:
    require_profile_snapshot_current(row, snapshot)
    row.pending_vector = vector
    row.pending_vector_content_hash = snapshot.content_hash
    row.status = "pending_handoff"
    row.updated_at = now
```

Do not mutate `SearchDocument.embedding_model`, `pending_vector` or `vector_status` in the new path.

- [ ] **Step 6: Add job tests for explicit profile/config/price snapshots and current-secret dispatch.**

```python
def test_search_job_carries_candidate_price_identity(db, candidate_profile, profile_document) -> None:
    job = enqueue_search_profile_document_job(
        db,
        profile=candidate_profile,
        profile_document=profile_document,
        config_revision_id=None,
        price_version_id=candidate_profile.candidate_price_version_id,
    )
    assert job.search_profile_id == candidate_profile.id
    assert job.price_version_id == candidate_profile.candidate_price_version_id

def test_same_document_can_have_active_and_candidate_jobs(db, active_profile, candidate_profile, document) -> None:
    jobs = enqueue_jobs_for_profiles(db, document=document, profiles=(active_profile, candidate_profile))
    assert {(item.search_profile_id, item.entity_id) for item in jobs} == {
        (active_profile.id, document.entity_id),
        (candidate_profile.id, document.entity_id),
    }

def test_active_job_created_after_reprice_uses_new_settings_price(db, active_profile, document) -> None:
    before = enqueue_document_for_family_profiles(db, document, user_id="owner")[0]
    publish_price_only_version(db, unit_price="2.0")
    after = enqueue_document_for_family_profiles(db, changed(document), user_id="owner")[0]
    assert after.config_revision_id == current_settings(db).active_config_revision_id
    assert after.price_version_id == current_settings(db).active_price_version_id
    assert after.price_version_id != before.price_version_id
```

Also race active job creation with price publication under the common settings lock: whichever commits first defines the job snapshot. Existing jobs keep their stored config/price; candidates keep the explicit candidate price.

- [ ] **Step 7: Build Embedding clients from resolved search profiles, not Settings.**

```python
def build_embedding_client(
    profile: ResolvedSearchProfile,
    *,
    transport: ProviderTransport,
    usage_dependencies: EmbeddingUsageDependencies,
) -> EmbeddingClient:
    definition = adapter_definition(profile.adapter_kind)
    definition.require_capability("embedding")
    return OpenAICompatibleEmbeddingClient(
        binding=profile,
        transport=transport,
        usage_adapter=EmbeddingUsageAdapter.for_search_profile(profile, usage_dependencies),
        model_usage_required=True,
    )
```

`ResolvedSearchProfile` remains the immutable endpoint/model/index identity and deliberately does not own mutable active config/price fields. Each invocation also receives an `EmbeddingUsageSnapshot(config_revision_id, price_version_id)` from the persisted job or query request. Candidate work uses its explicit candidate price; active work uses the settings snapshot captured when its job/request was created. Decrypt follows dispatch permit authorization.

- [ ] **Step 8: Refactor search jobs to operate on one profile document and preserve current recovery rules.**

```python
def process_search_index_job(job_id: str, *, session_factory=SessionLocal) -> None:
    job = start_and_load_profile_job(job_id, session_factory=session_factory)
    profile = resolve_job_search_profile(job, session_factory=session_factory)
    snapshot = snapshot_profile_document(job, session_factory=session_factory)
    client = build_embedding_client(profile, transport=provider_transport(), usage_dependencies=usage_dependencies())
    result = client.embed_text(
        snapshot.semantic_text,
        attribution=system_embedding_attribution(
            family_id=job.family_id,
            logical_operation_id=job.id,
        ),
        attempt_key=require_value(job.usage_attempt_key),
        usage_snapshot=EmbeddingUsageSnapshot(
            config_revision_id=job.config_revision_id,
            price_version_id=job.price_version_id,
            candidate=job.config_revision_id is None,
        ),
    )
    persist_and_handoff_profile_vector(job, snapshot=snapshot, result=result, profile=profile)
```

An already-accounted attempt with missing vector output remains terminal and is not resent. Budget-blocked jobs retain profile and price identities for safe retry.

- [ ] **Step 9: Enqueue updates for all serviceable profiles after SearchDocument changes.**

```python
def enqueue_document_for_family_profiles(db: Session, document: SearchDocument, *, user_id: str) -> tuple[SearchIndexJob, ...]:
    active_snapshot = lock_active_model_price_snapshot(db, family_id=document.family_id)
    profiles = list_profiles_accepting_document_updates(db, family_id=document.family_id)
    return tuple(
        enqueue_search_profile_document_job(
            db,
            profile=profile,
            profile_document=upsert_profile_document_snapshot(db, profile=profile, document=document),
            config_revision_id=(
                active_snapshot.config_revision_id if profile.id == active_snapshot.search_profile_id else None
            ),
            price_version_id=(
                active_snapshot.price_version_id
                if profile.id == active_snapshot.search_profile_id
                else require_candidate_price_version_id(profile)
            ),
            user_id=user_id,
        )
        for profile in profiles
    )
```

`list_profiles_accepting_document_updates()` returns the active profile and any non-cancelled provisioning replacement. It never includes failed/superseded/retired profiles unless an explicit retry transitions them back to provisioning.

The settings lock is acquired before profile/document locks. Active paths never read mutable config/price identity from
the search profile; doing so would go stale after an ordinary price-only publish.

- [ ] **Step 10: Run search profile repository, vector-store, job and embedding tests.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_search_profile_repository.py tests/search/test_profile_vector_store.py tests/search/test_profile_index_jobs.py tests/search/test_vector_indexing.py tests/search/test_search_jobs.py tests/model_usage/test_embedding_adapter.py -q`

Run with MySQL: `cd backend && CULINA_TEST_MYSQL_URL="$CULINA_TEST_MYSQL_URL" .venv/bin/python -m pytest tests/model_usage/test_embedding_mysql_handoff.py -q`

Expected: PASS; acceptance environment proves the MySQL handoff path.

- [ ] **Step 11: Create the review checkpoint.**

```bash
git add backend/app/repos/family_model_settings/search_profiles.py backend/app/services/search/vector_store.py backend/app/services/search/vector_indexing.py backend/app/services/search/indexing.py backend/app/services/search/jobs.py backend/app/services/search/documents.py backend/app/services/search/vector_cleanup.py backend/app/services/search/embeddings.py backend/app/services/model_usage/adapters/embedding.py backend/tests/family_model_settings/test_search_profile_repository.py backend/tests/search/test_profile_vector_store.py backend/tests/search/test_profile_index_jobs.py backend/tests/search/test_vector_indexing.py backend/tests/search/test_search_jobs.py backend/tests/model_usage/test_embedding_adapter.py backend/tests/model_usage/test_embedding_mysql_handoff.py
git commit -m "feat: isolate family search profile collections"
```

Only run the commit command when the user has explicitly authorized commits.

## Task 11: Search provisioning, replacement, atomic activation and query degradation

**Files**

- Create: `backend/app/services/family_model_settings/search_profiles.py`
- Modify: `backend/app/services/family_model_settings/publishing.py`
- Modify: `backend/app/services/family_model_settings/prices.py`
- Modify: `backend/app/repos/family_model_settings/resource_operations.py`
- Modify: `backend/app/core/config.py`
- Modify: `backend/app/api/family_model_settings.py`
- Modify: `backend/app/schemas/family_model_settings.py`
- Modify: `backend/app/services/search/hybrid.py`
- Modify: `backend/app/services/search/rerank.py`
- Modify: `backend/app/services/search/jobs.py`
- Modify: `backend/app/services/search/vector_cleanup.py`
- Modify: `backend/app/services/model_usage/adapters/rerank.py`
- Create: `backend/tests/family_model_settings/test_search_replacements.py`
- Create: `backend/tests/family_model_settings/test_search_replacement_api.py`
- Create: `backend/tests/family_model_settings/test_search_activation_mysql_concurrency.py`
- Create: `backend/tests/search/test_family_search_resolution.py`
- Modify: `backend/tests/search/test_hybrid_search.py`
- Modify: `backend/tests/search/test_rerank.py`
- Modify: `backend/tests/model_usage/test_rerank_adapter.py`

**Interfaces**

- Consumes: profile-explicit jobs/vector stores from Task 10 and config/price publication from Tasks 5–6.
- Produces: `create_search_replacement()`, `retry_search_replacement()`, `cancel_search_replacement()`, `activate_ready_search_profile()` and family-aware hybrid query resolution. Search-profile creation persists a durable collection ensure operation in the same transaction.
- Activation is the only path that can replace an active Embedding identity.

- [ ] **Step 1: Add initial-provisioning tests for keyword fallback, progress and activation.**

```python
def test_initial_profile_is_not_queried_until_fully_active(db, first_profile, hybrid_search_call) -> None:
    assert first_profile.status == FamilyModelSearchProfileStatus.PROVISIONING
    result = hybrid_search_call(first_profile.family_id)
    assert result.search_mode == "keyword"
    assert result.degradation_code == "search_embedding_provisioning"
    complete_all_profile_documents(db, first_profile)
    activate_ready_search_profile(db, family_id=first_profile.family_id, profile_id=first_profile.id)
    assert active_search_profile_id(db, first_profile.family_id) == first_profile.id
```

- [ ] **Step 2: Add replacement creation tests for immutable identity, cost estimate and candidate-only prices.**

```python
def test_replacement_creates_one_profile_collection_and_embedding_only_price(db, replacement_command) -> None:
    result = create_search_replacement(db, replacement_command)
    profile = require_search_profile(db, family_id=replacement_command.family_id, profile_id=result.profile_id)
    price = require_price_version(db, result.candidate_price_version_id)
    assert profile.base_search_profile_id == replacement_command.base_search_profile_id
    assert profile.status == FamilyModelSearchProfileStatus.PROVISIONING
    assert price.purpose == "search_rebuild_candidate"
    assert {rate.capability.value for rate in price_rates(db, price.id)} == {"embedding"}
    operation = get_resource_operation(db, profile.id, "ensure_search_profile_collection")
    assert operation.qdrant_collection_snapshot == profile.qdrant_collection
    assert operation.status == "pending"

def test_replacement_response_lost_replays_after_version_advanced(db, replacement_command) -> None:
    first = create_search_replacement(db, replacement_command)
    db.commit()
    replay = create_search_replacement(db, replacement_command)
    assert replay == first
    assert count_candidate_profiles(db, replacement_command.family_id) == 1
```

The draft validation response supplies document count, minimum estimate, conservative estimate and a confirmation checksum. Creation requires current password, base settings version, base active search profile and the checksum.

- [ ] **Step 3: Implement replacement creation after a locked stale-base check.**

```python
def create_search_replacement(db: Session, command: CreateSearchReplacementCommand) -> SearchReplacementResult:
    verify_owner_password(db, user_id=command.actor_user_id, password=command.current_password)
    require_search_profile(
        db, family_id=command.family_id, profile_id=command.base_search_profile_id
    )
    claim = claim_operation(db, command.idempotency_identity_with_hmac_fingerprint())
    if claim.completed:
        return SearchReplacementResult.model_validate(claim.response_json)
    settings = lock_family_model_settings(db, family_id=command.family_id)
    require_settings_version(settings, command.base_settings_version_number)
    if settings.active_search_profile_id != command.base_search_profile_id:
        raise FamilySearchProfileLocked("family_search_profile_locked")
    ensure_no_live_replacement(db, family_id=command.family_id)
    validated = validate_search_replacement(db, command)
    validated.require_checksum(command.confirm_checksum)
    profile = insert_candidate_search_profile(db, command, validated)
    candidate_price = publish_candidate_embedding_price(db, command, profile=profile, rates=validated.rates)
    seed_profile_document_snapshots(db, profile=profile)
    insert_ensure_collection_operation(db, search_profile=profile)
    settings.version_number += 1
    log_activity_safe(db, family_id=command.family_id, actor_id=command.actor_user_id, summary="开始重建家庭搜索索引")
    return complete_search_replacement_claim(claim, profile=profile, price=candidate_price)
```

`insert_candidate_search_profile()` first creates the profile ID, then assigns
`qdrant_collection = f"{settings.family_model_qdrant_collection_prefix}_{family_id.hex}_{profile_id.hex}"`.
Add `family_model_qdrant_collection_prefix: str = "culina_fsp"` to `Settings`. The prefix is deployment-only,
validated as a lowercase Qdrant-safe identifier, and the generated name contains no
Provider or model name. Initial provisioning uses the same helper. Qdrant collection creation and document-job
enqueue happen only through the durable resource-operation worker: the creation transaction inserts the operation,
then the worker idempotently ensures the collection and fills any missing jobs. Replaying the command returns the same
profile and safe response even after settings version advanced; receipt replay precedes stale-base validation.

- [ ] **Step 4: Add retry/cancel tests that never duplicate collections or overwrite active search.**

```python
def test_retry_reuses_candidate_profile_and_collection(db, failed_profile) -> None:
    old_collection = failed_profile.qdrant_collection
    result = retry_search_replacement(db, family_id=failed_profile.family_id, profile_id=failed_profile.id)
    assert result.profile_id == failed_profile.id
    assert result.qdrant_collection == old_collection

def test_cancel_keeps_old_active_profile(db, active_profile, candidate_profile) -> None:
    cancel_search_replacement(db, family_id=active_profile.family_id, profile_id=candidate_profile.id)
    assert active_search_profile_id(db, active_profile.family_id) == active_profile.id
    assert candidate_profile.status == FamilyModelSearchProfileStatus.FAILED
```

Cancellation stops enqueueing new candidate jobs and marks undispatched jobs cancelled/released. Dispatching/uncertain attempts settle under existing rules; the candidate collection remains for retention cleanup.

- [ ] **Step 5: Add activation tests that merge into switch-time config and price.**

```python
def test_activation_preserves_changes_published_during_rebuild(db, replacement, publish_other_changes) -> None:
    publish_other_changes(llm_model="new-llm", rerank_enabled=False, tts_price="3.2")
    activated = activate_ready_search_profile(
        db, family_id=replacement.family_id, profile_id=replacement.profile_id
    )
    revision = load_config_revision(db, activated.config_revision_id)
    assert binding(revision, "llm", "primary").requested_model == "new-llm"
    assert binding(revision, "rerank", "search").enabled is False
    assert price_rate(activated.price_version_id, "tts", "default").unit_price == Decimal("3.2")
    assert binding(revision, "embedding", "search").requested_model == replacement.embedding_model
```

- [ ] **Step 6: Implement atomic activation with base-search and readiness checks.**

```python
def activate_ready_search_profile(db: Session, *, family_id: str, profile_id: str) -> PublishedFamilyModelConfiguration:
    settings = lock_family_model_settings(db, family_id=family_id)
    candidate = lock_search_profile(db, family_id=family_id, profile_id=profile_id)
    require_profile_ready(db, candidate)
    if settings.active_search_profile_id != candidate.base_search_profile_id:
        raise FamilyModelSettingsVersionConflict(code="family_search_profile_locked")
    current_revision = require_config_revision(db, family_id=family_id, revision_id=settings.active_config_revision_id)
    current_price = require_price_version(db, family_id=family_id, price_version_id=settings.active_price_version_id)
    candidate_price = require_candidate_price_for_search_profile(db, family_id=family_id, search_profile_id=candidate.id)
    merged_revision = clone_revision_replacing_embedding(db, current_revision, candidate=candidate)
    merged_price = clone_price_replacing_embedding(
        db,
        current_price=current_price,
        candidate_price=candidate_price,
        config_revision_id=merged_revision.id,
    )
    old_profile = optional_search_profile(db, family_id=family_id, profile_id=settings.active_search_profile_id)
    settings.active_config_revision_id = merged_revision.id
    settings.active_price_version_id = merged_price.id
    settings.active_search_profile_id = candidate.id
    settings.version_number += 1
    candidate.status = FamilyModelSearchProfileStatus.ACTIVE
    candidate.activated_at = utcnow()
    mark_superseded(old_profile)
    return published_result(settings, revision=merged_revision, price=merged_price, search_profile=candidate)
```

The candidate price remains candidate-purpose history; the merged active price is a new complete version. A transaction failure leaves every active pointer and old profile unchanged.

- [ ] **Step 7: Add MySQL concurrency coverage for competing replacements and simultaneous price publication.**

```python
def test_only_matching_base_replacement_can_activate(mysql_sessions, two_ready_candidates) -> None:
    results = activate_concurrently(mysql_sessions, two_ready_candidates)
    assert sum(item.succeeded for item in results) == 1
    assert {item.code for item in results if not item.succeeded} == {"family_search_profile_locked"}

def test_price_publish_before_activation_is_preserved(mysql_sessions, ready_candidate) -> None:
    publish_price_and_activate_concurrently(mysql_sessions, ready_candidate)
    final = load_active_configuration(mysql_sessions[0], ready_candidate.family_id)
    assert final.non_embedding_rates == newest_committed_non_embedding_rates(mysql_sessions[0])
```

- [ ] **Step 8: Refactor hybrid search to resolve active Embedding and current Rerank independently.**

```python
def resolve_family_search_runtime(db: Session, *, family_id: str) -> FamilySearchRuntime:
    resolver = FamilyModelConfigurationResolver(db)
    active = lock_active_model_price_snapshot(db, family_id=family_id)
    embedding = (
        resolver.resolve_search_profile(family_id, active.search_profile_id)
        if active.search_profile_id is not None
        else None
    )
    rerank = resolver.optional_revision_variant(
        family_id, active.config_revision_id, "rerank", "search"
    )
    return FamilySearchRuntime(
        embedding=embedding,
        embedding_usage_snapshot=EmbeddingUsageSnapshot(
            config_revision_id=active.config_revision_id,
            price_version_id=active.price_version_id,
            candidate=False,
        ),
        rerank=rerank,
        rerank_price_version_id=active.price_version_id,
    )
```

Query Embedding uses the active search profile collection and the config/price snapshot captured from settings when the query runtime/reservation is created. The settings lock is held only in that short database transaction; persist the reservation/request snapshot and release the lock before DNS, Provider Embedding or Qdrant work. Rerank uses the same active config/price boundary. Add a test that publishes a new price without replacing the profile, then proves the next query Embedding reservation uses the new price while an already-created query keeps its old snapshot. Mutable price identity is not stored in `ResolvedSearchProfile`. Missing/provisioning/failed Embedding yields keyword + local ranking; missing/failed Rerank yields full local ranking.

- [ ] **Step 9: Build Rerank clients from resolved bindings and shared transport.**

```python
def build_rerank_client(binding: ResolvedCapabilityBinding | None, dependencies: RerankDependencies) -> RerankClient:
    if binding is None:
        return DisabledRerankClient()
    return OpenAICompatibleRerankClient(
        binding=binding,
        transport=dependencies.transport,
        usage_adapter=RerankUsageAdapter.for_binding(binding, dependencies.usage),
        instruct=FIXED_CULINA_RERANK_INSTRUCTION,
        model_usage_required=True,
    )
```

The fixed instruction moves from environment configuration to a tested code constant. Key rotation and Rerank changes never create a search replacement.

- [ ] **Step 10: Add search replacement Owner API endpoints and stable progress response.**

```python
class SearchReplacementOut(BaseModel):
    profile_id: str
    status: Literal["provisioning", "failed", "active", "cancelled"]
    total_documents: int
    indexed_documents: int
    failed_documents: int
    budget_blocked_documents: int
    retryable: bool
    created_at: datetime
    activated_at: datetime | None = None
```

Implement POST create, GET status, POST retry and POST cancel at the exact paths in the spec. Responses do not expose Qdrant collection, Provider endpoint or credential metadata.

- [ ] **Step 11: Run replacement, hybrid, Rerank and MySQL activation tests.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_search_replacements.py tests/family_model_settings/test_search_replacement_api.py tests/search/test_family_search_resolution.py tests/search/test_hybrid_search.py tests/search/test_rerank.py tests/model_usage/test_rerank_adapter.py -q`

Run with MySQL: `cd backend && CULINA_TEST_MYSQL_URL="$CULINA_TEST_MYSQL_URL" .venv/bin/python -m pytest tests/family_model_settings/test_search_activation_mysql_concurrency.py -q`

Expected: PASS; old search remains live until atomic activation and other settings changes survive.

- [ ] **Step 12: Create the review checkpoint.**

```bash
git add backend/app/core/config.py backend/app/services/family_model_settings/search_profiles.py backend/app/services/family_model_settings/publishing.py backend/app/services/family_model_settings/prices.py backend/app/repos/family_model_settings/resource_operations.py backend/app/api/family_model_settings.py backend/app/schemas/family_model_settings.py backend/app/services/search/hybrid.py backend/app/services/search/rerank.py backend/app/services/search/jobs.py backend/app/services/search/vector_cleanup.py backend/app/services/model_usage/adapters/rerank.py backend/tests/family_model_settings/test_search_replacements.py backend/tests/family_model_settings/test_search_replacement_api.py backend/tests/family_model_settings/test_search_activation_mysql_concurrency.py backend/tests/search/test_family_search_resolution.py backend/tests/search/test_hybrid_search.py backend/tests/search/test_rerank.py backend/tests/model_usage/test_rerank_adapter.py
git commit -m "feat: rebuild and switch family search profiles"
```

Only run the commit command when the user has explicitly authorized commits.

## Task 12: Member-safe AI status, capability-test dispatch, redaction and maintenance

**Files**

- Create: `backend/app/services/family_model_settings/status.py`
- Create: `backend/app/services/family_model_settings/maintenance.py`
- Modify: `backend/app/repos/family_model_settings/resource_operations.py`
- Modify: `backend/app/api/ai.py`
- Modify: `backend/app/schemas/ai.py`
- Modify: `backend/app/api/family_model_settings.py`
- Modify: `backend/app/ai/observability/redaction.py`
- Modify: `backend/app/core/logging.py`
- Modify: `backend/app/core/config.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/services/model_usage/queries.py`
- Modify: `backend/app/services/model_usage/serializers.py`
- Modify: `backend/app/schemas/model_usage.py`
- Modify: `backend/app/api/model_usage.py`
- Create: `backend/tests/family_model_settings/test_member_status.py`
- Create: `backend/tests/family_model_settings/test_capability_tests.py`
- Create: `backend/tests/family_model_settings/test_maintenance.py`
- Create: `backend/tests/family_model_settings/test_family_resource_cleanup.py`
- Create: `backend/tests/family_model_settings/test_privacy_boundaries.py`
- Modify: `backend/tests/ai_infra/test_workspace_chat.py`
- Modify: `backend/tests/model_usage/test_usage_api_permissions.py`
- Modify: `backend/tests/model_usage/test_privacy_boundaries.py`

**Interfaces**

- Consumes: all seven runtime paths and search lifecycle from Tasks 7–11.
- Produces: stable Member-safe `/api/ai/status`, generic Owner capability-test router, secret maintenance plus durable Qdrant resource-operation worker, family-deletion cleanup tombstones and privacy regression gate.
- Owner settings GET may show provider display name, adapter, normalized Base URL, model and prices. Member schemas structurally omit them rather than returning null.

- [ ] **Step 1: Add Member status contract tests that scan both JSON keys and values.**

```python
def test_member_ai_status_contains_only_safe_capability_state(member_client, configured_family) -> None:
    response = member_client.get("/api/ai/status")
    assert response.status_code == 200
    assert response.json() == {
        "configured": True,
        "enabled": True,
        "supports_vision": True,
        "status": "ready",
        "detail": "家庭 AI 服务已就绪。",
        "capabilities": {
            "llm": "available",
            "image_generation": "unavailable",
            "stt": "available",
            "tts": "available",
            "realtime_audio": "unavailable",
            "embedding": "provisioning",
            "rerank": "available",
        },
        "recipe_cook_contracts": response.json()["recipe_cook_contracts"],
    }
    forbidden = {"provider", "model", "base_url", "profile_id", "price", "credential"}
    assert forbidden.isdisjoint(recursive_keys(response.json()))
```

- [ ] **Step 2: Replace global AI status logic with family capability projection.**

```python
class AIStatusResponse(BaseModel):
    configured: bool
    enabled: bool
    supports_vision: bool = False
    status: Literal["ready", "not_configured", "disabled", "degraded"]
    detail: str
    capabilities: dict[FamilyModelCapability, Literal[
        "available", "unavailable", "provisioning", "failed", "budget_blocked"
    ]]
    recipe_cook_contracts: RecipeCookContractsProbe | None = None

@router.get("/api/ai/status", response_model=AIStatusResponse)
def get_ai_status(auth=Depends(get_current_auth), db=Depends(get_db)) -> AIStatusResponse:
    _, membership = auth
    return project_member_safe_ai_status(db, family_id=membership.family_id)
```

Remove `_model_supports_vision()` inference from environment values. Vision comes from the active primary LLM binding option.

- [ ] **Step 3: Add generic capability-test dispatch tests for all seven capabilities, confirmation and idempotency.**

```python
@pytest.mark.parametrize("capability,variant", [
    ("llm", "primary"),
    ("image_generation", "text"),
    ("stt", "default"),
    ("tts", "default"),
    ("realtime_audio", "default"),
    ("embedding", "search"),
    ("rerank", "search"),
])
def test_owner_real_capability_test_uses_normal_ledger(owner_client, capability, variant) -> None:
    result = owner_client.post(
        f"/api/family/model-settings/capabilities/{capability}/test",
        json={
            "variant_key": variant,
            "confirm_billable": True,
            "idempotency_key": f"real-test-{capability}",
        },
    )
    assert result.status_code == 200
    assert exactly_one_usage_event(capability, operation_kind="family_model_capability_test")
```

Calling without `confirm_billable` returns 422 before reserve/send. Same-key replay returns the first safe result and creates no second usage event.

- [ ] **Step 4: Implement a closed capability-test registry.**

```python
CAPABILITY_TEST_RUNNERS: Mapping[FamilyModelCapability, CapabilityTestRunner] = {
    "llm": run_llm_capability_test,
    "image_generation": run_image_capability_test,
    "stt": run_stt_capability_test,
    "tts": run_tts_capability_test,
    "realtime_audio": run_realtime_capability_test,
    "embedding": run_embedding_capability_test,
    "rerank": run_rerank_capability_test,
}

def run_family_capability_test(db: Session, command: CapabilityTestCommand) -> CapabilityTestResult:
    if not command.confirm_billable:
        raise FamilyModelDraftInvalid("family_model_billable_test_confirmation_required")
    claim = claim_operation(db, command.idempotency_identity())
    if claim.completed:
        return CapabilityTestResult.model_validate(claim.response_json)
    runner = CAPABILITY_TEST_RUNNERS[command.capability]
    result = runner(CapabilityTestContext.from_command(db, command))
    complete_operation(claim, result_id=result.usage_event_id, response=result.safe_response())
    return result
```

The operation claim must be committed before a remote test send or be coupled to the usage attempt key so a process crash cannot create a second send on replay.

- [ ] **Step 5: Expand trace and logging redaction keys and add secret-marker scans.**

```python
SENSITIVE_KEYS = frozenset({
    "authorization", "proxy-authorization", "api-key", "x-api-key",
    "api_key", "secret", "secret_value", "ciphertext", "nonce",
    "auth_tag", "credential", "credential_secret_version_id",
})
```

Redact key matches case-insensitively and after replacing `-` with `_`. Safe logs may include adapter kind, config revision, profile stable ID, HTTP status class and latency; they exclude URL query, raw host for Member errors, request/response body and secret fingerprints.

- [ ] **Step 6: Add maintenance tests for revoked secrets, durable collection ensure/delete and family deletion.**

```python
def test_maintenance_destroys_only_unreferenced_expired_revoked_secret(db, revoked_secrets) -> None:
    stats = maintain_family_model_settings(db, now=NOW)
    assert revoked_secrets.safe.status == FamilyModelSecretStatus.DESTROYED
    assert revoked_secrets.dispatching.status == FamilyModelSecretStatus.REVOKED
    assert revoked_secrets.uncertain.status == FamilyModelSecretStatus.REVOKED
    assert stats.destroyed_secrets == 1

def test_committed_profile_without_post_commit_enqueue_is_recovered(db, pending_ensure, fake_qdrant) -> None:
    process_family_model_resource_operations(db, now=NOW, qdrant_admin=fake_qdrant)
    assert fake_qdrant.has_collection(pending_ensure.qdrant_collection_snapshot)
    assert missing_profile_document_job_count(db, pending_ensure.search_profile_id_snapshot) == 0

def test_ensure_replays_after_crash_between_qdrant_and_completion(db, ensured_but_unfinished, fake_qdrant) -> None:
    process_family_model_resource_operations(db, now=NOW, qdrant_admin=fake_qdrant)
    assert fake_qdrant.ensure_call_count(ensured_but_unfinished.collection) == 2
    assert fake_qdrant.collection_count(ensured_but_unfinished.collection) == 1
    assert jobs_are_unique(db, ensured_but_unfinished.profile_id)

def test_family_delete_tombstone_survives_profile_cascade(db, family_with_profiles) -> None:
    delete_family_with_model_cleanup(db, family_id=family_with_profiles.id)
    db.commit()
    assert not family_exists(db, family_with_profiles.id)
    operations = pending_delete_operations(db, family_id_snapshot=family_with_profiles.id)
    assert {item.qdrant_collection_snapshot for item in operations} == family_with_profiles.collections
```

Also cover an external delete succeeding before the worker can mark completion, stale `running` lease recovery, retry backoff and a pending ensure suppressed when a family-delete tombstone exists. Qdrant fakes must model idempotent ensure/delete; tests cannot infer recovery from profile rows that may already be gone.

- [ ] **Step 7: Implement maintenance with idempotent state transitions and safe failure retry.**

```python
def maintain_family_model_settings(db: Session, *, now: datetime) -> FamilyModelMaintenanceStats:
    destroyed = destroy_eligible_revoked_secrets(
        db,
        cutoff=now - timedelta(hours=settings.family_model_revoked_secret_retention_hours),
    )
    queued_deletes = queue_expired_search_profile_cleanup_tombstones(
        db,
        cutoff=now - timedelta(days=settings.family_model_retired_collection_retention_days),
    )
    return FamilyModelMaintenanceStats(
        destroyed_secrets=destroyed,
        queued_collection_deletes=queued_deletes,
    )
```

Add `family_model_retired_collection_retention_days: int = 7` to deployment `Settings` and reject non-positive values.
The revoked-secret retention field already introduced in Task 2 remains independently configurable.

`queue_expired_search_profile_cleanup_tombstones()` only writes idempotent delete operations in the database transaction; it does not call Qdrant. `delete_family_with_model_cleanup()` first snapshots every family collection into the same non-cascading operation table, suppresses pending ensure operations, then deletes the Family so cascade cannot erase the cleanup target. All application-level family deletion must use this transaction boundary.

`process_family_model_resource_operations()` claims `pending`, due `retry_wait` or expired-lease `running` rows in short transactions. For ensure it checks that no delete tombstone supersedes the request, idempotently ensures the exact snapshotted collection, then in another transaction idempotently fills missing profile-document jobs and marks completed. For delete it idempotently deletes the snapshotted collection, then marks completed and, only if the live family/profile still exists and still matches, marks the profile retired. Network/process failure leaves a durable retry target; no recovery path relies only on scanning live or retired profile rows.

- [ ] **Step 8: Start and stop the maintenance worker in FastAPI lifespan.**

```python
family_model_worker = FamilyModelSettingsMaintenanceWorker(
    process_resource_operations=True,
)
family_model_worker.start()
try:
    yield
finally:
    family_model_worker.stop()
```

The worker uses short `SessionLocal` transactions and does not share sessions with request handlers, image workers or search workers. Startup immediately makes pending/expired-lease resource operations eligible; shutdown never marks an unfinished operation completed.

- [ ] **Step 9: Harden model-usage Member privacy after family BYOK.**

```python
def allowed_personal_group_by(group_by: str) -> bool:
    return group_by in {"capability", "meter", "daily_capability_cost"}
```

Personal/Member request logs and breakdown schemas must not include provider, requested model, billing model, provider request ID, profile IDs or per-request prices. Define separate `ModelUsagePersonalRequestLogPageOut`/item and personal breakdown item/group enums in `backend/app/schemas/model_usage.py`; `/me/*` routes use those response models and reject provider/model filters plus `provider_model`/`subject` groupings. Owner family endpoints retain wider diagnostic schemas and grouping. Add schema-level tests, not only serializer null checks.

- [ ] **Step 10: Run status, capability, maintenance and privacy tests.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_member_status.py tests/family_model_settings/test_capability_tests.py tests/family_model_settings/test_maintenance.py tests/family_model_settings/test_family_resource_cleanup.py tests/family_model_settings/test_privacy_boundaries.py tests/ai_infra/test_workspace_chat.py tests/model_usage/test_usage_api_permissions.py tests/model_usage/test_privacy_boundaries.py -q && cd .. && git diff --check`

Expected: PASS; recursive response/log/trace scans contain no secret marker, endpoint or Member-forbidden identity.

- [ ] **Step 11: Create the review checkpoint.**

```bash
git add backend/app/services/family_model_settings/status.py backend/app/services/family_model_settings/maintenance.py backend/app/repos/family_model_settings/resource_operations.py backend/app/api/ai.py backend/app/schemas/ai.py backend/app/api/family_model_settings.py backend/app/ai/observability/redaction.py backend/app/core/logging.py backend/app/core/config.py backend/app/main.py backend/app/services/model_usage/queries.py backend/app/services/model_usage/serializers.py backend/app/schemas/model_usage.py backend/app/api/model_usage.py backend/tests/family_model_settings/test_member_status.py backend/tests/family_model_settings/test_capability_tests.py backend/tests/family_model_settings/test_maintenance.py backend/tests/family_model_settings/test_family_resource_cleanup.py backend/tests/family_model_settings/test_privacy_boundaries.py backend/tests/ai_infra/test_workspace_chat.py backend/tests/model_usage/test_usage_api_permissions.py backend/tests/model_usage/test_privacy_boundaries.py
git commit -m "feat: expose safe family ai capability status"
```

Only run the commit command when the user has explicitly authorized commits.
## Task 13: Frontend contracts, family-isolated queries, actions and navigation state

**Files**

- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/api/modelUsageApi.ts`
- Modify: `frontend/src/api/modelUsageApi.test.ts`
- Create: `frontend/src/api/familyModelSettingsApi.ts`
- Create: `frontend/src/api/familyModelSettingsApi.test.ts`
- Modify: `frontend/src/api/queryKeys.ts`
- Modify: `frontend/src/api/queryKeys.test.ts`
- Modify: `frontend/src/api/cacheInvalidation.ts`
- Modify: `frontend/src/api/cacheInvalidation.test.ts`
- Modify: `frontend/src/app/appNavigationModel.ts`
- Modify: `frontend/src/app/appNavigationModel.test.ts`
- Modify: `frontend/src/app/useAppNavigationState.test.tsx`
- Create: `frontend/src/features/family-model-settings/familyModelSettingsOptions.ts`
- Create: `frontend/src/features/family-model-settings/familyModelSettingsModel.ts`
- Create: `frontend/src/features/family-model-settings/familyModelSettingsModel.test.ts`
- Create: `frontend/src/features/family-model-settings/useFamilyModelSettingsQueries.ts`
- Create: `frontend/src/features/family-model-settings/useFamilyModelSettingsQueries.test.tsx`
- Create: `frontend/src/features/family-model-settings/useFamilyModelSettingsState.ts`
- Create: `frontend/src/features/family-model-settings/useFamilyModelSettingsState.test.tsx`
- Create: `frontend/src/features/family-model-settings/useFamilyModelSettingsActions.ts`
- Create: `frontend/src/features/family-model-settings/useFamilyModelSettingsActions.test.tsx`
- Modify: `frontend/src/features/model-usage/ModelUsageWorkspace.tsx`
- Modify: `frontend/src/features/model-usage/ModelUsageWorkspace.test.tsx`
- Modify: `frontend/src/features/model-usage/ModelUsageDesktopView.tsx`
- Modify: `frontend/src/features/model-usage/ModelUsageMobileView.tsx`
- Modify: `frontend/src/features/model-usage/ModelUsageRequestLogsPage.tsx`
- Modify: `frontend/src/features/model-usage/ModelUsageRequestLogs.tsx`
- Modify: `frontend/src/features/model-usage/ModelUsageBreakdownTable.tsx`
- Modify: `frontend/src/features/model-usage/modelUsageModel.ts`
- Modify: `frontend/src/features/model-usage/modelUsageModel.test.ts`
- Modify: `frontend/src/features/model-usage/modelUsageOptions.ts`
- Modify: `frontend/src/features/model-usage/modelUsageWorkspaceViewModel.ts`
- Modify: `frontend/src/features/model-usage/useModelUsageQueries.ts`
- Modify: `frontend/src/features/model-usage/useModelUsageQueries.test.tsx`
- Create: `frontend/src/features/model-usage/modelUsageRequestLogsModel.ts`
- Create: `frontend/src/features/model-usage/modelUsageRequestLogsModel.test.ts`
- Create: `frontend/src/features/model-usage/useModelUsageRequestLogs.ts`
- Create: `frontend/src/features/model-usage/useModelUsageRequestLogs.test.tsx`
- Create: `frontend/src/features/model-usage/ModelUsagePrivacy.test.tsx`
- Modify: `frontend/src/components/ai/AiWorkspace.test.tsx`

**Interfaces**

- Consumes: Owner schemas and Member-safe AI status from Tasks 4–6 and 11–12.
- Produces: typed API methods for every route in section 18.1 of the specification, family-keyed React Query contracts,
  one shared actions/state/model layer and the `family.aiServices` navigation target used by Task 14.
- Provider Key exists only in the local controlled input and the immediate mutation payload. It is absent from every
  response type, query cache value, persisted navigation value and recoverable server draft.
- Personal model-usage contracts are structurally separate from Owner family diagnostics: they cannot express or send
  provider/model filters and cannot render provider/model/request-ID/price fields that the backend no longer returns.

- [ ] **Step 1: Add API contract tests for methods, paths and write-only credentials.**

```typescript
it('sends a provider key only in the create request and never models it in a response', async () => {
  mockRequest.mockResolvedValue({
    id: 'profile-1',
    display_name: '家用模型',
    credential: { configured: true, version_number: 1, updated_at: NOW },
  });

  const result = await familyModelSettingsApi.createProviderProfile({
    display_name: '家用模型',
    adapter_kind: 'openai_compatible_http',
    auth_mode: 'api_key',
    api_base_url: 'https://provider.example/v1',
    api_key: 'write-only-value',
    idempotency_key: 'profile-create-1',
  });

  expect(mockRequest).toHaveBeenCalledWith('/api/family/model-settings/provider-profiles', {
    method: 'POST',
    body: expect.any(String),
  });
  expect(JSON.parse(mockRequest.mock.calls.at(-1)?.[1]?.body).api_key).toBe('write-only-value');
  expect(JSON.stringify(result)).not.toContain('write-only-value');
  expect('api_key' in result).toBe(false);
});
```

Cover GET settings/draft/prices, PUT draft/price draft, validate/publish, profile create/update/rotate/check,
billable capability test and replacement create/get/retry/cancel. Verify URL path parameters are encoded and no request
accepts `family_id` or actor fields.

Add a contract test proving provider PATCH accepts only display/status/scope-external fields. Changing endpoint/auth/
workspace/region/project uses `createProviderProfile()` with the new write-only Key and then updates the binding draft;
the client never sends endpoint B to profile A's PATCH endpoint.

- [ ] **Step 2: Define closed frontend contracts and implement the API client.**

```typescript
export type FamilyModelCapability =
  | 'llm' | 'image_generation' | 'stt' | 'tts'
  | 'realtime_audio' | 'embedding' | 'rerank';

export type FamilyModelCredentialMetadata = {
  configured: boolean;
  version_number: number | null;
  updated_at: string | null;
};

export type FamilyModelProviderProfile = {
  id: string;
  display_name: string;
  adapter_kind: FamilyModelAdapterKind;
  auth_mode: FamilyModelAuthMode;
  api_base_url: string;
  websocket_base_url: string | null;
  archived: boolean;
  credential: FamilyModelCredentialMetadata;
};

export type FamilyModelProviderProfileCreate = {
  display_name: string;
  adapter_kind: FamilyModelAdapterKind;
  auth_mode: FamilyModelAuthMode;
  api_base_url: string;
  websocket_base_url?: string | null;
  api_key?: string;
  idempotency_key: string;
};

export type FamilyModelProviderProfilePatch = {
  display_name?: string;
  status?: 'active' | 'disabled' | 'archived';
  base_profile_version_number: number;
  idempotency_key: string;
};
```

Capability options use discriminated unions for LLM/image/STT/TTS/realtime/Embedding/Rerank. Do not introduce
`Record<string, unknown>` for provider options. Money and quantity remain strings end to end. Update `AiStatus` to the
Member-safe `configured/enabled/supports_vision/status/detail/capabilities` shape; remove `provider` and `model`. Export
the new methods through the existing central `api` object in `client.ts`.

Split existing model-usage types instead of keeping one optional-field superset:

```typescript
export type ModelUsagePersonalGroupBy = 'capability' | 'meter' | 'daily_capability_cost';
export type ModelUsageFamilyGroupBy = ModelUsagePersonalGroupBy | 'provider_model' | 'subject';

export interface ModelUsagePersonalRequestLog {
  id: string;
  occurred_at: string;
  capability: ModelUsageCapability;
  provider_outcome: string;
  execution_certainty: string;
  measurement_status: string;
  meters: ModelUsageRequestMeter[];
}

export interface ModelUsageFamilyRequestLog extends ModelUsagePersonalRequestLog {
  provider: string;
  requested_model: string;
  billing_model: string;
  provider_request_id?: string | null;
  cost_cny?: string | null;
}
```

Personal and family breakdown/page responses use their own group/item types. Personal item/page types have no provider,
billing model, provider request ID or per-request cost property; do not leave these as optional fields. `modelUsageApi`
accepts a closed `ModelUsagePersonalRequestFilters` for `/me/requests` and a wider
`ModelUsageFamilyRequestFilters` only for Owner `/family/requests`.

- [ ] **Step 3: Add query-key isolation tests.**

```typescript
it('scopes every family model settings key by family', () => {
  expect(queryKeys.familyModelSettingsRoot('family-a')).toEqual(['family-model-settings', 'family-a']);
  expect(queryKeys.familyModelSettings('family-a')).toEqual(['family-model-settings', 'family-a', 'settings']);
  expect(queryKeys.familyModelSettingsDraft('family-a')).toEqual(['family-model-settings', 'family-a', 'draft']);
  expect(queryKeys.familyModelPriceVersions('family-a')).toEqual(['family-model-settings', 'family-a', 'prices']);
  expect(queryKeys.familySearchProfile('family-a')).toEqual(['family-model-settings', 'family-a', 'search']);
  expect(queryKeys.familyModelSettingsRoot('family-a')).not.toEqual(
    queryKeys.familyModelSettingsRoot('family-b'),
  );
});
```

- [ ] **Step 4: Add exact invalidation tests and implement the helpers.**

```typescript
export async function invalidateAfterFamilyModelSettingsChanged(
  queryClient: QueryClient,
  familyId: string,
) {
  await invalidateMany(queryClient, [
    queryKeys.familyModelSettingsRoot(familyId),
    queryKeys.modelUsageRoot(familyId),
    queryKeys.aiStatus,
  ]);
}

export async function invalidateAfterFamilySearchReplacementChanged(
  queryClient: QueryClient,
  familyId: string,
) {
  await invalidateMany(queryClient, [
    queryKeys.familySearchProfile(familyId),
    queryKeys.familyModelSettings(familyId),
    queryKeys.searchRoot,
    queryKeys.aiStatus,
  ]);
}
```

Tests assert no root for another family and no unrelated food/inventory query is invalidated. Price-only publish also
invalidates the affected model-usage root because future estimates change.

- [ ] **Step 5: Add pure model tests for Decimal strings, complete price coverage and immutable search identity.**

```typescript
it.each(['', '1.', '.5', '-1', 'NaN', '1e3', '0.1234567890123'])(
  'rejects a non-canonical money string %s',
  (value) => expect(validateMoneyInput(value)).toBeDefined(),
);

it('keeps active embedding identity out of a normal draft payload', () => {
  const payload = toSaveDraftPayload(editActiveEmbeddingIdentity(readyDraft));
  expect(payload).toEqual(expect.objectContaining({ bindings: readyDraft.bindings }));
  expect(payload.bindings.embedding.search).toEqual(readyDraft.bindings.embedding.search);
});
```

`validateMoneyInput()` accepts canonical non-negative fixed decimals up to 12 fractional digits; no `Number()` or
floating-point multiplication is used. Conversion helpers emit complete rates for every enabled variant/meter and
return field-addressable Chinese errors for missing, overlapping or unsupported rates.

- [ ] **Step 6: Implement labels, defaults, payload conversion and safe error projection.**

```typescript
export const FAMILY_MODEL_CAPABILITY_OPTIONS: Record<FamilyModelCapability, {
  label: string;
  description: string;
}> = {
  llm: { label: '对话与视觉理解', description: '用于家庭助手、菜谱草稿和图片理解。' },
  image_generation: { label: '图片生成', description: '用于菜谱、食物和家庭图片。' },
  stt: { label: '语音识别', description: '把做菜时的语音转成文字。' },
  tts: { label: '语音播报', description: '朗读步骤和助手回复。' },
  realtime_audio: { label: '实时语音', description: '支持连续的语音交互。' },
  embedding: { label: '搜索向量', description: '为家庭内容建立语义索引。' },
  rerank: { label: '搜索重排', description: '优化家庭搜索结果顺序。' },
};
```

Safe API error parsing maps stable codes to recovery actions. It never renders a raw provider response, URL, auth
header, stack or response payload. Publish conflict exposes only “刷新后重新应用草稿”.

- [ ] **Step 7: Add Owner-query gating and stale-data tests, then implement query composition.**

```typescript
const settingsQuery = useQuery({
  queryKey: queryKeys.familyModelSettings(familyId),
  queryFn: familyModelSettingsApi.getSettings,
  enabled: Boolean(familyId) && role === 'Owner',
});

const stale = settingsQuery.data !== undefined && settingsQuery.isError;
```

Tests render as Member and assert zero Owner API calls. A failed background refetch preserves the prior non-secret data
and marks `stale=true`; a family ID change never uses the previous family's draft as placeholder data. Queries for a
replacement poll only while its safe status is `provisioning` or `cancelling`.

Update `useModelUsageQueries` in the same step. Derive an effective group before constructing query keys/functions:
when scope is `me`, only `capability | meter | daily_capability_cost` is possible. Switching `family -> me` while
`provider_model` or `subject` is selected resets to `capability` before a personal query is enabled, so no transient
422 request is sent. Desktop/mobile option lists hide Owner-only groups in personal scope.

`ModelUsageRequestLogsPage` keeps personal and family filter state separate. Switching to `me` clears provider/model
filters and calls only `getMyModelUsageRequests()` with date/capability/status/pagination. `ModelUsageRequestLogs` and
`ModelUsageBreakdownTable` render discriminated personal/family props; the personal branch never reads or renders
provider, model, provider request ID or per-request cost. `ModelUsagePrivacy.test.tsx` asserts both the outgoing query
string and DOM after an Owner switches from family diagnostics to personal scope.

Move request-log filter defaults, personal projection and query payload conversion into
`modelUsageRequestLogsModel.ts`; move query keys/functions, pagination and scope transition into
`useModelUsageRequestLogs.ts`. `ModelUsageRequestLogsPage` composes that hook and visible controls only, rather than
constructing API filters inline. Put scope-aware group option selection in `modelUsageOptions.ts`, so desktop and mobile
views receive the same closed choices and cannot drift.

- [ ] **Step 8: Add state tests for sensitive busy actions, overlays and browser storage.**

```typescript
it('blocks close and section changes while a sensitive mutation is pending', () => {
  const state = reduceFamilyModelSettingsState(readyState, { type: 'busy', action: 'rotate' });
  expect(reduceFamilyModelSettingsState(state, { type: 'close-overlay' })).toBe(state);
  expect(reduceFamilyModelSettingsState(state, { type: 'select-section', section: 'prices' })).toBe(state);
});
```

The hook keeps section, overlay, selected profile, unsaved flag and mobile task stack in React state only. Add a test
spying on `localStorage.setItem` and `sessionStorage.setItem`; editing Key, Base URL or price must make zero calls.

- [ ] **Step 9: Add action tests for idempotency, confirmations and cache boundaries.**

```typescript
await actions.publish({ currentPassword: 'owner-password', confirmChecksum: 'checksum-1' });
expect(api.publish).toHaveBeenCalledWith(expect.objectContaining({
  base_settings_version_number: 7,
  confirm_checksum: 'checksum-1',
  idempotency_key: expect.any(String),
}));
expect(invalidateAfterFamilyModelSettingsChanged).toHaveBeenCalledWith(queryClient, 'family-a');
```

One user submission creates one idempotency key and reuses it only for the exact same retry payload. Changed payloads
receive a new key. Real capability tests require the explicit billable confirmation in state; rotate/publish/rebuild
require current password and cannot start twice while pending.

- [ ] **Step 10: Add the `aiServices` family navigation target and persistence tests.**

```typescript
export type FamilyView = 'profile' | 'modelUsage' | 'modelUsageRequests' | 'aiServices';

navigation.navigate({ workspace: 'family', view: 'aiServices' });
```

Keep persisted navigation version 2 compatible: old snapshots default to `profile`, valid `aiServices` round-trips,
and invalid family views are ignored. Authorization remains in Task 14 composition; navigation state itself does not
pretend to be a permission boundary.

- [ ] **Step 11: Update AI workspace fixtures for the Member-safe status contract.**

Replace test fixtures containing `provider` or `model` with capability states. Assert an unavailable LLM displays
“该能力尚未由家庭主理人配置” and no provider/model identity appears in the DOM.

- [ ] **Step 12: Run the contract, model, hook and navigation tests.**

Run: `npm --prefix frontend run test -- src/api/familyModelSettingsApi.test.ts src/api/modelUsageApi.test.ts src/api/queryKeys.test.ts src/api/cacheInvalidation.test.ts src/app/appNavigationModel.test.ts src/app/useAppNavigationState.test.tsx src/features/family-model-settings/familyModelSettingsModel.test.ts src/features/family-model-settings/useFamilyModelSettingsQueries.test.tsx src/features/family-model-settings/useFamilyModelSettingsState.test.tsx src/features/family-model-settings/useFamilyModelSettingsActions.test.tsx src/features/model-usage/modelUsageModel.test.ts src/features/model-usage/modelUsageRequestLogsModel.test.ts src/features/model-usage/useModelUsageQueries.test.tsx src/features/model-usage/useModelUsageRequestLogs.test.tsx src/features/model-usage/ModelUsageWorkspace.test.tsx src/features/model-usage/ModelUsagePrivacy.test.tsx src/components/ai/AiWorkspace.test.tsx`

Run: `npm run frontend:typecheck && git diff --check`

Expected: PASS; Member rendering makes no Owner settings request, family keys do not collide and no response/cache type
contains an API Key field.

- [ ] **Step 13: Create the review checkpoint.**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/api/modelUsageApi.ts frontend/src/api/modelUsageApi.test.ts frontend/src/api/familyModelSettingsApi.ts frontend/src/api/familyModelSettingsApi.test.ts frontend/src/api/queryKeys.ts frontend/src/api/queryKeys.test.ts frontend/src/api/cacheInvalidation.ts frontend/src/api/cacheInvalidation.test.ts frontend/src/app/appNavigationModel.ts frontend/src/app/appNavigationModel.test.ts frontend/src/app/useAppNavigationState.test.tsx frontend/src/features/family-model-settings/familyModelSettingsOptions.ts frontend/src/features/family-model-settings/familyModelSettingsModel.ts frontend/src/features/family-model-settings/familyModelSettingsModel.test.ts frontend/src/features/family-model-settings/useFamilyModelSettingsQueries.ts frontend/src/features/family-model-settings/useFamilyModelSettingsQueries.test.tsx frontend/src/features/family-model-settings/useFamilyModelSettingsState.ts frontend/src/features/family-model-settings/useFamilyModelSettingsState.test.tsx frontend/src/features/family-model-settings/useFamilyModelSettingsActions.ts frontend/src/features/family-model-settings/useFamilyModelSettingsActions.test.tsx frontend/src/features/model-usage/ModelUsageWorkspace.tsx frontend/src/features/model-usage/ModelUsageWorkspace.test.tsx frontend/src/features/model-usage/ModelUsageDesktopView.tsx frontend/src/features/model-usage/ModelUsageMobileView.tsx frontend/src/features/model-usage/ModelUsageRequestLogsPage.tsx frontend/src/features/model-usage/ModelUsageRequestLogs.tsx frontend/src/features/model-usage/ModelUsageBreakdownTable.tsx frontend/src/features/model-usage/modelUsageModel.ts frontend/src/features/model-usage/modelUsageModel.test.ts frontend/src/features/model-usage/modelUsageOptions.ts frontend/src/features/model-usage/modelUsageWorkspaceViewModel.ts frontend/src/features/model-usage/useModelUsageQueries.ts frontend/src/features/model-usage/useModelUsageQueries.test.tsx frontend/src/features/model-usage/modelUsageRequestLogsModel.ts frontend/src/features/model-usage/modelUsageRequestLogsModel.test.ts frontend/src/features/model-usage/useModelUsageRequestLogs.ts frontend/src/features/model-usage/useModelUsageRequestLogs.test.tsx frontend/src/features/model-usage/ModelUsagePrivacy.test.tsx frontend/src/components/ai/AiWorkspace.test.tsx
git commit -m "feat: add family model settings frontend state"
```

Only run the commit command when the user has explicitly authorized commits.

## Task 14: Owner AI-services workspace for desktop, tablet and phone

**Files**

- Create: `frontend/src/features/family-model-settings/FamilyModelSettingsWorkspace.tsx`
- Create: `frontend/src/features/family-model-settings/FamilyModelSettingsWorkspace.test.tsx`
- Create: `frontend/src/features/family-model-settings/FamilyModelSettingsDesktopView.tsx`
- Create: `frontend/src/features/family-model-settings/FamilyModelSettingsMobilePage.tsx`
- Create: `frontend/src/features/family-model-settings/ProviderProfileEditor.tsx`
- Create: `frontend/src/features/family-model-settings/CapabilityBindingEditor.tsx`
- Create: `frontend/src/features/family-model-settings/ModelPriceEditor.tsx`
- Create: `frontend/src/features/family-model-settings/SearchProfilePanel.tsx`
- Create: `frontend/src/features/family-model-settings/PublishReview.tsx`
- Create: `frontend/src/features/family-model-settings/FamilyModelSettingsEditors.test.tsx`
- Modify: `frontend/src/features/family/FamilySettings.tsx`
- Modify: `frontend/src/features/family/FamilySettings.test.tsx`
- Modify: `frontend/src/features/family/FamilyMobileView.tsx`
- Modify: `frontend/src/App.tsx`
- Create: `frontend/src/App.test.tsx`
- Create: `frontend/src/styles/15-family-model-settings.css`
- Modify: `frontend/src/styles.css`
- Create: `frontend/e2e/family-model-settings.spec.mjs`
- Modify: `frontend/e2e/fixtures/apiMocks.mjs`
- Modify: `frontend/e2e/fixtures/p0App.mjs`

**Interfaces**

- Consumes: shared contracts/hooks from Task 13 and backend validation/search states from Tasks 5, 11 and 12.
- Produces: Owner-only “AI 服务” entry, a lazily loaded independent workspace, distinct desktop and phone views and
  complete visible states for overview/provider/capability/price/search/review tasks.
- `FamilySettings.tsx` only renders the navigation entry. It does not own settings queries, form state or overlays.

- [ ] **Step 1: Add entry and composition tests for Owner/Member authorization.**

```typescript
it('shows AI 服务 beside 模型用量 only to Owner', () => {
  renderFamily({ role: 'Owner' });
  expect(screen.getByRole('button', { name: 'AI 服务' })).toBeVisible();
  expect(screen.getByRole('button', { name: '模型用量' })).toBeVisible();
});

it('does not mount the settings workspace for a Member with persisted aiServices state', () => {
  seedNavigation({ familyView: 'aiServices' });
  renderApp({ role: 'Member' });
  expect(familyModelSettingsApi.getSettings).not.toHaveBeenCalled();
  expect(screen.queryByText('家庭 AI 服务')).not.toBeInTheDocument();
});
```

In `App.tsx`, lazy-load the workspace only for `isOwner && family.view === 'aiServices'`; otherwise render the normal
family profile. Back returns to `family.profile`. Do not add settings data to `App.tsx` props or global workspace query.

- [ ] **Step 2: Add workspace phase tests and implement hook-only composition.**

```tsx
export function FamilyModelSettingsWorkspace(props: FamilyModelSettingsWorkspaceProps) {
  const queries = useFamilyModelSettingsQueries(props);
  const state = useFamilyModelSettingsState(queries);
  const actions = useFamilyModelSettingsActions({ ...props, queries, state });

  return props.isPhoneViewport
    ? <FamilyModelSettingsMobilePage model={state.model} actions={actions} />
    : <FamilyModelSettingsDesktopView model={state.model} actions={actions} />;
}
```

Tests cover initial loading, first-time empty state, ready, stale refresh warning, forbidden-safe fallback, validation
errors, publish conflict, busy and search provisioning/failed. Retry preserves non-secret edits already in React state.

- [ ] **Step 3: Implement the desktop/tablet information architecture.**

Desktop uses a restrained section sidebar and one main editor card for 服务概览、Provider 档案、能力配置、模型价格、
搜索索引 and 发布复核. At the canonical tablet range 768–1023px it becomes a controlled-width workspace with a compact
section rail; at 1024px and above it uses the desktop composition and may reflow content inside that tier. Tablet must
not open phone-sized dialogs. The editor header exposes at most one strongest action: editing uses “检查配置”,
review uses “发布配置”. “保存草稿” and tests remain secondary.

```tsx
<main className="family-model-settings-workspace family-model-settings-desktop">
  <nav aria-label="家庭 AI 服务设置分区">...</nav>
  <section aria-labelledby="family-model-settings-title">...</section>
</main>
```

- [ ] **Step 4: Implement independent phone task pages.**

The phone surface uses a single scroll container, a compact back header and task-specific body. Provider、能力、价格、
搜索 and 复核 each open as a full-screen page; desktop JSX is not conditionally squeezed into the phone view. The
sticky footer contains only the current task's primary and secondary actions, includes
`padding-bottom: calc(12px + env(safe-area-inset-bottom))`, and remains visible with a software keyboard.

Back navigation with dirty state opens a discard confirmation. During publish/rotate/rebuild, browser back, section
back, Escape and overlay backdrop are inert until the request settles.

- [ ] **Step 5: Add Provider editor tests and implement write-only Key behavior.**

```tsx
<input
  type="password"
  value={form.apiKey}
  autoComplete="new-password"
  placeholder={mode === 'rotate' ? '输入同一服务范围的新 API Key' : '输入 API Key'}
  onChange={(event) => onChange({ ...form, apiKey: event.target.value })}
/>
```

The UI never shows, copies or restores the old Key. Existing-profile edit exposes only name/status/scope-external
options; endpoint、adapter、auth、workspace、region and project are read-only with “更换服务地址或账号需要创建新档案”.
That action opens a create-and-rebind flow requiring endpoint B and its write-only Key B in the same create request;
only after creation succeeds does the draft bind capabilities to the new profile. Key rotation is a separate modal and
states that it is valid only for the existing service scope. Tests assert endpoint fields never reach PATCH, endpoint A/
key B and endpoint B/key A cannot be constructed, and a scope-change backend error preserves the form for recovery.

After a successful create/rotation it clears the controlled value before query invalidation. Connection check clearly
distinguishes “安全检查已通过” from “尚未执行真实调用”. A real capability test shows the expected meter and requires a
separate “我确认本次测试可能产生费用” checkbox.

- [ ] **Step 6: Add capability and price editor tests.**

Render all seven controlled capability editors from registry options. Provider choices are filtered by adapter support;
unsupported combinations cannot be submitted. Active Embedding adapter/Base URL/model/dimensions/distance/builder
identity is read-only with the message “更换这些设置需要完整重建搜索索引”; selecting a newly created Provider with a
different endpoint for Embedding enters replacement rather than normal publish. Same-scope Key rotation and Rerank remain editable.

Price rows use user-facing units such as 每 100 万 Token、每 1 千字符、每分钟 and 每张图片, while payload conversion
uses exact string unit quantities. Zero price is allowed and shows “零价格不会消耗成本预算，请同时设置用量上限”.

- [ ] **Step 7: Add publish-review tests and implement checksum-bound confirmations.**

`PublishReview` lists enabled/disabled capabilities, provider display name, model, full price coverage and search impact.
The first publish requests current password. Publish is disabled until the displayed `config_checksum` and
`price_checksum` still match the validation response. Editing any field exits review and invalidates the prior
confirmation locally.

```typescript
expect(screen.getByRole('button', { name: '发布配置' })).toBeDisabled();
await user.type(screen.getByLabelText('当前密码'), 'owner-password');
await user.click(screen.getByLabelText('我已核对能力、价格和搜索影响'));
expect(screen.getByRole('button', { name: '发布配置' })).toBeEnabled();
```

- [ ] **Step 8: Add search replacement, progress and recovery tests.**

The replacement confirmation shows document count, minimum/conservative estimated cost, candidate Embedding identity
and explicit “完整重建期间继续使用当前搜索索引”. It requires password and checksum. Default focus lands on “取消”, not
the dangerous button. Progress is announced through a polite live region; failed state offers retry/cancel, cancelled
state explains retention cleanup, and activation success refreshes settings/search/usage without erasing unrelated
draft edits.

- [ ] **Step 9: Implement canonical business CSS and import order.**

Use `--bg`, `--surface-2`, `--accent`, `--text`, `--line-soft`, `--radius-md`, `--control-height` and
`--control-height-touch`; do not add near-duplicate colors, radii or shadows. Touch targets are at least 48px on phone,
focus-visible is never removed, error/disabled/busy do not rely on color alone, and long Base URLs/model names wrap.

Import `15-family-model-settings.css` after `14-model-usage.css` and before the final `07-mobile.css`. Keep selectors
under `.family-model-settings-*` and use media/container rules local to this workspace.

- [ ] **Step 10: Add P0 browser journeys at the fixed project viewports.**

```javascript
const VIEWPORTS = [
  { name: 'phone-small', width: 375, height: 812 },
  { name: 'phone-medium', width: 390, height: 844 },
  { name: 'phone-large', width: 430, height: 932 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
];
```

Mock responses contain no Key. Cover Owner entry, create Provider, edit only non-scope metadata without a Key field,
create-and-rebind for an endpoint change, bind seven capabilities, enter prices, validate/review/publish, rotate a
same-scope Key, start replacement, show progress and retry a failure.
Also cover Member entry absence, no Owner requests, focus order, Escape/backdrop, phone scroll ownership and sticky
footer. Tag the critical Owner publish and Member privacy journeys `@p0`.

- [ ] **Step 11: Run component, style and browser validation.**

Run: `npm --prefix frontend run test -- src/App.test.tsx src/features/family/FamilySettings.test.tsx src/features/family-model-settings/FamilyModelSettingsWorkspace.test.tsx src/features/family-model-settings/FamilyModelSettingsEditors.test.tsx`

Run: `npm run frontend:typecheck && npm --prefix frontend run check:style-tokens && npm --prefix frontend exec playwright test e2e/family-model-settings.spec.mjs && npm run frontend:build && git diff --check`

Expected: PASS at 375×812, 390×844, 430×932, 768×1024, 1024×768 and 1440×900. Manually review style-token additions
and screenshots at all six viewports; verify phone keyboard, safe area, focus restore, unique scroll container and busy
overlay dismissal, plus tablet portrait/landscape layout and touch targets.

- [ ] **Step 12: Create the review checkpoint.**

```bash
git add frontend/src/features/family-model-settings/FamilyModelSettingsWorkspace.tsx frontend/src/features/family-model-settings/FamilyModelSettingsWorkspace.test.tsx frontend/src/features/family-model-settings/FamilyModelSettingsDesktopView.tsx frontend/src/features/family-model-settings/FamilyModelSettingsMobilePage.tsx frontend/src/features/family-model-settings/ProviderProfileEditor.tsx frontend/src/features/family-model-settings/CapabilityBindingEditor.tsx frontend/src/features/family-model-settings/ModelPriceEditor.tsx frontend/src/features/family-model-settings/SearchProfilePanel.tsx frontend/src/features/family-model-settings/PublishReview.tsx frontend/src/features/family-model-settings/FamilyModelSettingsEditors.test.tsx frontend/src/features/family/FamilySettings.tsx frontend/src/features/family/FamilySettings.test.tsx frontend/src/features/family/FamilyMobileView.tsx frontend/src/App.tsx frontend/src/App.test.tsx frontend/src/styles/15-family-model-settings.css frontend/src/styles.css frontend/e2e/family-model-settings.spec.mjs frontend/e2e/fixtures/apiMocks.mjs frontend/e2e/fixtures/p0App.mjs
git commit -m "feat: add family ai services workspace"
```

Only run the commit command when the user has explicitly authorized commits.
## Task 15: Remove legacy Provider environment configuration and perform the fail-closed cutover

**Files**

- Modify: `backend/app/core/config.py`
- Create: `backend/app/services/search/constants.py`
- Modify: `backend/app/services/search/hybrid.py`
- Modify: `backend/app/services/search/rerank.py`
- Modify: `backend/tests/conftest.py`
- Modify: `backend/tests/core/test_search_config.py`
- Create: `backend/tests/core/test_no_legacy_provider_settings.py`
- Create: `backend/tests/search/test_search_constants.py`
- Modify: `backend/.env.example`
- Modify: `deploy/.env.example`
- Modify: `deploy/docker-compose.yml`
- Modify: `README.md`

**Interfaces**

- Consumes: database-backed runtime resolution from Tasks 7–12 and the security/infrastructure settings introduced in
  Tasks 2–3, 11–12.
- Produces: one fail-closed runtime with no model Provider `.env` fields, no compatibility fallback and documented
  deployment-only credential/network/Qdrant/limit settings.
- Do not edit, inspect, delete or commit developers' actual `backend/.env` or `deploy/.env`; after this task legacy
  Provider names in those ignored files have no runtime effect. Only tracked examples and Compose wiring change.

- [ ] **Step 1: Add a denylist test for every removed Settings field and environment name.**

```python
LEGACY_PROVIDER_SETTINGS = {
    "ai_provider", "ai_api_base", "ai_api_key", "ai_model",
    "ai_max_output_tokens", "ai_fallback_model", "ai_fallback_max_output_tokens",
    "ai_supports_vision", "ai_timeout_seconds", "ai_prompt_cache_enabled",
    "ai_image_reference_provider", "ai_image_reference_api_base",
    "ai_image_reference_api_key", "ai_image_reference_model",
    "ai_image_text_provider", "ai_image_text_api_base",
    "ai_image_text_api_key", "ai_image_text_model", "ai_audio_enabled",
    "ai_stt_provider", "ai_stt_api_base", "ai_stt_api_key", "ai_stt_model",
    "ai_stt_language_hint", "ai_stt_audio_format", "ai_stt_sample_rate", "ai_stt_hotwords",
    "ai_stt_timeout_seconds", "ai_stt_max_upload_bytes", "ai_stt_max_duration_seconds",
    "ai_tts_provider", "ai_tts_api_base", "ai_tts_api_key", "ai_tts_model",
    "ai_tts_voice", "ai_tts_format", "ai_tts_sample_rate", "ai_tts_language_type",
    "ai_tts_streaming", "ai_tts_timeout_seconds", "ai_realtime_provider", "ai_realtime_api_base",
    "ai_realtime_api_key", "ai_realtime_model", "ai_realtime_voice",
    "ai_realtime_audio_format", "ai_realtime_input_sample_rate",
    "ai_realtime_output_sample_rate", "ai_realtime_vad_silence_ms",
    "ai_realtime_timeout_seconds", "ai_realtime_tts_max_characters",
    "dashscope_api_key", "dashscope_workspace_id", "dashscope_region",
    "dashscope_http_api_base", "dashscope_websocket_api_base",
    "search_embedding_provider", "search_embedding_api_base", "search_embedding_api_key",
    "search_embedding_model", "search_embedding_dimensions", "search_embedding_timeout_seconds",
    "search_rerank_provider", "search_rerank_api_base", "search_rerank_api_key",
    "search_rerank_model", "search_rerank_timeout_seconds", "search_rerank_instruct",
    "search_semantic_min_score", "search_rerank_min_score",
    "search_literal_fallback_min_score", "search_rerank_candidate_limit",
    "qdrant_collection",
}

def test_settings_has_no_legacy_provider_fields() -> None:
    assert LEGACY_PROVIDER_SETTINGS.isdisjoint(Settings.model_fields)
```

The test scans `backend/app` for `settings.<legacy_field>`, direct `os.getenv`/`environ` access and legacy constructor
parameters. It separately scans `deploy/docker-compose.yml`, both tracked backend/deploy env examples and `README.md`
for exact uppercase environment names. The denylist may appear only inside this regression test and historical
design/plan docs; tested search constants such as `SEARCH_RERANK_INSTRUCTION` are not environment reads.

- [ ] **Step 2: Add a runtime test proving legacy environment variables are ignored.**

```python
def test_legacy_provider_environment_cannot_enable_runtime(monkeypatch) -> None:
    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_API_KEY", "must-not-be-read")
    monkeypatch.setenv("AI_MODEL", "must-not-be-read")
    monkeypatch.setenv("SEARCH_EMBEDDING_PROVIDER", "openai")
    settings = Settings(_env_file=None)
    assert not hasattr(settings, "ai_provider")
    assert not hasattr(settings, "search_embedding_provider")
```

Create an unconfigured family under this environment and assert `/api/ai/status` is `not_configured`, LLM/image/audio
dispatch does not construct a transport, and search remains keyword-only until the family publishes Embedding.

- [ ] **Step 3: Remove all Provider/model/default-option fields from `Settings`.**

Delete the legacy fields, their validators and search-provider startup requirements. Remove provider-specific timeouts
already superseded by `family_model_provider_*`. Rename the safety-only limits so their deployment purpose is explicit:

```python
family_model_audio_upload_max_bytes: int = 10 * 1024 * 1024
family_model_stt_max_duration_seconds: int = 60
family_model_tts_max_characters: int = 4096
family_model_realtime_session_max_seconds: int = 300
family_model_qdrant_collection_prefix: str = "culina_fsp"
family_model_retired_collection_retention_days: int = 7
```

Keep database/JWT/MinIO/logging, AI trace limits, `MODEL_USAGE_*`, family credential keyring, private-target allowlist,
egress proxy, provider connection/response/media limits, Qdrant URL/API key/timeout and fixed platform search backend
selection. Production validation requires the credential keyring but never a family Provider key.

- [ ] **Step 4: Move fixed search instruction and scoring parameters into tested code constants.**

```python
SEARCH_RERANK_INSTRUCTION = (
    "你是中文厨房搜索结果重排器。目标是找出与查询词最直接匹配的食材、食物或菜谱。"
    "短查询优先按字面匹配排序：名称完全相同 > 名称、别名或关键词包含查询词 > "
    "语义相关但未字面命中 > 无关、测试或占位数据。"
)
SEARCH_SEMANTIC_MIN_SCORE = 0.48
SEARCH_RERANK_MIN_SCORE = 0.58
SEARCH_LITERAL_FALLBACK_MIN_SCORE = 0.70
SEARCH_RERANK_CANDIDATE_LIMIT = 50
```

Tests lock the values and exercise threshold behavior. These constants are not Owner-editable and are no longer
overridden by `SEARCH_RERANK_INSTRUCT` or scoring environment variables.

- [ ] **Step 5: Remove test-suite environment defaults and require explicit family fixtures.**

Delete `SEARCH_EMBEDDING_PROVIDER`, `SEARCH_RERANK_PROVIDER`, model/dimensions and Provider-key setup from
`backend/tests/conftest.py`. Provider tests use `_support.py` family profiles/revisions/prices plus fake transports.
Rewrite `test_search_config.py` to cover only retained Qdrant/platform safety validation and collection-prefix syntax.
No test may obtain credentials from the developer process environment.

- [ ] **Step 6: Replace tracked env examples with deployment-only settings.**

Remove all categories listed in specification section 20.1 from `backend/.env.example`, `deploy/.env.example` and the
backend Compose environment. Add documented placeholders for:

```dotenv
FAMILY_MODEL_CREDENTIAL_ACTIVE_KEY_ID=
FAMILY_MODEL_CREDENTIAL_KEYS_JSON=
FAMILY_MODEL_REVOKED_SECRET_RETENTION_HOURS=24
FAMILY_MODEL_PRIVATE_TARGET_ALLOWLIST_JSON={"http":[],"websocket":[]}
FAMILY_MODEL_EGRESS_PROXY_URL=
FAMILY_MODEL_PROVIDER_CONNECT_TIMEOUT_SECONDS=10
FAMILY_MODEL_PROVIDER_REQUEST_TIMEOUT_SECONDS=180
FAMILY_MODEL_PROVIDER_RESPONSE_MAX_BYTES=8388608
FAMILY_MODEL_PROVIDER_MEDIA_MAX_BYTES=31457280
FAMILY_MODEL_PROVIDER_REDIRECT_LIMIT=0
FAMILY_MODEL_AUDIO_UPLOAD_MAX_BYTES=10485760
FAMILY_MODEL_STT_MAX_DURATION_SECONDS=60
FAMILY_MODEL_TTS_MAX_CHARACTERS=4096
FAMILY_MODEL_REALTIME_SESSION_MAX_SECONDS=300
FAMILY_MODEL_QDRANT_COLLECTION_PREFIX=culina_fsp
FAMILY_MODEL_RETIRED_COLLECTION_RETENTION_DAYS=7
```

Examples explain that the credential keyring is a deployment secret and must use base64-encoded independent 32-byte
keys. Do not place an operational key in examples. Compose passes these values through but does not synthesize a
production key or Provider fallback.

- [ ] **Step 7: Update startup documentation for Owner configuration.**

README local setup lists only infrastructure and security environment variables. Replace “AI provider 默认可保持
disabled” with: initialize the database, sign in as Owner, open 家庭 → AI 服务, create Provider profiles, configure all
needed capabilities and prices, validate, then publish. State clearly that existing legacy `.env` Provider values are
ignored and are not imported.

- [ ] **Step 8: Run cutover source, config and fail-closed tests.**

Run: `cd backend && .venv/bin/python -m pytest tests/core/test_search_config.py tests/core/test_no_legacy_provider_settings.py tests/search/test_search_constants.py tests/family_model_settings/test_member_status.py tests/family_model_settings/test_family_image_runtime.py tests/family_model_settings/test_family_audio_runtime.py tests/search/test_family_search_resolution.py -q`

Run: `rg -n '\b(?:AI_(?:PROVIDER|API_BASE|API_KEY|MODEL|MAX_OUTPUT_TOKENS|FALLBACK_MODEL|FALLBACK_MAX_OUTPUT_TOKENS|SUPPORTS_VISION|TIMEOUT_SECONDS|PROMPT_CACHE_ENABLED|AUDIO_ENABLED)|AI_IMAGE_(?:REFERENCE|TEXT)_(?:PROVIDER|API_BASE|API_KEY|MODEL)|AI_(?:STT|TTS|REALTIME)_(?:PROVIDER|API_BASE|API_KEY|MODEL|LANGUAGE_HINT|AUDIO_FORMAT|SAMPLE_RATE|HOTWORDS|TIMEOUT_SECONDS|MAX_UPLOAD_BYTES|MAX_DURATION_SECONDS|VOICE|FORMAT|LANGUAGE_TYPE|STREAMING|INPUT_SAMPLE_RATE|OUTPUT_SAMPLE_RATE|VAD_SILENCE_MS|TTS_MAX_CHARACTERS)|DASHSCOPE_(?:API_KEY|WORKSPACE_ID|REGION|HTTP_API_BASE|WEBSOCKET_API_BASE)|SEARCH_(?:EMBEDDING|RERANK)_(?:PROVIDER|API_BASE|API_KEY|MODEL|DIMENSIONS|TIMEOUT_SECONDS|INSTRUCT)|SEARCH_(?:SEMANTIC_MIN_SCORE|RERANK_MIN_SCORE|LITERAL_FALLBACK_MIN_SCORE|RERANK_CANDIDATE_LIMIT)|QDRANT_COLLECTION)\b' backend/.env.example deploy/.env.example deploy/docker-compose.yml README.md`

Expected: pytest PASS; `rg` returns no matches. Then run `git diff --check`.

- [ ] **Step 9: Create the review checkpoint.**

```bash
git add backend/app/core/config.py backend/app/services/search/constants.py backend/app/services/search/hybrid.py backend/app/services/search/rerank.py backend/tests/conftest.py backend/tests/core/test_search_config.py backend/tests/core/test_no_legacy_provider_settings.py backend/tests/search/test_search_constants.py backend/.env.example deploy/.env.example deploy/docker-compose.yml README.md
git commit -m "refactor: remove model provider environment config"
```

Only run the commit command when the user has explicitly authorized commits.

## Task 16: Protocol acceptance, migration and full release verification

**Files**

- Create: `backend/tests/family_model_settings/fake_provider.py`
- Create: `backend/tests/family_model_settings/test_protocol_acceptance.py`
- Create: `backend/tests/family_model_settings/test_cutover_acceptance.py`
- Modify: `frontend/e2e/family-model-settings.spec.mjs`
- Modify: `frontend/e2e/fixtures/apiMocks.mjs`

**Interfaces**

- Consumes: the complete Tasks 1–15 implementation.
- Produces: a deterministic local fake-provider protocol gate, cross-family acceptance coverage and the final evidence
  that all seven capabilities ship together without Provider environment variables.
- No test reaches the public Internet or reads a real Key. The fake provider binds only to the test process and is
  admitted through an explicit test-only private-target allowlist.

- [ ] **Step 1: Build a protocol-faithful fake provider with secret markers.**

```python
@dataclass
class FakeProviderRequest:
    protocol: str
    path: str
    authorization: str | None
    model: str | None
    body: dict[str, object] | bytes

class FakeFamilyModelProvider:
    def requests_for(self, secret_marker: str) -> list[FakeProviderRequest]: ...
```

Support OpenAI-compatible chat/responses, images, transcription, speech, embeddings and rerank, plus realtime
WebSocket frames and the DashScope HTTP/realtime shapes declared by the adapter registry. Return deterministic usage,
stream chunks, media URLs/bytes, provider request IDs, retryable errors and uncertain timeouts. Captured secret markers
stay inside the test helper and are never logged or serialized by application code.

- [ ] **Step 2: Add one end-to-end acceptance case for all seven capability paths.**

```python
@pytest.mark.parametrize("capability,variant", [
    ("llm", "primary"),
    ("image_generation", "text"),
    ("stt", "default"),
    ("tts", "default"),
    ("realtime_audio", "default"),
    ("embedding", "search"),
    ("rerank", "search"),
])
def test_published_family_dispatches_each_capability_through_its_snapshot(
    configured_family, fake_provider, capability, variant
) -> None:
    result = dispatch_real_family_operation(configured_family, capability, variant)
    assert result.completed_or_streamed
    assert exactly_one_settled_usage_event(configured_family.id, capability)
    assert fake_provider.requests_for(configured_family.secret_marker)
```

For each path assert reservation price snapshot, config revision, profile version and credential secret version. LLM
also asserts the persisted `AIRunLLMExchange` has `config_revision_id`, `provider_profile_id` and
`provider_profile_version_id`, while a migrated historical exchange with NULL identities remains readable. Image
and audio jobs survive worker/session reconstruction; Embedding writes only its profile collection; Rerank cannot see
another family's candidates.

- [ ] **Step 3: Add a two-family isolation and rotation/repricing scenario.**

Create Family A and B with different endpoints, secret markers, models, dimensions and prices. Dispatch concurrently,
rotate A's Key, publish A's new price, start an A search replacement and update A's LLM during rebuild. Assert:

- neither fake provider receives the other family's marker/model/content;
- old authorized A dispatch keeps the old secret/price, new dispatch uses the new secret/price;
- rotating a Key within endpoint A never changes endpoint identity; changing to endpoint B creates profile B with key B
  and publishes the new binding, and captured requests never contain endpoint A/key B or endpoint B/key A;
- B revision, price, jobs and Qdrant collection remain unchanged;
- A activation replaces only Embedding in the switch-time config and price;
- a price-only publish immediately changes later active Embedding query and incremental-index reservations without
  changing the active search profile; already-created jobs keep their old config/price snapshot;
- old and new usage events retain their original snapshots.

- [ ] **Step 4: Add fail-closed, privacy and crash-replay acceptance cases.**

Without an active revision, all capabilities return stable not-configured/keyword fallback behavior and fake-provider
request count stays zero. A Member cannot call any Owner route and Member status/request logs contain no provider,
model, URL, profile, price, credential or secret-marker key/value. The personal model-usage API rejects Owner-only
group/filter inputs structurally, and family-to-me UI switching sends neither provider nor model filters.

Replay process-crash/response-loss boundaries for publish, price publish, rotate, billable test, search replacement and
first dispatch. After a successful commit advances versions, the same key/fingerprint still returns the completed
receipt; same key/different fingerprint conflicts, and there is at most one external send/business result.

Commit a first-publish/replacement transaction and terminate before any in-process enqueue, then restart the resource
worker and prove it creates the exact collection and missing jobs. Repeat crashes after external ensure/delete but
before operation completion. Delete a family after writing cleanup tombstones and prove collection deletion can finish
after profile/Family cascade removed the live rows. Finally, race two MySQL Owners on the same draft base version,
including first creation, and prove only one write advances.

- [ ] **Step 5: Expand the browser acceptance journey with server conflict and recovery states.**

Add cases for stale draft/publish conflict, background refresh failure with retained data, hard-limit blocked test,
failed/cancelled search rebuild and successful retry/activation. Inspect all request bodies and browser storage: Key is
present only in its intended create/rotate request, cleared afterward, and absent from local/session storage, query
fixtures, screenshots and accessible error text.

Add Provider scope-change UI coverage: editing endpoint/auth opens create-and-rebind, never PATCHes the existing
profile, and requires the new Key in the new-profile request. Add model-usage coverage that selects `provider_model` and
provider/model filters in family scope, switches to “我的”, then asserts group resets to `capability`, filters are
cleared, no personal 422 occurs and no diagnostic identity remains in the DOM.

- [ ] **Step 6: Validate the migration on MySQL from the previous head.**

Run: `npm run db:up`

Run: `cd backend && CULINA_TEST_MYSQL_URL="$CULINA_TEST_MYSQL_URL" .venv/bin/python -m pytest tests/family_model_settings/test_migration_mysql.py tests/family_model_settings/test_draft_mysql_concurrency.py tests/family_model_settings/test_publishing_mysql_concurrency.py tests/family_model_settings/test_search_activation_mysql_concurrency.py tests/model_usage/test_realtime_audio_mysql.py tests/model_usage/test_embedding_mysql_handoff.py -q`

Run: `npm run backend:migrate && cd backend && .venv/bin/alembic heads && .venv/bin/alembic current`

Expected: migration from `5f6a7b8c9d0e` to the single new head succeeds; every existing family receives exactly one
settings lock row whose active pointers remain NULL, resource tombstones do not cascade with Family/profile, exchange
snapshot columns are present, foreign keys/checks are present and no `.env` value is imported. Record an environment gap if
`CULINA_TEST_MYSQL_URL` or Docker is unavailable; do not substitute SQLite for these concurrency/migration claims.

- [ ] **Step 7: Run backend protocol, focused and full quality gates.**

Run: `cd backend && .venv/bin/python -m pytest tests/family_model_settings/test_protocol_acceptance.py tests/family_model_settings/test_cutover_acceptance.py -q`

Run: `npm run backend:model-usage:send-coverage && npm run backend:quality`

Run: `npm run backend:test:ai-evals && npm run backend:check:ai-evals`

Expected: PASS; no outbound-network attempt outside the fake transport, all seven capability adapters are covered,
full pytest passes and AI eval thresholds remain satisfied.

- [ ] **Step 8: Run frontend quality, build, style and all P0 browser gates.**

Run: `npm run frontend:quality && npm run frontend:build && npm run frontend:e2e:p0`

Run: `npm --prefix frontend exec playwright test e2e/family-model-settings.spec.mjs`

Expected: typecheck, Vitest, token-drift report review, production bundle and P0 tests PASS. Manually inspect 375×812,
390×844, 430×932, 768×1024, 1024×768 and 1440×900 for entry visibility, keyboard/safe area, sticky actions, focus
restoration, long values, loading/error/busy states and search progress. A zero-exit style report still requires
reviewing every new hit.

- [ ] **Step 9: Run final security and scope inventories.**

Run: `rg -n 'TODO|TBD|implement later|pass #|NotImplementedError' backend/app/services/family_model_settings frontend/src/features/family-model-settings`

Run: `rg -n '\b(?:AI_(?:PROVIDER|API_BASE|API_KEY|MODEL|MAX_OUTPUT_TOKENS|FALLBACK_MODEL|FALLBACK_MAX_OUTPUT_TOKENS|SUPPORTS_VISION|TIMEOUT_SECONDS|PROMPT_CACHE_ENABLED|AUDIO_ENABLED)|AI_IMAGE_(?:REFERENCE|TEXT)_(?:PROVIDER|API_BASE|API_KEY|MODEL)|AI_(?:STT|TTS|REALTIME)_(?:PROVIDER|API_BASE|API_KEY|MODEL|LANGUAGE_HINT|AUDIO_FORMAT|SAMPLE_RATE|HOTWORDS|TIMEOUT_SECONDS|MAX_UPLOAD_BYTES|MAX_DURATION_SECONDS|VOICE|FORMAT|LANGUAGE_TYPE|STREAMING|INPUT_SAMPLE_RATE|OUTPUT_SAMPLE_RATE|VAD_SILENCE_MS|TTS_MAX_CHARACTERS)|DASHSCOPE_(?:API_KEY|WORKSPACE_ID|REGION|HTTP_API_BASE|WEBSOCKET_API_BASE)|SEARCH_(?:EMBEDDING|RERANK)_(?:PROVIDER|API_BASE|API_KEY|MODEL|DIMENSIONS|TIMEOUT_SECONDS|INSTRUCT)|SEARCH_(?:SEMANTIC_MIN_SCORE|RERANK_MIN_SCORE|LITERAL_FALLBACK_MIN_SCORE|RERANK_CANDIDATE_LIMIT)|QDRANT_COLLECTION)\b' backend/.env.example deploy/.env.example deploy/docker-compose.yml README.md`

Run: `git diff --check && git status --short`

Expected: both source inventories return no matches; `test_no_legacy_provider_settings.py` separately proves runtime
source and `Settings` contain no legacy reads. Diff check passes; status contains only files intentionally listed
by Tasks 1–16. Review API examples, logs, traces and browser fixtures for secret markers and Member-forbidden identity.

- [ ] **Step 10: Perform the release checklist.**

Confirm all 13 acceptance criteria in specification section 25 with links to the exact tests/commands. Verify one
Alembic head, seven-capability registry coverage, no partial feature flag, no runtime `.env` fallback and no migration
of old Provider values. Do not announce the feature ready if any capability, privacy boundary, MySQL concurrency gate,
mobile viewport or fake-provider protocol case is missing.

- [ ] **Step 11: Create the final review checkpoint.**

```bash
git add backend/tests/family_model_settings/fake_provider.py backend/tests/family_model_settings/test_protocol_acceptance.py backend/tests/family_model_settings/test_cutover_acceptance.py frontend/e2e/family-model-settings.spec.mjs frontend/e2e/fixtures/apiMocks.mjs
git commit -m "test: verify family model settings cutover"
```

Only run the commit command when the user has explicitly authorized commits.

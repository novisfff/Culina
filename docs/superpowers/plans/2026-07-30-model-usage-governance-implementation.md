# Culina Model Usage Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Culina 首次正式开放前，一次性实现覆盖 LLM/视觉、Embedding、Rerank、STT、TTS、Realtime audio 与图片生成的统一用量账本、个人/家庭统计、预算提醒、hard limit、恢复补偿、长期聚合和移动优先管理界面。

**Architecture:** 后端以不可变价格/策略版本、强一致 reservation/counter、不可变 event/adjustment 和长期 rollup 为核心；七类 adapter 只负责估算、dispatch 前授权、provider usage 归一化和结算。所有 provider 调用都通过独立用量事务，业务事务失败不会撤销已经发生的费用。当前月 API 读取 counter 与原始账本，历史月读取 rollup；FastAPI lifespan 内的 maintenance worker 承担 uncertain、incident、alert、audit、rollup 和 retention。前端在家庭工作区内提供独立模型用量子页面，并把后台任务与预算提醒合并为可辨识通知联合。

**Tech Stack:** Python 3.12、FastAPI、SQLAlchemy 2、Alembic、MySQL 8.4、Pydantic 2、httpx/OpenAI SDK/WebSocket、pytest；React 18、TypeScript 5.7、React Query 5、Vitest、Testing Library、Playwright、Culina UI kit 与 canonical CSS tokens。

## Global Constraints

- 本计划以 `docs/superpowers/specs/2026-07-29-model-usage-governance-design.md` 为产品与架构真相源；实现发现冲突时先更新规格并取得复核，不在代码里静默改变保证。
- 系统尚未上线，因此使用一次性全量首发；不实现 allowlist、灰度、双写、shadow、cohort 或按能力分批开放。
- 七类 capability 必须同一制品、同一 Alembic head、同一 preflight 通过后才能开放；任何真实远程发送点都不能绕过 adapter。
- `recovery_mode=none` 的 provider 不宣称 exactly-once、不自动重发 ambiguous attempt；24 小时后的 unknown/estimated 是额度治理的保守事实，不是 provider 已确认费用。
- 当前实现中的 OpenAI、DashScope、兼容 HTTP 和 WebSocket provider 首发全部按 `recovery_mode=none` 注册，除非实施时同时加入可执行的幂等或预持久化 client ID 查询 contract、provider 依据和正数窗口测试。仅返回事后 request ID 不得升级 recovery mode。
- 金额内部统一 `Decimal`/`Numeric(30,12)`；价格/FX/exact line 使用 `ROUND_HALF_UP`，reservation line 使用 `ROUND_CEILING`，预算比较不先舍入到分。数量使用 `Numeric(30,6)`；Token、字符、请求和图片在 service 层验证为整数。
- `total_tokens` 默认 informational；每个 billing scheme 只有一个不重叠 billable meter 集合。固定费使用 `request_units=1`；priced event 总成本只能等于 billable meter line 成本之和。
- Meter 的 `guardrail_eligible` 治理属性与 billable/informational 定价角色正交；被选 capability meter 必须在所有 active variant 上可保守预留和结算。Monitoring 的 unpriced/informational quantity 仍进入 meter counter，不能因为没有 cost 而丢失软状态。
- 每个 reservation 保存该 active variant 的完整 contract-required 可治理 quantity，不只保存 admission policy 当时选中的 guardrail/billable set。首次 dispatch 因而可以重验新选 current guardrail；旧版或不完整 reservation 缺少所需 quantity 时 fail-closed 并释放，不能把缺失当成零。
- Strong counter 的维护不依赖 policy 当前选择：始终维护 family cost、七类 capability cost，以及每个 active variant 可产出的 `guardrail_eligible` capability meter。策略切换读取已经完整的 counter，不能让新选 guardrail 从零开始；新增 variant/meter dimension 必须先按 ledger backfill/audit，再由 preflight 暴露。
- 数据库强制 reservation/event `(family_id, attempt_key)` 和 adjustment group `(family_id, idempotency_key)` 唯一；所有唯一 claim loser 都先回滚 claim/savepoint，再锁 winner 复核 fingerprint，不能依赖 service 层先查后写。这些约束只证明账本/counter 单 winner，不被用来宣称 fail-open 外部 provider exactly-once。
- 普通 reservation 的最终 provider-send 授权在首次 `reserved → dispatching` 事务中按 current policy 重验并保存 `dispatch_policy_version_id`；策略更新与该事务锁同一个 family policy pointer。已经 dispatching 的 attempt 不撤销，但 replay 也不重新签发 `first_send`；只有显式 recovery 在 provider 幂等窗口内才可得到 `idempotent_resend`。短时、单次 monitoring fail-open proof 是明确披露的并发例外。
- 用量 service 使用自己的 `SessionLocal` 短事务，不提交或回滚调用方业务 session；provider 已执行但 MinIO、Qdrant、业务保存或响应失败时仍须结算。
- 账本、receipt、日志、API 和 CLI 不保存 prompt、response、query、文档、转写、TTS 文本、图片提示词、媒体 URL、user ID receipt 字段或凭据。测试使用秘密标记扫描这些边界。
- 普通成员响应 schema 本身不包含家庭金额、百分比、其他成员、system、limit 数值或 Owner alert 字段；禁止只返回 `null` 来掩盖越权字段。
- 所有 checkbox 是一个 2–5 分钟动作。若一个符号实现超过 5 分钟，停在当前列出的函数/类边界，先运行该步骤的 focused test，再继续下一 checkbox。
- 每个 Task 按红—绿—重构执行并单独提交。不得使用 `git add -A`；只暂存 Task 列出的文件。工作区存在无关修改时保留并绕开。
- MySQL 专项测试在本地缺少 `CULINA_TEST_MYSQL_URL` 时可以 skip，但 skip 不能作为首发门禁通过证据；CI/验收环境必须使用以 `_test` 结尾的 MySQL 8.4 数据库。
- 每个任务结束都运行 `git diff --check`。最终 Task 再执行全量后端、前端、migration、真实视口与七类 provider smoke。

## Dependency Map

```mermaid
flowchart LR
    A["1. Vocabulary and math"] --> B["2. Schema and migration"]
    B --> C["3. Price catalog"]
    B --> D["4. Subjects and policy"]
    C --> E["5. Reserve and counters"]
    D --> E
    E --> F["6. Dispatch and settlement"]
    F --> G["7. Recovery and incidents"]
    F --> H["8. Adjustments and alerts"]
    G --> I["9. Aggregation and rollups"]
    H --> I
    I --> J["10. Worker and operations CLI"]
    J --> K["11-16. Seven capability adapters"]
    K --> L["17. Backend API"]
    L --> M["18-21. Frontend contracts, UI and notifications"]
    M --> N["22. Launch gates"]
```

## Locked Cross-Task Interfaces

这些名称在后续 Task 中是接口锁；实现者若需要改名，必须在同一提交更新所有生产代码、测试和本文后续引用。

```python
@dataclass(frozen=True, slots=True)
class UsageAttribution:
    family_id: str
    attribution_kind: ModelUsageAttributionKind
    actor_user_id: str | None
    operation_source: ModelUsageOperationSource
    logical_operation_id: str

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

@dataclass(frozen=True, slots=True)
class UsageMeterQuantity:
    meter: ModelUsageMeter
    quantity: Decimal
    meter_role: ModelUsageMeterRole
    quantity_source: ModelUsageQuantitySource

@dataclass(frozen=True, slots=True)
class UsageEstimate:
    meters: Sequence[UsageMeterQuantity]

    def quantity(self, meter: ModelUsageMeter) -> Decimal:
        return sum((line.quantity for line in self.meters if line.meter is meter), Decimal("0"))

@dataclass(frozen=True, slots=True)
class ProviderRecoveryPolicy:
    mode: ModelUsageRecoveryMode
    idempotency_window_seconds: int | None
    query_window_seconds: int | None
    automatic_resend_deadline_seconds: int | None

    @classmethod
    def none(cls) -> "ProviderRecoveryPolicy":
        return cls(
            mode=ModelUsageRecoveryMode.NONE,
            idempotency_window_seconds=None,
            query_window_seconds=None,
            automatic_resend_deadline_seconds=None,
        )

@dataclass(frozen=True, slots=True)
class ProviderMeterWatermark:
    meter: ModelUsageMeter
    lease_sequence: int
    baseline_quantity: Decimal
    cumulative_quantity: Decimal

@dataclass(frozen=True, slots=True)
class ProviderUsageReceipt:
    reservation_id: str | None
    family_id: str
    subject_key: str
    capability: ModelUsageCapability
    provider: str
    requested_model: str
    reported_model: str | None
    billing_model: str
    variant_key: str
    billing_scheme_key: str
    attempt_key: str
    fingerprint: str
    client_attempt_id: str
    policy_version_id: str
    dispatch_policy_version_id: str
    provider_request_id: str | None
    provider_outcome: ModelUsageProviderOutcome
    execution_certainty: ModelUsageExecutionCertainty
    measurement_status: ModelUsageMeasurementStatus
    pricing_status: ModelUsagePricingStatus
    period: BillingPeriod
    meters: Sequence[UsageMeterQuantity]
    meter_watermarks: Sequence[ProviderMeterWatermark]
    dispatched_at: datetime
    completed_at: datetime
    price_version_id: str | None
    price_snapshot: UsagePriceSnapshot | None
    price_snapshot_checksum: str | None
    fail_open_proof_id: str | None
    integrity_key_id: str
    integrity_hmac: str

@dataclass(frozen=True, slots=True)
class DispatchPermit:
    reservation_id: str | None
    send_kind: Literal["first_send", "idempotent_resend", "fail_open_single_send"]
    family_id: str
    subject_key: str
    capability: ModelUsageCapability
    provider: str
    requested_model: str
    billing_model: str
    variant_key: str
    billing_scheme_key: str
    attempt_key: str
    fingerprint: str
    client_attempt_id: str
    policy_version_id: str
    dispatch_policy_version_id: str
    pricing_status: ModelUsagePricingStatus
    period: BillingPeriod
    dispatched_at: datetime
    price_version_id: str | None
    price_snapshot: UsagePriceSnapshot | None
    price_snapshot_checksum: str | None
    provider_idempotency_key: str | None
    recovery_policy: ProviderRecoveryPolicy
    fail_open_proof_id: str | None = None
    expires_at: datetime | None = None

@dataclass(frozen=True, slots=True)
class ReservationDecision:
    decision: Literal["allowed", "blocked", "fail_open", "already_accounted"]
    reservation_id: str | None = None
    existing_event_id: str | None = None
    subject_key: str | None = None
    policy_version_id: str | None = None
    price_version_id: str | None = None
    pricing_status: ModelUsagePricingStatus | None = None
    reserved_cost_cny: Decimal | None = None
    fail_open_permit: DispatchPermit | None = None
    error_code: str | None = None

    @classmethod
    def blocked(cls, error_code: str) -> "ReservationDecision":
        return cls(decision="blocked", error_code=error_code)

    @classmethod
    def already_accounted(cls, event_id: str) -> "ReservationDecision":
        return cls(decision="already_accounted", existing_event_id=event_id)

@dataclass(frozen=True, slots=True)
class DispatchGateOutcome:
    decision: Literal["allowed", "blocked", "recovery_required"]
    permit: DispatchPermit | None = None
    existing_dispatch_id: str | None = None
    error_code: str | None = None

    def require_first_send_permit(self) -> DispatchPermit:
        if self.permit is None:
            if self.decision == "recovery_required":
                raise ModelUsageDispatchRecoveryRequired("model_usage_dispatch_recovery_required")
            raise ModelUsageBlocked(require_value(self.error_code))
        if self.permit.send_kind != "first_send":
            raise ModelUsageContractError("first_send_permit_required")
        return self.permit

@dataclass(frozen=True, slots=True)
class UsageSettlement:
    event_id: str
    reservation_id: str | None
    measurement_status: ModelUsageMeasurementStatus
    pricing_status: ModelUsagePricingStatus
    execution_certainty: ModelUsageExecutionCertainty
    cost_cny: Decimal | None
    meters: Sequence[UsageMeterQuantity]
    billable_line_costs: Sequence[Decimal]

    def quantity(self, meter: ModelUsageMeter) -> Decimal:
        return sum((line.quantity for line in self.meters if line.meter is meter), Decimal("0"))

    def informational_quantity(self, meter: ModelUsageMeter) -> Decimal:
        return sum(
            (
                line.quantity
                for line in self.meters
                if line.meter is meter and line.meter_role is ModelUsageMeterRole.INFORMATIONAL
            ),
            Decimal("0"),
        )
```

Public service signatures and independent transaction wrappers (implemented in Tasks 5–7):

```python
def reserve_usage(
    context: UsageContext,
    estimate: UsageEstimate,
    *,
    fingerprint: str,
    session_factory: Callable[[], Session] = SessionLocal,
) -> ReservationDecision:
    with session_factory() as db, db.begin():
        return reserve_usage_in_session(db, context, estimate, fingerprint=fingerprint, at=utcnow())

def prepare_usage_dispatch(
    reservation_id: str,
    *,
    fingerprint: str,
    recovery_policy: ProviderRecoveryPolicy,
    session_factory: Callable[[], Session] = SessionLocal,
) -> DispatchPermit:
    with session_factory() as db:
        with db.begin():
            outcome = prepare_usage_dispatch_in_session(
                db,
                reservation_id=reservation_id,
                fingerprint=fingerprint,
                recovery_policy=recovery_policy,
            )
    return outcome.require_first_send_permit()

def consume_fail_open_dispatch_permit(
    permit: DispatchPermit,
    *,
    at: datetime,
    registry: FailOpenPermitRegistry = process_fail_open_permit_registry,
) -> DispatchPermit:
    return registry.consume_once(permit, at=at)

def settle_usage(
    receipt: ProviderUsageReceipt,
    *,
    session_factory: Callable[[], Session] = SessionLocal,
) -> UsageSettlement:
    with session_factory() as db, db.begin():
        return settle_usage_in_session(db, receipt)

def record_usage_uncertain(
    reservation_id: str,
    *,
    stable_error_code: str,
    session_factory: Callable[[], Session] = SessionLocal,
) -> None:
    with session_factory() as db, db.begin():
        record_usage_uncertain_in_session(db, reservation_id=reservation_id, stable_error_code=stable_error_code)
```

## Commit Sequence

| Task | Commit |
| --- | --- |
| 1 | `feat(model-usage): define domain vocabulary and decimal rules` |
| 2 | `feat(model-usage): add ledger schema and migration` |
| 3 | `feat(model-usage): add immutable price catalog tooling` |
| 4 | `feat(model-usage): add subject and policy lifecycle` |
| 5 | `feat(model-usage): add reservation and strong counters` |
| 6 | `feat(model-usage): add dispatch settlement and receipts` |
| 7 | `feat(model-usage): add uncertain recovery and incidents` |
| 8 | `feat(model-usage): add adjustments and budget alerts` |
| 9 | `feat(model-usage): add deterministic usage rollups` |
| 10 | `feat(model-usage): add maintenance worker and operations cli` |
| 11 | `feat(model-usage): meter llm and vision provider rounds` |
| 12 | `feat(model-usage): meter embedding without duplicate provider calls` |
| 13 | `feat(model-usage): meter rerank with local degradation` |
| 14 | `feat(model-usage): meter speech transcription and synthesis` |
| 15 | `feat(model-usage): meter realtime audio leases` |
| 16 | `feat(model-usage): meter image generation jobs` |
| 17 | `feat(model-usage): expose scoped usage and policy api` |
| 18 | `feat(model-usage): add frontend contracts and view models` |
| 19 | `feat(model-usage): add responsive usage workspace` |
| 20 | `feat(model-usage): add responsive budget settings` |
| 21 | `feat(model-usage): unify usage alerts and degradation notices` |
| 22 | `test(model-usage): enforce first launch gates` |

---
## Task 1: Domain vocabulary, periods, Decimal math, and content-free contracts

**Files**

- Create: `backend/app/services/model_usage/__init__.py`
- Create: `backend/app/services/model_usage/types.py`
- Create: `backend/app/services/model_usage/errors.py`
- Create: `backend/app/services/model_usage/decimal_math.py`
- Create: `backend/app/services/model_usage/periods.py`
- Modify: `backend/app/core/enums.py`
- Create: `backend/tests/model_usage/__init__.py`
- Create: `backend/tests/model_usage/test_domain_types.py`
- Create: `backend/tests/model_usage/test_decimal_math.py`
- Create: `backend/tests/model_usage/test_periods.py`

**Interfaces**

- Consumes: `Decimal`, timezone-aware `datetime`, trusted IDs supplied by later adapters.
- Produces: the locked dataclasses above; immutable `CapabilityMeterContract` registry; `new_client_attempt_id()`; `shanghai_billing_period(at)`; `exact_line_cost(quantity, unit_price, unit_quantity)`; `reservation_line_cost(quantity, unit_price, unit_quantity)`; stable `ModelUsageError.code` values.
- Must not import: provider SDKs, FastAPI, business ORM models, prompt/query/media types.

- [ ] Add failing enum and content-boundary tests in `test_domain_types.py`.

```python
def test_usage_context_has_no_content_fields() -> None:
    forbidden = {"prompt", "response", "query", "text", "document", "media_url", "user_id"}
    assert forbidden.isdisjoint(UsageContext.__dataclass_fields__)

def test_capabilities_and_meters_are_closed_sets() -> None:
    assert {item.value for item in ModelUsageCapability} == {
        "llm", "embedding", "rerank", "stt", "tts", "realtime_audio", "image_generation"
    }
    assert ModelUsageMeter.TOTAL_TOKENS.value == "total_tokens"
    assert ModelUsageMeterRole.INFORMATIONAL.value == "informational"

def test_guardrail_eligibility_is_independent_from_price_role() -> None:
    contract = capability_meter_contract(ModelUsageCapability.LLM, ModelUsageMeter.TOTAL_TOKENS)
    assert contract.guardrail_eligible is True
    assert contract.requires_reservation_estimate is True
    assert contract.requires_settlement_quantity is True
```

- [ ] Run the new domain test and confirm the expected red state.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_domain_types.py -q
```

Expected: collection fails because `app.services.model_usage.types` and model-usage enums do not exist.

- [ ] Add all controlled enums to `backend/app/core/enums.py`, including capability, meter, role, pricing, reservation, provider outcome, execution certainty, measurement, recovery, attribution, subject, counter, limit, resolution, rollup, correction, incident coverage/recovery, quantity source, operation source, and stable budget state.

```python
class ModelUsageCapability(str, Enum):
    LLM = "llm"
    EMBEDDING = "embedding"
    RERANK = "rerank"
    STT = "stt"
    TTS = "tts"
    REALTIME_AUDIO = "realtime_audio"
    IMAGE_GENERATION = "image_generation"

class ModelUsageMeterRole(str, Enum):
    BILLABLE = "billable"
    INFORMATIONAL = "informational"

class ModelUsageRecoveryMode(str, Enum):
    IDEMPOTENCY_KEY = "idempotency_key"
    QUERYABLE_REQUEST = "queryable_request"
    IDEMPOTENCY_AND_QUERYABLE = "idempotency_and_queryable"
    NONE = "none"

@dataclass(frozen=True, slots=True)
class CapabilityMeterContract:
    capability: ModelUsageCapability
    meter: ModelUsageMeter
    canonical_unit: str
    integer_only: bool
    guardrail_eligible: bool
    requires_reservation_estimate: bool
    requires_settlement_quantity: bool
```

The registry is capability-scoped and does not carry `meter_role`; that role is selected by a billing scheme. Policy validation may expose only entries with `guardrail_eligible=True`, and Task 22 preflight proves every active adapter can estimate and settle any exposed guardrail meter.

- [ ] Implement the locked dataclasses and validate trusted attribution in `types.py`.

```python
@dataclass(frozen=True, slots=True)
class UsageAttribution:
    family_id: str
    attribution_kind: ModelUsageAttributionKind
    actor_user_id: str | None
    operation_source: ModelUsageOperationSource
    logical_operation_id: str

    def __post_init__(self) -> None:
        if self.attribution_kind is ModelUsageAttributionKind.USER and not self.actor_user_id:
            raise ValueError("user attribution requires actor_user_id")
        if self.attribution_kind is ModelUsageAttributionKind.SYSTEM and self.actor_user_id is not None:
            raise ValueError("system attribution cannot carry actor_user_id")

def new_client_attempt_id() -> str:
    return f"mua_{secrets.token_urlsafe(24)}"
```

- [ ] Add failing Decimal rounding tests in `test_decimal_math.py`.

```python
def test_exact_and_reservation_rounding_are_distinct() -> None:
    assert exact_line_cost(Decimal("1"), Decimal("0.0000000000005"), Decimal("1")) == Decimal("0.000000000001")
    assert reservation_line_cost(Decimal("1"), Decimal("0.0000000000001"), Decimal("1")) == Decimal("0.000000000001")

def test_budget_comparison_does_not_round_to_cents() -> None:
    assert would_exceed_limit(Decimal("0.009"), Decimal("0.002"), Decimal("0.010")) is True
```

- [ ] Implement quantization helpers with explicit rounding modes in `decimal_math.py`.

```python
CNY_QUANTUM = Decimal("0.000000000001")
QUANTITY_QUANTUM = Decimal("0.000001")

def exact_line_cost(quantity: Decimal, unit_price: Decimal, unit_quantity: Decimal) -> Decimal:
    raw = quantity * unit_price / unit_quantity
    return raw.quantize(CNY_QUANTUM, rounding=ROUND_HALF_UP)

def reservation_line_cost(quantity: Decimal, unit_price: Decimal, unit_quantity: Decimal) -> Decimal:
    raw = quantity * unit_price / unit_quantity
    return raw.quantize(CNY_QUANTUM, rounding=ROUND_CEILING)
```

- [ ] Add failing Beijing month boundary tests in `test_periods.py`.

```python
def test_shanghai_period_uses_utc_storage_boundaries() -> None:
    period = shanghai_billing_period(datetime(2026, 7, 31, 16, 0, tzinfo=timezone.utc))
    assert period.local_month == "2026-08"
    assert period.start_at == datetime(2026, 7, 31, 16, 0, tzinfo=timezone.utc)
    assert period.end_at == datetime(2026, 8, 31, 16, 0, tzinfo=timezone.utc)
```

- [ ] Implement `BillingPeriod` and `shanghai_billing_period` using `ZoneInfo("Asia/Shanghai")`, then run all Task 1 tests.

```python
def shanghai_billing_period(at: datetime) -> BillingPeriod:
    instant = require_aware_utc(at)
    local = instant.astimezone(SHANGHAI)
    local_start = datetime(local.year, local.month, 1, tzinfo=SHANGHAI)
    next_local_start = datetime(
        local.year + (1 if local.month == 12 else 0),
        1 if local.month == 12 else local.month + 1,
        1,
        tzinfo=SHANGHAI,
    )
    return BillingPeriod(
        local_month=local_start.strftime("%Y-%m"),
        start_at=local_start.astimezone(timezone.utc),
        end_at=next_local_start.astimezone(timezone.utc),
    )
```

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_domain_types.py tests/model_usage/test_decimal_math.py tests/model_usage/test_periods.py -q
cd ..
git diff --check
```

Expected: all Task 1 tests pass; no whitespace errors.

- [ ] Commit Task 1.

```bash
git add backend/app/core/enums.py backend/app/services/model_usage backend/tests/model_usage
git commit -m "feat(model-usage): define domain vocabulary and decimal rules"
```

---
## Task 2: ORM schema, Alembic migration, existing-family backfill, and raw retention keys

**Files**

- Create: `backend/app/models/model_usage.py`
- Modify: `backend/app/models/__init__.py`
- Modify: `backend/app/db/base.py`
- Create: `backend/alembic/versions/2d3e4f5a6b7c_add_model_usage_governance.py`
- Create: `backend/tests/model_usage/test_models.py`
- Create: `backend/tests/model_usage/test_migration_mysql.py`

**Interfaces**

- Consumes: enums/value constraints from Task 1 and current Alembic head `1c2d3e4f5a6b`.
- Produces: 18 foundational tables (`price_versions/rates`, `subjects`, `family_policies/policy_versions/capability_limits`, `period_counters`, `reservations/meters`, `events/meters`, `adjustment_groups/adjustment_lines`, `monthly_rollups`, `alerts/receipts`, `measurement_incidents/attempts`). Task 15 adds the nineteenth design table, `model_usage_realtime_watermarks`, only after the realtime lease contract exists.
- Key DB guarantees: `(family_id, attempt_key)` unique on reservations and events, `reservation_id` unique on events, `(family_id, idempotency_key)` unique on adjustment groups, `(adjustment_group_id, line_sequence)` unique on adjustment lines, `(family_id, period_start, dimension_key)` counter unique, `(family_id, user_id)` unique for non-null active subjects, immutable admission/dispatch/pre-dispatch-denial policy identities, `subject.user_id ON DELETE SET NULL`, explicit non-null dimension keys, cascade only on family deletion.

- [ ] Add metadata tests for table presence, Numeric precision, unique keys, and the forbidden circular event/reservation FK.

```python
def test_model_usage_metadata_has_ledger_tables() -> None:
    expected = {
        "model_usage_price_versions", "model_usage_price_rates", "model_usage_subjects",
        "model_usage_family_policies", "model_usage_policy_versions",
        "model_usage_capability_limits", "model_usage_period_counters",
        "model_usage_reservations", "model_usage_reservation_meters",
        "model_usage_events", "model_usage_event_meters",
        "model_usage_adjustment_groups", "model_usage_adjustments",
        "model_usage_monthly_rollups", "model_usage_alerts",
        "model_usage_alert_receipts", "model_usage_measurement_incidents",
        "model_usage_measurement_incident_attempts",
    }
    assert expected <= set(Base.metadata.tables)
    assert "usage_event_id" not in Base.metadata.tables["model_usage_reservations"].c
    assert Base.metadata.tables["model_usage_family_policies"].c.current_policy_version_id.nullable is False
    assert unique_columns(Base.metadata.tables["model_usage_reservations"], "uq_model_usage_reservation_attempt") == {
        "family_id", "attempt_key"
    }
    assert unique_columns(Base.metadata.tables["model_usage_events"], "uq_model_usage_event_attempt") == {
        "family_id", "attempt_key"
    }
    assert unique_columns(Base.metadata.tables["model_usage_adjustment_groups"], "uq_model_usage_adjustment_group_key") == {
        "family_id", "idempotency_key"
    }
    assert unique_columns(Base.metadata.tables["model_usage_subjects"], "uq_model_usage_subject_user") == {
        "family_id", "user_id"
    }
```

- [ ] Run `test_models.py` and confirm it fails because the tables are absent.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_models.py -q
```

Expected: assertions report missing `model_usage_*` tables.

- [ ] Create price, subject, and immutable policy ORM classes with `Numeric(30, 12)`, JSON aliases, checksum fields, and explicit unique constraints.

```python
class ModelUsageSubject(Base):
    __tablename__ = "model_usage_subjects"
    __table_args__ = (
        UniqueConstraint("family_id", "user_id", name="uq_model_usage_subject_user"),
        UniqueConstraint("family_id", "dimension_key", name="uq_model_usage_subject_dimension"),
        UniqueConstraint("family_id", "anonymized_label", name="uq_model_usage_subject_anonymized_label"),
    )
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    subject_key: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    dimension_key: Mapped[str] = mapped_column(String(160), nullable=False)
```

The nullable user unique is intentional on MySQL: it prevents duplicate non-null active identities while allowing multiple unlinked historical subjects with `user_id=NULL`. `dimension_key` separately enforces one system subject and keeps every deleted/user dimension distinct.

- [ ] Add policy pointer/version relationships without a circular creation dependency: each immutable version owns `family_id` directly; the steady-state ORM pointer is non-null. The migration alone creates the pointer nullable, backfills version 1 for every family, then alters it to non-null.

```python
class ModelUsagePolicyVersion(Base):
    __tablename__ = "model_usage_policy_versions"
    __table_args__ = (
        UniqueConstraint("family_id", "version_number", name="uq_model_usage_policy_family_version"),
    )
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False)
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by_subject_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_subjects.id", ondelete="RESTRICT"), nullable=False
    )

class ModelUsageFamilyPolicy(Base):
    __tablename__ = "model_usage_family_policies"
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), primary_key=True)
    current_policy_version_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    tracking_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
```

- [ ] Create counter and reservation ORM classes, including operation source/logical operation IDs, admission/dispatch policy versions, all recovery windows needed by dispatch, and the family-scoped attempt unique claim.

```python
class ModelUsagePeriodCounter(Base):
    __tablename__ = "model_usage_period_counters"
    __table_args__ = (
        UniqueConstraint("family_id", "period_start", "dimension_key", name="uq_model_usage_counter_dimension"),
    )
    settled_value: Mapped[Decimal] = mapped_column(Numeric(30, 12), default=Decimal("0"), nullable=False)
    reserved_value: Mapped[Decimal] = mapped_column(Numeric(30, 12), default=Decimal("0"), nullable=False)
    adjustment_value: Mapped[Decimal] = mapped_column(Numeric(30, 12), default=Decimal("0"), nullable=False)

class ModelUsageReservation(Base):
    __tablename__ = "model_usage_reservations"
    __table_args__ = (
        UniqueConstraint("family_id", "attempt_key", name="uq_model_usage_reservation_attempt"),
    )
    policy_version_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    dispatch_policy_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="RESTRICT"), nullable=True
    )
    pre_dispatch_denial_policy_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="RESTRICT"), nullable=True
    )
```

`dispatch_policy_version_id` is non-null only after a durable first-send authorization. A reservation released by the current dispatch gate stores that policy in `pre_dispatch_denial_policy_version_id` while leaving `dispatch_policy_version_id` null; a model/service validation test enforces that the two evidence fields are not both populated by a pre-dispatch transition.

- [ ] Create event/meter plus adjustment group/line ORM classes; keep source prices per meter, make event `reservation_id` nullable-but-unique for fail-open recovery, and retain database idempotency when `reservation_id IS NULL`.

```python
class ModelUsageEvent(Base):
    __tablename__ = "model_usage_events"
    __table_args__ = (
        UniqueConstraint("family_id", "attempt_key", name="uq_model_usage_event_attempt"),
    )
    reservation_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_reservations.id", ondelete="RESTRICT"), unique=True, nullable=True
    )
    policy_version_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    dispatch_policy_version_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    cost_cny: Mapped[Decimal | None] = mapped_column(Numeric(30, 12), nullable=True)
    provider_reported_source_cost: Mapped[Decimal | None] = mapped_column(Numeric(30, 12), nullable=True)

class ModelUsageAdjustmentGroup(Base):
    __tablename__ = "model_usage_adjustment_groups"
    __table_args__ = (
        UniqueConstraint("family_id", "idempotency_key", name="uq_model_usage_adjustment_group_key"),
    )
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source_event_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_events.id", ondelete="RESTRICT"), nullable=False
    )

class ModelUsageAdjustment(Base):
    __tablename__ = "model_usage_adjustments"
    __table_args__ = (
        UniqueConstraint("adjustment_group_id", "line_sequence", name="uq_model_usage_adjustment_line_sequence"),
    )
    adjustment_group_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_adjustment_groups.id", ondelete="CASCADE"), nullable=False
    )
```

- [ ] Create rollup, alert/receipt, incident/attempt ORM classes with correction status and source counts/checksums.

```python
class ModelUsageMonthlyRollup(Base):
    __tablename__ = "model_usage_monthly_rollups"
    __table_args__ = (
        UniqueConstraint("family_id", "period_start", "dimension_key", name="uq_model_usage_rollup_dimension"),
    )
    correction_status: Mapped[ModelUsageCorrectionStatus] = mapped_column(
        SqlEnum(ModelUsageCorrectionStatus, native_enum=False), nullable=False
    )
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
```

- [ ] Register the module in `models/__init__.py` and `db/base.py`, then rerun `test_models.py` to green.

```python
from app.models.domain import Base
from app.models import model_usage as _model_usage

__all__ = ["Base"]
```

- [ ] Add a MySQL migration fixture that can upgrade an isolated database from a requested revision and seed two current families with members, trace, image, and search job rows.

```python
@pytest.fixture()
def mysql_alembic_database() -> Iterator[MySqlAlembicDatabase]:
    database = MySqlAlembicDatabase.from_test_url(require_model_usage_mysql_url())
    database.recreate()
    try:
        yield database
    finally:
        database.dispose()
```

- [ ] Add a migration test that asserts default policies/subjects are created without historical usage.

```python
def test_upgrade_initializes_policy_and_subjects_without_usage(mysql_alembic_database) -> None:
    mysql_alembic_database.upgrade("1c2d3e4f5a6b")
    mysql_alembic_database.seed_existing_families()
    mysql_alembic_database.upgrade("2d3e4f5a6b7c")
    assert mysql_alembic_database.scalar("SELECT COUNT(*) FROM model_usage_events") == 0
    assert mysql_alembic_database.scalar("SELECT COUNT(*) FROM model_usage_family_policies") == 2
    assert mysql_alembic_database.scalar("SELECT COUNT(*) FROM model_usage_policy_versions") == 2
    assert mysql_alembic_database.scalar(
        "SELECT COUNT(*) FROM model_usage_family_policies WHERE current_policy_version_id IS NULL"
    ) == 0
    creators = mysql_alembic_database.rows(
        """
        SELECT s.subject_kind, s.user_id
        FROM model_usage_policy_versions AS p
        JOIN model_usage_subjects AS s ON s.id = p.created_by_subject_id
        WHERE p.version_number = 1
        ORDER BY p.family_id
        """
    )
    assert creators == [("system", None), ("system", None)]
```

- [ ] Assert the upgraded MySQL schema contains the three non-null idempotency unique keys and rejects duplicate reservation/event/group claims at the database layer; SQLite metadata alone is not sufficient evidence.

```python
def test_mysql_enforces_model_usage_idempotency_uniques(mysql_alembic_database) -> None:
    mysql_alembic_database.insert_reservation(family_id="family-a", attempt_key="attempt-1", fingerprint="fp-a")
    with pytest.raises(IntegrityError):
        mysql_alembic_database.insert_reservation(family_id="family-a", attempt_key="attempt-1", fingerprint="fp-a")
    mysql_alembic_database.insert_event(family_id="family-a", attempt_key="fail-open-1", reservation_id=None)
    with pytest.raises(IntegrityError):
        mysql_alembic_database.insert_event(family_id="family-a", attempt_key="fail-open-1", reservation_id=None)
    mysql_alembic_database.insert_adjustment_group(family_id="family-a", idempotency_key="adjust-1", fingerprint="fp-a")
    with pytest.raises(IntegrityError):
        mysql_alembic_database.insert_adjustment_group(family_id="family-a", idempotency_key="adjust-1", fingerprint="fp-a")
```

- [ ] Write the Alembic revision table creation in FK order, using a final `alter_column` only after every family pointer is backfilled.

```python
revision = "2d3e4f5a6b7c"
down_revision = "1c2d3e4f5a6b"

def upgrade() -> None:
    _create_price_tables()
    _create_subject_tables()
    _create_policy_tables()
    _create_ledger_tables()
    _create_reporting_tables()
    _backfill_existing_families()
    op.alter_column("model_usage_family_policies", "current_policy_version_id", nullable=False)
```

- [ ] Implement migration backfill per current family using random UUID-backed IDs/subject keys, one system subject, one subject per active membership, and default version 1. Create/flush the system subject before the policy version and use its ID as `created_by_subject_id`; migration backfill never copies a raw user ID into policy history.

```python
def _default_policy_values(now: datetime) -> dict[str, object]:
    return {
        "version_number": 1,
        "monthly_budget_cny": None,
        "alerts_enabled": True,
        "hard_limit_enabled": False,
        "budget_alert_revision": 1,
        "effective_at": now,
    }

def _backfill_family(connection: Connection, *, family_id: str, now: datetime) -> None:
    system_subject_id = create_migration_id("model-usage-subject")
    connection.execute(
        subject_table.insert().values(
            id=system_subject_id,
            family_id=family_id,
            user_id=None,
            subject_kind="system",
            dimension_key="system",
            subject_key=new_migration_subject_key(),
        )
    )
    _backfill_active_member_subjects(connection, family_id=family_id)
    version_id = create_migration_id("model-usage-policy")
    connection.execute(
        policy_version_table.insert().values(
            id=version_id,
            family_id=family_id,
            created_by_subject_id=system_subject_id,
            **_default_policy_values(now),
        )
    )
    connection.execute(
        family_policy_table.insert().values(
            family_id=family_id,
            current_policy_version_id=version_id,
            tracking_started_at=now,
        )
    )
```

The migration system subject is intentionally different from runtime bootstrap attribution: existing rows have no trustworthy historical human actor, while a newly created family has a known Owner creator. Both paths use a stable subject foreign key and never place a user ID in immutable policy history.

- [ ] Add downgrade in exact reverse FK order and test disposable `upgrade -> downgrade -> upgrade`.

```python
def downgrade() -> None:
    _drop_reporting_tables()
    _drop_ledger_tables()
    _drop_policy_tables()
    _drop_subject_tables()
    _drop_price_tables()
```

- [ ] Run metadata and MySQL migration tests, then inspect Alembic head.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_models.py tests/model_usage/test_migration_mysql.py -q
.venv/bin/alembic heads
cd ..
git diff --check
```

Expected: tests pass in the MySQL environment; Alembic prints only `2d3e4f5a6b7c (head)`.

- [ ] Commit Task 2.

```bash
git add backend/app/models/model_usage.py backend/app/models/__init__.py backend/app/db/base.py backend/alembic/versions/2d3e4f5a6b7c_add_model_usage_governance.py backend/tests/model_usage/test_models.py backend/tests/model_usage/test_migration_mysql.py
git commit -m "feat(model-usage): add ledger schema and migration"
```

---

## Task 3: Immutable price manifest, overlap validation, coverage, and price CLI

**Files**

- Create: `backend/app/repos/model_usage/__init__.py`
- Create: `backend/app/repos/model_usage/catalog.py`
- Create: `backend/app/services/model_usage/pricing_manifest.py`
- Create: `backend/app/services/model_usage/pricing.py`
- Create: `backend/app/services/model_usage/configured_variants.py`
- Create: `backend/scripts/manage_model_usage_prices.py`
- Create: `backend/tests/model_usage/fixtures/prices_valid.json`
- Create: `backend/tests/model_usage/test_price_manifest.py`
- Create: `backend/tests/model_usage/test_pricing_service.py`
- Create: `backend/tests/model_usage/test_price_cli.py`
- Modify: `backend/tests/conftest.py`

**Interfaces**

- Consumes: JSON manifest with Decimal strings; actual enabled provider/model settings; price ORM from Task 2.
- Produces: `ValidatedPriceManifest`, `UsagePriceSnapshot`, `PriceCoverageReport`; CLI `validate|diff|publish|list|show|coverage|cancel`.
- `select_price_snapshot(db, context, estimate, at) -> UsagePriceSnapshot` locks one published version and one exact billing scheme; it never selects wildcard rates for a hard limit.
- A realtime variant whose billable set uses audio Token meters must declare positive Decimal `input_tokens_per_second_cap` and `output_tokens_per_second_cap` in `ConfiguredUsageVariant`; seconds-billed variants declare both caps null. Manifest/preflight validation rejects the opposite combinations.
- Realtime variants also declare `lease_boundary_cumulative_meters`: a subset of produced provider meters backed by an adapter contract that can return a cumulative snapshot at every 30-second boundary. The default is empty; non-realtime variants, unsupported meters, or a provider that exposes only a final session total cannot opt in.

- [ ] Add a valid manifest fixture containing all seven capabilities, explicit `billingSchemeKey`, explicit aliases, and non-overlapping meter roles.

```json
{
  "catalogVersion": "test-2026-07-30",
  "effectiveFrom": "2026-07-30T00:00:00+08:00",
  "reviewedAt": "2026-07-30T00:00:00+08:00",
  "sourceRef": "tests:model-usage-price-contract",
  "changeNote": "Deterministic seven-capability test catalog",
  "fxRates": {"USD": "7.200000000000", "CNY": "1.000000000000"},
  "modelAliases": {
    "openai:gpt-test-2026-07-01": "gpt-test",
    "openai:embedding-test-2026-07-01": "embedding-test",
    "dashscope:rerank-test-2026-07-01": "rerank-test",
    "openai:stt-test-2026-07-01": "stt-test",
    "openai:tts-test-2026-07-01": "tts-test",
    "dashscope:realtime-test-2026-07-01": "realtime-test",
    "dashscope:image-test-2026-07-01": "image-test"
  },
  "rates": [
    {"provider":"openai","billingModel":"gpt-test","capability":"llm","variant":"default","billingSchemeKey":"llm-split-v1","meter":"uncached_input_tokens","meterRole":"billable","unitQuantity":"1000000","unitPrice":"1.000000000000","sourceCurrency":"USD"},
    {"provider":"openai","billingModel":"gpt-test","capability":"llm","variant":"default","billingSchemeKey":"llm-split-v1","meter":"cached_input_tokens","meterRole":"billable","unitQuantity":"1000000","unitPrice":"0.500000000000","sourceCurrency":"USD"},
    {"provider":"openai","billingModel":"gpt-test","capability":"llm","variant":"default","billingSchemeKey":"llm-split-v1","meter":"output_tokens","meterRole":"billable","unitQuantity":"1000000","unitPrice":"2.000000000000","sourceCurrency":"USD"},
    {"provider":"openai","billingModel":"embedding-test","capability":"embedding","variant":"dimensions=1536","billingSchemeKey":"embedding-token-v1","meter":"embedding_tokens","meterRole":"billable","unitQuantity":"1000000","unitPrice":"0.100000000000","sourceCurrency":"USD"},
    {"provider":"dashscope","billingModel":"rerank-test","capability":"rerank","variant":"top_n=20","billingSchemeKey":"rerank-request-document-v1","meter":"rerank_requests","meterRole":"billable","unitQuantity":"1000","unitPrice":"0.100000000000","sourceCurrency":"CNY"},
    {"provider":"dashscope","billingModel":"rerank-test","capability":"rerank","variant":"top_n=20","billingSchemeKey":"rerank-request-document-v1","meter":"rerank_documents","meterRole":"billable","unitQuantity":"1000","unitPrice":"0.200000000000","sourceCurrency":"CNY"},
    {"provider":"openai","billingModel":"stt-test","capability":"stt","variant":"format=webm","billingSchemeKey":"stt-seconds-v1","meter":"audio_input_seconds","meterRole":"billable","unitQuantity":"60","unitPrice":"0.006000000000","sourceCurrency":"USD"},
    {"provider":"openai","billingModel":"tts-test","capability":"tts","variant":"voice=default","billingSchemeKey":"tts-characters-v1","meter":"tts_characters","meterRole":"billable","unitQuantity":"1000","unitPrice":"0.015000000000","sourceCurrency":"USD"},
    {"provider":"dashscope","billingModel":"realtime-test","capability":"realtime_audio","variant":"voice=default","billingSchemeKey":"realtime-audio-token-v1","meter":"audio_input_tokens","meterRole":"billable","unitQuantity":"1000000","unitPrice":"1.000000000000","sourceCurrency":"CNY"},
    {"provider":"dashscope","billingModel":"realtime-test","capability":"realtime_audio","variant":"voice=default","billingSchemeKey":"realtime-audio-token-v1","meter":"audio_output_tokens","meterRole":"billable","unitQuantity":"1000000","unitPrice":"2.000000000000","sourceCurrency":"CNY"},
    {"provider":"dashscope","billingModel":"image-test","capability":"image_generation","variant":"mode=text|size=1024*1024|quality=standard","billingSchemeKey":"image-count-request-v1","meter":"generated_images","meterRole":"billable","unitQuantity":"1","unitPrice":"0.200000000000","sourceCurrency":"CNY"},
    {"provider":"dashscope","billingModel":"image-test","capability":"image_generation","variant":"mode=text|size=1024*1024|quality=standard","billingSchemeKey":"image-count-request-v1","meter":"request_units","meterRole":"billable","unitQuantity":"1","unitPrice":"0.010000000000","sourceCurrency":"CNY"}
  ]
}
```

This is the complete committed fixture: seven configured capability variants and twelve concrete billable rates. It is deterministic test data and must never be published to production.

- [ ] Add failing manifest tests for Decimal-as-number, alias cycles, duplicate identity, missing FX, informational price, total/component overlap, cached overlap, audio seconds/token overlap, and adapter scheme mismatch.

```python
@pytest.mark.parametrize("mutation, code", [
    ("total_and_components_billable", "overlapping_billable_meters"),
    ("cached_and_full_input_billable", "overlapping_billable_meters"),
    ("audio_seconds_and_tokens_billable", "overlapping_billable_meters"),
    ("tts_alternative_meters_billable", "overlapping_billable_meters"),
    ("informational_has_price", "informational_meter_has_price"),
])
def test_manifest_rejects_overlap(price_manifest, mutation: str, code: str) -> None:
    broken = mutate_manifest(price_manifest, mutation)
    with pytest.raises(PriceManifestError, match=code):
        validate_price_manifest(broken, configured_variants=test_variants())

def test_realtime_boundary_watermark_requires_adapter_contract(test_variant) -> None:
    unsupported = replace(
        test_variant,
        lease_boundary_cumulative_meters=frozenset({ModelUsageMeter.AUDIO_INPUT_TOKENS}),
        provider_contract=replace(
            test_variant.provider_contract,
            supports_lease_boundary_cumulative_usage=False,
        ),
    )
    with pytest.raises(PriceManifestError, match="unsupported_lease_boundary_cumulative_meter"):
        validate_configured_variant(unsupported)
```

- [ ] Run price manifest tests and confirm red.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_price_manifest.py -q
```

Expected: import/behavior failures for the absent validator.

- [ ] Implement strict Pydantic manifest models that accept Decimal only from strings and compute canonical SHA-256 over sorted JSON.

```python
class ManifestRate(BaseModel):
    provider: str
    billing_model: str = Field(alias="billingModel")
    capability: ModelUsageCapability
    variant_key: str = Field(alias="variant")
    billing_scheme_key: str = Field(alias="billingSchemeKey")
    meter: ModelUsageMeter
    meter_role: ModelUsageMeterRole = Field(alias="meterRole")
    unit_quantity: Decimal = Field(alias="unitQuantity")
    unit_price: Decimal | None = Field(alias="unitPrice", default=None)
```

- [ ] Implement scheme-level overlap validation and exact adapter billable-set comparison.

```python
def validate_billable_scheme(rates: Sequence[ManifestRate], configured: ConfiguredUsageVariant) -> None:
    billable = {rate.meter for rate in rates if rate.meter_role is ModelUsageMeterRole.BILLABLE}
    if ModelUsageMeter.TOTAL_TOKENS in billable and billable & TOKEN_COMPONENT_METERS:
        raise PriceManifestError("overlapping_billable_meters")
    forbidden_pairs = (
        (ModelUsageMeter.INPUT_TOKENS, ModelUsageMeter.UNCACHED_INPUT_TOKENS),
        (ModelUsageMeter.INPUT_TOKENS, ModelUsageMeter.CACHED_INPUT_TOKENS),
        (ModelUsageMeter.AUDIO_INPUT_SECONDS, ModelUsageMeter.AUDIO_INPUT_TOKENS),
        (ModelUsageMeter.AUDIO_OUTPUT_SECONDS, ModelUsageMeter.AUDIO_OUTPUT_TOKENS),
        (ModelUsageMeter.TTS_CHARACTERS, ModelUsageMeter.TTS_TOKENS),
        (ModelUsageMeter.TTS_CHARACTERS, ModelUsageMeter.AUDIO_OUTPUT_SECONDS),
        (ModelUsageMeter.TTS_CHARACTERS, ModelUsageMeter.AUDIO_OUTPUT_TOKENS),
        (ModelUsageMeter.TTS_TOKENS, ModelUsageMeter.AUDIO_OUTPUT_SECONDS),
        (ModelUsageMeter.TTS_TOKENS, ModelUsageMeter.AUDIO_OUTPUT_TOKENS),
    )
    if any(left in billable and right in billable for left, right in forbidden_pairs):
        raise PriceManifestError("overlapping_billable_meters")
    if billable != configured.billable_meters:
        raise PriceManifestError("adapter_billable_meter_mismatch")
```

`TOKEN_COMPONENT_METERS` excludes `TOTAL_TOKENS` itself and includes all capability-applicable input/uncached/cached/output components. The validator is capability-scoped: independent request/image fixed fees may coexist with Token or media usage, while two alternative representations of the same quantity never may. Tests cover every forbidden pair in both orderings and a valid `uncached_input_tokens + cached_input_tokens + output_tokens + request_units` scheme.

- [ ] Add failing service tests for effective version selection, alias mapping, immutable published rows, partial unpriced snapshots, and publish checksum/OCC.

```python
def test_settle_uses_reservation_snapshot_after_new_publish(db, priced_context, estimate) -> None:
    first = publish_test_catalog(db, version="v1", output_price="2.0")
    snapshot = select_price_snapshot(db, priced_context, estimate, at=aware("2026-07-30T01:00:00Z"))
    publish_test_catalog(db, version="v2", output_price="9.0")
    assert snapshot.price_version_id == first.id
    assert snapshot.rate_for(ModelUsageMeter.OUTPUT_TOKENS).unit_price == Decimal("2.0")
```

- [ ] Implement catalog repository reads with exact provider/billing model/capability/variant/time predicates and `with_for_update()` only during publish.

```python
def current_published_version(db: Session, *, at: datetime) -> ModelUsagePriceVersion | None:
    return db.scalar(
        select(ModelUsagePriceVersion)
        .where(ModelUsagePriceVersion.status == "published", ModelUsagePriceVersion.effective_from <= at)
        .order_by(ModelUsagePriceVersion.effective_from.desc(), ModelUsagePriceVersion.version_number.desc())
        .limit(1)
    )
```

- [ ] Implement atomic publish, cancel restrictions, diff, selection, and coverage services; never mutate a published version/rate.

```python
def publish_price_manifest(db: Session, command: PublishPriceCommand) -> ModelUsagePriceVersion:
    validated = validate_price_manifest(command.manifest, configured_variants=command.configured_variants)
    if validated.checksum != command.confirm_checksum:
        raise PriceCatalogConflict("checksum_mismatch")
    version = insert_immutable_version(
        db,
        validated,
        operator=command.operator,
        change_ticket=command.change_ticket,
    )
    db.flush()
    return version
```

- [ ] Add CLI tests for required operator/change ticket/checksum, JSON coverage, secret redaction, and non-zero unhealthy exit.

```python
def test_publish_requires_checksum_and_change_ticket(cli_runner, valid_manifest_path) -> None:
    result = cli_runner("publish", "--file", valid_manifest_path, "--operator", "release-owner")
    assert result.returncode != 0
    assert "--change-ticket" in result.stderr
    assert "api_key" not in result.stdout.lower()
```

- [ ] Implement `argparse` subcommands in the thin script; delegate all DB work to pricing services.

```python
publish = subparsers.add_parser("publish")
publish.add_argument("--file", required=True)
publish.add_argument("--operator", required=True)
publish.add_argument("--change-ticket", required=True)
publish.add_argument("--confirm-checksum", required=True)
publish.set_defaults(handler=handle_publish)
```

- [ ] Run price tests and CLI smoke.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_price_manifest.py tests/model_usage/test_pricing_service.py tests/model_usage/test_price_cli.py -q
PYTHONPATH=. .venv/bin/python scripts/manage_model_usage_prices.py validate --file tests/model_usage/fixtures/prices_valid.json
cd ..
git diff --check
```

Expected: tests pass; validate prints the canonical checksum and seven capability coverage rows without secrets.

- [ ] Commit Task 3.

```bash
git add backend/app/repos/model_usage backend/app/services/model_usage/pricing_manifest.py backend/app/services/model_usage/pricing.py backend/app/services/model_usage/configured_variants.py backend/scripts/manage_model_usage_prices.py backend/tests/model_usage backend/tests/conftest.py
git commit -m "feat(model-usage): add immutable price catalog tooling"
```

---

## Task 4: Stable subjects, immutable family policy versions, OCC, and lifecycle hooks

**Files**

- Create: `backend/app/repos/model_usage/identity.py`
- Create: `backend/app/services/model_usage/subjects.py`
- Create: `backend/app/services/model_usage/policies.py`
- Modify: `backend/app/services/bootstrap.py`
- Modify: `backend/app/api/family.py`
- Create: `backend/tests/model_usage/test_subjects.py`
- Create: `backend/tests/model_usage/test_policies.py`
- Modify: `backend/tests/account/test_account_management.py`
- Modify: `backend/tests/family/test_family_api.py`

**Interfaces**

- Consumes: `family_id`, trusted current `user_id`, current immutable policy pointer.
- Produces: `ensure_family_model_usage_defaults(db, family_id, creator_subject_id)`, `ensure_user_subject(db, family_id, user_id)`, `resolve_subject(db, attribution)`, `unlink_user_subjects(db, user_id)`, `lock_family_policy(db, family_id)`, `update_family_policy(db, command)`.
- `PolicyUpdateCommand` contains `base_version_number`, Decimal budget, alerts, hard limit, at most one guardrail per capability, and a server-resolved `actor_subject_id`; routes never accept that identity from the request body.
- Policy writes are in the caller's family/member transaction. Reserve stores an immutable admission snapshot; Task 6 locks the same current-policy pointer during first dispatch authorization, revalidates under the then-current snapshot, and stores `dispatch_policy_version_id`.

- [ ] Add failing subject tests for system uniqueness, same-family reuse, concurrent same-user creation, cross-family separation, and independent random keys that contain no user ID.

```python
def test_user_subject_reuses_family_identity_without_leaking_user_id(db) -> None:
    first = ensure_user_subject(db, family_id="family-a", user_id="user-a")
    second = ensure_user_subject(db, family_id="family-a", user_id="user-a")
    other = ensure_user_subject(db, family_id="family-b", user_id="user-a")
    assert first.id == second.id
    assert first.subject_key != other.subject_key
    assert "user-a" not in first.subject_key

def test_concurrent_same_family_user_has_one_subject(mysql_usage_context) -> None:
    results = run_barriered([
        lambda: mysql_usage_context.ensure_user_subject(family_id="family-a", user_id="user-a")
        for _ in range(20)
    ])
    assert len({result.id for result in results}) == 1
    assert mysql_usage_context.subject_count(family_id="family-a", user_id="user-a") == 1
```

- [ ] Implement locked identity repository lookups by `(family_id, user_id)` for active user subjects and `(family_id, dimension_key)` for all stable dimensions. Generate both `subject_key` and the non-null user dimension from independent random data; neither contains a reversible user identifier. Duplicate-key losers roll back their savepoint, load the unique winner, and never return a second in-memory identity.

```python
def new_subject_key() -> str:
    return f"mus_{secrets.token_urlsafe(24)}"

def create_user_subject(db: Session, *, family_id: str, user_id: str) -> ModelUsageSubject:
    lock_family_subjects(db, family_id=family_id)
    existing = find_user_subject(db, family_id=family_id, user_id=user_id)
    if existing is not None:
        return existing
    subject_key = new_subject_key()
    dimension_nonce = secrets.token_urlsafe(24)
    return ModelUsageSubject(
        id=create_id("model-usage-subject"),
        family_id=family_id,
        user_id=user_id,
        dimension_key=f"user:{dimension_nonce}",
        subject_key=subject_key,
        anonymized_label=None,
        subject_kind=ModelUsageSubjectKind.USER,
    )
```

The random `dimension_key` is only an internal uniqueness key; APIs and logs never expose it. It is independently generated from the separately random `subject_key`, so exposure of one does not reveal the other.

- [ ] Add failing unlink tests for two deleted users and concurrent anonymized label allocation.

```python
def test_unlink_keeps_deleted_subjects_distinct(db) -> None:
    first = ensure_user_subject(db, family_id="family-a", user_id="user-1")
    second = ensure_user_subject(db, family_id="family-a", user_id="user-2")
    unlink_user_subjects(db, user_id="user-1")
    unlink_user_subjects(db, user_id="user-2")
    assert first.user_id is None and second.user_id is None
    assert first.subject_key != second.subject_key
    assert {first.anonymized_label, second.anonymized_label} == {"已删除成员 1", "已删除成员 2"}

def test_every_user_delete_unlinks_model_usage_subjects_first() -> None:
    for source_path in Path("app").rglob("*.py"):
        source = source_path.read_text()
        if "db.delete(user)" not in source:
            continue
        assert "unlink_user_subjects(db, user_id=user.id)" in source
        assert source.index("unlink_user_subjects(db, user_id=user.id)") < source.index("db.delete(user)")
```

- [ ] Implement unlink by locking all family subjects in stable family/id order, selecting the next unused numeric label, then nulling `user_id` and setting `unlinked_at`. Any account-deletion service must call this hook before deleting `User`; add a source-contract test for every production `db.delete(user)` site.

```python
def unlink_user_subjects(db: Session, *, user_id: str) -> list[ModelUsageSubject]:
    subjects = lock_subjects_for_unlink(db, user_id=user_id)
    for subject in subjects:
        subject.anonymized_label = allocate_deleted_member_label(db, family_id=subject.family_id)
        subject.user_id = None
        subject.unlinked_at = utcnow()
    db.flush()
    return subjects
```

- [ ] Add failing policy tests for default version, immutable history, `base_version_number` conflict, hard-limit validation, capability/meter contract eligibility, and `budget_alert_revision` rules.

```python
def test_only_budget_or_alert_reenable_bumps_alert_revision(db, family_defaults) -> None:
    v1 = current_policy(db, family_id=family_defaults.family_id)
    v2 = update_family_policy(db, policy_command(v1, hard_limit_enabled=False, capability_limits=one_limit()))
    v3 = update_family_policy(db, policy_command(v2, monthly_budget_cny=Decimal("80")))
    assert v2.budget_alert_revision == v1.budget_alert_revision
    assert v3.budget_alert_revision == v2.budget_alert_revision + 1

def test_policy_rejects_meter_without_cross_variant_guardrail_contract(db, family_defaults) -> None:
    command = policy_command(
        current_policy(db, family_id=family_defaults.family_id),
        capability_limits=[meter_limit("realtime_audio", "provider_private_audio_units")],
    )
    with pytest.raises(ModelUsagePolicyValidationError, match="guardrail_meter_not_supported"):
        update_family_policy(db, command)

def test_policy_history_uses_stable_subject_identity(db, family_defaults, owner_subject) -> None:
    initial = current_policy(db, family_id=family_defaults.family_id)
    updated = update_family_policy(db, policy_command(initial, actor_subject_id=owner_subject.id))
    raw_user_id = owner_subject.user_id
    assert {initial.created_by_subject_id, updated.created_by_subject_id} == {owner_subject.id}
    assert owner_subject.id != raw_user_id
    unlink_user_subjects(db, user_id=raw_user_id)
    assert {initial.created_by_subject_id, updated.created_by_subject_id} == {owner_subject.id}
    assert owner_subject.user_id is None
```

- [ ] Implement policy checksum, lock-current-pointer OCC, immutable version insert, guardrail validation, and pointer swap in one transaction.

```python
def update_family_policy(db: Session, command: PolicyUpdateCommand) -> ModelUsagePolicyVersion:
    pointer = lock_family_policy(db, family_id=command.family_id)
    current = require_current_policy(db, pointer)
    if current.version_number != command.base_version_number:
        raise ModelUsagePolicyConflict(current)
    validated = validate_policy_command(command)
    actor_subject = require_family_subject(
        db, family_id=command.family_id, subject_id=command.actor_subject_id
    )
    next_version = insert_policy_version(
        db, current=current, command=validated, created_by_subject_id=actor_subject.id
    )
    pointer.current_policy_version_id = next_version.id
    db.flush()
    return next_version
```

`lock_family_policy` is the shared linearization lock for policy update, reserve admission, and Task 6 first dispatch authorization. Callers must acquire it before reservation/counter locks; a route or adapter must not invent a second lock order.

- [ ] Implement first-family defaults in FK-safe order: the caller has already flushed `Family`, membership and creator user subject; validate that creator subject belongs to the family, ensure/flush the system subject, insert immutable version 1 with `created_by_subject_id`, flush it, then insert the non-null current pointer in the same caller-owned transaction.

```python
def ensure_family_model_usage_defaults(
    db: Session,
    *,
    family_id: str,
    creator_subject_id: str,
) -> ModelUsageFamilyPolicy:
    existing = db.get(ModelUsageFamilyPolicy, family_id)
    if existing is not None:
        return existing
    creator_subject = require_family_subject(
        db, family_id=family_id, subject_id=creator_subject_id
    )
    ensure_system_subject(db, family_id=family_id)
    db.flush()
    version = create_default_policy_version(
        family_id=family_id,
        version_number=1,
        created_by_subject_id=creator_subject.id,
    )
    db.add(version)
    db.flush()
    pointer = ModelUsageFamilyPolicy(
        family_id=family_id,
        current_policy_version_id=version.id,
        tracking_started_at=utcnow(),
    )
    db.add(pointer)
    db.flush()
    return pointer
```

- [ ] Modify `initialize_configured_admin` so family, owner membership, system subject, user subject, and default policy commit together.

```python
membership = Membership(
    id=create_id("membership"),
    family_id=family.id,
    user_id=user.id,
    role=UserRole.OWNER,
    status=MembershipStatus.ACTIVE,
    created_by=system_actor,
    updated_by=system_actor,
)
db.add_all([credential, membership])
db.flush()
creator_subject = ensure_user_subject(db, family_id=family.id, user_id=user.id)
ensure_family_model_usage_defaults(
    db,
    family_id=family.id,
    creator_subject_id=creator_subject.id,
)
commit_session(db)
```

- [ ] Modify `create_member` to ensure/reuse the family/user subject before the existing commit.

```python
db.add_all([credential, member_membership])
ensure_user_subject(db, family_id=membership.family_id, user_id=member_user.id)
log_activity(
    db,
    family_id=membership.family_id,
    actor_id=user.id,
    action=ActivityAction.INVITE,
    entity_type="Membership",
    entity_id=member_membership.id,
    summary=f"邀请 {member_user.display_name} 成为{'管理员' if payload.role.value == 'Owner' else '成员'}",
    highlight=ActivityHighlight(
        kind=ActivityHighlightKind.FAMILY,
        summary=f"邀请 {member_user.display_name} 加入家庭",
    ),
)
commit_session(db)
```

- [ ] Add a lifecycle contract test that scans production `Family(` and active `Membership(` creation sites and fails if a site does not call the initialization hook in the same function.

```python
def test_production_family_creation_calls_model_usage_defaults() -> None:
    bootstrap_source = Path("app/services/bootstrap.py").read_text()
    family_source = Path("app/api/family.py").read_text()
    assert "Family(" in bootstrap_source
    assert "Membership(" in bootstrap_source
    assert "ensure_family_model_usage_defaults(" in bootstrap_source
    assert "ensure_user_subject(" in bootstrap_source
    assert bootstrap_source.index("ensure_family_model_usage_defaults(") < bootstrap_source.index("commit_session(db)")
    assert "Membership(" in family_source
    assert "ensure_user_subject(" in family_source
    assert family_source.index("ensure_user_subject(") < family_source.index("commit_session(db)")
```

- [ ] Run focused identity/policy/bootstrap/family tests.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_subjects.py tests/model_usage/test_policies.py tests/account/test_account_management.py tests/family/test_family_api.py -q
cd ..
git diff --check
```

Expected: all tests pass; default bootstrap creates one system and one owner subject with policy version 1.

- [ ] Commit Task 4.

```bash
git add backend/app/repos/model_usage/identity.py backend/app/services/model_usage/subjects.py backend/app/services/model_usage/policies.py backend/app/services/bootstrap.py backend/app/api/family.py backend/tests/model_usage backend/tests/account/test_account_management.py backend/tests/family/test_family_api.py
git commit -m "feat(model-usage): add subject and policy lifecycle"
```

---
## Task 5: Strong counters, conservative estimators, reservation idempotency, and budget decisions

**Files**

- Create: `backend/app/repos/model_usage/ledger.py`
- Create: `backend/app/services/model_usage/counters.py`
- Create: `backend/app/services/model_usage/estimators.py`
- Create: `backend/app/services/model_usage/reservations.py`
- Create: `backend/tests/model_usage/test_estimators.py`
- Create: `backend/tests/model_usage/test_reservations.py`
- Create: `backend/tests/model_usage/test_reservation_mysql_concurrency.py`

**Interfaces**

- Consumes: current policy pointer/version, stable subject, price snapshot, `UsageContext`, and conservative `UsageEstimate`.
- Produces: `ReservationDecision` with `decision=allowed|blocked|already_accounted`, immutable reservation/event identity, admission pricing/policy snapshots, and stable error code. `already_accounted` means the same fingerprint already has an event and must not call the provider; business output is recovered from the owning job/conversation/media state because the usage ledger never stores it. Final provider-send authorization remains Task 6's current-policy dispatch gate.
- Locked internal signature: `reserve_usage_in_session(db, context, estimate, *, fingerprint, at, expected_policy_version_id=None) -> ReservationDecision`.
- Counter lock order is always family cost → capability cost → capability meter; unique `dimension_key` constructors live in `counters.py`.

- [ ] Add failing estimator tests for explicit LLM output caps, realtime 30-second leases, exact embedding batch size, rerank candidate count, STT duration, final TTS characters, and image count/variant.

```python
def test_llm_estimator_requires_output_cap() -> None:
    with pytest.raises(ModelUsageContractError, match="llm_output_cap_required"):
        estimate_llm(input_tokens=120, cached_input_tokens=20, max_output_tokens=None)

def test_realtime_estimator_reserves_only_next_lease() -> None:
    estimate = estimate_realtime_audio(
        billable_meters=frozenset({
            ModelUsageMeter.AUDIO_INPUT_SECONDS,
            ModelUsageMeter.AUDIO_OUTPUT_SECONDS,
        }),
        lease_seconds=Decimal("30"),
        input_tokens_per_second_cap=None,
        output_tokens_per_second_cap=None,
    )
    assert {line.quantity for line in estimate.meters} == {Decimal("30.000000")}

def test_realtime_token_scheme_uses_explicit_conservative_caps() -> None:
    estimate = estimate_realtime_audio(
        billable_meters=frozenset({
            ModelUsageMeter.AUDIO_INPUT_TOKENS,
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS,
        }),
        lease_seconds=Decimal("30"),
        input_tokens_per_second_cap=Decimal("50"),
        output_tokens_per_second_cap=Decimal("100"),
    )
    assert estimate.quantity(ModelUsageMeter.AUDIO_INPUT_TOKENS) == Decimal("1500.000000")
    assert estimate.quantity(ModelUsageMeter.AUDIO_OUTPUT_TOKENS) == Decimal("3000.000000")
```

- [ ] Implement pure estimators that return normalized quantities but do not select prices or touch the database.

```python
def estimate_rerank(*, document_count: int) -> UsageEstimate:
    require_positive_integer(document_count, field="document_count")
    return UsageEstimate(meters=(
        meter_quantity(ModelUsageMeter.RERANK_REQUESTS, 1),
        meter_quantity(ModelUsageMeter.RERANK_DOCUMENTS, document_count),
    ))
```

- [ ] Add failing reservation tests for subject resolution, priced/unpriced monitoring, hard-limit missing price, full-precision budget checks, billable/informational/unpriced meter guardrails, and attempt replay.

```python
def test_hard_limit_rejects_unpriced_before_dispatch(usage_db, hard_limit_policy, context) -> None:
    estimate = estimate_llm(input_tokens=100, cached_input_tokens=20, max_output_tokens=200)
    result = reserve_usage_in_session(
        usage_db,
        context,
        estimate,
        fingerprint="hmac:request-a",
        at=NOW,
    )
    assert result.decision == "blocked"
    assert result.error_code == "model_usage_price_unavailable"
    assert count_provider_dispatches() == 0

def test_same_attempt_and_fingerprint_replays_reservation(usage_db, context, estimate) -> None:
    first = reserve_usage_in_session(usage_db, context, estimate, fingerprint="hmac:request-a", at=NOW)
    second = reserve_usage_in_session(usage_db, context, estimate, fingerprint="hmac:request-a", at=NOW)
    assert first.reservation_id == second.reservation_id
    assert counter_value(usage_db, "family_cost", "reserved") == first.reserved_cost_cny

def test_same_attempt_with_different_fingerprint_is_rejected(usage_db, context, estimate) -> None:
    reserve_usage_in_session(usage_db, context, estimate, fingerprint="hmac:request-a", at=NOW)
    with pytest.raises(ModelUsageAttemptConflict):
        reserve_usage_in_session(usage_db, context, estimate, fingerprint="hmac:request-b", at=NOW)

def test_same_attempt_with_existing_event_returns_already_accounted(usage_db, settled_context, estimate) -> None:
    decision = reserve_usage_in_session(
        usage_db, settled_context, estimate, fingerprint=settled_context.fingerprint, at=NOW
    )
    assert decision.decision == "already_accounted"
    assert decision.existing_event_id == settled_context.event_id
    assert count_provider_dispatches() == 0

def test_unpriced_informational_meter_still_reserves_guardrail_quantity(
    usage_db, monitoring_meter_policy, context
) -> None:
    estimate = estimate_with_informational_meter("total_tokens", quantity="300")
    decision = reserve_usage_in_session(usage_db, context, estimate, fingerprint="fp-meter", at=NOW)
    assert decision.pricing_status == "unpriced"
    assert counter_value(usage_db, "capability_meter:llm:total_tokens", "reserved") == Decimal("300")

def test_unselected_guardrail_eligible_meter_counter_is_still_maintained(
    usage_db, policy_selecting_capability_cost, context
) -> None:
    estimate = estimate_with_informational_meter("total_tokens", quantity="300")
    reserve_usage_in_session(usage_db, context, estimate, fingerprint="fp-all-counters", at=NOW)
    assert counter_value(usage_db, "capability_meter:llm:total_tokens", "reserved") == Decimal("300")
```

The test helper must use explicit values rather than a provider call; no adapter is connected in this Task.

- [ ] Implement canonical counter dimension keys and repository upsert/lock helpers.

```python
def family_cost_dimension_key() -> str:
    return "family_cost"

def capability_cost_dimension_key(capability: ModelUsageCapability) -> str:
    return f"capability_cost:{capability.value}"

def capability_meter_dimension_key(capability: ModelUsageCapability, meter: ModelUsageMeter) -> str:
    return f"capability_meter:{capability.value}:{meter.value}"
```

- [ ] Implement counter creation with duplicate-key retry followed by `SELECT FOR UPDATE`, never relying on nullable unique columns.

```python
def lock_or_create_counter(db: Session, key: CounterKey) -> ModelUsagePeriodCounter:
    counter = select_counter_for_update(db, key)
    if counter is not None:
        return counter
    insert_counter_with_savepoint(db, key)
    return require_counter_for_update(db, key)
```

- [ ] Implement reservation fingerprint/idempotency with the database unique claim before any counter mutation: same attempt/same fingerprint replays; same attempt/different fingerprint raises `model_usage_attempt_conflict`.

```python
existing = lock_reservation_by_attempt(db, family_id=context.attribution.family_id, attempt_key=context.attempt_key)
if existing is not None:
    return replay_reservation_or_conflict(existing, fingerprint)

try:
    with db.begin_nested():
        reservation = build_reservation_claim(context, fingerprint, policy, price, period)
        db.add(reservation)
        db.flush()  # claims uq_model_usage_reservation_attempt before meter/counter writes
except IntegrityError:
    winner = require_reservation_by_attempt_for_update(
        db, family_id=context.attribution.family_id, attempt_key=context.attempt_key
    )
    return replay_reservation_or_conflict(winner, fingerprint)
```

The family-policy pointer lock also protects the cross-table attempt namespace: before inserting a reservation, query both reservation and event by `(family_id, attempt_key)`. A same-fingerprint event returns `ReservationDecision.already_accounted(event.id)` instead of creating a late reservation; a different fingerprint conflicts. The decision replays only the content-free ledger outcome, never invents the provider/business response. This is required because separate reservation/event unique indexes cannot prevent one winner in each table. The insert claim occurs after read-only validation/required locks but before reservation meter insertion or `reserved_value` mutation. A unique loser never resumes the create path. The MySQL test must prove this under real concurrent sessions; a service lookup test alone is insufficient.

- [ ] Implement admission price/policy selection, stable subject resolution, Beijing period selection, and ordered counter locks; acquire the shared family-policy pointer before counters and persist its immutable version as `policy_version_id`.

```python
policy = require_current_policy_snapshot(db, family_id=context.attribution.family_id)
subject = resolve_subject(db, context.attribution)
price = select_price_snapshot(db, context, estimate, at=at)
period = shanghai_billing_period(at)
counter_keys = contract_counter_keys(context, estimate)
counters = [lock_or_create_counter(db, key) for key in counter_keys]
```

- [ ] Implement full-precision family/capability limit evaluation; monitoring mode admits unpriced, hard limit rejects it before reservation creation.

```python
effective = counter.settled_value + counter.adjustment_value + counter.reserved_value
if policy.hard_limit_enabled and effective + requested_value > limit_value:
    return ReservationDecision.blocked(
        "model_usage_capability_limit_exceeded" if counter.capability else "model_usage_budget_exceeded"
    )
```

- [ ] Insert reservation meter snapshots for the complete configured-variant contract (billable plus required informational/guardrail quantities), assert billable-line sum, and update every policy-independent matching `reserved_value` counter in the same transaction. Capability meter counters match capability/meter contract identity regardless of pricing status or meter role; Task 6 therefore revalidates a newly selected current guardrail against a counter that already includes all active reservations.

```python
reservation.reserved_cost_cny = (
    sum((line.reserved_cost_cny for line in meter_rows if line.reserved_cost_cny is not None), Decimal("0"))
    if price.pricing_status is ModelUsagePricingStatus.PRICED
    else None
)
assert_priced_reservation_sum(reservation, meter_rows)
apply_reserved_counter_delta(counters, reservation, direction=Decimal("1"))
```

- [ ] Add the 50-thread MySQL gate using a shared barrier and one session per worker.

```python
def test_fifty_concurrent_reservations_do_not_oversell(mysql_usage_context) -> None:
    results = run_barriered([
        lambda index=index: reserve_three_cny(mysql_usage_context, attempt_key=f"attempt-{index}")
        for index in range(50)
    ])
    assert sum(result.decision == "allowed" for result in results) == 33
    assert sum(result.decision == "blocked" for result in results) == 17
    assert mysql_usage_context.family_reserved_value() == Decimal("99.000000000000")

def test_fifty_same_attempt_claims_mutate_counter_once(mysql_usage_context) -> None:
    results = run_barriered([
        lambda: mysql_usage_context.reserve(cost="3", attempt_key="same-attempt", fingerprint="fp-a")
        for _ in range(50)
    ])
    assert len({result.reservation_id for result in results}) == 1
    assert mysql_usage_context.family_reserved_value() == Decimal("3.000000000000")

def test_concurrent_same_attempt_different_fingerprint_has_one_winner(mysql_usage_context) -> None:
    results = run_barriered([
        lambda fingerprint=fingerprint: mysql_usage_context.capture_reserve(
            cost="3", attempt_key="conflicting-attempt", fingerprint=fingerprint
        )
        for fingerprint in ("fp-a", "fp-b")
    ])
    assert sum(result.allowed for result in results) == 1
    assert sum(result.error_code == "model_usage_attempt_conflict" for result in results) == 1
    assert mysql_usage_context.family_reserved_value() == Decimal("3.000000000000")
```

- [ ] Run pure/service tests and the MySQL gate.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_estimators.py tests/model_usage/test_reservations.py tests/model_usage/test_reservation_mysql_concurrency.py -q
cd ..
git diff --check
```

Expected: all unit/service tests pass; MySQL records exactly 33 allowed, 17 blocked, ¥99 reserved; same-attempt races create one reservation/counter delta; mixed fingerprints produce one winner and one stable conflict, with no negative or duplicate counter rows.

- [ ] Commit Task 5.

```bash
git add backend/app/repos/model_usage/ledger.py backend/app/services/model_usage/counters.py backend/app/services/model_usage/estimators.py backend/app/services/model_usage/reservations.py backend/tests/model_usage
git commit -m "feat(model-usage): add reservation and strong counters"
```

---

## Task 6: Durable dispatch intent, state machine, exact settlement, and receipt retry queue

**Files**

- Create: `backend/app/services/model_usage/state_machine.py`
- Create: `backend/app/services/model_usage/dispatch.py`
- Create: `backend/app/services/model_usage/settlement.py`
- Create: `backend/app/services/model_usage/receipts.py`
- Create: `backend/tests/model_usage/test_state_machine.py`
- Create: `backend/tests/model_usage/test_dispatch.py`
- Create: `backend/tests/model_usage/test_dispatch_policy_mysql_concurrency.py`
- Create: `backend/tests/model_usage/test_settlement.py`
- Create: `backend/tests/model_usage/test_receipts.py`
- Create: `backend/tests/model_usage/test_usage_transaction_isolation.py`

**Interfaces**

- Consumes: an admitted reservation, current immutable policy pointer, payload HMAC fingerprint, recovery policy, and content-free provider receipt.
- Produces: a current-policy `first_send` `DispatchPermit`, a committed pre-dispatch release/block, or `recovery_required` for an existing durable intent; one immutable event at most, meter lines, counter deltas, and `UsageSettlement`.
- `ProviderUsageReceipt` may contain `reservation_id=None` only for the fail-open recovery path implemented in Task 7.
- Every receipt is a content-free, self-contained accounting identity: capability/provider/model/variant/scheme, original period/timestamps, admission/dispatch policy IDs and pricing snapshot are validated against the reservation or live consumed fail-open proof before settlement. Every receipt is canonically HMAC-signed; post-restart fail-open recovery requires a valid retained verification key and non-null `fail_open_proof_id` because the process-local proof registry no longer exists.
- The `recovery_policy` argument is an internal adapter value and must exactly equal the trusted configured-variant registry entry resolved from the reservation; a caller cannot upgrade mode/windows or provide its own provider idempotency key.
- `ProviderUsageReceiptSigner` is injected into receipt builders in this Task; tests use a fixed secret fixture, and Task 10 wires the production active-key/keyring settings. No module reads a key from request data or logs it.
- In-memory `ProviderUsageReceiptQueue` is bounded and writes an allowlisted structured log; it is explicitly not a financial WAL.

- [ ] Add failing state-machine tests for every legal reservation transition and illegal outcome/certainty pair.

```python
@pytest.mark.parametrize("outcome, certainty", [
    ("succeeded", "confirmed_executed"),
    ("failed_billed", "confirmed_executed"),
    ("unknown", "unknown"),
    ("not_billed", "confirmed_not_executed"),
    ("not_billed", "confirmed_executed"),
])
def test_valid_event_outcome_pairs(outcome: str, certainty: str) -> None:
    validate_event_outcome(ModelUsageProviderOutcome(outcome), ModelUsageExecutionCertainty(certainty))

def test_succeeded_cannot_be_unknown() -> None:
    with pytest.raises(ModelUsageStateError):
        validate_event_outcome(ModelUsageProviderOutcome.SUCCEEDED, ModelUsageExecutionCertainty.UNKNOWN)
```

- [ ] Implement explicit transition maps and outcome validation in `state_machine.py`; no caller may assign arbitrary strings.

```python
ALLOWED_RESERVATION_TRANSITIONS = {
    ModelUsageReservationStatus.RESERVED: {
        ModelUsageReservationStatus.DISPATCHING,
        ModelUsageReservationStatus.RELEASED,
    },
    ModelUsageReservationStatus.DISPATCHING: {
        ModelUsageReservationStatus.SETTLED,
        ModelUsageReservationStatus.RELEASED,
        ModelUsageReservationStatus.UNCERTAIN,
    },
    ModelUsageReservationStatus.UNCERTAIN: {
        ModelUsageReservationStatus.SETTLED,
        ModelUsageReservationStatus.RELEASED,
    },
}
```

- [ ] Add failing dispatch tests for current-policy revalidation, atomic admission/dispatch policy evidence and recovery fields, same-fingerprint replay, conflicting fingerprint, committed pre-dispatch release, and state-write failure before any network callback.

```python
def test_dispatch_failure_never_calls_provider(usage_service, reservation, provider_spy) -> None:
    usage_service.fail_next_dispatch_commit()
    with pytest.raises(ModelUsageLedgerUnavailable):
        usage_service.dispatch_and_call(reservation.id, fingerprint="fp-a", provider_call=provider_spy)
    provider_spy.assert_not_called()

def test_new_hard_limit_rejects_old_unpriced_reservation_before_send(
    usage_service, monitoring_unpriced_reservation, enable_hard_limit, provider_spy
) -> None:
    new_policy = enable_hard_limit()
    with pytest.raises(ModelUsageBlocked, match="model_usage_price_unavailable"):
        usage_service.dispatch_and_call(
            monitoring_unpriced_reservation.id,
            fingerprint=monitoring_unpriced_reservation.fingerprint,
            provider_call=provider_spy,
        )
    provider_spy.assert_not_called()
    assert monitoring_unpriced_reservation.status == "released"
    assert monitoring_unpriced_reservation.dispatch_policy_version_id is None
    assert monitoring_unpriced_reservation.pre_dispatch_denial_policy_version_id == new_policy.id
    assert reserved_counter_value() == Decimal("0")

def test_dispatch_replay_with_none_mode_does_not_issue_second_send(
    usage_service, already_dispatching_reservation, provider_spy
) -> None:
    with pytest.raises(ModelUsageDispatchRecoveryRequired, match="model_usage_dispatch_recovery_required"):
        usage_service.dispatch_and_call(
            already_dispatching_reservation.id,
            fingerprint=already_dispatching_reservation.fingerprint,
            provider_call=provider_spy,
        )
    provider_spy.assert_not_called()

def test_dispatch_revalidates_new_meter_guardrail_from_complete_counter(
    usage_service, reservation_with_total_tokens_300, switch_to_total_token_limit_200, provider_spy
) -> None:
    new_policy = switch_to_total_token_limit_200()
    with pytest.raises(ModelUsageBlocked, match="model_usage_capability_limit_exceeded"):
        usage_service.dispatch_and_call(
            reservation_with_total_tokens_300.id,
            fingerprint=reservation_with_total_tokens_300.fingerprint,
            provider_call=provider_spy,
        )
    provider_spy.assert_not_called()
    assert reservation_with_total_tokens_300.pre_dispatch_denial_policy_version_id == new_policy.id
```

- [ ] Implement `prepare_usage_dispatch` as a separate committed transaction. On the first `reserved → dispatching`, discover family scope without trusting caller input, then lock current family-policy pointer → reservation → counters; revalidate current hard limit/price/guardrails and store `dispatch_policy_version_id`, `client_attempt_id`, recovery windows, optional idempotency key, and `dispatching_at`. Keep the internal helper name locked as `prepare_usage_dispatch_in_session`.

```python
def prepare_usage_dispatch(
    reservation_id: str,
    *,
    fingerprint: str,
    recovery_policy: ProviderRecoveryPolicy,
    session_factory: Callable[[], Session] = SessionLocal,
) -> DispatchPermit:
    with session_factory() as db:
        with db.begin():
            outcome = prepare_usage_dispatch_in_session(
                db,
                reservation_id=reservation_id,
                fingerprint=fingerprint,
                recovery_policy=recovery_policy,
            )
    return outcome.require_first_send_permit()  # block/recovery_required state is committed before raising

def prepare_usage_dispatch_in_session(
    db: Session,
    *,
    reservation_id: str,
    fingerprint: str,
    recovery_policy: ProviderRecoveryPolicy,
) -> DispatchGateOutcome:
    identity = require_reservation_identity(db, reservation_id=reservation_id)
    pointer = lock_family_policy(db, family_id=identity.family_id)
    current_policy = require_current_policy(db, pointer)
    reservation = lock_family_reservation(db, family_id=identity.family_id, reservation_id=reservation_id)
    replay_outcome = classify_existing_dispatch(reservation, fingerprint)
    if replay_outcome is not None:
        return replay_outcome  # durable identity only; never another first_send permit
    counters = lock_reservation_counters(db, reservation)
    blocked = evaluate_current_dispatch_policy(current_policy, reservation, counters)
    if blocked is not None:
        remove_reserved_values(counters, reservation)
        reservation.status = ModelUsageReservationStatus.RELEASED
        reservation.dispatch_policy_version_id = None
        reservation.pre_dispatch_denial_policy_version_id = current_policy.id
        reservation.error_code = blocked.error_code
        db.flush()
        return DispatchGateOutcome.blocked(blocked.error_code)
    apply_dispatch_intent(reservation, fingerprint=fingerprint, recovery_policy=recovery_policy)
    reservation.dispatch_policy_version_id = current_policy.id
    reservation.pre_dispatch_denial_policy_version_id = None
    db.flush()
    return DispatchGateOutcome.allowed(dispatch_permit_from(reservation))
```

If the reservation is already `dispatching`, replay is classified before current-policy blocking because the durable send intent may already have left the process. Same fingerprint returns the existing dispatch identity as `recovery_required`, not a new `first_send` permit; a different fingerprint remains a stable conflict. Task 7 is the only place that may turn this state into `idempotent_resend`, and only while the stored provider contract/window permits it. Queryable recovery performs a read-only query, while mode `none` never sends. A new policy never rewrites `policy_version_id`; successful authorization is recorded in `dispatch_policy_version_id`, while a pre-send policy rejection is recorded separately in `pre_dispatch_denial_policy_version_id`.

- [ ] Add a real MySQL interleaving test proving policy update and first dispatch share one linearization lock: update commit first makes the reserved attempt use/block under the new version; dispatch commit first returns a durable permit that the later update does not revoke.

```python
def test_policy_update_and_first_dispatch_have_total_order(mysql_dispatch_context) -> None:
    update_first = mysql_dispatch_context.run_interleaving(order="policy_then_dispatch")
    assert update_first.provider_send_count == 0
    assert update_first.reservation_status == "released"
    assert update_first.dispatch_policy_version_id is None
    assert update_first.pre_dispatch_denial_policy_version_id == update_first.new_policy_version_id

    dispatch_first = mysql_dispatch_context.run_interleaving(order="dispatch_then_policy")
    assert dispatch_first.provider_send_count == 1
    assert dispatch_first.reservation_status == "dispatching"
    assert dispatch_first.dispatch_policy_version_id == dispatch_first.old_policy_version_id

def test_concurrent_first_dispatch_issues_one_first_send_permit(mysql_dispatch_context) -> None:
    results = run_barriered([
        lambda: mysql_dispatch_context.prepare_same_reserved_attempt()
        for _ in range(50)
    ])
    assert sum(result.send_kind == "first_send" for result in results) == 1
    assert sum(result.error_code == "model_usage_dispatch_recovery_required" for result in results) == 49
    assert mysql_dispatch_context.provider_send_count == 1
```

- [ ] Add failing settlement tests for cached input normalization, exact/informational roles, unpriced missing rate, unpriced/informational capability meter counting, not-billed zero exception, unknown usage never becoming zero, event-attempt replay/conflict, and event-cost equality.

```python
def test_cached_input_is_not_double_billed(priced_reservation) -> None:
    receipt = llm_receipt(input_tokens=100, cached_input_tokens=40, output_tokens=10)
    settlement = settle_usage(receipt)
    assert settlement.quantity(ModelUsageMeter.UNCACHED_INPUT_TOKENS) == Decimal("60")
    assert settlement.quantity(ModelUsageMeter.CACHED_INPUT_TOKENS) == Decimal("40")
    assert settlement.informational_quantity(ModelUsageMeter.TOTAL_TOKENS) == Decimal("110")
    assert settlement.cost_cny == sum(settlement.billable_line_costs, Decimal("0"))
```

- [ ] Implement meter-set validation against the reservation billing scheme and reject `cached_input_tokens > input_tokens`.

```python
normalized = normalize_receipt_meters(receipt, reservation_scheme)
if normalized.billable_meter_set != reservation_scheme.billable_meter_set:
    raise ModelUsageSettlementPending("model_usage_settlement_pending")
if normalized.cached_input_tokens > normalized.input_tokens:
    raise ModelUsageSettlementPending("cached_input_exceeds_input")
```

Normal settlement first verifies the canonical receipt HMAC, then requires the receipt's family/subject, capability/provider, requested/billing model, variant/scheme, attempt/client identity, period, `policy_version_id`, `dispatch_policy_version_id`, pricing identity and dispatch time to match the reservation; `fail_open_proof_id` must be null. Live fail-open settlement validates the same fields and proof ID against its consumed permit. After restart, fail-open recovery requires `reservation_id=None`, a non-null proof ID, a valid receipt HMAC/key ID and the trusted allowlist log record; it does not pretend the vanished in-memory registry is still queryable. `meter_watermarks` must be empty outside realtime; Task 15 validates each realtime baseline/end/sequence against the active lease and durable row. A mismatch is a settlement conflict, never an invitation to substitute the current policy, period, model alias or price catalog.

- [ ] Implement settlement lock order, database-backed unique event claim, reserved removal, settled addition, and reservation terminal transition in one transaction. Claim `(family_id, attempt_key)`/unique `reservation_id` before any counter mutation; a unique loser locks the winner and replays only when fingerprint matches.

```python
identity = require_reservation_identity(db, reservation_id=receipt.reservation_id)
pointer = lock_family_policy(db, family_id=identity.family_id)
current_policy = require_current_policy(db, pointer)  # Task 8 alert linearization; not event repricing
reservation = lock_family_reservation(db, family_id=identity.family_id, reservation_id=receipt.reservation_id)
existing = event_for_reservation(db, reservation.id)
if existing is not None:
    return replay_event_or_conflict(existing, receipt.fingerprint)
counters = lock_reservation_counters(db, reservation)
try:
    with db.begin_nested():
        event = build_event_claim_from_receipt(reservation, receipt)
        db.add(event)
        db.flush()  # claims uq_model_usage_event_attempt / unique reservation_id
except IntegrityError:
    winner = require_event_by_attempt_for_update(db, reservation.family_id, reservation.attempt_key)
    return replay_event_or_conflict(winner, receipt.fingerprint)
meter_rows = build_event_meter_rows(event, reservation, receipt)
assert_priced_event_sum(event, meter_rows)
remove_reserved_values(counters, reservation)
add_settled_values(counters, event, meter_rows)
reservation.status = terminal_status_for(event)
db.flush()
```

- [ ] Implement `not_billed` as priced exact zero with all retained meters informational and no required price version; distinguish executed-but-free from confirmed-not-executed.

```python
if receipt.provider_outcome is ModelUsageProviderOutcome.NOT_BILLED:
    event.pricing_status = ModelUsagePricingStatus.PRICED
    event.price_version_id = None
    event.cost_cny = Decimal("0")
    meter_rows = [as_informational(line) for line in receipt.meters]
```

`add_settled_values` uses event cost only for cost counters and matching meter quantity for capability meter counters. An executed-but-free informational quantity can count toward an eligible usage guardrail; a confirmed-not-executed event carries no consumed guardrail quantity. Pricing role never decides meter-counter inclusion.

- [ ] Add failing receipt queue tests for strict allowlist, canonical HMAC verification/tamper rejection, retained key IDs, bounded eviction logging, exact retry, and absence of user/content fields.

```python
def test_receipt_log_is_allowlisted(caplog, provider_receipt) -> None:
    ProviderUsageReceiptQueue(max_size=2).enqueue(provider_receipt)
    payload = parse_structured_receipt(caplog.text)
    assert "user_id" not in payload
    assert "prompt" not in payload
    assert set(payload) <= PROVIDER_USAGE_RECEIPT_LOG_FIELDS

def test_tampered_logged_receipt_cannot_create_event(receipt_signer, provider_receipt) -> None:
    signed = receipt_signer.sign(provider_receipt)
    tampered = replace(signed, capability=ModelUsageCapability.IMAGE_GENERATION)
    with pytest.raises(ModelUsageReceiptIntegrityError, match="receipt_integrity_invalid"):
        verify_provider_usage_receipt(tampered)
```

- [ ] Implement queue/log serialization and HMAC fingerprinting; raw provider errors and business content are never accepted by the receipt type.

```python
PROVIDER_USAGE_RECEIPT_LOG_FIELDS = frozenset({
    "reservation_id", "family_id", "subject_key", "capability", "provider", "requested_model",
    "reported_model", "billing_model", "variant_key", "billing_scheme_key",
    "attempt_key", "fingerprint", "client_attempt_id", "period_start", "period_end",
    "policy_version_id", "dispatch_policy_version_id",
    "provider_request_id", "provider_outcome", "execution_certainty",
    "measurement_status", "pricing_status", "meters", "meter_watermarks",
    "dispatched_at", "completed_at",
    "price_version_id", "price_snapshot", "price_snapshot_checksum",
    "fail_open_proof_id", "integrity_key_id", "integrity_hmac",
})
```

`price_snapshot` serialization is itself a closed schema containing only version/rate/FX/unit metadata and Decimal strings. `integrity_hmac` uses a dedicated, domain-separated keyring (not the request-fingerprint or JWT key) and covers the canonical allowlisted receipt payload excluding only itself; verification keys remain available for at least the receipt log/recovery retention window, and secrets are never logged. If the structured log is unavailable, receipt HMAC fails, or its key has expired, no post-restart recovered event is created. If only the price snapshot checksum fails, recovery may keep exact meters but forces `pricing_status=unpriced`; it never applies the current catalog retroactively.

- [ ] Add transaction-isolation tests proving caller rollback cannot remove usage and usage commit cannot commit an unapproved caller draft.

```python
def test_provider_usage_survives_business_rollback(business_db, usage_service, dispatched) -> None:
    business_db.add(unapproved_draft())
    settle_usage(exact_receipt(dispatched))
    business_db.rollback()
    assert usage_service.event_count(dispatched.reservation_id) == 1
    assert business_db.scalar(select(AITaskDraft)) is None
```

- [ ] Run all Task 6 tests.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_state_machine.py tests/model_usage/test_dispatch.py tests/model_usage/test_dispatch_policy_mysql_concurrency.py tests/model_usage/test_settlement.py tests/model_usage/test_receipts.py tests/model_usage/test_usage_transaction_isolation.py -q
cd ..
git diff --check
```

Expected: one event/counter mutation per reservation; queue payload contains only allowlisted recovery fields.

- [ ] Commit Task 6.

```bash
git add backend/app/services/model_usage/state_machine.py backend/app/services/model_usage/dispatch.py backend/app/services/model_usage/settlement.py backend/app/services/model_usage/receipts.py backend/tests/model_usage
git commit -m "feat(model-usage): add dispatch settlement and receipts"
```

---

## Task 7: Monitoring fail-open, measurement incidents, uncertain recovery, and 24-hour conservative settlement

**Files**

- Create: `backend/app/repos/model_usage/incidents.py`
- Create: `backend/app/services/model_usage/outage_latch.py`
- Create: `backend/app/services/model_usage/incidents.py`
- Create: `backend/app/services/model_usage/recovery.py`
- Create: `backend/app/services/model_usage/facade.py`
- Create: `backend/tests/model_usage/test_fail_open.py`
- Create: `backend/tests/model_usage/test_incidents.py`
- Create: `backend/tests/model_usage/test_recovery.py`
- Create: `backend/tests/model_usage/test_crash_windows.py`

**Interfaces**

- Consumes: a short-lived, single-use dispatch-eligibility proof from the same attempt (fresh current monitoring policy, resolved stable subject, period, billing scheme and available price snapshot), dispatch timestamps/windows, receipt queue, optional provider query handler.
- Produces: `decision=fail_open` with one sealed `fail_open_single_send` permit only after that complete proof and a later ledger write failure; explicit `idempotent_resend` permits only for stored provider contracts still inside their resend window; exact/partial/unknown incident fragments; recovery/estimated settlement.
- `ProviderRecoveryHandler.query_original_attempt(client_attempt_id) -> ProviderUsageReceipt | None` is read-only. Maintenance never calls a method that creates a new provider generation.
- Current adapters remain `recovery_mode=none`; fake handlers exercise the generic idempotency/query contracts.

- [ ] Add failing fail-open tests for current monitoring policy, hard limit, unreadable/stale policy, proof expiry/single-use, policy-update interleaving, classified connectivity/commit-unknown reservation failure, non-infrastructure SQL errors that must fail closed, and family-less unknown scope.

```python
def test_only_proven_current_monitoring_policy_can_fail_open(failing_ledger, current_monitoring_policy) -> None:
    decision = failing_ledger.reserve(
        context(),
        estimate(),
        fingerprint="hmac:request-a",
        policy=current_monitoring_policy,
    )
    assert decision.decision == "fail_open"
    assert decision.policy_version_id == current_monitoring_policy.id
    assert decision.fail_open_permit.send_kind == "fail_open_single_send"
    assert decision.fail_open_permit.dispatch_policy_version_id == current_monitoring_policy.id
    assert_pricing_identity_is_self_consistent(decision.fail_open_permit)

@pytest.mark.parametrize(
    "policy_state",
    ["hard_limit", "unreadable", "stale_pointer", "subject_unreadable", "billing_contract_unreadable"],
)
def test_incomplete_or_hard_dispatch_proof_fails_closed(failing_ledger, policy_state: str) -> None:
    decision = failing_ledger.reserve(
        context(),
        estimate(),
        fingerprint="hmac:request-a",
        policy=policy_fixture(policy_state),
    )
    assert decision.decision == "blocked"
    assert decision.error_code == "model_usage_ledger_unavailable"

def test_proof_linearizes_at_fresh_read_but_cannot_be_revoked_cross_system(
    failing_ledger, current_monitoring_policy, enable_hard_limit
) -> None:
    proof = failing_ledger.issue_dispatch_proof(current_monitoring_policy)
    enable_hard_limit()
    decision = failing_ledger.fail_open_with(proof)
    assert decision.decision == "fail_open"
    assert decision.policy_version_id == current_monitoring_policy.id
    with pytest.raises(ModelUsageProofConsumed):
        failing_ledger.fail_open_with(proof)

def test_fail_open_permit_can_authorize_only_one_provider_send(failing_ledger, current_monitoring_policy) -> None:
    decision = failing_ledger.reserve_with_write_failure(current_monitoring_policy)
    first = consume_fail_open_dispatch_permit(decision.fail_open_permit, at=NOW)
    assert first.send_kind == "fail_open_single_send"
    with pytest.raises(ModelUsageProofConsumed):
        consume_fail_open_dispatch_permit(decision.fail_open_permit, at=NOW)

def test_proof_issued_after_hard_limit_commit_is_rejected(failing_ledger, enable_hard_limit) -> None:
    enable_hard_limit()
    assert failing_ledger.try_issue_dispatch_proof() is None
```

- [ ] Implement `ModelUsageFacade.reserve` so policy proof is captured only after pointer/version validation and fail-open is impossible for pre-policy failures.

```python
@dataclass(frozen=True, slots=True)
class DispatchEligibilityProof:
    proof_id: str
    family_id: str
    subject_key: str
    capability: ModelUsageCapability
    provider: str
    requested_model: str
    billing_model: str
    variant_key: str
    billing_scheme_key: str
    attempt_key: str
    client_attempt_id: str
    fingerprint: str
    policy_version_id: str
    hard_limit_enabled: bool
    issued_at: datetime
    expires_at: datetime
    period: BillingPeriod
    pricing_status: ModelUsagePricingStatus
    price_version_id: str | None
    price_snapshot: UsagePriceSnapshot | None
    price_snapshot_checksum: str | None
    recovery_policy: ProviderRecoveryPolicy

def reserve(self, context: UsageContext, estimate: UsageEstimate, *, fingerprint: str) -> ReservationDecision:
    proof: DispatchEligibilityProof | None = None
    try:
        with self.session_factory() as db:
            proof = prove_monitoring_dispatch_eligibility(
                db,
                context=context,
                estimate=estimate,
                fingerprint=fingerprint,
                at=utcnow(),
            )
            decision = reserve_usage_in_session(
                db,
                context,
                estimate,
                fingerprint=fingerprint,
                at=utcnow(),
                expected_policy_version_id=proof.policy_version_id,
            )
            db.commit()
            return decision
    except SQLAlchemyError as exc:
        if proof is None or proof.hard_limit_enabled or not is_model_usage_ledger_unavailable(exc):
            return ReservationDecision.blocked("model_usage_ledger_unavailable")
        return self._record_fail_open(context, estimate, fingerprint, proof)
```

`is_model_usage_ledger_unavailable` is a closed classifier for connectivity loss, pool exhaustion/timeout and commit outcome unknown. Unique/FK/check constraint failures, stale policy, bad meter/model identity, application exceptions and ordinary transaction conflicts never authorize provider send; deadlock/serialization cases may retry the database transaction within the proof deadline, then fail closed if still unresolved.

`DispatchEligibilityProof` is immutable, content-free, bound to the exact family/subject/capability/provider/model/variant/scheme/attempt/fingerprint, one-shot, and bounded by a short configured deadline that is shorter than any provider call timeout. `_record_fail_open` atomically exchanges the eligibility proof for one pending `DispatchPermit(send_kind="fail_open_single_send")` registered by proof ID in a thread-safe process-local `FailOpenPermitRegistry`; the permit carries the original period, pricing state/snapshot and both policy IDs (equal to the proof policy), and never reconstructs a subject from `actor_user_id` while the database is unavailable. `consume_fail_open_dispatch_permit` atomically changes that registry entry from pending to consumed and rejects expiry or a second consumer, even if two `MeteredProviderAttempt` objects hold the same decision. Neither proof nor permit is a durable reservation, so both disappear on process restart and are never reconstructed from ordinary logs for a new send. Its documented linearization point is a transaction-consistent primary-database read of the current pointer/version: a policy update committed after issuance cannot revoke the proof, while a proof read after that update must observe/block on the new hard limit.

- [ ] Add failing outage-latch tests for thread safety, process source instance, recovery flush, and cross-Beijing-month fragmentation.

```python
def test_cross_month_gap_flushes_stable_fragments(latch, incident_db) -> None:
    latch.open_unknown_scope(started_at=aware("2026-07-31T15:59:50Z"), source_instance="api-1")
    latch.recover(at=aware("2026-07-31T16:00:10Z"))
    flush_outage_latch(incident_db, latch)
    rows = incident_db.scalars(select(ModelUsageMeasurementIncident)).all()
    assert [row.period_start for row in rows] == [july_period().start_at, august_period().start_at]
```

- [ ] Implement the in-process latch with stable incident keys and structured log events; do not invent family IDs for database-wide outages.

```python
def incident_fragment_key(source_instance: str, started_at: datetime, period_start: datetime) -> str:
    raw = f"{source_instance}|{started_at.isoformat()}|{period_start.isoformat()}"
    return hashlib.sha256(raw.encode()).hexdigest()
```

- [ ] Add failing incident tests: exact scope counts unresolved attempt rows, partial scope keeps count plus gap, unknown scope has no attempt rows/count/cost.

```python
def test_unknown_scope_exposes_gap_without_counts(db) -> None:
    incident = record_incident(db, incident_command(coverage="unknown_scope", family_id=None))
    health = measurement_health(db, family_id="family-a", period=overlapping_period())
    assert incident.attempts == []
    assert health.measurement_gap is True
    assert health.known_unmeasured_attempt_count == 0
    assert health.known_unmeasured_cost_cny is None
```

- [ ] Add a full post-restart recovery test with no reservation and no price snapshot: serialize only the signed allowlist receipt, discard process registry/queue state, verify the retained HMAC key, and idempotently create an unpriced event preserving capability/provider/requested/billing model/variant/scheme, admission/dispatch policy IDs, period and meters.

```python
def test_signed_logged_fail_open_receipt_is_self_contained_after_restart(fail_open_harness) -> None:
    receipt = fail_open_harness.call_provider_and_log_receipt(
        reservation_id=None,
        price_snapshot=None,
        pricing_status="unpriced",
    )
    logged_payload = fail_open_harness.allowlisted_log_payload(receipt.attempt_key)
    fail_open_harness.restart_process_and_drop_permit_registry()
    recovered = fail_open_harness.recover_signed_logged_receipt(logged_payload)
    replay = fail_open_harness.recover_signed_logged_receipt(logged_payload)
    assert recovered.event_id == replay.event_id
    assert recovered.reservation_id is None
    assert recovered.pricing_status == "unpriced"
    assert recovered.identity == receipt.accounting_identity()
```

- [ ] Implement incident persistence and signed receipt recovery linking in the same transaction as the database-unique recovered event claim. First verify the receipt HMAC/key and fail-open proof ID, lock the same family-policy pointer used by reserve, inspect both reservation/event attempt identities, and reconcile a same-fingerprint reservation winner by removing any remaining reserved delta and closing it into the one receipt-backed event rather than creating a second accounting path. During the live process, identity fields are checked against the consumed proof/permit; after restart, they come from the previously signed allowlist receipt because the registry is intentionally gone. The current pointer is only an idempotency namespace and must not reprice/re-authorize the historical proof. This prevents duplicate ledger/counter mutation, but does not claim that recovery always wins the lock before a separate process tries to dispatch a just-created retry reservation.

```python
lock_family_policy(db, family_id=receipt.family_id)
event = claim_reconcile_or_replay_fail_open_event(db, receipt)  # checks reservation + event, then uq event
attempt = lock_incident_attempt(db, family_id=receipt.family_id, client_attempt_id=receipt.client_attempt_id)
if attempt is not None:
    attempt.recovery_status = ModelUsageIncidentRecoveryStatus.RECOVERED
    attempt.recovered_event_id = event.id
    attempt.resolved_at = utcnow()
```

- [ ] Add a MySQL concurrency test that delivers the same fail-open receipt from 50 sessions: exactly one `reservation_id IS NULL` event and one set of counter deltas exist; same fingerprint replays the winner and a different fingerprint returns `model_usage_attempt_conflict`.

```python
def test_concurrent_fail_open_receipt_recovery_claims_one_event(mysql_usage_context) -> None:
    results = run_barriered([lambda: mysql_usage_context.recover_fail_open(RECEIPT) for _ in range(50)])
    assert len({result.event_id for result in results}) == 1
    assert mysql_usage_context.event_count(attempt_key=RECEIPT.attempt_key) == 1
    assert mysql_usage_context.counter_matches_ledger()

def test_retry_reserve_and_fail_open_recovery_cannot_win_separate_tables(mysql_usage_context) -> None:
    reserve_result, recovery_result = run_barriered_pair(
        lambda: mysql_usage_context.reserve_same_attempt_as(RECEIPT),
        lambda: mysql_usage_context.recover_fail_open(RECEIPT),
    )
    assert reserve_result.decision in {"allowed", "already_accounted"}
    assert recovery_result.event_id == mysql_usage_context.event_for_attempt(RECEIPT.attempt_key).id
    assert mysql_usage_context.event_count(attempt_key=RECEIPT.attempt_key) == 1
    assert mysql_usage_context.active_reservation_count(attempt_key=RECEIPT.attempt_key) == 0
    assert mysql_usage_context.counter_matches_ledger()
```

- [ ] Add failing recovery tests for each recovery mode/window, mode `none`, provider-confirmed non-execution, and no resend after the 24-hour conservative event.

```python
def test_none_mode_never_resends_ambiguous_attempt(recovery_service, uncertain_reservation) -> None:
    recovery_service.reconcile(uncertain_reservation, at=uncertain_reservation.dispatching_at + timedelta(minutes=10))
    assert recovery_service.provider_send_count == 0

def test_query_after_estimated_event_can_only_adjust(recovery_service, estimated_event) -> None:
    recovery_service.register_query_result(estimated_event.client_attempt_id, exact_receipt_for(estimated_event))
    result = recovery_service.reconcile_event(estimated_event)
    assert result.created_event is None
    assert result.created_adjustment is not None
```

- [ ] Implement recovery-window predicates and a registry whose worker-facing protocol exposes only `query_original_attempt`.

```python
class ProviderRecoveryHandler(Protocol):
    def query_original_attempt(self, *, client_attempt_id: str) -> ProviderUsageReceipt | None:
        raise NotImplementedError("query_original_attempt must be a read-only provider lookup")

def can_query(reservation: ModelUsageReservation, at: datetime) -> bool:
    return (
        reservation.recovery_mode in QUERYABLE_MODES
        and reservation.query_window_seconds is not None
        and at <= reservation.dispatching_at + timedelta(seconds=reservation.query_window_seconds)
    )
```

- [ ] Implement a separate `prepare_idempotent_resend` transaction for synchronous transport recovery. It locks the existing reservation, verifies the same fingerprint, stored idempotency mode/key, provider window and automatic resend deadline, then returns `DispatchPermit(send_kind="idempotent_resend")`; it never rewrites dispatch policy/price evidence. Ordinary `prepare_usage_dispatch` and the maintenance worker cannot call this path implicitly. Queryable-only and `none` modes never receive a resend permit.

- [ ] Implement dispatch timeout → uncertain, 24-hour reservation hold, then one unknown/estimated event using reservation quantities and locked prices.

```python
if at >= reservation.dispatching_at + CONSERVATIVE_SETTLEMENT_AFTER:
    receipt = estimated_unknown_receipt_from_reservation(
        reservation,
        reason="provider_execution_unresolved_after_24h",
    )
    return settle_usage_in_session(db, receipt)
```

- [ ] Add crash-window tests for reserve-before-dispatch, dispatch-before-send, send-before-response, provider-success-before-settle, settle-before-business-response, receipt loss, and late reliable evidence.

```python
@pytest.mark.parametrize("crash_point", [
    "after_reserve", "after_dispatch_commit", "after_provider_send",
    "after_provider_success", "after_settle_commit", "after_business_rollback",
])
def test_crash_point_never_duplicates_ledger_attempt(crash_harness, crash_point: str) -> None:
    crash_harness.run(crash_point)
    crash_harness.recover()
    assert crash_harness.reservation_count == 1
    assert crash_harness.event_count <= 1
    assert crash_harness.counter_matches_ledger()
```

- [ ] Run Task 7 tests.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_fail_open.py tests/model_usage/test_incidents.py tests/model_usage/test_recovery.py tests/model_usage/test_crash_windows.py -q
cd ..
git diff --check
```

Expected: mode `none` produces no automated resend; unknown scope produces only gap intervals; proof timing/expiry is explicit; fail-open recovery and the 24-hour path create at most one event/counter mutation per family attempt.

- [ ] Commit Task 7.

```bash
git add backend/app/repos/model_usage/incidents.py backend/app/services/model_usage/outage_latch.py backend/app/services/model_usage/incidents.py backend/app/services/model_usage/recovery.py backend/app/services/model_usage/facade.py backend/tests/model_usage
git commit -m "feat(model-usage): add uncertain recovery and incidents"
```

---
## Task 8: Append-only adjustments, effective state resolution, threshold alerts, and negative-credit release

**Files**

- Create: `backend/app/repos/model_usage/adjustments.py`
- Create: `backend/app/services/model_usage/adjustments.py`
- Create: `backend/app/services/model_usage/alerts.py`
- Modify: `backend/app/services/model_usage/settlement.py`
- Create: `backend/tests/model_usage/test_adjustments.py`
- Create: `backend/tests/model_usage/test_alerts.py`
- Create: `backend/tests/model_usage/test_adjustment_mysql_concurrency.py`

**Interfaces**

- Consumes: a required source event, current family-policy pointer for alert evaluation, optional source reservation, evidence/change ticket, idempotency key/fingerprint, immutable price-resolution snapshot.
- Produces: one database-claimed immutable adjustment group plus append-only lines, counter `adjustment_value` delta, non-negative effective event cost/meter projection, and immutable alert facts/Owner receipts.
- `preview_adjustment(db, command) -> AdjustmentPreview`; `apply_adjustment(db, command) -> AdjustmentResult`.
- Adjustment is accepted only while the source family/period `family_total` rollup is `open`.

- [ ] Add failing adjustment tests for group-level idempotent replay, conflicting fingerprint, legal multi-line groups, required source event, open/pruning/closed windows, meter correction, pricing resolution, and execution resolution with matching cost/meter deltas.

```python
def test_closed_period_rejects_preview_and_apply(db, closed_rollup, adjustment_command) -> None:
    with pytest.raises(ModelUsageAdjustmentWindowClosed):
        preview_adjustment(db, adjustment_command)
    with pytest.raises(ModelUsageAdjustmentWindowClosed):
        apply_adjustment(db, adjustment_command)

def test_pricing_resolution_uses_evidence_snapshot_not_current_catalog(db, unpriced_event) -> None:
    result = apply_adjustment(db, pricing_resolution_command(unpriced_event, evidence_snapshot("snapshot-v1")))
    assert result.effective.pricing_status == ModelUsagePricingStatus.PRICED
    assert result.lines[0].snapshot_checksum == evidence_snapshot("snapshot-v1").checksum

def test_one_group_can_hold_multiple_lines_without_reusing_idempotency_key(db, adjustment_command) -> None:
    result = apply_adjustment(db, adjustment_command.with_lines(meter_delta="-10", cost_delta="-0.2"))
    assert len(result.lines) == 2
    assert {line.adjustment_group_id for line in result.lines} == {result.group.id}

def test_confirmed_not_executed_resolution_zeros_effective_cost_and_guardrail_meters(db, unknown_event) -> None:
    result = apply_adjustment(db, confirmed_not_executed_command(unknown_event))
    assert result.effective.cost_cny == Decimal("0")
    assert result.effective.guardrail_quantity("total_tokens") == Decimal("0")
    assert result.counter_delta.cost == -unknown_event.cost_cny
    assert result.counter_delta.meter("total_tokens") == -unknown_event.quantity("total_tokens")

def test_negative_adjustment_cannot_over_credit_source_event(db, priced_event) -> None:
    existing = priced_event.quantity(ModelUsageMeter.TOTAL_TOKENS)
    with pytest.raises(ModelUsageAdjustmentValidationError, match="effective_usage_cannot_be_negative"):
        apply_adjustment(
            db,
            meter_correction(
                priced_event,
                meter=ModelUsageMeter.TOTAL_TOKENS,
                meter_delta=-(existing + Decimal("1")),
            ),
        )
```

- [ ] Implement pointer-first current-policy lock, then source-event/rollup family-period locking, correction-window validation, and affected counters in the global family-cost → capability-cost → capability-meter order. The pointer establishes alert revision order only; it never reprices the source event. All required row locks and validation precede the group claim, but the claim remains the first mutation.

```python
def lock_open_source_event_and_policy(
    db: Session, *, family_id: str, source_event_id: str
) -> tuple[ModelUsageEvent, ModelUsagePolicyVersion, Sequence[ModelUsagePeriodCounter]]:
    pointer = lock_family_policy(db, family_id=family_id)
    current_policy = require_current_policy(db, pointer)
    event = require_family_event_for_update(db, family_id=family_id, event_id=source_event_id)
    rollup = require_family_total_rollup_for_update(db, family_id=family_id, period_start=event.period_start)
    if rollup.correction_status is not ModelUsageCorrectionStatus.OPEN:
        raise ModelUsageAdjustmentWindowClosed("model_usage_adjustment_window_closed")
    counters = lock_adjustment_counters_in_global_order(db, event=event)
    return event, current_policy, counters
```

- [ ] Implement preview checksum over source effective state, proposed deltas, counters, rollup revision, and alert impact without mutation.

```python
preview_payload = {
    "source_event_id": event.id,
    "effective_before": effective_state_payload(effective_before),
    "meter_delta": canonical_decimal(command.meter_delta),
    "cost_delta_cny": canonical_decimal(command.cost_delta_cny),
    "counter_after": canonical_decimal(counter_after),
    "rollup_revision_after": rollup.revision + 1,
    "crossed_thresholds": crossed_thresholds,
}
return AdjustmentPreview(payload=preview_payload, checksum=canonical_checksum(preview_payload))
```

- [ ] Implement apply with checksum verification, a database-unique group claim before every line/counter mutation, append-only lines, and same-transaction counter delta. The header owns `(family_id, idempotency_key, fingerprint)`; line rows own only `(adjustment_group_id, line_sequence)`.

```python
if command.confirm_checksum != preview.checksum:
    raise ModelUsageAdjustmentConflict("checksum_mismatch")
existing = adjustment_group_by_idempotency_key_for_update(
    db, family_id=command.family_id, idempotency_key=command.idempotency_key
)
if existing is not None:
    return replay_or_conflict(existing, command.fingerprint)
try:
    with db.begin_nested():
        group = build_adjustment_group_claim(command, source_event=event)
        db.add(group)
        db.flush()  # claims uq_model_usage_adjustment_group_key
except IntegrityError:
    winner = require_adjustment_group_for_update(
        db, family_id=command.family_id, idempotency_key=command.idempotency_key
    )
    return replay_or_conflict(winner, command.fingerprint)
insert_adjustment_lines(db, group=group, command=command)
apply_cost_and_meter_adjustment_values(counters, command.lines)
db.flush()
```

Before the claim, project the source event plus all prior ordered adjustments plus the proposed group; reject any effective cost or meter below zero and require execution-resolution deltas to match the resulting state. The claim is the first mutation. A unique loser never inserts lines and never reaches counter/alert mutation. The repository always includes `family_id` when finding or locking an idempotency winner.

- [ ] Add a real MySQL race test for 50 same-key commands and a mixed-fingerprint pair; prove one group, its complete ordered line set, and one counter delta. Same fingerprint returns the complete winner result only after its transaction commits.

```python
def test_concurrent_adjustment_group_claim_is_exactly_once(mysql_usage_context) -> None:
    results = run_barriered([
        lambda: mysql_usage_context.adjust(idempotency_key="adj-1", fingerprint="fp-a", lines=TWO_LINES)
        for _ in range(50)
    ])
    assert len({result.group_id for result in results}) == 1
    assert mysql_usage_context.adjustment_group_count("adj-1") == 1
    assert mysql_usage_context.adjustment_line_count("adj-1") == 2
    assert mysql_usage_context.counter_delta_applied_times("adj-1") == 1
```

- [ ] Add failing negative-adjustment concurrency test proving credit is immediately available to a later reservation and no prior blocked call is replayed.

```python
def test_negative_adjustment_releases_budget_without_replaying_blocked_call(mysql_usage_context) -> None:
    blocked = mysql_usage_context.reserve(cost="3", attempt_key="blocked-before-credit")
    assert blocked.decision == "blocked"
    mysql_usage_context.adjust(source_event_id="event-a", cost_delta="-5")
    allowed = mysql_usage_context.reserve(cost="3", attempt_key="new-after-credit")
    assert allowed.decision == "allowed"
    assert mysql_usage_context.reservation_for("blocked-before-credit") is None
```

- [ ] Add failing alert tests for 79%, crossing 80/100/110, large multi-threshold settlement, no reservation alert, disabled alerts, and revision behavior.

```python
def test_alerts_are_unique_per_budget_revision_and_threshold(db, policy, settled_counter) -> None:
    settled_counter.settled_value = Decimal("79")
    assert evaluate_budget_alerts(db, policy, settled_counter) == []
    settled_counter.settled_value = Decimal("111")
    alerts = evaluate_budget_alerts(db, policy, settled_counter)
    assert [alert.threshold for alert in alerts] == [Decimal("0.80"), Decimal("1.00"), Decimal("1.10")]
    assert evaluate_budget_alerts(db, policy, settled_counter) == []
```

- [ ] Implement threshold evaluation from `settled_value + adjustment_value` only, create all immutable facts, and mark the highest crossed alert as the notification focus.

```python
effective_spend = counter.settled_value + counter.adjustment_value
for threshold in ALERT_THRESHOLDS:
    if effective_spend >= policy.monthly_budget_cny * threshold:
        insert_alert_if_absent(db, policy=policy, counter=counter, threshold=threshold)
```

- [ ] Implement new-revision repair: on policy budget change or alert re-enable, insert only the current highest crossed threshold; later crossings behave normally.

```python
def repair_new_budget_revision(db: Session, policy: ModelUsagePolicyVersion, counter: ModelUsagePeriodCounter) -> list[ModelUsageAlert]:
    highest = highest_crossed_threshold(policy, counter)
    return [] if highest is None else [insert_alert_if_absent(db, policy=policy, counter=counter, threshold=highest)]
```

- [ ] Create an independent receipt for every active Owner at alert creation; ordinary members never receive one.

```python
for owner_user_id in active_owner_user_ids(db, family_id=policy.family_id):
    db.add(ModelUsageAlertReceipt(
        id=create_id("model-usage-alert-receipt"),
        alert_id=alert.id,
        owner_user_id=owner_user_id,
    ))
```

- [ ] Call alert evaluation inside exact settlement and adjustment apply transactions after counter mutation, using the current policy captured under the transaction's pointer-first lock rather than the reservation admission policy.

```python
add_settled_values(counters, event, meter_rows)
alerts = evaluate_budget_alerts(db, policy=current_policy, counter=family_cost_counter)
reservation.status = terminal_status_for(event)
```

- [ ] Add a policy-update/late-settlement interleaving test: whichever transaction acquires the policy pointer first determines the alert revision; a settlement ordered after the update cannot create an alert for the stale admission budget.

- [ ] Run adjustment, alert, and MySQL concurrency tests.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_adjustments.py tests/model_usage/test_alerts.py tests/model_usage/test_adjustment_mysql_concurrency.py -q
cd ..
git diff --check
```

Expected: adjustments never mutate events; negative deltas release budget after commit; threshold facts and Owner receipts remain unique.

- [ ] Commit Task 8.

```bash
git add backend/app/repos/model_usage/adjustments.py backend/app/services/model_usage/adjustments.py backend/app/services/model_usage/alerts.py backend/app/services/model_usage/settlement.py backend/tests/model_usage
git commit -m "feat(model-usage): add adjustments and budget alerts"
```

---

## Task 9: Effective-state aggregation, current-month queries, deterministic rollups, and historical dimensions

**Files**

- Create: `backend/app/repos/model_usage/reporting.py`
- Create: `backend/app/services/model_usage/effective_state.py`
- Create: `backend/app/services/model_usage/aggregation.py`
- Create: `backend/app/services/model_usage/rollups.py`
- Create: `backend/tests/model_usage/test_effective_state.py`
- Create: `backend/tests/model_usage/test_aggregation.py`
- Create: `backend/tests/model_usage/test_rollups.py`
- Create: `backend/tests/model_usage/test_reporting_queries_mysql.py`

**Interfaces**

- Consumes: immutable events, ordered adjustments, active reservations, incident overlaps, stable subjects, current counters, or historical rollup rows.
- Produces: owner/personal aggregate DTOs, all rollup kinds, deterministic source watermark/checksum.
- Current period: overview budget values from strong counters; breakdown from indexed raw rows.
- Historical period: only `model_usage_monthly_rollups`; no re-pricing and no raw-row dependency after close.

- [ ] Add failing effective-state tests for unknown estimated event resolved by later evidence, unpriced→priced snapshot, and event immutability.

```python
def test_execution_resolution_removes_unresolved_unknown_without_mutating_event(db, unknown_event) -> None:
    original = snapshot_event_row(unknown_event)
    apply_adjustment(db, execution_resolution_command(unknown_event, outcome="succeeded"))
    effective = effective_event_state(db, unknown_event.id)
    assert effective.execution_certainty == ModelUsageExecutionCertainty.CONFIRMED_EXECUTED
    assert effective.measurement_status == ModelUsageMeasurementStatus.EXACT
    assert snapshot_event_row(unknown_event) == original
```

- [ ] Implement ordered adjustment projection by `(group.created_at, group.id, line_sequence, line.id)` and resolution-kind validation; load group/lines by the source event's family scope.

```python
def effective_event_state(
    event: ModelUsageEvent,
    adjustment_groups: Sequence[ModelUsageAdjustmentGroup],
) -> EffectiveUsageState:
    state = EffectiveUsageState.from_event(event)
    for group in sorted(adjustment_groups, key=adjustment_group_order_key):
        for line in sorted(group.lines, key=adjustment_line_order_key):
            state = state.apply(line)
    return state
```

- [ ] Add failing aggregate tests for orthogonal exact/estimated, priced/unpriced, uncertain/pending, unresolved unknown, known unmeasured, unknown gap, and partial pricing.

```python
def test_unknown_gap_does_not_change_family_or_subject_totals(aggregate_fixture) -> None:
    before = aggregate_fixture.family_totals()
    aggregate_fixture.add_unknown_scope_gap()
    after = aggregate_fixture.family_totals()
    assert after.known_priced_cost_cny == before.known_priced_cost_cny
    assert after.known_unmeasured_attempt_count == before.known_unmeasured_attempt_count
    assert after.measurement_gap is True
```

- [ ] Implement reporting repository predicates that always include `family_id`, period bounds, and subject scope where applicable.

```python
def family_events_for_period(db: Session, *, family_id: str, period: BillingPeriod) -> list[ModelUsageEvent]:
    return list(db.scalars(
        select(ModelUsageEvent)
        .where(
            ModelUsageEvent.family_id == family_id,
            ModelUsageEvent.period_start == period.start_at,
        )
        .order_by(ModelUsageEvent.created_at, ModelUsageEvent.id)
    ))
```

- [ ] Implement owner and personal current-month aggregation without content joins; personal scope resolves exactly one stable subject.

```python
def aggregate_personal_current_period(db: Session, *, family_id: str, user_id: str, period: BillingPeriod) -> UsageAggregate:
    subject = require_user_subject(db, family_id=family_id, user_id=user_id)
    return aggregate_raw_usage(
        events=subject_events_for_period(db, family_id=family_id, subject_id=subject.id, period=period),
        reservations=subject_active_reservations(db, family_id=family_id, subject_id=subject.id, period=period),
        incidents=subject_incidents(db, family_id=family_id, subject_id=subject.id, period=period),
    )
```

- [ ] Add failing rollup tests for every required kind, daily trend, stable checksum, late adjustment revision, subject labels, and no model alias re-selection.

```python
def test_same_sources_generate_same_rollup_checksum(db, source_period) -> None:
    first = rebuild_monthly_rollups(db, family_id=source_period.family_id, period=source_period.period)
    second = rebuild_monthly_rollups(db, family_id=source_period.family_id, period=source_period.period)
    assert first.checksum == second.checksum
    assert first.revision == second.revision
```

- [ ] Implement canonical dimension keys for `family_total`, `subject_total`, `capability_total`, `provider_model_total`, `meter_total`, and `daily_capability_cost`.

```python
def rollup_dimension_key(kind: ModelUsageRollupKind, dimensions: Mapping[str, str]) -> str:
    normalized = "|".join(f"{key}={dimensions[key]}" for key in sorted(dimensions))
    return f"{kind.value}|{normalized}"
```

- [ ] Implement idempotent rollup rebuild with a canonical source watermark and increment revision only when checksum changes.

```python
existing = lock_rollup_dimension(db, family_id=family_id, period_start=period.start_at, dimension_key=row.dimension_key)
if existing is None:
    insert_rollup(db, row, revision=1)
elif existing.checksum != row.checksum:
    replace_rollup_values(existing, row)
    existing.revision += 1
```

- [ ] Add MySQL EXPLAIN tests for current overview, current breakdown, historical rollup, and family/subject index usage.

```python
@pytest.mark.mysql
def test_current_breakdown_uses_family_period_index(mysql_reporting_fixture) -> None:
    plan = mysql_reporting_fixture.explain_current_breakdown(group_by="provider_model")
    assert plan.uses_index("ix_model_usage_events_family_period")
    assert plan.full_table_scan is False
```

- [ ] Seed the reference-scale test generator with 100,000 events and 3–5 meters per event; gate query count and plan automatically, record wall time as a reference metric.

```python
stats = run_reporting_reference_benchmark(
    family_count=1,
    periods=13,
    events_in_current_period=100_000,
    meters_per_event=(3, 5),
)
assert stats.current_overview_query_count <= 8
assert stats.historical_rollup_query_count <= 3
```

- [ ] Run effective-state, aggregation, rollup, and MySQL reporting tests.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_effective_state.py tests/model_usage/test_aggregation.py tests/model_usage/test_rollups.py tests/model_usage/test_reporting_queries_mysql.py -q
cd ..
git diff --check
```

Expected: deterministic checksums/revisions; query plans use family/period indexes; unknown gaps do not fabricate count or cost.

- [ ] Commit Task 9.

```bash
git add backend/app/repos/model_usage/reporting.py backend/app/services/model_usage/effective_state.py backend/app/services/model_usage/aggregation.py backend/app/services/model_usage/rollups.py backend/tests/model_usage
git commit -m "feat(model-usage): add deterministic usage rollups"
```

---

## Task 10: Counter audit, retention state machine, maintenance worker, preflight, and operations CLI

**Files**

- Create: `backend/app/services/model_usage/counter_audit.py`
- Create: `backend/app/services/model_usage/retention.py`
- Create: `backend/app/services/model_usage/maintenance.py`
- Create: `backend/app/services/model_usage/preflight.py`
- Create: `backend/scripts/maintain_model_usage.py`
- Modify: `backend/app/core/config.py`
- Modify: `backend/app/main.py`
- Modify: `backend/.env.example`
- Modify: `deploy/.env.example`
- Modify: `deploy/docker-compose.yml`
- Modify: `package.json`
- Create: `backend/tests/model_usage/test_counter_audit.py`
- Create: `backend/tests/model_usage/test_retention.py`
- Create: `backend/tests/model_usage/test_maintenance_worker.py`
- Create: `backend/tests/model_usage/test_maintenance_cli.py`
- Create: `backend/tests/model_usage/test_preflight.py`

**Interfaces**

- Consumes: dirty periods, active/uncertain reservations, adjustment groups/lines, receipt queue, outage latch, price coverage, raw ledger/rollup checksums.
- Produces: `ModelUsageMaintenanceWorker.start()/stop()`, scheduled short batches, health JSON/text and non-zero unhealthy CLI exit.
- Worker tasks/frequencies are fixed: incident 15s, reservation 30s, uncertain 5m, alerts 5m, rollup 15m, audit hourly, coverage startup/daily, prune daily 03:30 Asia/Shanghai.
- CLI subcommands: `health`, `reconcile`, `audit`, `rollup`, `prune`, `adjustment preview`, `adjustment apply`, and `incident record`.

- [ ] Add failing counter-audit tests for separate family-cost, capability-cost, and capability-meter settled/reserved/adjustment equations; include unpriced and informational guardrail-eligible quantities, second locked verification, safe repair, and fail-closed/fail-open health behavior.

```python
def test_counter_audit_repairs_only_after_locked_recheck(db, drifted_counter) -> None:
    report = audit_counter(db, drifted_counter.id, repair=True)
    assert report.drift_detected is True
    assert report.rechecked_under_lock is True
    assert report.repaired is True
    assert report.after == report.expected

def test_capability_meter_audit_uses_quantity_not_cost(db, meter_counter_fixture) -> None:
    fixture = meter_counter_fixture(
        event_quantity="120", event_cost="0.006", reserved_quantity="30",
        reserved_cost="0.002", meter_delta="-5", cost_delta="-0.001",
    )
    expected = expected_counter_values(db, fixture.counter)
    assert expected == CounterValues(
        settled_value=Decimal("120"),
        reserved_value=Decimal("30"),
        adjustment_value=Decimal("-5"),
    )

def test_unpriced_informational_quantity_is_audited_into_meter_counter(db, meter_counter_fixture) -> None:
    fixture = meter_counter_fixture(
        pricing_status="unpriced", meter_role="informational", event_quantity="40", event_cost=None
    )
    assert expected_counter_values(db, fixture.counter).settled_value == Decimal("40")
```

- [ ] Implement ledger-derived counter expectations dispatched by `counter_kind` and fixed counter lock order; never mutate events. Cost counters read CNY cost/cost_delta only; capability meter counters read matching reservation/event quantity/meter_delta regardless of pricing status or meter role, after validating the central guardrail contract.

```python
match counter.counter_kind:
    case ModelUsageCounterKind.FAMILY_COST:
        expected = expected_family_cost_values(db, counter)
    case ModelUsageCounterKind.CAPABILITY_COST:
        expected = expected_capability_cost_values(db, counter)
    case ModelUsageCounterKind.CAPABILITY_METER:
        require_guardrail_eligible(counter.capability, counter.meter)
        expected = CounterValues(
            settled_value=sum_event_meter_quantities(db, counter),
            reserved_value=sum_active_reservation_meter_quantities(db, counter),
            adjustment_value=sum_adjustment_meter_deltas(db, counter),
        )
    case _:
        raise ModelUsageCounterAuditError("unsupported_counter_kind")
if locked_counter_values(counter) != expected:
    replace_counter_values(counter, expected)
```

The cost helpers exclude null/unpriced costs but include zero-priced/not-billed events. The meter helpers join event/reservation meter rows by family, period, capability, and meter; they do not filter on `meter_role`. Adjustment helpers join line → group so family/period/source scope comes from the immutable group header and cannot cross families.

- [ ] Add failing retention tests for 13 complete months, preflight zero-delete failures, open→pruning→closed, adjustment/receipt/incident rejection, batch resume, and family-less global incidents.

```python
def test_prune_failure_keeps_period_pruning_and_resumes(db, eligible_period, fail_after_batch) -> None:
    fail_after_batch("model_usage_events")
    with pytest.raises(SimulatedCrash):
        prune_period(db, eligible_period, batch_size=10)
    assert family_total_rollup(db, eligible_period).correction_status == "pruning"
    prune_period(db, eligible_period, batch_size=10)
    assert family_total_rollup(db, eligible_period).correction_status == "closed"
    assert family_total_rollup(db, eligible_period).raw_data_pruned_at is not None
```

- [ ] Implement retention eligibility and preflight with no mutation in `dry_run`/`verify_only`.

```python
def retention_preflight(db: Session, target: RetentionTarget) -> RetentionVerification:
    return RetentionVerification(
        old_enough=is_complete_period_older_than(target.period, months=13),
        no_active_reservations=not has_active_reservations(db, target),
        no_pending_recovery=not has_pending_latch_receipt_or_incident(db, target),
        rollups_complete=rollups_match_raw_sources(db, target),
        checksum_matches=rollup_checksum_matches(db, target),
    )
```

- [ ] Implement pruning transition and exact FK-safe batch order; `pruning` never returns to `open`.

```python
RAW_DELETE_ORDER = (
    "model_usage_alert_receipts", "model_usage_alerts",
    "model_usage_measurement_incident_attempts", "model_usage_adjustments",
    "model_usage_adjustment_groups",
    "model_usage_event_meters", "model_usage_events",
    "model_usage_reservation_meters", "model_usage_reservations",
    "model_usage_period_counters", "model_usage_measurement_incidents",
)
```

- [ ] Add failing worker tests with a fake monotonic clock for all frequencies, exception isolation, SKIP LOCKED competition, and graceful stop after a short batch.

```python
def test_one_task_exception_does_not_stop_worker(fake_clock, worker) -> None:
    worker.tasks["alert_repair"].fail_once(RuntimeError("test failure"))
    fake_clock.advance(minutes=15)
    worker.run_due_once()
    assert worker.tasks["rollup_refresh"].run_count > 0
    assert worker.is_stopped is False
```

- [ ] Implement scheduler task descriptors and short-lived sessions; worker-facing uncertain recovery only queries existing attempts.

- [ ] Implement `repair_alerts_batch` by selecting candidate family/period IDs without mutation, then using one short transaction per candidate with the same policy-pointer-first order as settlement/adjustment: lock current family policy pointer → load current immutable policy → lock family-cost counter → verify the rollup correction window → insert only alerts for the current `budget_alert_revision`. It never derives alert policy from a reservation/event and skips `pruning/closed` periods. Add a worker interleaving test proving a policy update that wins the pointer lock prevents a later repair from creating a stale-revision alert.

```python
@dataclass(frozen=True, slots=True)
class IntervalMaintenanceTask:
    name: str
    runner: Callable[[], None]
    interval: timedelta
    run_on_startup: bool = False

@dataclass(frozen=True, slots=True)
class DailyMaintenanceTask:
    name: str
    runner: Callable[[], None]
    local_time: time
    timezone: ZoneInfo

DEFAULT_INTERVAL_TASKS = (
    IntervalMaintenanceTask("incident_flush", flush_incidents_batch, interval=timedelta(seconds=15)),
    IntervalMaintenanceTask("reservation_reconcile", reconcile_reservations_batch, interval=timedelta(seconds=30)),
    IntervalMaintenanceTask("uncertain_reconcile", query_uncertain_batch, interval=timedelta(minutes=5)),
    IntervalMaintenanceTask("alert_repair", repair_alerts_batch, interval=timedelta(minutes=5)),
    IntervalMaintenanceTask("rollup_refresh", refresh_rollups_batch, interval=timedelta(minutes=15)),
    IntervalMaintenanceTask("counter_audit", audit_counters_batch, interval=timedelta(hours=1)),
    IntervalMaintenanceTask(
        "price_coverage",
        check_price_coverage_batch,
        interval=timedelta(days=1),
        run_on_startup=True,
    ),
)

DEFAULT_DAILY_TASKS = (
    DailyMaintenanceTask(
        "retention_prune",
        prune_eligible_periods_batch,
        local_time=time(hour=3, minute=30),
        timezone=ZoneInfo("Asia/Shanghai"),
    ),
)
```

- [ ] Add configuration fields and validation for required mode, maintenance, default hard limit, receipt queue size, receipt-integrity active key/keyring, fail-open proof TTL, source-instance ID, and seven fixed required capabilities.

```python
model_usage_required: bool = False
model_usage_maintenance_enabled: bool = True
model_usage_default_hard_limit: bool = False
model_usage_receipt_queue_size: int = 1000
model_usage_receipt_integrity_active_key_id: str = ""
model_usage_receipt_integrity_keys_json: SecretStr = SecretStr("")
model_usage_fail_open_proof_ttl_seconds: int = 5
model_usage_source_instance: str = "culina-api"
```

Validate the proof TTL as a small positive value below the minimum configured provider timeout. It bounds proof reuse but does not turn the fail-open policy read and provider send into an atomic operation. Required-mode preflight also requires the active receipt-integrity key ID to resolve from the secret keyring; health reports key IDs/retirement deadlines only, never key material. Operators retain every verification key until all receipts signed by it are outside the maximum log/recovery window.

Production preflight rejects `MODEL_USAGE_REQUIRED=false`; local/test may leave it false.

- [ ] Add failing preflight tests for missing migration/idempotency unique, missing policy/subject, missing price or guardrail-meter coverage, invalid fail-open proof TTL, absent/expired receipt-integrity verification key, missing recovery declaration/window, SDK retry, and adapter registry gaps.

```python
def test_required_preflight_rejects_missing_capability_coverage(preflight_fixture) -> None:
    preflight_fixture.remove_capability(ModelUsageCapability.TTS)
    with pytest.raises(ModelUsagePreflightError, match="tts:missing"):
        run_model_usage_preflight(preflight_fixture.settings)
```

- [ ] Implement startup preflight without changing `/api/health` semantics.

```python
if settings.model_usage_required:
    run_model_usage_preflight(settings, session_factory=SessionLocal)
# /api/health remains {"status": "ok"}
```

- [ ] Wire `ModelUsageMaintenanceWorker` into FastAPI lifespan after preflight and stop it before existing search/image workers are torn down.

```python
model_usage_worker = ModelUsageMaintenanceWorker()
if settings.model_usage_maintenance_enabled:
    model_usage_worker.start()
yield
model_usage_worker.stop()
search_index_worker.stop()
image_worker.stop()
```

- [ ] Add CLI tests for health JSON/non-zero exit, reconcile, audit repair, deterministic rollup, prune modes, adjustment checksum, and incident record.

```python
def test_unhealthy_health_json_exits_nonzero(cli_runner) -> None:
    result = cli_runner("health", "--json")
    payload = json.loads(result.stdout)
    assert result.returncode == 2
    assert payload["healthy"] is False
    assert payload["priceCoverage"]["missing"] == ["tts"]
```

- [ ] Implement the thin argparse CLI and explicit transaction ownership per command.

```python
prune = subparsers.add_parser("prune")
prune.add_argument("--family", dest="family_id")
prune.add_argument("--period")
prune.add_argument("--batch-size", type=int, default=500)
prune.add_argument("--dry-run", action="store_true")
prune.add_argument("--verify-only", action="store_true")
```

- [ ] Add example/deploy settings and package scripts without touching real `.env` files.

```json
{
  "backend:model-usage:health": "cd backend && PYTHONPATH=. .venv/bin/python scripts/maintain_model_usage.py health",
  "backend:model-usage:prices": "cd backend && PYTHONPATH=. .venv/bin/python scripts/manage_model_usage_prices.py"
}
```

- [ ] Run focused operations tests and CLI help.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_counter_audit.py tests/model_usage/test_retention.py tests/model_usage/test_maintenance_worker.py tests/model_usage/test_maintenance_cli.py tests/model_usage/test_preflight.py -q
PYTHONPATH=. .venv/bin/python scripts/maintain_model_usage.py --help
cd ..
git diff --check
```

Expected: tests pass; help lists every required command; real `.env` files remain unstaged and unmodified.

- [ ] Commit Task 10.

```bash
git add backend/app/services/model_usage/counter_audit.py backend/app/services/model_usage/retention.py backend/app/services/model_usage/maintenance.py backend/app/services/model_usage/preflight.py backend/scripts/maintain_model_usage.py backend/app/core/config.py backend/app/main.py backend/.env.example deploy/.env.example deploy/docker-compose.yml package.json backend/tests/model_usage
git commit -m "feat(model-usage): add maintenance worker and operations cli"
```

---
## Task 11: LLM/vision per-round metering for Chat Completions and Responses

**Files**

- Create: `backend/app/services/model_usage/adapters/__init__.py`
- Create: `backend/app/services/model_usage/adapters/base.py`
- Create: `backend/app/services/model_usage/adapters/llm.py`
- Modify: `backend/app/ai/runtime/types.py`
- Modify: `backend/app/ai/runtime/factory.py`
- Modify: `backend/app/ai/runtime/openai_chat.py`
- Modify: `backend/app/ai/runtime/openai_responses.py`
- Modify: `backend/app/ai/runtime/prompt_cache.py`
- Modify: `backend/app/ai/workspace_service.py`
- Modify: `backend/app/ai/workflows/orchestrator/agent.py`
- Modify: `backend/app/ai/workflows/runner_support/approval_followup_streamer.py`
- Modify: `backend/app/core/config.py`
- Modify: `backend/tests/ai_infra/test_ai_observability.py`
- Create: `backend/tests/model_usage/test_llm_adapter.py`
- Create: `backend/tests/model_usage/test_llm_provider_contract.py`
- Create: `backend/tests/model_usage/test_llm_fallback.py`

**Interfaces**

- Consumes: `UsageAttribution` from the workflow, system/user messages only inside the provider sender, explicit output cap, provider response usage.
- Produces: one reservation/event per provider round/attempt; normalized uncached/cached/output/total meter lines; stable degradation/block errors.
- Add optional `usage_attribution: UsageAttribution | None` to `BaseChatProvider.generate`, `generate_with_tools`, and `stream_generate`. Built-in remote providers require it when `MODEL_USAGE_REQUIRED=true`; disabled/fake providers do not dispatch and may omit it.
- `LLMUsageAdapter.start_round(attribution, provider_round, attempt_index, model, input_estimate, output_cap, fingerprint) -> MeteredProviderAttempt`.
- Existing prompt-cache/stream-option compatibility fallback may retry only after the first attempt is conclusively classified `confirmed_not_executed/not_billed`; the changed payload always receives a new attempt key and reservation. Ambiguous transport errors never enter this fallback.
- `model_usage_dispatch_recovery_required` means the same attempt already has a durable send intent; the current invocation does not call the provider or start a fallback attempt, and leaves recovery to Task 7's mode-specific path.
- `model_usage_attempt_already_accounted` means the ledger event already exists; the adapter does not call the provider, and the owning workflow reloads its persisted business result or exposes a pending/manual-recovery state instead of inventing a response or creating a same-key retry.

- [ ] Add failing adapter tests for input/cached normalization, output cap, per-round attempt keys, streaming cancellation, unknown alias, and trace-disabled usage.

```python
def test_round_attempt_key_is_stable_and_distinct(llm_adapter, attribution) -> None:
    first = llm_adapter.start_round(attribution, provider_round=1, attempt_index=1, model="gpt-test", input_estimate=40, output_cap=100, fingerprint="hmac:round-1")
    replay = llm_adapter.start_round(attribution, provider_round=1, attempt_index=1, model="gpt-test", input_estimate=40, output_cap=100, fingerprint="hmac:round-1")
    second = llm_adapter.start_round(attribution, provider_round=2, attempt_index=1, model="gpt-test", input_estimate=20, output_cap=100, fingerprint="hmac:round-2")
    assert first.attempt_key == replay.attempt_key
    assert first.attempt_key != second.attempt_key
```

- [ ] Implement base adapter helpers for reserve → dispatch → acknowledge → settle/uncertain, with a recovery policy supplied by the registry.

```python
class MeteredProviderAdapter:
    def begin(
        self,
        context: UsageContext,
        estimate: UsageEstimate,
        *,
        fingerprint: str,
        recovery_policy: ProviderRecoveryPolicy,
    ) -> "MeteredProviderAttempt":
        decision = self.usage_facade.reserve(context, estimate, fingerprint=fingerprint)
        if decision.decision == "blocked":
            raise ModelUsageBlocked.from_decision(decision)
        if decision.decision == "already_accounted":
            raise ModelUsageAttemptAlreadyAccounted(require_value(decision.existing_event_id))
        return MeteredProviderAttempt(
            usage_facade=self.usage_facade,
            context=context,
            estimate=estimate,
            decision=decision,
            fingerprint=fingerprint,
            recovery_policy=recovery_policy,
        )

class MeteredProviderAttempt:
    usage_facade: ModelUsageFacade
    context: UsageContext
    estimate: UsageEstimate
    decision: ReservationDecision
    fingerprint: str
    recovery_policy: ProviderRecoveryPolicy
    _dispatch_prepared: bool = False

    @property
    def attempt_key(self) -> str:
        return self.context.attempt_key

    @property
    def reservation_id(self) -> str | None:
        return self.decision.reservation_id

    def prepare_dispatch(self) -> DispatchPermit:
        if self._dispatch_prepared:
            raise ModelUsageDispatchRecoveryRequired("model_usage_dispatch_recovery_required")
        if self.decision.decision == "fail_open":
            permit = self.usage_facade.consume_fail_open_dispatch_permit(
                require_value(self.decision.fail_open_permit), at=utcnow()
            )
        else:
            permit = prepare_usage_dispatch(
                require_value(self.decision.reservation_id),
                fingerprint=self.fingerprint,
                recovery_policy=self.recovery_policy,
            )
        self._dispatch_prepared = True
        return permit

    def settle(self, receipt: ProviderUsageReceipt) -> UsageSettlement:
        return settle_usage(receipt)
```

- [ ] Implement LLM estimates and provider usage normalization; `total_tokens` is informational and cached input becomes uncached + cached billable lines only when the scheme prices cache separately.

```python
def normalize_openai_token_usage(raw: Mapping[str, object], scheme: UsageBillingScheme) -> Sequence[UsageMeterQuantity]:
    input_tokens = decimal_integer(raw_token(raw, "input_tokens", "prompt_tokens"))
    cached_tokens = decimal_integer(raw_cached_tokens(raw))
    output_tokens = decimal_integer(raw_token(raw, "output_tokens", "completion_tokens"))
    if cached_tokens > input_tokens:
        raise ModelUsageSettlementPending("cached_input_exceeds_input")
    return scheme.normalize_llm(
        input_tokens=input_tokens,
        cached_input_tokens=cached_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
    )
```

- [ ] Add failing provider-contract tests asserting SDK retry is zero, every outgoing request has a max output cap, and the usage adapter reserve/dispatch occurs before `.create()`.

```python
def test_chat_provider_disables_sdk_retry_and_caps_output(fake_openai_client, provider, attribution) -> None:
    provider.openai_client = fake_openai_client
    provider.generate(system="system", user="hello", usage_attribution=attribution)
    assert provider.openai_client.max_retries == 0
    assert fake_openai_client.request["max_tokens"] == provider.max_output_tokens
    assert fake_openai_client.timeline[:3] == ["reserve", "dispatch", "provider_create"]
```

- [ ] Replace the looping `create_stream_with_unsupported_param_fallback` helper with a single-send classifier; a confirmed client-side `TypeError` or provider 4xx unsupported-parameter response settles the current attempt as not billed, removes exactly one supported optional field group, and starts a newly metered attempt.

```python
MAX_COMPATIBILITY_ATTEMPTS = 3

for attempt_index in range(1, MAX_COMPATIBILITY_ATTEMPTS + 1):
    fingerprint = fingerprint_chat_request(request)
    attempt = self.usage_adapter.start_round(
        usage_attribution,
        provider_round=provider_round,
        attempt_index=attempt_index,
        model=self.model_name,
        input_estimate=estimate_chat_input(messages),
        output_cap=self.max_output_tokens,
        fingerprint=fingerprint,
    )
    permit = attempt.prepare_dispatch()
    try:
        response = create_stream_once(self.openai_client.chat.completions.create, request)
        break
    except UnsupportedOptionalProviderParameter as exc:
        attempt.settle(self.usage_adapter.confirmed_not_executed_receipt(permit, error_code=exc.code))
        request = remove_confirmed_unsupported_option(request, exc.option_group)
else:
    raise ModelUsageContractError("provider_optional_parameter_fallback_exhausted")
```

`UnsupportedOptionalProviderParameter` may be raised only for a local SDK `TypeError` before socket send or an inspected 4xx response that confirms rejection. It must never wrap timeout, disconnect, 5xx, or an unclassified provider exception.

- [ ] Modify factory/config so remote chat providers receive `max_output_tokens`, optional fallback model/cap, and a model-usage adapter; set OpenAI SDK `max_retries=0`.

```python
self.openai_client = OpenAI(
    api_key=api_key,
    base_url=api_base.rstrip("/"),
    timeout=timeout_seconds,
    max_retries=0,
)
self.max_output_tokens = max_output_tokens
self.usage_adapter = usage_adapter
```

- [ ] Wrap non-stream Chat Completions send/response in one metered attempt and settle empty-but-executed responses rather than dropping usage.

```python
attempt = self.usage_adapter.start_round(
    usage_attribution,
    provider_round=1,
    attempt_index=1,
    model=self.model_name,
    input_estimate=estimate_chat_input(messages),
    output_cap=self.max_output_tokens,
    fingerprint=fingerprint_chat_request(request),
)
permit = attempt.prepare_dispatch()
response = self.openai_client.chat.completions.create(**request)
attempt.settle(self.usage_adapter.receipt_from_chat_response(permit, response))
```

- [ ] Wrap every streaming tool round/attempt; an ambiguous exception marks only that attempt uncertain and stops automatic retry. A received empty response may start a new explicitly metered attempt.

```python
except Exception as exc:
    attempt.mark_uncertain(stable_error_code="provider_stream_transport_ambiguous")
    return ChatProviderResult(
        text=None,
        status="failed",
        model=self.model_name,
        error=str(exc),
        tool_calls=requested_calls,
    )
```

- [ ] Apply the same per-round wrapper to Responses API streaming, including completed response usage and cancellation.

```python
with self.usage_adapter.stream_round(
    attribution=usage_attribution,
    provider_round=provider_round,
    attempt_index=attempt_index,
    model=self.model_name,
    input_estimate=estimate_responses_input(request),
    output_cap=self.max_output_tokens,
) as metered_stream:
    stream = self.client.responses.create(**request)
    return collect_responses_stream(stream, metered_stream=metered_stream)
```

- [ ] Pass trusted attribution from all three workflow call sites even when tracing is disabled.

```python
provider_kwargs["usage_attribution"] = UsageAttribution(
    family_id=context.family_id,
    attribution_kind=ModelUsageAttributionKind.USER,
    actor_user_id=context.user_id,
    operation_source=ModelUsageOperationSource.INTERACTIVE,
    logical_operation_id=context.run_id,
)
```

Use `family_id/user_id/run_id` from the concrete scope in `workspace_service.py`, `agent.py`, and `approval_followup_streamer.py`; do not derive identity from messages.

- [ ] Add failing fallback tests: pre-dispatch budget block may call configured light model with a new attempt; unknown original execution forbids fallback.

```python
def test_predispatch_block_uses_new_fallback_attempt(llm_gateway, attribution) -> None:
    result = llm_gateway.invoke_with_optional_fallback(attribution, primary="gpt-large", fallback="gpt-small")
    assert result.model == "gpt-small"
    assert result.attempt_keys[0] != result.attempt_keys[1]

def test_unknown_primary_never_auto_falls_back(llm_gateway, attribution) -> None:
    llm_gateway.make_primary_ambiguous()
    result = llm_gateway.invoke_with_optional_fallback(attribution, primary="gpt-large", fallback="gpt-small")
    assert result.status == "failed"
    assert llm_gateway.models_called == ["gpt-large"]
```

- [ ] Run LLM adapter/provider tests and affected AI tests.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_llm_adapter.py tests/model_usage/test_llm_provider_contract.py tests/model_usage/test_llm_fallback.py tests/ai_infra/test_ai_observability.py tests/ai_infra/test_workspace_chat.py tests/ai_infra/test_workspace_streaming.py -q
cd ..
git diff --check
```

Expected: Chat/Responses, stream/non-stream, multi-round, cancel, cached tokens, output cap, and fallback boundaries pass with no trace dependency.

- [ ] Commit Task 11.

```bash
git add backend/app/services/model_usage/adapters backend/app/ai/runtime/types.py backend/app/ai/runtime/factory.py backend/app/ai/runtime/openai_chat.py backend/app/ai/runtime/openai_responses.py backend/app/ai/runtime/prompt_cache.py backend/app/ai/workspace_service.py backend/app/ai/workflows/orchestrator/agent.py backend/app/ai/workflows/runner_support/approval_followup_streamer.py backend/app/core/config.py backend/tests/model_usage backend/tests/ai_infra/test_ai_observability.py
git commit -m "feat(model-usage): meter llm and vision provider rounds"
```

---

## Task 12: Embedding metering with family-split batches and persistent vector handoff

**Files**

- Create: `backend/app/services/model_usage/adapters/embedding.py`
- Modify: `backend/app/models/domain.py`
- Create: `backend/alembic/versions/3e4f5a6b7c8d_add_search_usage_recovery_state.py`
- Modify: `backend/app/services/search/embeddings.py`
- Modify: `backend/app/services/search/hybrid.py`
- Modify: `backend/app/services/search/jobs.py`
- Modify: `backend/app/services/search/vector_indexing.py`
- Modify: `backend/app/services/search/indexing.py`
- Modify: `backend/app/schemas/search.py`
- Create: `backend/tests/model_usage/test_embedding_adapter.py`
- Modify: `backend/tests/search/test_embeddings.py`
- Modify: `backend/tests/search/test_hybrid_search.py`
- Modify: `backend/tests/search/test_search_index_jobs.py`
- Modify: `backend/tests/search/test_vector_indexing.py`
- Create: `backend/tests/model_usage/test_embedding_mysql_handoff.py`

**Interfaces**

- Consumes: user search attribution or family system attribution, exact per-family text batch, model response usage when available.
- Produces: embedding event plus vectors; a provider-success vector is persisted before Qdrant and reused after Qdrant failure.
- Remote protocol becomes `embed_text(text, *, attribution, attempt_key) -> MeteredEmbeddingResult` and `embed_batch(texts, *, attribution, attempt_key) -> MeteredEmbeddingResult`, where the result contains vectors plus the settled `usage_event_id`.
- Search jobs persist diagnostic `usage_attempt_key` and `usage_event_id` strings without ledger FKs. A stale job with a dispatched/settled attempt but no pending vector is terminal and never calls embedding automatically again.
- Search job statuses add `budget_blocked` plus a general stable `error_code`; provider attempt count does not change when reserve is blocked.

- [ ] Add failing adapter tests for user/system attribution, exact batch size, provider token usage, estimated token fallback, unpriced state, budget block, and family-split rejection.

```python
def test_embedding_adapter_rejects_cross_family_batch(adapter) -> None:
    with pytest.raises(ModelUsageContractError, match="embedding_batch_crosses_family"):
        adapter.embed_batch([
            embedding_item(family_id="family-a", text="a"),
            embedding_item(family_id="family-b", text="b"),
        ])
```

- [ ] Implement `EmbeddingUsageAdapter` with one reservation per actual HTTP batch and `recovery_mode=none`.

```python
def begin_embedding_batch(
    self,
    *,
    attribution: UsageAttribution,
    attempt_key: str,
    text_token_estimates: Sequence[int],
    fingerprint: str,
) -> MeteredProviderAttempt:
    estimate = estimate_embedding(token_count=sum(text_token_estimates))
    context = self.context(attribution=attribution, attempt_key=attempt_key)
    return self.begin(
        context,
        estimate,
        fingerprint=fingerprint,
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
```

- [ ] Add migration tests for durable search handoff fields and `budget_blocked` metadata.

```python
def test_search_usage_handoff_columns_exist() -> None:
    columns = Base.metadata.tables["search_documents"].c
    assert {"pending_vector", "pending_vector_content_hash", "pending_vector_model", "pending_vector_dimensions"} <= set(columns)
    job_columns = Base.metadata.tables["search_index_jobs"].c
    assert {
        "usage_attempt_key",
        "usage_event_id",
        "budget_blocked_period_start",
        "budget_blocked_policy_version_id",
        "error_code",
    } <= set(job_columns)
    assert list(job_columns.usage_event_id.foreign_keys) == []
```

- [ ] Add `SearchDocument.pending_vector` JSON and matching hash/model/dimension fields plus search-job blocked metadata in model and Alembic revision `3e4f5a6b7c8d`.

```python
revision = "3e4f5a6b7c8d"
down_revision = "2d3e4f5a6b7c"

def upgrade() -> None:
    op.add_column("search_documents", sa.Column("pending_vector", sa.JSON(), nullable=True))
    op.add_column("search_documents", sa.Column("pending_vector_content_hash", sa.String(64), nullable=True))
    op.add_column("search_documents", sa.Column("pending_vector_model", sa.String(120), nullable=True))
    op.add_column("search_documents", sa.Column("pending_vector_dimensions", sa.Integer(), nullable=True))
    op.add_column("search_index_jobs", sa.Column("usage_attempt_key", sa.String(255), nullable=True))
    op.add_column("search_index_jobs", sa.Column("usage_event_id", sa.String(64), nullable=True))
    op.add_column("search_index_jobs", sa.Column("budget_blocked_period_start", sa.DateTime(timezone=True), nullable=True))
    op.add_column("search_index_jobs", sa.Column("budget_blocked_policy_version_id", sa.String(64), nullable=True))
    op.add_column("search_index_jobs", sa.Column("error_code", sa.String(64), nullable=True))
```

- [ ] Modify embedding client protocol/HTTP implementation to require attribution/attempt key, reserve and dispatch before `httpx.post`, and settle before returning vectors.

```python
@dataclass(frozen=True, slots=True)
class MeteredEmbeddingResult:
    vectors: list[list[float]]
    usage_event_id: str

def embed_batch(
    self,
    texts: list[str],
    *,
    attribution: UsageAttribution,
    attempt_key: str,
) -> MeteredEmbeddingResult:
    fingerprint = fingerprint_embedding_request(self.model, texts)
    attempt = self.usage_adapter.begin_embedding_batch(
        attribution=attribution,
        attempt_key=attempt_key,
        text_token_estimates=[estimate_embedding_tokens(text) for text in texts],
        fingerprint=fingerprint,
    )
    permit = attempt.prepare_dispatch()
    response = self._post_embeddings(texts)
    settlement = attempt.settle(self.usage_adapter.receipt_from_response(permit, response))
    vectors = parse_vectors(response, expected_count=len(texts), dimensions=self.dimensions)
    return MeteredEmbeddingResult(vectors=vectors, usage_event_id=settlement.event_id)
```

The fingerprint is HMAC-only and never logged as raw text.

- [ ] Pass interactive attribution from `hybrid_search`; budget block or provider failure returns keyword-only results with a stable degradation code.

```python
query_embedding = embedding_client.embed_text(
    query,
    attribution=user_usage_attribution(
        family_id=family_id,
        user_id=user_id,
        logical_operation_id=search_request_id,
    ),
    attempt_key=f"{search_request_id}:embedding:query",
)
query_vector = require_single_vector(query_embedding)
```

- [ ] Add failing handoff tests proving provider success is committed before Qdrant, a Qdrant retry reuses the pending vector, and a crash after settlement but before vector persistence never calls embedding automatically again.

```python
def test_qdrant_failure_reuses_persisted_vector(job_harness) -> None:
    job_harness.qdrant.fail_once()
    job_harness.process()
    assert job_harness.embedding.call_count == 1
    assert job_harness.document.pending_vector is not None
    job_harness.process()
    assert job_harness.embedding.call_count == 1
    assert job_harness.qdrant.call_count == 2
    assert job_harness.document.pending_vector is None

def test_settled_attempt_without_persisted_vector_is_not_reembedded(job_harness) -> None:
    job_harness.crash_after_usage_settlement()
    job_harness.process()
    assert job_harness.embedding.call_count == 1
    job_harness.recover_stale_job()
    assert job_harness.embedding.call_count == 1
    assert job_harness.job.status == "failed"
    assert job_harness.job.error_code == "embedding_output_unavailable_after_provider_success"
```

- [ ] Refactor indexing into phase A “embed and persist pending vectors” and phase B “write pending vectors to Qdrant and clear on success”; each phase owns a short transaction.

```python
mark_jobs_usage_attempt(job_ids, attempt_key=batch_attempt_key)
db.commit()

metered_result = embedding_client.embed_batch(
    texts,
    attribution=system_attribution,
    attempt_key=batch_attempt_key,
)
persist_pending_vectors(
    db,
    documents,
    metered_result.vectors,
    usage_event_id=metered_result.usage_event_id,
)
db.commit()

for document in load_pending_vectors(db):
    vector_store.upsert_point(
        point_id=search_point_id(document.entity_type, document.entity_id),
        vector=require_pending_vector(document),
        payload=pending_vector_payload(document),
    )
    clear_pending_vector(document)
db.commit()
```

Before phase A starts again, inspect the diagnostic attempt against the usage ledger. Only a reservation proven never dispatched or an event proven `confirmed_not_executed` may start a new attempt; `dispatching`, `uncertain`, `confirmed_executed`, or an unknown/estimated event with no pending vector becomes non-retryable `embedding_output_unavailable_after_provider_success`.

- [ ] Mark budget-blocked jobs without incrementing `attempt_count`; store block period/policy version and requeue only after period change or policy pointer change.

```python
except ModelUsageBlocked as exc:
    job.status = "budget_blocked"
    job.error = exc.user_safe_message
    job.budget_blocked_period_start = exc.period_start
    job.budget_blocked_policy_version_id = exc.policy_version_id
    job.error_code = exc.code
    job.locked_at = None
    db.commit()
```

- [ ] Ensure retry/worker claim excludes current-policy/current-period `budget_blocked` jobs and Qdrant-only retries reuse pending vectors.

```python
def can_requeue_budget_blocked(job: SearchIndexJob, *, period_start: datetime, policy_version_id: str) -> bool:
    return (
        job.budget_blocked_period_start != period_start
        or job.budget_blocked_policy_version_id != policy_version_id
    )
```

- [ ] Extend the backend search-job response contract with the stable blocked status/code; keep `error` user-safe and never expose policy amounts or IDs.

```python
SearchIndexJobStatus = Literal["queued", "running", "succeeded", "failed", "budget_blocked"]

class SearchIndexJobResponse(BaseModel):
    job_id: str
    status: SearchIndexJobStatus
    error: str | None = None
    error_code: str | None = None
    entity_type: SearchEntityType
    entity_id: str
    target_name: str
    vector_status: SearchIndexVectorStatus = "pending"
    created_at: datetime
    completed_at: datetime | None = None
```

- [ ] Run embedding/search tests and Alembic head check.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_embedding_adapter.py tests/model_usage/test_embedding_mysql_handoff.py tests/search/test_embeddings.py tests/search/test_hybrid_search.py tests/search/test_search_index_jobs.py tests/search/test_vector_indexing.py -q
.venv/bin/alembic heads
cd ..
git diff --check
```

Expected: head is `3e4f5a6b7c8d`; cross-family batches fail; query fallback works; Qdrant retry does not create a second embedding event or provider call.

- [ ] Commit Task 12.

```bash
git add backend/app/services/model_usage/adapters/embedding.py backend/app/models/domain.py backend/alembic/versions/3e4f5a6b7c8d_add_search_usage_recovery_state.py backend/app/services/search backend/app/schemas/search.py backend/tests/model_usage backend/tests/search
git commit -m "feat(model-usage): meter embedding without duplicate provider calls"
```

---

## Task 13: Rerank metering with exact candidate quantities and local degradation

**Files**

- Create: `backend/app/services/model_usage/adapters/rerank.py`
- Modify: `backend/app/services/search/rerank.py`
- Modify: `backend/app/services/search/hybrid.py`
- Modify: `backend/app/schemas/search.py`
- Modify: `backend/app/api/search.py`
- Create: `backend/tests/model_usage/test_rerank_adapter.py`
- Modify: `backend/tests/search/test_rerank.py`
- Modify: `backend/tests/search/test_hybrid_search.py`
- Modify: `backend/tests/search/test_search_api.py`

**Interfaces**

- Consumes: current user attribution, one request, exact candidate document count; query/documents remain inside search provider only.
- Produces: `rerank_requests=1`, `rerank_documents=N`, and either provider ordering or local ordering with `degradation_code`.
- Budget block, confirmed provider failure, and uncertain transport all return local results; uncertain still remains in the ledger.

- [ ] Add failing adapter tests for exact request/document meters, empty input no event, budget block, provider failure, uncertain transport, and content-free receipt.

```python
def test_rerank_exact_candidate_count(adapter, attribution) -> None:
    attempt = adapter.begin(
        attribution=attribution,
        attempt_key="search-1:rerank",
        document_count=17,
        fingerprint="hmac:rerank-request",
    )
    assert attempt.estimate.quantity(ModelUsageMeter.RERANK_REQUESTS) == Decimal("1")
    assert attempt.estimate.quantity(ModelUsageMeter.RERANK_DOCUMENTS) == Decimal("17")
```

- [ ] Implement `RerankUsageAdapter` with `recovery_mode=none` and request/document normalization.

```python
def begin(
    self,
    *,
    attribution: UsageAttribution,
    attempt_key: str,
    document_count: int,
    fingerprint: str,
) -> MeteredProviderAttempt:
    return self.base.begin(
        context=self.context(attribution=attribution, attempt_key=attempt_key),
        estimate=estimate_rerank(document_count=document_count),
        fingerprint=fingerprint,
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
```

- [ ] Add failing client tests that assert reserve/dispatch precede HTTP and local fallback is returned for each stable model-usage block code.

```python
@pytest.mark.parametrize("code", [
    "model_usage_budget_exceeded",
    "model_usage_capability_limit_exceeded",
    "model_usage_price_unavailable",
    "model_usage_ledger_unavailable",
])
def test_rerank_budget_or_ledger_block_uses_local_order(rerank_harness, code: str) -> None:
    rerank_harness.block_with(code)
    result = rerank_harness.search()
    assert result.order == rerank_harness.local_order
    assert result.degradation_code == code
    assert rerank_harness.http_call_count == 0
```

- [ ] Wrap `OpenAICompatibleRerankClient.rerank` with trusted attribution and attempt key; no query/documents are passed to usage types.

```python
fingerprint = fingerprint_rerank_request(self.model, query, documents)
attempt = self.usage_adapter.begin(
    attribution=attribution,
    attempt_key=attempt_key,
    document_count=len(documents),
    fingerprint=fingerprint,
)
permit = attempt.prepare_dispatch()
response = self._post_rerank(query=query, documents=documents, top_n=top_n)
attempt.settle(self.usage_adapter.receipt_from_response(permit, response))
```

- [ ] Modify `hybrid_search` to create a stable per-request ID, pass current user attribution, and preserve local ranking signals on fallback.

```python
rerank_result = rerank_candidates_or_local(
    rerank_client,
    attribution=user_usage_attribution(family_id=family_id, user_id=user_id, logical_operation_id=request_id),
    attempt_key=f"{request_id}:rerank",
    query=query,
    candidates=candidates,
)
```

- [ ] Extend backend search response with optional stable `degradation_code`; keep the existing boolean `degraded` for compatibility.

```python
class SearchResponseOut(BaseModel):
    items: list[SearchHitOut]
    total: int
    query: str
    search_mode: str
    degraded: bool
    degradation_code: str | None = None
```

- [ ] Run rerank/search service and API tests.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_rerank_adapter.py tests/search/test_rerank.py tests/search/test_hybrid_search.py tests/search/test_search_api.py -q
cd ..
git diff --check
```

Expected: no remote call on pre-dispatch block; uncertain attempt is recorded once; local results remain available with stable code and no family amount.

- [ ] Commit Task 13.

```bash
git add backend/app/services/model_usage/adapters/rerank.py backend/app/services/search/rerank.py backend/app/services/search/hybrid.py backend/app/schemas/search.py backend/app/api/search.py backend/tests/model_usage backend/tests/search
git commit -m "feat(model-usage): meter rerank with local degradation"
```

---
## Task 14: STT/TTS server-measured input, sanitized-output metering, and graceful fallback

**Files**

- Create: `backend/app/services/model_usage/adapters/audio.py`
- Modify: `backend/requirements.txt`
- Modify: `backend/app/services/ai_audio/schemas.py`
- Modify: `backend/app/services/ai_audio/transcription.py`
- Modify: `backend/app/services/ai_audio/service.py`
- Modify: `backend/app/services/ai_audio/openai_audio.py`
- Modify: `backend/app/services/ai_audio/dashscope_audio.py`
- Modify: `backend/app/api/ai_audio.py`
- Create: `backend/tests/model_usage/test_audio_adapter.py`
- Modify: `backend/tests/ai_audio/test_ai_audio_service.py`
- Modify: `backend/tests/ai_audio/test_ai_audio_api.py`

**Interfaces**

- Consumes: authenticated `family_id/user_id`, server-decoded audio duration, sanitized final TTS text length, provider usage when present.
- Produces: STT `audio_input_seconds` or audio-token scheme; TTS `tts_characters`/`tts_tokens` or output-seconds scheme; stable block/fallback errors.
- `TranscriptionRequest` and `SpeechRequest` gain required `user_id` for remote calls; tests for pure sanitization may use explicit fixture IDs.
- Add pinned `av==18.0.0` for server-side duration probing of supported upload containers; CPython 3.12 manylinux 2.28 wheels are available for x86_64 and aarch64, matching the Debian base used by `python:3.12-slim`. Raw PCM duration is computed from bytes/sample width/sample rate/channels.

- [ ] Add failing duration tests for WAV, WebM fixture, PCM, malformed format, max duration, and spoofed client metadata.

```python
def test_server_duration_ignores_client_claim(webm_fixture) -> None:
    measured = measure_audio_duration_seconds(
        webm_fixture.bytes,
        content_type="audio/webm",
        metadata={"duration_seconds": 0.01},
    )
    assert measured == pytest.approx(webm_fixture.actual_duration_seconds, rel=0.01)
```

- [ ] Add PyAV and implement `measure_audio_duration_seconds`; reject invalid/too-long audio before reservation/dispatch.

Append this exact dependency to `backend/requirements.txt`:

```text
av==18.0.0
```

```python
def measure_audio_duration_seconds(payload: bytes, *, content_type: str, metadata: Mapping[str, object]) -> Decimal:
    if "pcm" in content_type:
        sample_rate = require_server_validated_sample_rate(metadata)
        sample_width_bytes = require_server_validated_sample_width_bytes(metadata)
        channels = require_server_validated_channel_count(metadata)
        frame_bytes = Decimal(sample_width_bytes * channels)
        frames = Decimal(len(payload)) / frame_bytes
        return quantity_decimal(frames / Decimal(sample_rate))
    with av.open(io.BytesIO(payload)) as container:
        duration = require_container_duration(container)
    return quantity_decimal(Decimal(str(duration)))
```

- [ ] Add failing audio-adapter tests for STT seconds, provider audio tokens, TTS sanitized characters, empty TTS, cache hit, budget block, and post-provider business failure.

```python
def test_tts_counts_only_sanitized_text(audio_adapter, attribution) -> None:
    final_text = sanitize_speech_text("  做好啦！  ")
    attempt = audio_adapter.begin_tts(
        attribution=attribution,
        attempt_key="speech-1",
        sanitized_text=final_text,
        fingerprint="hmac:tts-request",
    )
    assert attempt.estimate.quantity(ModelUsageMeter.TTS_CHARACTERS) == Decimal(str(len(final_text)))

def test_local_tts_cache_hit_creates_no_event(tts_service, usage_db) -> None:
    tts_service.cache.put("做好啦", b"cached-audio")
    tts_service.synthesize(request_for("做好啦"))
    assert usage_db.event_count(capability="tts") == 0
```

- [ ] Implement STT/TTS adapter contexts and estimates with `recovery_mode=none`; fingerprints are HMACs of provider/model plus payload and never emitted as content.

```python
def begin_stt(
    self,
    request: TranscriptionRequest,
    *,
    duration_seconds: Decimal,
    fingerprint: str,
) -> MeteredProviderAttempt:
    attribution = user_usage_attribution(
        family_id=request.family_id,
        user_id=request.user_id,
        logical_operation_id=request.operation_id,
    )
    return self.base.begin(
        context=self.stt_context(attribution, request),
        estimate=estimate_stt(duration_seconds=duration_seconds),
        fingerprint=fingerprint,
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
```

- [ ] Require user attribution in API-built audio requests, including cooking session paths.

```python
TranscriptionRequest(
    audio_bytes=payload,
    filename=file.filename or "audio",
    content_type=content_type,
    surface=surface,
    language_hint=language_hint or settings.ai_stt_language_hint,
    family_id=membership.family_id,
    user_id=user.id,
    operation_id=create_id("stt-operation"),
)
```

- [ ] Wrap OpenAI STT/TTS HTTP sends; settle STT with provider usage or server duration and TTS with provider usage or sanitized character count.

```python
fingerprint = fingerprint_audio_request(model, text)
attempt = self.usage_adapter.begin_tts(request, sanitized_text=text, fingerprint=fingerprint)
permit = attempt.prepare_dispatch()
response = client.post(f"{self.api_base}/audio/speech", headers=headers, json=payload)
response.raise_for_status()
attempt.settle(self.usage_adapter.tts_receipt(permit, response=response, sanitized_text=text))
```

- [ ] Wrap DashScope synchronous STT/TTS sends with the same contract; downloading an already-generated audio URL is not a second model attempt.

```python
response = client.post(url, headers=headers, json=payload)
response.raise_for_status()
attempt.settle(self.usage_adapter.dashscope_tts_receipt(permit, response.json(), sanitized_text=text))
audio_bytes = extract_or_download_audio(response.json())
```

- [ ] Map pre-dispatch blocks: STT raises a safe “use text input” error; TTS returns/raises a safe “text remains available” error with the stable code and never calls provider.

```python
except ModelUsageBlocked as exc:
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail={"code": exc.code, "message": onsite_model_usage_message(exc.code, capability="tts")},
    ) from exc
```

- [ ] Add tests proving provider success is settled before downstream response/media processing failure and an explicit retry uses a new attempt key.

```python
def test_tts_usage_survives_response_processing_failure(tts_harness) -> None:
    tts_harness.fail_after_provider_success()
    with pytest.raises(AudioPostProcessingError):
        tts_harness.synthesize()
    assert tts_harness.usage_events == 1
    assert tts_harness.provider_calls == 1
```

- [ ] Run audio/model-usage tests.

```bash
cd backend
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pytest tests/model_usage/test_audio_adapter.py tests/ai_audio/test_ai_audio_service.py tests/ai_audio/test_ai_audio_api.py -q
cd ..
git diff --check
```

Expected: duration is server measured; empty/oversized/invalid input never reserves or dispatches; TTS block preserves textual result semantics.

- [ ] Commit Task 14.

```bash
git add backend/requirements.txt backend/app/services/model_usage/adapters/audio.py backend/app/services/ai_audio backend/app/api/ai_audio.py backend/tests/model_usage backend/tests/ai_audio
git commit -m "feat(model-usage): meter speech transcription and synthesis"
```

---

## Task 15: Realtime audio segment/lease metering, cumulative watermarks, disconnects, and cross-month renewal

**Files**

- Create: `backend/app/services/model_usage/adapters/realtime_audio.py`
- Modify: `backend/app/models/model_usage.py`
- Modify: `backend/app/models/__init__.py`
- Create: `backend/alembic/versions/4e5f6a7b8c9d_add_realtime_usage_watermarks.py`
- Modify: `backend/app/services/ai_audio/realtime.py`
- Modify: `backend/app/services/ai_audio/dashscope_audio.py`
- Modify: `backend/app/services/ai_audio/cooking_voice_stream.py`
- Modify: `backend/app/services/model_usage/recovery.py`
- Modify: `backend/app/services/model_usage/retention.py`
- Modify: `backend/app/api/ai_audio.py`
- Create: `backend/tests/model_usage/test_realtime_audio_adapter.py`
- Create: `backend/tests/model_usage/test_realtime_audio_mysql.py`
- Modify: `backend/tests/ai_audio/test_ai_audio_api.py`
- Modify: `backend/tests/ai_audio/test_ai_audio_service.py`

**Interfaces**

- Consumes: authenticated realtime session, server-generated turn/segment/lease sequence, cumulative server input/output clocks, and provider cumulative usage snapshots where available.
- Produces: one terminal reservation/event per dispatched lease; monotonic per-period/session/provider/meter watermark; `active|renewed|blocked|ended|settlement_pending` lease decision.
- WebSocket connection creation alone never reserves or creates an event. Lease duration is fixed at 30 seconds.
- The per-session lease gate serializes provider audio sends, deadline renewal, cancel, timeout, and disconnect. Lease N must reach a durable terminal settlement before lease N+1 can reserve/dispatch or send audio; a settlement-pending lease ends remote voice even in monitoring mode so attribution windows cannot overlap.
- Each configured realtime variant declares `lease_boundary_cumulative_meters`: only provider meters guaranteed observable at every lease boundary use durable watermarks. Missing/decreasing data for a declared meter is settlement pending; variants without that guarantee use server-clock meters or per-lease estimates and never reinterpret a late session total as the last lease.
- Internal STT/TTS within realtime is booked as `realtime_audio`; the AI model invoked by `AIApplicationService` remains `llm`.

- [ ] Add failing ORM/migration tests for `model_usage_realtime_watermarks` family/session/provider/meter uniqueness and 13-month raw retention behavior.

```python
def test_realtime_watermark_identity_is_period_scoped_and_non_nullable() -> None:
    table = Base.metadata.tables["model_usage_realtime_watermarks"]
    assert unique_columns(table, "uq_model_usage_realtime_watermark") == {
        "family_id", "period_start", "session_key", "provider", "meter"
    }
    assert table.c.period_start.nullable is False
    assert table.c.period_end.nullable is False
    assert table.c.session_key.nullable is False
    assert table.c.cumulative_quantity.nullable is False
    assert table.c.sequence.nullable is False
```

- [ ] Add the ORM model and migration `4e5f6a7b8c9d` after `3e4f5a6b7c8d`.

```python
class ModelUsageRealtimeWatermark(Base):
    __tablename__ = "model_usage_realtime_watermarks"
    __table_args__ = (
        UniqueConstraint(
            "family_id",
            "period_start",
            "session_key",
            "provider",
            "meter",
            name="uq_model_usage_realtime_watermark",
        ),
    )
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True
    )
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    session_key: Mapped[str] = mapped_column(String(96), nullable=False)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    meter: Mapped[ModelUsageMeter] = mapped_column(
        SqlEnum(ModelUsageMeter, native_enum=False), nullable=False
    )
    cumulative_quantity: Mapped[Decimal] = mapped_column(Numeric(30, 6), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
```

- [ ] Add failing adapter tests for no-connect event, a 65-second three-lease session, stable attempt replay, concurrent terminal callbacks, content-free receipt recovery after process-state loss, disconnect partial settlement, renewal budget block, settlement-pending renewal, and cross-month new period.

```python
def test_connection_without_remote_audio_has_no_usage(realtime_harness) -> None:
    realtime_harness.connect()
    realtime_harness.disconnect()
    assert realtime_harness.reservations == 0
    assert realtime_harness.events == 0

def test_sixty_five_seconds_terminalizes_three_non_overlapping_leases(realtime_harness) -> None:
    result = realtime_harness.stream_for(
        seconds=65,
        input_clock_totals=[Decimal("30"), Decimal("60"), Decimal("65")],
        output_clock_totals=[Decimal("18"), Decimal("37"), Decimal("40")],
        provider_cumulative_totals=[Decimal("100"), Decimal("145"), Decimal("180")],
    )
    assert [event.quantity("audio_input_seconds") for event in result.events] == [
        Decimal("30"), Decimal("30"), Decimal("5")
    ]
    assert [event.quantity("audio_output_seconds") for event in result.events] == [
        Decimal("18"), Decimal("19"), Decimal("3")
    ]
    assert [event.quantity("audio_input_tokens") for event in result.events] == [
        Decimal("100"), Decimal("45"), Decimal("35")
    ]
    assert sum(event.quantity("audio_input_seconds") for event in result.events) == Decimal("65")
    assert result.active_reservations == []
    assert all(event.terminal for event in result.events)

def test_renewal_settles_previous_lease_before_new_budget_decision(realtime_harness) -> None:
    first = realtime_harness.start_and_expire_first_lease()
    realtime_harness.block_next_reservation("model_usage_capability_limit_exceeded")
    renewal = realtime_harness.send_next_audio_frame()
    assert first.event_id is not None
    assert first.reservation_status == "settled"
    assert renewal.decision == "blocked"
    assert realtime_harness.provider_audio_sends_after(first.expires_at) == 0

def test_pending_terminal_settlement_never_opens_next_lease(realtime_harness) -> None:
    realtime_harness.fail_next_settlement("model_usage_settlement_pending")
    outcome = realtime_harness.send_audio_at_first_lease_deadline()
    assert outcome.decision == "settlement_pending"
    assert realtime_harness.lease_sequences_dispatched == [1]
    assert realtime_harness.remote_voice_ended is True

def test_late_provider_cumulative_increase_blocks_renewal(realtime_harness) -> None:
    realtime_harness.finish_first_lease(provider_cumulative=Decimal("100"))
    outcome = realtime_harness.begin_next_lease(provider_cumulative_before_send=Decimal("105"))
    assert outcome.decision == "settlement_pending"
    assert realtime_harness.lease_sequences_dispatched == [1]

def test_receipt_recovery_advances_event_counter_and_watermark_once(realtime_harness) -> None:
    receipt = realtime_harness.fail_settlement_after_freezing_receipt(cumulative=Decimal("145"))
    realtime_harness.drop_all_process_session_state()
    first = realtime_harness.recover_receipt(receipt)
    replay = realtime_harness.recover_receipt(receipt)
    assert first.event_id == replay.event_id
    assert realtime_harness.durable_watermark(receipt.meter_watermarks[0].meter) == Decimal("145")
    assert realtime_harness.counter_mutations_for(receipt.attempt_key) == 1

def test_cross_month_renewal_uses_new_period(realtime_harness) -> None:
    first = realtime_harness.dispatch_lease(at=aware("2026-07-31T15:59:40Z"))
    second = realtime_harness.renew(at=aware("2026-07-31T16:00:10Z"))
    assert first.event_id is not None
    assert first.period_start != second.period_start
```

- [ ] Implement canonical attempt keys, 30-second estimates, and baseline capture; sequence values come only from locked server session state, not client input.

```python
def realtime_attempt_key(session_id: str, turn_id: str, segment: str, lease_sequence: int) -> str:
    return f"realtime:{session_id}:{turn_id}:{segment}:lease:{lease_sequence}"

def begin_lease(
    self,
    *,
    session: RealtimeVoiceSessionState,
    turn_id: str,
    segment: str,
    now: datetime,
    server_input_clock: CumulativeAudioClock,
    server_output_clock: CumulativeAudioClock,
    provider_cumulative: Mapping[ModelUsageMeter, Decimal],
) -> ActiveRealtimeUsageLease:
    lease_sequence = session.next_lease_sequence
    attempt_key = realtime_attempt_key(session.session_id, turn_id, segment, lease_sequence)
    provider_baselines = require_pre_send_provider_baselines(
        previous=session.provider_meter_watermarks,
        observed=provider_cumulative,
        required_meters=self.billing_variant.lease_boundary_cumulative_meters,
        first_lease=lease_sequence == 1,
    )
    estimate = estimate_realtime_audio(
        billable_meters=self.billing_variant.billable_meters,
        lease_seconds=Decimal("30"),
        input_tokens_per_second_cap=self.billing_variant.input_tokens_per_second_cap,
        output_tokens_per_second_cap=self.billing_variant.output_tokens_per_second_cap,
    )
    attempt = self.base.begin(
        context=self.context(attempt_key=attempt_key),
        estimate=estimate,
        fingerprint=fingerprint_realtime_lease(attempt_key),
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    permit = attempt.prepare_dispatch()
    if permit.send_kind not in {"first_send", "fail_open_single_send"}:
        raise ModelUsageDispatchRecoveryRequired("model_usage_dispatch_recovery_required")
    lease = ActiveRealtimeUsageLease(
        lease_sequence=lease_sequence,
        attempt_key=attempt_key,
        reservation_id=attempt.reservation_id,
        dispatch_permit=permit,
        period=permit.period,
        started_at=permit.dispatched_at,
        expires_at=permit.dispatched_at + timedelta(seconds=30),
        server_input_clock_baseline=server_input_clock.total,
        server_output_clock_baseline=server_output_clock.total,
        provider_meter_baselines=provider_baselines,
    )
    session.active_usage_lease = lease
    session.next_lease_sequence += 1
    return lease
```

`begin_lease` is called only while holding `usage_lease_lock` and only after any prior lease has terminally committed. Its provider baseline is the content-free cumulative snapshot observed before this lease's first send. Every declared meter must be present, including lease 1; missing data is never synthesized as zero. After lease 1 the snapshot must equal the last terminal watermark exactly—an increase means late usage still belongs to the prior window and blocks dispatch until reconciled, while a decrease is invalid. At settlement the durable row must match this baseline. At a Beijing month boundary, a missing current-period row is created from the same absolute baseline and checked against the latest prior-period row. A failure after durable dispatch but before installing local state is treated by the ordinary uncertain recovery path; it never authorizes reconstructing and sending the same `recovery_mode=none` attempt.

- [ ] Add failing cumulative-usage tests showing `100 → 145 → 180` settles `100 → 45 → 35` exactly once, same-attempt replay does not advance again, and decreasing/baseline-mismatched watermarks are rejected.

```python
def test_cumulative_usage_is_converted_to_monotonic_delta(realtime_adapter) -> None:
    assert realtime_adapter.delta(session="s1", meter="audio_input_tokens", cumulative=100) == Decimal("100")
    assert realtime_adapter.delta(session="s1", meter="audio_input_tokens", cumulative=145) == Decimal("45")
    assert realtime_adapter.delta(session="s1", meter="audio_input_tokens", cumulative=180) == Decimal("35")
    replay = realtime_adapter.replay_terminal_lease(session="s1", lease_sequence=3)
    assert replay.existing_event is True
    assert replay.watermark == Decimal("180")
    with pytest.raises(ModelUsageSettlementPending, match="realtime_watermark_decreased"):
        realtime_adapter.delta(session="s1", meter="audio_input_tokens", cumulative=120)

def test_lease_baseline_must_match_durable_watermark(realtime_adapter) -> None:
    lease = realtime_adapter.active_lease(provider_meter_baselines={"audio_input_tokens": Decimal("100")})
    realtime_adapter.force_durable_watermark("audio_input_tokens", Decimal("145"))
    with pytest.raises(ModelUsageSettlementPending, match="realtime_watermark_baseline_conflict"):
        realtime_adapter.finish_active_lease(lease, provider_cumulative={"audio_input_tokens": Decimal("180")})
```

- [ ] Implement sorted watermark row locks after the base settlement locks; validate the active lease baseline and update each row in the same transaction that claims the event and mutates counters.

```python
watermark = lock_or_create_realtime_watermark(
    db,
    key,
    initial_cumulative_quantity=lease.provider_meter_baselines[meter],
)
expected_baseline = lease.provider_meter_baselines[meter]
if watermark.cumulative_quantity != expected_baseline:
    raise ModelUsageSettlementPending("realtime_watermark_baseline_conflict")
if reported_cumulative < expected_baseline:
    raise ModelUsageSettlementPending("realtime_watermark_decreased")
delta = reported_cumulative - expected_baseline
watermark.cumulative_quantity = reported_cumulative
watermark.sequence = lease_sequence
```

The fixed settlement lock order is current policy pointer → reservation → family/capability counters → event unique claim → watermark rows sorted by meter. No path may lock a watermark before the policy/reservation/counter set. If the event claim replays, return the existing event before changing any watermark. Baseline/end/sequence evidence lives in the content-free `ProviderUsageReceipt`, so queue/log recovery after a process restart can advance the exact same row without reconstructing values from current session state. At a Beijing month boundary, initialize the new period row with the prior row's last cumulative quantity as its baseline, then charge only the provider delta reported after the boundary. The new row's `cumulative_quantity` stores the provider's absolute watermark, not a month-local reset.

If a variant contract does not declare lease-boundary cumulative support, settle server-clock meters from that lease's own baselines and mark provider-only meters estimated from its reservation; do not create a watermark for them. If a declared cumulative meter is missing, decreased, or disagrees with the active baseline, settlement remains pending and renewal stops. A later session-total snapshot must not be charged wholly to the final lease or layered on top of prior estimates; only a provider-supported, deterministic per-lease allocation may create adjustment groups for those terminal events.

- [ ] Extend Task 10 retention order and verification so period-scoped realtime watermarks are pruned with their raw ledger period and are absent before `correction_status=closed`.

```python
RAW_DELETE_ORDER = (
    "model_usage_alert_receipts", "model_usage_alerts",
    "model_usage_measurement_incident_attempts", "model_usage_adjustments",
    "model_usage_adjustment_groups",
    "model_usage_event_meters", "model_usage_events",
    "model_usage_reservation_meters", "model_usage_reservations",
    "model_usage_realtime_watermarks", "model_usage_period_counters",
    "model_usage_measurement_incidents",
)
```

- [ ] Add an explicit active-lease state and a per-session async gate; keep business audio/text out of every usage reference.

```python
@dataclass(slots=True)
class ActiveRealtimeUsageLease:
    lease_sequence: int
    attempt_key: str
    reservation_id: str | None
    dispatch_permit: DispatchPermit
    period: BillingPeriod
    started_at: datetime
    expires_at: datetime
    server_input_clock_baseline: Decimal
    server_output_clock_baseline: Decimal
    provider_meter_baselines: Mapping[ModelUsageMeter, Decimal]
    terminal_state: Literal["active", "settlement_pending", "terminal"] = "active"
    terminal_provider_watermarks: Mapping[ModelUsageMeter, Decimal] | None = None
    terminal_receipt: ProviderUsageReceipt | None = None
    terminal_event_id: str | None = None

@dataclass(slots=True)
class RealtimeVoiceSessionState:
    session_id: str
    family_id: str
    user_id: str
    provider: str
    next_lease_sequence: int = 1
    provider_meter_watermarks: dict[ModelUsageMeter, Decimal] = field(default_factory=dict)
    active_usage_lease: ActiveRealtimeUsageLease | None = None
    usage_lease_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
```

`dispatch_permit` is the content-free permit from Task 6; the receipt persists `subject_key`, never `user_id`. Provider meter baselines are immutable snapshots captured before the first send of this lease. `terminal_state="terminal"` is set only after an event commit or idempotent reload of that existing event, not merely because a local `finally` block ran.

- [ ] Implement `ensure_active_lease` as `finish N → commit terminal N → reserve/dispatch N+1`; start a lease immediately before its first provider audio frame and stop when renewal is blocked or prior settlement is pending.

```python
async def send_metered_remote_audio(provider_audio_frame: bytes, *, frame_seconds: Decimal) -> None:
    async with session.usage_lease_lock:
        outcome = usage_adapter.ensure_active_lease(
            session=session,
            turn_id=turn_id,
            segment="duplex",
            now=utcnow(),
            server_input_clock=server_input_clock,
            server_output_clock=server_output_clock,
            provider_cumulative=provider_usage_snapshot(),
        )
        if outcome.decision in {"blocked", "settlement_pending"}:
            await send_json({
                "type": "usage_limit",
                "code": outcome.error_code,
                "message": "本次语音会话已结束，可以继续使用文字。",
            })
            await stop_remote_voice_without_stopping_text()
            return
        if outcome.decision == "ended":
            await stop_remote_voice_without_stopping_text()
            return
        await provider_websocket.send(provider_audio_frame)
        server_input_clock.add(frame_seconds)
```

Inside `ensure_active_lease`, an unexpired active lease returns `active`. At/after its deadline, first call `finish_active_lease`; clear it only after terminal commit, then obtain provider baselines, reserve/dispatch the next server sequence and install the new active lease. A blocked reservation consumes no provider send. `already_accounted`, `recovery_required`, an expired fail-open proof, or settlement pending ends remote voice rather than treating an old permit as a new send authorization. Increment `next_lease_sequence` only after a new dispatch permit has been installed. A deadline task acquires the same lock at `expires_at`, so a quiet connection cannot leave an expired dispatching reservation open until disconnect.

- [ ] Settle only the active lease's server-clock/provider-watermark deltas on deadline, segment end, cancel, timeout, and disconnect; serialize concurrent callbacks and never pass whole-segment elapsed values.

```python
def finish_active_lease(
    session: RealtimeVoiceSessionState,
    *,
    input_clock_total: Decimal,
    output_clock_total: Decimal,
    provider_cumulative: Mapping[ModelUsageMeter, Decimal],
    completion_reason: str,
) -> LeaseTerminalOutcome:
    lease = require_value(session.active_usage_lease)
    if lease.terminal_state == "terminal":
        return LeaseTerminalOutcome.existing(lease.terminal_event_id)
    if lease.terminal_receipt is None:
        try:
            input_delta = require_non_negative(input_clock_total - lease.server_input_clock_baseline)
            output_delta = require_non_negative(output_clock_total - lease.server_output_clock_baseline)
            lease.terminal_provider_watermarks = freeze_required_provider_watermarks(
                baselines=lease.provider_meter_baselines,
                observed=provider_cumulative,
            )
            lease.terminal_receipt = build_realtime_lease_receipt(
                lease=lease,
                server_input_seconds=input_delta,
                server_output_seconds=output_delta,
                provider_cumulative=lease.terminal_provider_watermarks,
                meter_watermarks=tuple(
                    ProviderMeterWatermark(
                        meter=meter,
                        lease_sequence=lease.lease_sequence,
                        baseline_quantity=baseline,
                        cumulative_quantity=require_value(lease.terminal_provider_watermarks)[meter],
                    )
                    for meter, baseline in sorted(
                        lease.provider_meter_baselines.items(), key=lambda item: item[0].value
                    )
                ),
                completion_reason=completion_reason,
            )
        except ModelUsageSettlementPending as exc:
            lease.terminal_state = "settlement_pending"
            return LeaseTerminalOutcome.pending(error_code=exc.code)
    try:
        outcome = settle_realtime_lease(lease=lease, receipt=lease.terminal_receipt)
    except ModelUsageSettlementPending as exc:
        lease.terminal_state = "settlement_pending"
        return LeaseTerminalOutcome.pending(error_code=exc.code)
    if outcome.terminal:
        session.provider_meter_watermarks.update({
            meter: require_value(lease.terminal_provider_watermarks)[meter]
            for meter in lease.provider_meter_baselines
        })
        lease.terminal_state = "terminal"
        lease.terminal_event_id = outcome.event_id
        session.active_usage_lease = None
    return outcome

async def finish_current_lease_once(completion_reason: str) -> None:
    async with session.usage_lease_lock:
        if session.active_usage_lease is None:
            return
        finish_active_lease(
            session,
            input_clock_total=server_input_clock.total,
            output_clock_total=server_output_clock.total,
            provider_cumulative=provider_usage_snapshot(),
            completion_reason=completion_reason,
        )
```

The first terminalization attempt freezes one content-free `terminal_receipt`; DB retry, queue recovery, disconnect and concurrent callbacks reuse it instead of recomputing from later clock/watermark values. Server-clock zero is valid only when that frozen boundary actually observed zero. Missing provider-only usage for a variant without declared boundary support is filled from that lease's reservation estimate with `measurement_status=estimated`; it is never silently converted to zero. Concurrent deadline/disconnect/cancel callbacks all use `finish_current_lease_once`; the attempt/event unique claim makes a replay return the terminal event without a second counter or watermark mutation. If settlement remains pending, no renewal or provider frame is allowed and maintenance owns later recovery; later provider increments are separate reconciliation evidence, not mutations of the frozen receipt.

- [ ] Ensure `DashScopeAudioProvider.transcribe_realtime_audio`, `synthesize_realtime_text`, and `stream_realtime_text` receive a realtime usage scope and do not create separate STT/TTS events.

```python
RealtimeProviderScope(
    capability=ModelUsageCapability.REALTIME_AUDIO,
    session_id=session.session_id,
    turn_id=turn_id,
    family_id=session.family_id,
    user_id=session.user_id,
)
```

- [ ] Run realtime adapter/MySQL/audio tests and head check.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_realtime_audio_adapter.py tests/model_usage/test_realtime_audio_mysql.py tests/ai_audio/test_ai_audio_api.py tests/ai_audio/test_ai_audio_service.py -q
.venv/bin/alembic heads
cd ..
git diff --check
```

Expected: head is `4e5f6a7b8c9d`; connections alone cost nothing; a 65-second session has exactly three terminal lease events, zero active reservations, non-overlapping quantities whose sums equal the session clocks, and provider cumulative deltas `100/45/35`; concurrent terminal callbacks and post-restart receipt replay do not duplicate events/counters/watermarks; lease N settlement or replay completes before any N+1 send; a blocked or settlement-pending renewal ends remote audio without affecting text; cross-month watermarks keep their absolute baseline; LLM events remain separate.

- [ ] Commit Task 15.

```bash
git add backend/app/services/model_usage/adapters/realtime_audio.py backend/app/services/model_usage/recovery.py backend/app/services/model_usage/retention.py backend/app/models/model_usage.py backend/app/models/__init__.py backend/alembic/versions/4e5f6a7b8c9d_add_realtime_usage_watermarks.py backend/app/services/ai_audio backend/app/api/ai_audio.py backend/tests/model_usage backend/tests/ai_audio
git commit -m "feat(model-usage): meter realtime audio leases"
```

---

## Task 16: Image-generation metering before attempt count and no regeneration after provider success

**Files**

- Create: `backend/app/services/model_usage/adapters/image_generation.py`
- Modify: `backend/app/models/domain.py`
- Create: `backend/alembic/versions/5f6a7b8c9d0e_add_image_usage_recovery_state.py`
- Modify: `backend/app/ai/images/generation.py`
- Modify: `backend/app/ai/images/jobs.py`
- Modify: `backend/app/api/media.py`
- Modify: `backend/app/schemas/media.py`
- Create: `backend/tests/model_usage/test_image_generation_adapter.py`
- Create: `backend/tests/model_usage/test_image_job_usage.py`
- Modify: `backend/tests/media/test_ai_image_job_api.py`
- Modify: `backend/tests/ai_infra/test_recipe_drafts_and_images.py`

**Interfaces**

- Consumes: image job family/user, job ID, provider attempt sequence, exact image count, size/quality/mode variant; prompt/reference stays inside image provider.
- Produces: one event per provider attempt, `MeteredImageGenerationResult(image, usage_event_id)`, and explicit job phase/error code.
- New job fields: `usage_attempt_key`, `usage_reservation_id`, `usage_event_id` (all diagnostic strings with no retention-blocking FK), `provider_execution_status`, `provider_completed_at`, `error_code`.
- Budget block occurs before `attempt_count += 1`; ambiguous provider execution is not auto-retried; provider success followed by MinIO/binding failure never calls generation again.
- A pre-dispatch budget block maps the existing job status to `failed`, sets a stable `model_usage_*` error code, and exposes `can_retry=false`; it does not expand the existing frontend image-status union.

- [ ] Add failing image-adapter tests for text/reference variants, fixed image count, request-unit fee composition, budget block, provider rejection, timeout uncertain, and content-free receipt.

```python
def test_image_variant_contains_only_billable_dimensions(adapter, attribution) -> None:
    attempt = adapter.begin(
        attribution=attribution,
        attempt_key="image-job-1:attempt:1",
        provider="dashscope",
        model="wan-test",
        mode="reference",
        image_count=1,
        size="1536*1152",
        quality="standard",
        fingerprint="hmac:image-request",
    )
    assert attempt.context.variant_key == "mode=reference|size=1536*1152|quality=standard"
    assert "prompt" not in attempt.context.__dataclass_fields__
```

- [ ] Implement image estimate/context and `recovery_mode=none`; generated images and independent request units may both be billable only if the catalog scheme declares both.

```python
def estimate_image_generation(*, image_count: int, include_request_fee: bool) -> UsageEstimate:
    meters = [meter_quantity(ModelUsageMeter.GENERATED_IMAGES, image_count)]
    if include_request_fee:
        meters.append(meter_quantity(ModelUsageMeter.REQUEST_UNITS, 1))
    return UsageEstimate(meters=tuple(meters))
```

- [ ] Add migration/model tests for the new job phase fields and non-FK diagnostic reservation ID.

```python
def test_image_job_usage_references_do_not_block_retention() -> None:
    columns = Base.metadata.tables["ai_image_generation_jobs"].c
    assert list(columns.usage_reservation_id.foreign_keys) == []
    assert list(columns.usage_event_id.foreign_keys) == []
```

- [ ] Add fields in `domain.py` and migration `5f6a7b8c9d0e` after the realtime revision.

```python
revision = "5f6a7b8c9d0e"
down_revision = "4e5f6a7b8c9d"

def upgrade() -> None:
    op.add_column("ai_image_generation_jobs", sa.Column("usage_attempt_key", sa.String(255), nullable=True))
    op.add_column("ai_image_generation_jobs", sa.Column("usage_reservation_id", sa.String(64), nullable=True))
    op.add_column("ai_image_generation_jobs", sa.Column("usage_event_id", sa.String(64), nullable=True))
    op.add_column("ai_image_generation_jobs", sa.Column("provider_execution_status", sa.String(32), nullable=False, server_default="not_started"))
    op.add_column("ai_image_generation_jobs", sa.Column("provider_completed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("ai_image_generation_jobs", sa.Column("error_code", sa.String(64), nullable=True))
```

- [ ] Add failing job tests: reserve block keeps attempt count zero/provider calls zero; success + MinIO failure has one provider call/event; bind retry does not regenerate.

```python
def test_budget_block_does_not_increment_provider_attempt(job_harness) -> None:
    job_harness.block_usage("model_usage_budget_exceeded")
    job_harness.process()
    assert job_harness.job.attempt_count == 0
    assert job_harness.provider_calls == 0
    assert job_harness.job.error_code == "model_usage_budget_exceeded"
    assert job_harness.job.status == "failed"
    assert job_harness.api_response["can_retry"] is False

def test_bind_retry_reuses_generated_asset(job_harness) -> None:
    job_harness.fail_binding_once()
    job_harness.process()
    job_harness.retry_binding()
    assert job_harness.provider_calls == 1
    assert job_harness.usage_events == 1
```

- [ ] Refactor job processing so request loading and reserve occur before running/attempt-count mutation.

```python
request = load_image_request_in_short_session(job_id)
try:
    usage_attempt = image_usage_adapter.begin_for_job(job, request)
except ModelUsageBlocked as exc:
    mark_image_job_budget_blocked(job_id, error_code=exc.code)
    return
mark_image_job_provider_start(job_id, usage_attempt)
```

`mark_image_job_budget_blocked` must update only terminal metadata; it must not increment `attempt_count` or set a provider-start timestamp:

```python
def mark_image_job_budget_blocked(job_id: str, *, error_code: str) -> None:
    with SessionLocal.begin() as db:
        job = require_image_job_for_update(db, job_id)
        job.status = "failed"
        job.error_code = error_code
        job.error = onsite_model_usage_message(error_code, capability="image_generation")
        job.provider_execution_status = "not_started"
        job.completed_at = utcnow()
```

- [ ] Wrap DashScope/OpenAI image HTTP sends inside `ImageGenerationClient` with dispatch and exact/estimated receipt normalization; image download is part of the same provider attempt.

```python
@dataclass(frozen=True, slots=True)
class MeteredImageGenerationResult:
    image: ImageGenerationResult
    usage_event_id: str

permit = usage_attempt.prepare_dispatch()
response = client.post(endpoint, headers=headers, json=provider_payload)
response.raise_for_status()
settlement = usage_attempt.settle(image_usage_adapter.receipt_from_response(permit, response))
return MeteredImageGenerationResult(
    image=download_or_decode_image(response),
    usage_event_id=settlement.event_id,
)
```

The HMAC fingerprint may cover content bytes internally but only the digest is persisted/logged.

- [ ] Mark `provider_execution_status=confirmed` and settle before MinIO save/binding; a later failure is terminal post-provider work, not a generation retry.

```python
provider_result = client.generate(request, usage_attempt=usage_attempt)
mark_provider_completed(job_id, usage_event_id=provider_result.usage_event_id)
try:
    generated_asset = save_and_bind_generated_result(job_id, request, provider_result.image)
except Exception as exc:
    mark_post_provider_failure(job_id, error_code="image_post_provider_persistence_failed", error=str(exc))
    return
```

- [ ] Restrict retry behavior: confirmed-not-executed may create a new attempt; uncertain remains pending recovery; generated asset with bind failure runs bind-only compensation; lost post-provider bytes cannot be regenerated automatically.

```python
def retry_mode_for_image_job(job: AIImageGenerationJob) -> str:
    if job.generated_media_id and job.error_code == "image_bind_failed":
        return "bind_only"
    if job.provider_execution_status == "confirmed_not_executed":
        return "new_provider_attempt"
    raise ValueError("Image job cannot safely re-run the provider")
```

- [ ] Expose stable `error_code` and safe `can_retry` semantics in media schema/API without leaking provider response bodies.

```python
return {
    "job_id": job.id,
    "status": job.status,
    "error": safe_image_job_error(job),
    "error_code": job.error_code,
    "can_retry": image_job_can_retry(job),
}

def image_job_can_retry(job: AIImageGenerationJob) -> bool:
    if job.error_code and job.error_code.startswith("model_usage_"):
        return False
    if job.generated_media_id and job.error_code == "image_bind_failed":
        return True
    return job.provider_execution_status == "confirmed_not_executed"
```

- [ ] Run image adapter/job/API tests and Alembic head check.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_image_generation_adapter.py tests/model_usage/test_image_job_usage.py tests/media/test_ai_image_job_api.py tests/ai_infra/test_recipe_drafts_and_images.py -q
.venv/bin/alembic heads
cd ..
git diff --check
```

Expected: head is `5f6a7b8c9d0e`; budget blocks do not increment attempts; provider success always creates usage; media/bind compensation never creates a second provider call.

- [ ] Commit Task 16.

```bash
git add backend/app/services/model_usage/adapters/image_generation.py backend/app/models/domain.py backend/alembic/versions/5f6a7b8c9d0e_add_image_usage_recovery_state.py backend/app/ai/images/generation.py backend/app/ai/images/jobs.py backend/app/api/media.py backend/app/schemas/media.py backend/tests/model_usage backend/tests/media/test_ai_image_job_api.py backend/tests/ai_infra/test_recipe_drafts_and_images.py
git commit -m "feat(model-usage): meter image generation jobs"
```

---
## Task 17: Scoped backend overview/breakdown, policy OCC, alert APIs, and privacy-safe schemas

**Files**

- Create: `backend/app/schemas/model_usage.py`
- Create: `backend/app/services/model_usage/queries.py`
- Create: `backend/app/services/model_usage/serializers.py`
- Create: `backend/app/api/model_usage.py`
- Modify: `backend/app/api/router.py`
- Create: `backend/tests/model_usage/test_usage_api.py`
- Create: `backend/tests/model_usage/test_usage_api_permissions.py`
- Create: `backend/tests/model_usage/test_policy_api.py`
- Create: `backend/tests/model_usage/test_alert_api.py`
- Create: `backend/tests/model_usage/test_usage_api_contract.py`

**Interfaces**

- Personal: `GET /api/model-usage/me/overview`, `GET /api/model-usage/me/breakdown`.
- Owner: `GET /api/model-usage/family/overview`, `GET /api/model-usage/family/breakdown`, `GET|PUT /api/model-usage/family/policy`.
- Owner alerts: `GET /api/model-usage/alerts`, `POST /api/model-usage/alerts/{alert_id}/seen`, `POST /api/model-usage/alerts/{alert_id}/dismiss`.
- Query: `period=YYYY-MM`; breakdown adds `group_by=capability|provider_model|subject|meter|daily_capability_cost`.
- Decimal values are response strings. Owner and member use distinct Pydantic response models so forbidden fields cannot serialize.
- Policy 409 detail contains `code`, `current_policy`, `current_version_number`, and `recovery_hint`.

- [ ] Add failing response-contract tests for separate schemas, Decimal strings, sub-cent values, partial pricing, and all orthogonal health fields.

```python
def test_personal_schema_has_no_owner_fields() -> None:
    forbidden = {
        "monthly_budget_cny", "family_total_cost_cny", "budget_percent",
        "capability_limits", "members", "system_usage",
    }
    assert forbidden.isdisjoint(ModelUsagePersonalOverviewOut.model_fields)

def test_sub_cent_cost_is_not_serialized_as_zero(api_client, personal_usage) -> None:
    response = api_client.get("/api/model-usage/me/overview?period=2026-07")
    assert response.json()["known_priced_cost_cny"] == "0.001000000000"
```

- [ ] Define shared health/dimension schemas and separate personal/owner overview/breakdown schemas.

```python
class ModelUsageMeasurementHealthOut(BaseModel):
    exact_event_count: int
    estimated_event_count: int
    unpriced_event_count: int
    uncertain_attempt_count: int
    pending_attempt_count: int
    unresolved_unknown_execution_attempt_count: int
    conservative_estimated_cost_cny: str | None
    known_unmeasured_attempt_count: int
    measurement_gap: bool
    measurement_gap_scope: list[str]
    gap_intervals: list[ModelUsageGapIntervalOut]
```

- [ ] Add failing query-service tests for current counter/raw split, historical rollup-only reads, partial month, owner family/my scope, and allowed groupings.

```python
def test_historical_overview_does_not_read_pruned_raw_rows(query_spy, closed_rollup) -> None:
    overview = get_family_usage_overview(query_spy.db, family_id=closed_rollup.family_id, period="2025-01")
    assert overview.source == "rollup"
    assert query_spy.raw_event_queries == 0
```

- [ ] Implement period parsing and query dispatch to current raw aggregation or historical rollups.

```python
def get_family_usage_overview(db: Session, *, family_id: str, period: str, at: datetime) -> FamilyUsageOverview:
    requested = parse_local_month(period)
    current = shanghai_billing_period(at)
    if requested.start_at == current.start_at:
        return build_current_family_overview(db, family_id=family_id, period=requested)
    return build_historical_family_overview(db, family_id=family_id, period=requested)
```

- [ ] Implement `total_cost_cny` omission semantics: only serialize it when pricing is complete; always include `known_priced_cost_cny`, `pricing_complete`, and `unpriced_event_count`.

```python
def serialize_cost_summary(aggregate: UsageAggregate) -> dict[str, object]:
    payload = {
        "known_priced_cost_cny": decimal_text(aggregate.known_priced_cost_cny),
        "pricing_complete": aggregate.unpriced_event_count == 0,
        "unpriced_event_count": aggregate.unpriced_event_count,
    }
    if aggregate.unpriced_event_count == 0:
        payload["total_cost_cny"] = decimal_text(aggregate.known_priced_cost_cny)
    return payload
```

- [ ] Add failing permissions/IDOR tests with two families, owners, ordinary members, exited and deleted subjects.

```python
def test_member_family_endpoint_is_forbidden_and_personal_has_no_family_amount(member_client) -> None:
    assert member_client.get("/api/model-usage/family/overview?period=2026-07").status_code == 403
    payload = member_client.get("/api/model-usage/me/overview?period=2026-07").json()
    assert "monthly_budget_cny" not in payload
    assert "budget_percent" not in payload
    assert "family_total_cost_cny" not in payload
```

- [ ] Implement API routes using `get_current_auth` for personal and `require_owner` for family/policy/alerts; never accept family/user identity from request bodies.

```python
@router.get("/api/model-usage/me/overview", response_model=ModelUsagePersonalOverviewOut)
def personal_overview(
    period: str,
    auth: tuple[User, Membership] = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    user, membership = auth
    return serialize_personal_overview(
        get_personal_usage_overview(db, family_id=membership.family_id, user_id=user.id, period=period)
    )
```

- [ ] Add policy API tests for full immutable GET, successful PUT, validation, 409 contract, amount-free activity log, missing-price hard-limit confirmation, and rejection of request-body actor/creator identity fields.

```python
def test_policy_conflict_returns_current_policy_and_keeps_client_draft(owner_client) -> None:
    response = owner_client.put("/api/model-usage/family/policy", json=policy_payload(base_version_number=1))
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "model_usage_policy_conflict"
    assert detail["current_version_number"] == 2
    assert detail["recovery_hint"] == "review_current_policy_and_reapply"

def test_policy_request_cannot_spoof_creator_subject(owner_client, other_family_subject) -> None:
    payload = policy_payload(base_version_number=1)
    payload["actor_subject_id"] = other_family_subject.id
    response = owner_client.put("/api/model-usage/family/policy", json=payload)
    assert response.status_code == 422
```

- [ ] Implement PUT policy OCC and activity log summary with no amount/limit details.

```python
actor_subject = ensure_user_subject(
    db,
    family_id=membership.family_id,
    user_id=user.id,
)
command = command_from_request(
    membership=membership,
    payload=payload,
    actor_subject_id=actor_subject.id,
)
version = update_family_policy(db, command)
log_activity(
    db,
    family_id=membership.family_id,
    actor_id=user.id,
    action=ActivityAction.UPDATE,
    entity_type="ModelUsagePolicy",
    entity_id=version.id,
    summary="更新了模型预算设置",
)
commit_session(db)
```

`ModelUsagePolicyUpdateRequest` sets `extra="forbid"`; `command_from_request` derives `family_id` from the authenticated membership and receives `actor_subject_id` only as a server-side argument. Neither identity is copied from JSON, even if a client sends a field with the same name.

- [ ] Add alert API tests for Owner-only list, independent receipts, seen/dismiss idempotency, dismissed filtering, and cross-family IDs.

```python
def test_owner_receipts_are_independent(owner_a_client, owner_b_client, alert_id) -> None:
    owner_a_client.post(f"/api/model-usage/alerts/{alert_id}/dismiss")
    assert alert_id not in ids(owner_a_client.get("/api/model-usage/alerts").json())
    assert alert_id in ids(owner_b_client.get("/api/model-usage/alerts").json())
```

- [ ] Implement family-scoped receipt mutations with row locking and idempotent timestamps.

```python
receipt = require_owner_alert_receipt_for_update(
    db,
    family_id=membership.family_id,
    owner_user_id=user.id,
    alert_id=alert_id,
)
receipt.dismissed_at = receipt.dismissed_at or utcnow()
commit_session(db)
```

- [ ] Register the new router and run all backend API contract tests.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage/test_usage_api.py tests/model_usage/test_usage_api_permissions.py tests/model_usage/test_policy_api.py tests/model_usage/test_alert_api.py tests/model_usage/test_usage_api_contract.py -q
cd ..
git diff --check
```

Expected: Owner and member schemas differ structurally; all IDOR paths are rejected; no content or subject key is present.

- [ ] Commit Task 17.

```bash
git add backend/app/schemas/model_usage.py backend/app/services/model_usage/queries.py backend/app/services/model_usage/serializers.py backend/app/api/model_usage.py backend/app/api/router.py backend/tests/model_usage
git commit -m "feat(model-usage): expose scoped usage and policy api"
```

---

## Task 18: Frontend API contracts, query keys, cache invalidation, formatting, and state view models

**Files**

- Create: `frontend/src/api/modelUsageApi.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/queryKeys.ts`
- Modify: `frontend/src/api/cacheInvalidation.ts`
- Create: `frontend/src/features/model-usage/modelUsageOptions.ts`
- Create: `frontend/src/features/model-usage/modelUsageModel.ts`
- Create: `frontend/src/features/model-usage/useModelUsageQueries.ts`
- Create: `frontend/src/features/model-usage/useModelUsagePolicy.ts`
- Create: `frontend/src/api/modelUsageApi.test.ts`
- Create: `frontend/src/features/model-usage/modelUsageModel.test.ts`
- Create: `frontend/src/features/model-usage/useModelUsageQueries.test.tsx`
- Create: `frontend/src/features/model-usage/useModelUsagePolicy.test.tsx`

**Interfaces**

- Consumes: Task 17 snake_case JSON; authenticated `familyId`, role, period, scope, groupBy.
- Produces: typed API client, family-isolated React Query keys, `ModelUsageWorkspaceViewModel`, policy draft/mutation state.
- Required query key identity: overview uses familyId + scope + period; breakdown adds groupBy; policy and alerts remain family-isolated.
- Central options map capability/meter/status/error codes to concise Chinese; call sites do not inspect arbitrary message strings.
- Extend `SearchIndexJobStatus` to include backend status `budget_blocked`; Task 21 maps it to a non-retryable attention notification without changing the background-notification status union.

- [ ] Add failing type/client tests for every endpoint and request/response shape.

```typescript
it('sends policy OCC and preserves decimal strings', async () => {
  mockJson({ version_number: 3, monthly_budget_cny: '80.000000000000' });
  await modelUsageApi.updateFamilyModelUsagePolicy({
    base_version_number: 2,
    monthly_budget_cny: '80.000000000000',
    alerts_enabled: true,
    hard_limit_enabled: false,
    capability_limits: [],
    confirm_missing_price_impact: false,
  });
  expect(lastRequest()).toMatchObject({
    url: '/api/model-usage/family/policy',
    method: 'PUT',
  });
});
```

- [ ] Define API types with distinct `ModelUsagePersonalOverview` and `ModelUsageFamilyOverview`; do not use one union with optional owner fields.

```typescript
export interface ModelUsagePersonalOverview extends ModelUsageOverviewBase {
  scope: 'me';
  family_budget_state: ModelUsageMemberBudgetState;
}

export interface ModelUsageFamilyOverview extends ModelUsageOverviewBase {
  scope: 'family';
  monthly_budget_cny: string | null;
  effective_spend_cny: string;
  reserved_cost_cny: string;
  hard_limit_enabled: boolean;
}

export type SearchIndexJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'budget_blocked';

export interface SearchIndexJobResponse {
  job_id: string;
  status: SearchIndexJobStatus;
  error?: string | null;
  error_code?: ModelUsageErrorCode | null;
  entity_type: SearchEntityType;
  entity_id: string;
  target_name: string;
  vector_status: SearchIndexVectorStatus;
  created_at: string;
  completed_at?: string | null;
}
```

- [ ] Implement `modelUsageApi.ts` and spread it into the central `api` object.

```typescript
export const modelUsageApi = {
  getMyModelUsageOverview: (period: string) =>
    request<ModelUsagePersonalOverview>(`/api/model-usage/me/overview?${params({ period })}`),
  getMyModelUsageBreakdown: (period: string, groupBy: ModelUsageGroupBy) =>
    request<ModelUsageBreakdown>(`/api/model-usage/me/breakdown?${params({ period, group_by: groupBy })}`),
  getFamilyModelUsageOverview: (period: string) =>
    request<ModelUsageFamilyOverview>(`/api/model-usage/family/overview?${params({ period })}`),
  getFamilyModelUsageBreakdown: (period: string, groupBy: ModelUsageGroupBy) =>
    request<ModelUsageBreakdown>(`/api/model-usage/family/breakdown?${params({ period, group_by: groupBy })}`),
  getFamilyModelUsagePolicy: () =>
    request<ModelUsagePolicy>('/api/model-usage/family/policy'),
  updateFamilyModelUsagePolicy: (payload: UpdateModelUsagePolicyPayload) =>
    request<ModelUsagePolicy>('/api/model-usage/family/policy', { method: 'PUT', body: JSON.stringify(payload) }),
  getModelUsageAlerts: () =>
    request<ModelUsageAlert[]>('/api/model-usage/alerts'),
  markModelUsageAlertSeen: (alertId: string) =>
    request<ModelUsageAlertReceipt>(`/api/model-usage/alerts/${alertId}/seen`, { method: 'POST' }),
  dismissModelUsageAlert: (alertId: string) =>
    request<ModelUsageAlertReceipt>(`/api/model-usage/alerts/${alertId}/dismiss`, { method: 'POST' }),
};
```

- [ ] Add failing query-key tests proving family, scope, period, and groupBy produce different keys.

```typescript
expect(queryKeys.modelUsageOverview('family-a', 'family', '2026-07'))
  .not.toEqual(queryKeys.modelUsageOverview('family-b', 'family', '2026-07'));
expect(queryKeys.modelUsageOverview('family-a', 'me', '2026-07'))
  .not.toEqual(queryKeys.modelUsageOverview('family-a', 'family', '2026-07'));
expect(queryKeys.modelUsageBreakdown('family-a', 'family', '2026-07', 'capability'))
  .not.toEqual(queryKeys.modelUsageBreakdown('family-a', 'family', '2026-07', 'meter'));
```

- [ ] Define `modelUsageRoot` above the existing exported `queryKeys` object, insert the five properties shown below into that object, and use `queryKeys.modelUsageRoot(familyId)` as the family-scoped invalidation prefix.

```typescript
const modelUsageRoot = (familyId: string) => ['model-usage', familyId] as const;

modelUsageRoot,
modelUsageOverview: (familyId: string, scope: ModelUsageScope, period: string) =>
  ['model-usage', familyId, 'overview', scope, period] as const,
modelUsageBreakdown: (familyId: string, scope: ModelUsageScope, period: string, groupBy: ModelUsageGroupBy) =>
  ['model-usage', familyId, 'breakdown', scope, period, groupBy] as const,
modelUsagePolicy: (familyId: string) => ['model-usage', familyId, 'policy'] as const,
modelUsageAlerts: (familyId: string) => ['model-usage', familyId, 'alerts'] as const,
```

- [ ] Add failing formatting/model tests for zero, sub-cent, exact/estimated, all-unpriced, mixed pricing, unknown conservative cost, known unmeasured, and unknown gap copy.

```typescript
it.each([
  ['0.000000000000', '¥0.00'],
  ['0.001000000000', '小于 ¥0.01'],
  ['12.345000000000', '¥12.35'],
])('formats CNY without feeding display rounding back to policy', (raw, expected) => {
  expect(formatModelUsageCny(raw)).toBe(expected);
});
```

- [ ] Implement pure formatters and `buildModelUsageWorkspaceViewModel`; never convert service Decimal strings to numbers for mutation payloads.

```typescript
export function costDisplay(summary: ModelUsageCostSummary): string {
  if (!summary.pricing_complete && summary.known_priced_cost_cny === '0.000000000000') return '未定价';
  const known = formatModelUsageCny(summary.known_priced_cost_cny);
  return summary.pricing_complete ? known : `已记录 ${known}，另有未定价用量`;
}
```

- [ ] Add central capability/meter/error/status labels and onsite degradation copy.

```typescript
export const MODEL_USAGE_ERROR_OPTIONS: Record<ModelUsageErrorCode, { title: string; message: string }> = {
  model_usage_budget_exceeded: { title: '本月模型额度已用完', message: '本次没有向模型服务商发起请求。' },
  model_usage_capability_limit_exceeded: { title: '这项模型能力已达上限', message: '本次已使用可用的基础方式处理。' },
  model_usage_price_unavailable: { title: '暂时无法确认模型费用', message: '为避免超出预算，本次没有发起模型调用。' },
  model_usage_ledger_unavailable: { title: '暂时无法确认模型额度', message: '请稍后重试；当前没有发起新的模型调用。' },
  model_usage_reservation_conflict: { title: '这次调用状态有冲突', message: '请刷新后重新操作。' },
  model_usage_attempt_conflict: { title: '这次调用无法安全重放', message: '请新建一次操作后重试。' },
  model_usage_attempt_already_accounted: { title: '这次调用已经记录', message: '请刷新当前操作结果；系统不会再次发起模型调用。' },
  model_usage_dispatch_recovery_required: { title: '模型调用状态正在核对', message: '系统不会重复发起调用，请稍后查看结果。' },
  model_usage_fail_open_proof_expired: { title: '本次调用未发起', message: '计量故障放行已过期，请重新操作。' },
  model_usage_settlement_pending: { title: '模型用量正在核对', message: '结果可继续使用，费用状态稍后更新。' },
  model_usage_policy_conflict: { title: '预算设置已更新', message: '请查看最新设置后再应用当前修改。' },
  model_usage_adjustment_window_closed: { title: '这个账期已归档', message: '历史统计不能再按单次调用修正。' },
};
```

- [ ] Add query-hook tests for Owner family/my scope, ordinary member personal-only, current/history, stale refresh failure, offline cache, family switch cancellation, and no previous-family flash.

```typescript
it('cancels and isolates the previous family before rendering the next family', async () => {
  const view = renderModelUsageHook({ familyId: 'family-a' });
  await view.switchFamily('family-b');
  expect(view.queryClient.getQueryState(queryKeys.modelUsageOverview('family-a', 'family', '2026-07'))?.fetchStatus)
    .not.toBe('fetching');
  expect(view.result.current.data?.family_id).not.toBe('family-a');
});
```

- [ ] Implement `useModelUsageQueries` with `placeholderData` only within the same family/scope/period identity and window-focus behavior inherited from React Query.

```typescript
const overviewQuery = useQuery({
  queryKey: queryKeys.modelUsageOverview(familyId, scope, period),
  queryFn: () => scope === 'family'
    ? api.getFamilyModelUsageOverview(period)
    : api.getMyModelUsageOverview(period),
  enabled: Boolean(familyId),
});
```

- [ ] Add policy-hook tests for draft preservation, busy duplicate-submit prevention, 409 current-policy recovery, and exact Decimal string payload.

```typescript
expect(result.current.draft.monthly_budget_cny).toBe('80.005000000000');
await act(() => result.current.save());
expect(result.current.conflict?.current_version_number).toBe(4);
expect(result.current.draft.monthly_budget_cny).toBe('80.005000000000');
```

- [ ] Implement mutation/invalidation while retaining draft on any failure.

```typescript
const mutation = useMutation({
  mutationFn: api.updateFamilyModelUsagePolicy,
  onSuccess: async () => {
    await invalidateAfterModelUsagePolicyChanged(queryClient, familyId);
    setConflict(null);
  },
  onError: (error) => setConflict(policyConflictFromApiError(error)),
});
```

- [ ] Run frontend contract/model/hook tests and typecheck.

```bash
npm --prefix frontend run test -- --run src/api/modelUsageApi.test.ts src/features/model-usage/modelUsageModel.test.ts src/features/model-usage/useModelUsageQueries.test.tsx src/features/model-usage/useModelUsagePolicy.test.tsx
npm --prefix frontend run typecheck
git diff --check
```

Expected: tests/typecheck pass; keys isolate family/scope/period/groupBy; no member type includes owner-only fields.

- [ ] Commit Task 18.

```bash
git add frontend/src/api frontend/src/features/model-usage
git commit -m "feat(model-usage): add frontend contracts and view models"
```

---

## Task 19: Family-workspace navigation and separate desktop/mobile model-usage views

**Files**

- Create: `frontend/src/features/model-usage/ModelUsageWorkspace.tsx`
- Create: `frontend/src/features/model-usage/ModelUsageDesktopView.tsx`
- Create: `frontend/src/features/model-usage/ModelUsageMobileView.tsx`
- Create: `frontend/src/features/model-usage/ModelUsageTrend.tsx`
- Create: `frontend/src/features/model-usage/ModelUsageHealth.tsx`
- Create: `frontend/src/features/model-usage/ModelUsageWorkspace.test.tsx`
- Create: `frontend/src/features/model-usage/ModelUsageTrend.test.tsx`
- Modify: `frontend/src/app/appNavigationModel.ts`
- Modify: `frontend/src/app/appNavigationModel.test.ts`
- Modify: `frontend/src/app/useAppNavigationState.ts`
- Modify: `frontend/src/app/useAppNavigationState.test.tsx`
- Modify: `frontend/src/features/family/FamilySettings.tsx`
- Modify: `frontend/src/features/family/FamilyMobileView.tsx`
- Modify: `frontend/src/App.tsx`
- Create: `frontend/src/styles/14-model-usage.css`
- Modify: `frontend/src/styles.css`

**Interfaces**

- Family primary tab remains unchanged. Add `family.view: 'profile' | 'modelUsage'` and navigation target `{ workspace: 'family', view, period? }`.
- Persist only family subview; alert-supplied period is ephemeral and defaults to current Beijing month after ordinary navigation.
- Owner workspace accepts `scope='family'|'me'`; ordinary member is forced to `scope='me'`.
- Desktop and mobile are distinct render components sharing only view model and small semantic primitives.

- [ ] Add failing navigation tests for family profile/usage, persisted subview, alert deep-link period, task cleanup, and family query scope.

```typescript
it('opens model usage inside the family workspace with an optional alert period', () => {
  const next = reduceNavigation(initialNavigationState, {
    type: 'navigate',
    target: { workspace: 'family', view: 'modelUsage', period: '2026-06' },
  });
  expect(next).toMatchObject({
    primaryTab: 'family',
    family: { view: 'modelUsage', period: '2026-06' },
    eat: { task: null },
  });
});
```

- [ ] Extend navigation state/reducer/parser/persistence and query scope without adding a sixth primary navigation item.

```typescript
export type FamilyView = 'profile' | 'modelUsage';

export type AppNavigationState = {
  primaryTab: PrimaryTabKey;
  eat: { baseView: EatBaseView; task: EatTask | null; discoverSection: 'all' | 'selfMade' };
  family: { view: FamilyView; period: string | null };
};
```

- [ ] Add a “模型用量” entry card/button to desktop FamilySettings and mobile FamilyMobileView that calls the structured navigation target.

```tsx
<button
  className="family-model-usage-entry"
  type="button"
  onClick={() => props.onNavigate({ workspace: 'family', view: 'modelUsage' })}
>
  <DashboardIcon name="chart" />
  <span><strong>模型用量</strong><small>查看个人使用和家庭额度</small></span>
</button>
```

- [ ] Add failing workspace tests for Owner family/my toggle, member personal-only, month selector, partial-month notice, empty/loading/error, stale refresh, offline, and family switch.

```tsx
it('ordinary members never render the family scope toggle or amount', () => {
  renderWorkspace({ role: 'Member', personalOverview: personalFixture() });
  expect(screen.queryByRole('button', { name: '家庭' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '我的模型用量' })).toBeInTheDocument();
  expect(screen.queryByText('家庭月预算')).not.toBeInTheDocument();
});
```

- [ ] Implement the workspace controller that derives query state and chooses desktop/mobile by the existing `isPhoneViewport` value from `App.tsx`.

```tsx
export function ModelUsageWorkspace(props: ModelUsageWorkspaceProps) {
  const model = useModelUsageQueries({
    familyId: props.familyId,
    role: props.role,
    initialPeriod: props.initialPeriod,
  });
  const View = props.isPhoneViewport ? ModelUsageMobileView : ModelUsageDesktopView;
  return <View model={model.viewModel} actions={model.actions} />;
}
```

- [ ] Implement desktop information order: budget summary → attention → seven capabilities → trend/breakdowns → measurement health.

```tsx
<main className="model-usage-workspace model-usage-desktop">
  <ModelUsageHeader model={model.header} actions={actions} />
  <ModelUsageBudgetSummary summary={model.budget} />
  <ModelUsageAttention attention={model.attention} />
  <ModelUsageCapabilityGrid items={model.capabilities} />
  <ModelUsageTrend points={model.dailyTrend} summary={model.dailyTrendSummary} />
  <ModelUsageBreakdownTabs groups={model.breakdowns} />
  <ModelUsageHealth health={model.health} />
</main>
```

- [ ] Implement mobile-specific order and list presentation with no compressed desktop table or horizontal scroll.

```tsx
<main className="model-usage-workspace model-usage-mobile">
  <ModelUsageMobileHeader model={model.header} actions={actions} />
  <ModelUsageAttention attention={model.attention} />
  <ModelUsageMobileCostCard summary={model.budget} />
  <ModelUsageMobileCapabilityList items={model.capabilities} />
  <ModelUsageMobileBreakdownList groups={model.breakdowns} />
  <ModelUsageHealth health={model.health} compact />
</main>
```

- [ ] Add trend accessibility tests requiring a text summary, labeled chart, keyboard-safe controls, and reduced-motion behavior.

```tsx
expect(screen.getByRole('img', { name: '本月每日模型费用趋势' })).toHaveAccessibleDescription();
expect(screen.getByText('本月最高用量出现在 7 月 18 日')).toBeVisible();
```

- [ ] Implement a small SVG trend with `<title>/<desc>` and an adjacent summary/list; use no enterprise dashboard library.

```tsx
<svg role="img" aria-labelledby={`${id}-title ${id}-desc`} viewBox="0 0 640 180">
  <title id={`${id}-title`}>本月每日模型费用趋势</title>
  <desc id={`${id}-desc`}>{summary}</desc>
  {points.map((point) => <path key={point.date} d={barPath(point)} />)}
</svg>
```

- [ ] Implement health copy that separately renders uncertain, conservative unknown execution, known unmeasured count, and unknown measurement gap intervals.

```tsx
{health.knownUnmeasuredAttemptCount > 0 && (
  <StatusRow label="可定位但尚未恢复" value={`${health.knownUnmeasuredAttemptCount} 次`} />
)}
{health.measurementGap && (
  <StatusRow label="计量可能不完整" value={formatGapIntervals(health.gapIntervals)} />
)}
```

- [ ] Lazy-load `ModelUsageWorkspace` in `App.tsx`; render FamilySettings only for profile subview and reset page scroll on family view change.

```tsx
{navigation.state.primaryTab === 'family' && navigation.state.family.view === 'modelUsage' ? (
  <Suspense fallback={<WorkspaceLoadingFallback />}>
    <ModelUsageWorkspace
      familyId={family?.id ?? ''}
      role={membership?.role ?? 'Member'}
      initialPeriod={navigation.state.family.period}
      isPhoneViewport={isPhoneViewport}
      onBack={() => navigation.navigate({ workspace: 'family', view: 'profile' })}
    />
  </Suspense>
) : (
  <FamilySettings />
)}
```

- [ ] Add feature CSS using only canonical tokens; include stable numeric typography, long-model wrapping, safe-area padding, 200% zoom, and reduced motion.

```css
.model-usage-number {
  font-variant-numeric: tabular-nums;
}

.model-usage-provider-name {
  min-width: 0;
  overflow-wrap: anywhere;
}

@media (prefers-reduced-motion: reduce) {
  .model-usage-workspace * {
    scroll-behavior: auto;
    transition-duration: 0.01ms;
  }
}
```

- [ ] Run navigation/workspace/style token tests and frontend build.

```bash
npm --prefix frontend run test -- --run src/app/appNavigationModel.test.ts src/app/useAppNavigationState.test.tsx src/features/model-usage/ModelUsageWorkspace.test.tsx src/features/model-usage/ModelUsageTrend.test.tsx
npm --prefix frontend run check:style-tokens
npm run frontend:build
git diff --check
```

Expected: tests/build pass; style-token report has no new hard-coded color/spacing/shadow drift; mobile components do not render desktop tables.

- [ ] Commit Task 19.

```bash
git add frontend/src/features/model-usage frontend/src/app/appNavigationModel.ts frontend/src/app/appNavigationModel.test.ts frontend/src/app/useAppNavigationState.ts frontend/src/app/useAppNavigationState.test.tsx frontend/src/features/family/FamilySettings.tsx frontend/src/features/family/FamilyMobileView.tsx frontend/src/App.tsx frontend/src/styles/14-model-usage.css frontend/src/styles.css
git commit -m "feat(model-usage): add responsive usage workspace"
```

---
## Task 20: Desktop budget drawer, mobile full-screen settings, validation, and OCC recovery

**Files**

- Create: `frontend/src/features/model-usage/ModelUsagePolicySettings.tsx`
- Create: `frontend/src/features/model-usage/ModelUsagePolicyDesktopDrawer.tsx`
- Create: `frontend/src/features/model-usage/ModelUsagePolicyMobilePage.tsx`
- Create: `frontend/src/features/model-usage/ModelUsagePolicySettings.test.tsx`
- Modify: `frontend/src/features/model-usage/ModelUsageWorkspace.tsx`
- Modify: `frontend/src/features/model-usage/modelUsageModel.ts`
- Modify: `frontend/src/styles/14-model-usage.css`
- Test: `frontend/src/components/ui-kit.test.tsx`

**Interfaces**

- Owner-only fields: monthly budget, alerts enabled, hard limit, zero-or-one guardrail per capability.
- Desktop opens a right `WorkspaceDrawer`; phone replaces usage content with a full-screen settings page and explicit back action.
- Save uses `base_version_number`; `busy` blocks close/duplicate submit. Failure/409 keeps the draft.
- If active configured variants have missing price coverage, enabling hard limit requires one explicit checkbox/confirmation and sends `confirm_missing_price_impact=true`.
- Hard-limit help text states the actual linearization boundary: after save, ordinary reservations that have not obtained first durable dispatch authorization are revalidated; already-dispatching calls and short-lived fail-open proofs issued before save may still finish.

- [ ] Add failing UI tests for Owner-only access, desktop drawer, mobile full-screen page, default form, hard-limit prerequisites, in-flight boundary disclosure, one guardrail/capability, busy, error retention, and 409 recovery.

```tsx
it('uses a drawer on desktop and a full page on phone', async () => {
  const desktop = renderPolicySettings({ isPhoneViewport: false });
  await desktop.user.click(screen.getByRole('button', { name: '预算设置' }));
  expect(screen.getByRole('dialog', { name: '模型预算设置' })).toHaveClass('workspace-drawer');

  desktop.unmount();
  const phone = renderPolicySettings({ isPhoneViewport: true });
  await phone.user.click(screen.getByRole('button', { name: '预算设置' }));
  expect(screen.getByRole('main', { name: '模型预算设置' })).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
```

- [ ] Implement shared controlled fields with string Decimal values; empty budget serializes `null`, not zero.

```tsx
<input
  inputMode="decimal"
  value={draft.monthly_budget_cny ?? ''}
  onChange={(event) => actions.patch({ monthly_budget_cny: normalizeDecimalDraft(event.target.value) })}
  aria-describedby="model-usage-budget-help"
/>
```

- [ ] Add pure validation for positive budget requirement, hard limit/guardrail dependency, valid capability meter, and duplicate guardrail.

```typescript
export function validatePolicyDraft(draft: ModelUsagePolicyDraft): ModelUsagePolicyValidation {
  if ((draft.hard_limit_enabled || draft.capability_limits.length > 0) && !isPositiveDecimal(draft.monthly_budget_cny)) {
    return { valid: false, field: 'monthly_budget_cny', message: '开启限制前，请先填写大于 0 的家庭月预算。' };
  }
  if (new Set(draft.capability_limits.map((item) => item.capability)).size !== draft.capability_limits.length) {
    return { valid: false, field: 'capability_limits', message: '每项模型能力只能设置一个护栏。' };
  }
  return { valid: true };
}
```

- [ ] Implement desktop drawer with `WorkspaceOverlayFrame` + `WorkspaceDrawer`, canonical footer actions, focus label, and busy lock.

```tsx
<WorkspaceOverlayFrame onClose={actions.close} busy={model.isSaving}>
  <WorkspaceDrawer
    title="模型预算设置"
    description="提醒和限制只作用于当前家庭。"
    onClose={actions.close}
    busy={model.isSaving}
    footerActions={<PolicyFooter model={model} actions={actions} />}
  >
    <ModelUsagePolicySettings model={model} actions={actions} />
  </WorkspaceDrawer>
</WorkspaceOverlayFrame>
```

- [ ] Implement mobile full-screen page with safe-area header/back, scrollable form, and non-floating bottom save region.

```tsx
<main className="model-usage-policy-mobile" aria-label="模型预算设置">
  <header className="model-usage-policy-mobile-header">
    <button type="button" onClick={actions.close} disabled={model.isSaving}>返回模型用量</button>
    <h1>模型预算设置</h1>
  </header>
  <ModelUsagePolicySettings model={model} actions={actions} />
  <PolicyFooter model={model} actions={actions} />
</main>
```

- [ ] Add missing-price impact confirmation plus persistent in-flight boundary help, and do not allow hard-limit save until the required confirmation is checked.

```tsx
{model.requiresMissingPriceConfirmation && (
  <label className="model-usage-price-confirmation">
    <input
      type="checkbox"
      checked={model.draft.confirm_missing_price_impact}
      onChange={(event) => actions.patch({ confirm_missing_price_impact: event.target.checked })}
    />
    <span>我知道保存后，尚未取得发送授权的缺价调用会被阻止。</span>
  </label>
)}
<p id="model-usage-hard-limit-inflight-help">
  已经开始发送的调用可能继续完成；保存前已签发的短时计量故障放行也可能完成。
</p>
```

- [ ] Render OCC conflict with current-policy summary and two explicit actions: review current, then reapply retained draft with the new base version.

```tsx
{model.conflict && (
  <StateBlock
    status="warning"
    title="预算设置已被更新"
    description="你的修改仍然保留。先查看最新设置，再决定是否重新应用。"
    actionLabel="查看最新设置"
    onAction={actions.reviewConflict}
  />
)}
```

- [ ] Ensure save busy state disables form mutation, close/drag-dismiss, and duplicate submission; success closes and refreshes policy/overview/alerts.

```typescript
if (mutation.isPending || !validation.valid) return;
await mutation.mutateAsync(policyPayloadFromDraft(draft, policy.version_number));
```

- [ ] Add responsive CSS using canonical tokens and verify 200% zoom/no horizontal overflow.

```css
.model-usage-policy-mobile {
  min-width: 0;
  min-height: var(--app-visual-viewport-layout-height, 100dvh);
  padding: env(safe-area-inset-top, 0) var(--space-4) calc(var(--space-6) + env(safe-area-inset-bottom, 0));
  background: var(--bg);
}
```

- [ ] Run policy UI, shared overlay, token, and build checks.

```bash
npm --prefix frontend run test -- --run src/features/model-usage/ModelUsagePolicySettings.test.tsx src/components/ui-kit.test.tsx
npm --prefix frontend run check:style-tokens
npm run frontend:build
git diff --check
```

Expected: Owner-only settings pass; member cannot render/open them; drawer/mobile behavior and OCC draft retention are verified.

- [ ] Commit Task 20.

```bash
git add frontend/src/features/model-usage frontend/src/styles/14-model-usage.css
git commit -m "feat(model-usage): add responsive budget settings"
```

---

## Task 21: Unified notification union and capability-specific onsite degradation notices

**Files**

- Create: `frontend/src/hooks/useAppNotifications.ts`
- Create: `frontend/src/hooks/useAppNotifications.test.tsx`
- Create: `frontend/src/features/model-usage/ModelUsageDegradationNotice.tsx`
- Modify: `frontend/src/app/AppShell.tsx`
- Modify: `frontend/src/app/AppShell.test.tsx`
- Modify: `frontend/src/hooks/useAiImageJobMonitor.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/features/search/GlobalSearchOverlay.tsx`
- Modify: `frontend/src/features/search/GlobalSearchOverlay.test.tsx`
- Modify: `frontend/src/components/ai/AiVoiceInputButton.tsx`
- Modify: `frontend/src/components/ai/AiVoiceInputButton.test.tsx`
- Modify: `frontend/src/components/ai/AiWorkspace.tsx`
- Modify: `frontend/src/components/recipes/CookingAssistantPanel.tsx`
- Modify: `frontend/src/components/recipes/useCookingRealtimeVoiceSession.ts`
- Modify: `frontend/src/components/recipes/useCookingRealtimeVoiceSession.test.tsx`
- Modify: `frontend/src/styles/00-foundation.css`
- Modify: `frontend/src/styles/07-mobile.css`

**Interfaces**

- Replace `AppNotificationJob` with a discriminated `AppNotificationItem = BackgroundTaskNotification | ModelUsageAlertNotification`.
- Groups are fixed: `needs_attention`, `in_progress`, `recently_completed`.
- Alerts poll every 60 seconds, refetch on window focus, mark seen/dismiss through Owner receipt APIs, and navigate to `{ workspace:'family', view:'modelUsage', period }`.
- Background image/search polling remains 3 seconds and keeps retry behavior; model alerts have no retry.
- Search `budget_blocked` is normalized to background notification `status='failed'`, `can_retry=false`, and its stable error code; a later period/policy change is requeued only by the backend worker. Image budget blocks already arrive from Task 16 as `failed` with `can_retry=false`.
- Capability onsite notices use stable backend codes and never show family amount to ordinary members.

- [ ] Add failing union/order tests for alert severity, failed task, active task, completed history limit, dismissed alert, and deterministic recency.

```typescript
it('orders attention before progress and completion while keeping kind-specific actions', () => {
  const grouped = groupAppNotifications([
    modelUsageAlert({ severity: 'critical' }),
    backgroundTask({ status: 'running' }),
    backgroundTask({ status: 'succeeded' }),
  ]);
  expect(grouped.map((group) => group.key)).toEqual(['needs_attention', 'in_progress', 'recently_completed']);
  expect(grouped[0].items[0].kind).toBe('model_usage_alert');
});

it('maps a budget-blocked search job to non-retryable attention', () => {
  const item = searchJobNotification(searchJob({
    status: 'budget_blocked',
    error_code: 'model_usage_capability_limit_exceeded',
  }));
  expect(item.status).toBe('failed');
  expect(item.can_retry).toBe(false);
  expect(item.error_code).toBe('model_usage_capability_limit_exceeded');
});
```

- [ ] Define the discriminated types and pure grouping functions in `AppShell.tsx` or a colocated exported model section.

```typescript
export type BackgroundTaskNotification = {
  kind: 'background_task';
  notification_id: string;
  task_kind: 'image' | 'search_index';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  can_retry: boolean;
  can_dismiss: boolean;
  error_code: ModelUsageErrorCode | null;
  title: string;
  description: string;
  occurred_at: string | null;
};

export type ModelUsageAlertNotification = {
  kind: 'model_usage_alert';
  notification_id: string;
  alert_id: string;
  severity: 'warning' | 'critical';
  period: string;
  seen: boolean;
  title: string;
  description: string;
  occurred_at: string;
};

export type AppNotificationItem = BackgroundTaskNotification | ModelUsageAlertNotification;
```

- [ ] Refactor `useAiImageJobMonitor` to emit only `BackgroundTaskNotification`, preserving local terminal-task dismissal and retry.

```typescript
return {
  kind: 'background_task',
  notification_id: imageNotificationId(job.job_id),
  task_kind: 'image',
  status: job.status,
  can_retry: job.can_retry ?? job.status === 'failed',
  can_dismiss: isTerminalImageJob(job),
  error_code: job.error_code ?? null,
  title,
  description,
  occurred_at: job.completed_at ?? job.created_at ?? null,
};

export function searchJobNotification(job: SearchIndexJobResponse): BackgroundTaskNotification {
  const budgetBlocked = job.status === 'budget_blocked';
  const normalizedStatus: BackgroundTaskNotification['status'] =
    job.status === 'budget_blocked' ? 'failed' : job.status;
  return {
    kind: 'background_task',
    notification_id: searchNotificationId(job.job_id),
    task_kind: 'search_index',
    status: normalizedStatus,
    can_retry: !budgetBlocked && normalizedStatus === 'failed',
    can_dismiss: budgetBlocked || job.status === 'succeeded' || job.status === 'failed',
    error_code: job.error_code ?? null,
    title: budgetBlocked ? '搜索索引等待模型额度恢复' : searchJobTitle(job),
    description: budgetBlocked ? '额度或策略变化后，系统会自动继续处理。' : searchJobDescription(job),
    occurred_at: job.completed_at ?? job.created_at ?? null,
  };
}
```

- [ ] Add hook tests for 60-second alert polling, focus refetch, Owner-only enablement, seen, dismiss, family switch, and alert click navigation.

```typescript
it('polls owner alerts every 60 seconds and refetches on focus', async () => {
  vi.useFakeTimers();
  const hook = renderAppNotifications({ role: 'Owner', familyId: 'family-a' });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(hook.api.getModelUsageAlerts).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event('focus'));
  await waitFor(() => expect(hook.api.getModelUsageAlerts).toHaveBeenCalledTimes(3));
});
```

- [ ] Implement `useAppNotifications` to combine background items and alert query; member alert query remains disabled.

```typescript
const alertsQuery = useQuery({
  queryKey: queryKeys.modelUsageAlerts(familyId),
  queryFn: api.getModelUsageAlerts,
  enabled: enabled && role === 'Owner',
  refetchInterval: enabled && role === 'Owner' ? 60_000 : false,
  refetchOnWindowFocus: true,
});
```

- [ ] Rebuild `AppNotificationCenter`: title “通知”, fixed group headings, alert click/seen/dismiss, task retry, accessible count summary, Escape/outside click.

```tsx
{groups.map((group) => (
  <section key={group.key} aria-labelledby={`notification-${group.key}`}>
    <h3 id={`notification-${group.key}`}>{group.label}</h3>
    {group.items.map((item) => <AppNotificationRow key={item.notification_id} item={item} actions={props.actions} />)}
  </section>
))}
```

- [ ] Wire alert navigation and union props once in `App.tsx`; use the same center instance model for sidebar and mobile.

```typescript
const notifications = useAppNotifications({
  enabled: isAuthenticated,
  familyId: family?.id ?? '',
  role: membership?.role ?? 'Member',
  background: aiImageJobMonitor,
  onOpenModelUsageAlert: (alert) =>
    navigation.navigate({ workspace: 'family', view: 'modelUsage', period: alert.period }),
});
```

- [ ] Add onsite degradation tests and use central code mapping for Rerank, STT, TTS, image, LLM fallback, hard-limit ledger error, and realtime end.

```tsx
it('shows rerank fallback without exposing family budget', () => {
  renderSearch({ degraded: true, degradation_code: 'model_usage_capability_limit_exceeded' });
  expect(screen.getByText('模型排序额度达到限制，本次已改用基础排序。')).toBeVisible();
  expect(screen.queryByText(/¥|预算比例|家庭已用/)).not.toBeInTheDocument();
});
```

- [ ] Implement a reusable semantic notice and integrate stable-code branches at each listed capability surface.

```tsx
export function ModelUsageDegradationNotice({ code, capability }: Props) {
  const option = onsiteModelUsageOption(code, capability);
  return (
    <div className={`model-usage-degradation tone-${option.tone}`} role="status">
      <DashboardIcon name={option.icon} />
      <span>{option.message}</span>
    </div>
  );
}
```

- [ ] Preserve capability outcomes: search local results, STT text-entry alternative, TTS/voice textual answer, image “provider not called”, LLM fallback label, realtime graceful end.

```typescript
if (event.type === 'usage_limit') {
  setSessionStatus('ended');
  setNotice({
    code: event.code,
    message: '语音额度已达到限制，本次会话已结束；可以继续使用文字。',
  });
  socket.close(1000, 'usage lease not renewed');
}
```

- [ ] Update notification/mobile CSS with canonical tokens, long text wrapping, focus states, and no color-only status.

```css
.app-notification-row-copy,
.model-usage-degradation span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.app-notification-group-title {
  color: var(--text-soft);
  font-size: var(--text-sm);
}
```

- [ ] Run notification and affected surface tests, style tokens, and build.

```bash
npm --prefix frontend run test -- --run src/hooks/useAppNotifications.test.tsx src/app/AppShell.test.tsx src/features/search/GlobalSearchOverlay.test.tsx src/components/ai/AiVoiceInputButton.test.tsx src/components/recipes/useCookingRealtimeVoiceSession.test.tsx
npm --prefix frontend run check:style-tokens
npm run frontend:build
git diff --check
```

Expected: Owner alerts and background tasks share one accessible notification center; ordinary members never fetch/show amount alerts; capability fallbacks remain usable.

- [ ] Commit Task 21.

```bash
git add frontend/src/hooks/useAppNotifications.ts frontend/src/hooks/useAppNotifications.test.tsx frontend/src/features/model-usage frontend/src/app/AppShell.tsx frontend/src/app/AppShell.test.tsx frontend/src/hooks/useAiImageJobMonitor.ts frontend/src/App.tsx frontend/src/features/search frontend/src/components/ai frontend/src/components/recipes frontend/src/styles/00-foundation.css frontend/src/styles/07-mobile.css
git commit -m "feat(model-usage): unify usage alerts and degradation notices"
```

---

## Task 22: Provider-send inventory, privacy/performance gates, E2E, real smoke, and first-launch report

**Files**

- Create: `backend/app/services/model_usage/provider_registry.py`
- Create: `backend/scripts/check_model_usage_adapter_coverage.py`
- Create: `backend/scripts/smoke_model_usage_providers.py`
- Create: `backend/scripts/generate_model_usage_launch_report.py`
- Create: `backend/tests/model_usage/test_provider_send_inventory.py`
- Create: `backend/tests/model_usage/test_privacy_boundaries.py`
- Create: `backend/tests/model_usage/test_performance_reference.py`
- Create: `backend/tests/model_usage/test_first_launch_preflight.py`
- Modify: `backend/tests/conftest.py`
- Modify: `frontend/e2e/fixtures/apiMocks.mjs`
- Create: `frontend/e2e/model-usage-governance.spec.mjs`
- Modify: `frontend/playwright.config.mjs`
- Modify: `frontend/package.json`
- Modify: `package.json`
- Create: `docs/plans/model-usage-first-launch-report.md`
- Test: all files changed in Tasks 1–21.

**Interfaces**

- Registry maps each enabled provider/billing model/capability/variant to adapter class, billable meter set, produced guardrail-eligible meter set, realtime lease-boundary cumulative meter set, recovery policy, and owned source send points.
- Static send inventory covers OpenAI Chat/Responses, image HTTP, embedding HTTP, rerank HTTP, OpenAI/DashScope STT/TTS, and three DashScope realtime WebSocket helpers.
- Smoke script sends the smallest valid request for all seven capabilities in one designated test family, reports attempt/event/meter IDs and status only, and never prints content or secrets.
- Report generator consumes machine-readable test/coverage/health/smoke artifacts and refuses to emit a “pass” report if any required gate is missing.

- [ ] Add a failing exact provider-send manifest test based on AST call signatures and current source paths.

```python
EXPECTED_MODEL_PROVIDER_SEND_POINTS = {
    "app/ai/runtime/openai_chat.py:_create_chat_completion_stream:openai_client.chat.completions.create",
    "app/ai/runtime/openai_chat.py:_create_chat_completion:openai_client.chat.completions.create",
    "app/ai/runtime/openai_responses.py:_create_responses_stream:client.responses.create",
    "app/ai/images/generation.py:_generate:client.post",
    "app/ai/images/generation.py:_generate:client.get",
    "app/ai/images/generation.py:_post_json_image:client.post",
    "app/ai/images/generation.py:_post_multipart_image:client.post",
    "app/ai/images/generation.py:_result_from_payload:client.get",
    "app/services/search/embeddings.py:embed_batch:client.post",
    "app/services/search/rerank.py:rerank:client.post",
    "app/services/ai_audio/openai_audio.py:transcribe:client.post",
    "app/services/ai_audio/openai_audio.py:synthesize:client.post",
    "app/services/ai_audio/dashscope_audio.py:transcribe:client.post",
    "app/services/ai_audio/dashscope_audio.py:synthesize:client.post",
    "app/services/ai_audio/dashscope_audio.py:_download_provider_audio:client.get",
    "app/services/ai_audio/dashscope_audio.py:_qwen_asr_realtime_transcribe:websockets.connect",
    "app/services/ai_audio/dashscope_audio.py:_qwen_tts_realtime_synthesize:websockets.connect",
    "app/services/ai_audio/dashscope_audio.py:_qwen_tts_realtime_stream:websockets.connect",
}

EXPECTED_NON_MODEL_REMOTE_SEND_POINTS = {
    "app/services/search/vector_store.py:ensure_collection:client.get": "Qdrant infrastructure",
    "app/services/search/vector_store.py:ensure_collection:client.put": "Qdrant infrastructure",
    "app/services/search/vector_store.py:upsert_point:client.put": "Qdrant infrastructure",
    "app/services/search/vector_store.py:delete_point:client.post": "Qdrant infrastructure",
    "app/services/search/vector_store.py:scroll_points:client.post": "Qdrant infrastructure",
    "app/services/search/vector_store.py:search:client.post": "Qdrant infrastructure",
    "app/services/search/vector_store.py:_ensure_payload_indexes:client.put": "Qdrant infrastructure",
}

def test_every_remote_send_point_has_registered_adapter() -> None:
    discovered = discover_remote_send_points(Path("app"))
    assert discovered.model_provider == EXPECTED_MODEL_PROVIDER_SEND_POINTS
    assert discovered.non_model == set(EXPECTED_NON_MODEL_REMOTE_SEND_POINTS)
    assert registry_send_points() == EXPECTED_MODEL_PROVIDER_SEND_POINTS
```

The scanner recognizes OpenAI SDK creates, `httpx` provider calls, and WebSocket connects. A newly discovered network send must be classified in code review: model-provider sends require an adapter registration; non-model exemptions require a fixed source point and reason and cannot be added through runtime configuration. Provider artifact downloads remain attached to the originating attempt and therefore stay in the model-provider inventory even when they add no meter.

- [ ] Implement the provider registry and AST checker; an added/unregistered send point exits non-zero.

```python
@dataclass(frozen=True, slots=True)
class ProviderUsageRegistration:
    capability: ModelUsageCapability
    provider: str
    billing_model: str
    variant_key: str
    adapter_path: str
    billable_meters: frozenset[ModelUsageMeter]
    produced_guardrail_meters: frozenset[ModelUsageMeter]
    lease_boundary_cumulative_meters: frozenset[ModelUsageMeter]
    reservation_parameters: Mapping[str, Decimal]
    recovery_policy: ProviderRecoveryPolicy
    source_send_points: frozenset[str]
```

- [ ] Add privacy tests that seed a unique secret marker into prompt/query/document/transcript/TTS/image fields, run all fake adapters, then scan usage tables, receipt logs, CLI JSON, and API JSON.

```python
def test_secret_marker_never_crosses_usage_boundaries(full_usage_harness, caplog) -> None:
    marker = "CULINA_USAGE_SECRET_7f3a9d"
    full_usage_harness.run_all_capabilities(content_marker=marker)
    assert marker not in full_usage_harness.dump_usage_tables()
    assert marker not in caplog.text
    assert marker not in full_usage_harness.health_cli_json()
    assert marker not in full_usage_harness.owner_api_json()
```

- [ ] Implement allowlist serialization checks and high-cardinality log-label checks.

```python
FORBIDDEN_LOG_KEYS = {"user_id", "prompt", "response", "query", "media_url", "authorization", "api_key"}
assert FORBIDDEN_LOG_KEYS.isdisjoint(all_model_usage_log_keys())
assert {"family_id", "event_id", "attempt_key"}.isdisjoint(model_usage_metric_label_keys())
```

- [ ] Add a reference performance test that seeds 100,000 events/current month, 13 rollup months, and verifies query counts/plans plus configured p95 targets.

```python
@pytest.mark.model_usage_reference
def test_reference_profile_latency(reference_dataset, reference_host_profile) -> None:
    reference_host_profile.require_enabled()
    result = benchmark_usage_queries(reference_dataset)
    assert result.reserve_p95_ms <= 150
    assert result.settle_p95_ms <= 150
    assert result.current_overview_p95_ms <= 300
    assert result.current_breakdown_p95_ms <= 1000
    assert result.historical_rollup_p95_ms <= 500

def test_usage_query_plans_and_counts(reference_dataset) -> None:
    result = inspect_usage_query_plans(reference_dataset)
    assert result.has_full_table_scan is False
    assert result.current_overview_query_count <= 5
    assert result.current_breakdown_query_count <= 6
    assert result.historical_rollup_query_count <= 3
```

Absolute timing runs only when `MODEL_USAGE_REFERENCE_PROFILE` names the documented reference host; otherwise the marked test skips. Ordinary CI always gates query plans, query counts, correctness, and absence of N+1.

- [ ] Register the reference marker and require the fixed first-launch profile name for absolute timing.

```python
import pytest

def pytest_configure(config: pytest.Config) -> None:
    os.environ.setdefault("SEARCH_EMBEDDING_PROVIDER", "disabled")
    os.environ.setdefault("SEARCH_VECTOR_BACKEND", "disabled")
    os.environ.setdefault("SEARCH_RERANK_PROVIDER", "disabled")
    os.environ.setdefault("SEARCH_EMBEDDING_MODEL", "")
    os.environ.setdefault("SEARCH_EMBEDDING_DIMENSIONS", "0")
    os.environ.setdefault("QDRANT_URL", "")
    os.environ.setdefault("QDRANT_COLLECTION", "")
    config.addinivalue_line(
        "markers",
        "model_usage_reference: absolute model-usage latency gate for the first-launch MySQL 8.4 reference host",
    )
```

In `test_performance_reference.py`, define the gate used by the marked test:

```python
@dataclass(frozen=True, slots=True)
class ReferenceHostProfile:
    actual: str | None
    required: str

    def require_enabled(self) -> None:
        if self.actual is None:
            pytest.skip("absolute latency runs only on the designated first-launch reference host")
        if self.actual != self.required:
            pytest.fail(f"unexpected reference profile: {self.actual}")

@pytest.fixture()
def reference_host_profile() -> ReferenceHostProfile:
    return ReferenceHostProfile(
        actual=os.getenv("MODEL_USAGE_REFERENCE_PROFILE"),
        required="culina-first-launch-mysql84-v1",
    )
```

- [ ] Add first-launch preflight test that requires current head, actual MySQL idempotency unique keys, default policies/subjects, seven configured registry entries, cross-variant guardrail-meter coverage, published price coverage, maintenance enabled, valid fail-open proof TTL, SDK retries disabled, and no active cross-version attempts.

```python
def test_first_launch_preflight_is_all_or_nothing(launch_fixture) -> None:
    report = run_first_launch_preflight(launch_fixture.settings)
    assert report.required_capabilities == set(ModelUsageCapability)
    assert report.missing_capabilities == set()
    assert report.unregistered_send_points == set()
    assert report.missing_idempotency_uniques == set()
    assert report.missing_guardrail_meter_coverage == set()
    assert report.unsupported_lease_boundary_cumulative_meters == set()
    assert report.receipt_integrity_keyring_valid is True
    assert report.active_provider_attempts == 0
    assert report.ready is True
```

- [ ] Implement minimal real-provider smoke commands with explicit `--family-id`, `--user-id`, `--output`, and operator cost acknowledgement.

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/smoke_model_usage_providers.py \
  --family-id family-model-usage-smoke \
  --user-id user-model-usage-smoke \
  --acknowledge-provider-cost \
  --output .artifacts/model-usage-provider-smoke.json
```

The script refuses non-test family IDs unless `MODEL_USAGE_SMOKE_ALLOW_PRODUCTION_FAMILY=true`; output contains no request/response content.

- [ ] Extend E2E API mocks with Owner family/personal overview, breakdowns, policy, alerts, an ordinary-member auth variant, and all health states.

```javascript
const modelUsageFamilyOverview = {
  family_id: family.id,
  scope: 'family',
  period: '2026-07',
  known_priced_cost_cny: '12.345000000000',
  pricing_complete: false,
  unpriced_event_count: 1,
  monthly_budget_cny: '80.000000000000',
  effective_spend_cny: '12.345000000000',
  reserved_cost_cny: '0.500000000000',
  hard_limit_enabled: false,
  measurement_health: modelUsageHealthFixture,
};
```

- [ ] Add Playwright E2E for Owner family/my, month switch, alert deep link/dismiss, policy save/conflict and hard-limit in-flight disclosure, member privacy, offline recovery, and all target viewports.

```javascript
for (const viewport of [
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
]) {
  test(`@p0 model usage is usable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openModelUsage(page);
    await expectNoHorizontalOverflow(page);
  });
}
```

- [ ] Add explicit keyboard, focus, screen reader names, 200% text zoom, reduced motion, and no-horizontal-overflow assertions.

```javascript
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
await expectNoHorizontalOverflow(page);
await page.keyboard.press('Tab');
await expect(page.getByRole('button', { name: '预算设置' })).toBeFocused();
```

- [ ] Add root/frontend smoke scripts.

```json
{
  "frontend:smoke": "npm --prefix frontend run smoke",
  "backend:model-usage:send-coverage": "cd backend && PYTHONPATH=. .venv/bin/python scripts/check_model_usage_adapter_coverage.py"
}
```

```json
{
  "smoke": "playwright test e2e/model-usage-governance.spec.mjs"
}
```

- [ ] Run focused model-usage suites, send coverage, privacy, performance-plan, migration, and CLI health.

```bash
cd backend
.venv/bin/python -m pytest tests/model_usage -q
PYTHONPATH=. .venv/bin/python scripts/check_model_usage_adapter_coverage.py
PYTHONPATH=. .venv/bin/python scripts/manage_model_usage_prices.py coverage --json
PYTHONPATH=. .venv/bin/python scripts/maintain_model_usage.py health --json
.venv/bin/alembic heads
cd ..
```

Expected: all focused tests pass; send coverage has zero gaps; seven capabilities are covered; health is healthy; head is `5f6a7b8c9d0e`.

- [ ] Run repository quality/build/style/smoke/E2E gates.

```bash
npm run backend:quality
npm run frontend:quality
npm run frontend:build
npm --prefix frontend run check:style-tokens
npm run frontend:smoke
npm run frontend:e2e:p0
docker compose -f deploy/docker-compose.yml build backend frontend
```

Expected: every command exits 0; review the style-token report manually even when its exit code is 0; the Python 3.12 backend image installs the pinned PyAV wheel without compiling system FFmpeg libraries.

- [ ] Start disposable infrastructure and validate migration plus MySQL concurrency/retention/reference query plans.

```bash
npm run db:up
npm run backend:migrate
cd backend
CULINA_TEST_MYSQL_URL=mysql+pymysql://culina:culina@127.0.0.1:3306/culina_model_usage_test \
  .venv/bin/python -m pytest \
	  tests/model_usage/test_migration_mysql.py \
	  tests/model_usage/test_reservation_mysql_concurrency.py \
	  tests/model_usage/test_dispatch_policy_mysql_concurrency.py \
	  tests/model_usage/test_adjustment_mysql_concurrency.py \
  tests/model_usage/test_realtime_audio_mysql.py \
  tests/model_usage/test_reporting_queries_mysql.py -q
MODEL_USAGE_REFERENCE_PROFILE=culina-first-launch-mysql84-v1 \
  CULINA_TEST_MYSQL_URL=mysql+pymysql://culina:culina@127.0.0.1:3306/culina_model_usage_test \
  .venv/bin/python -m pytest tests/model_usage/test_performance_reference.py \
  -m model_usage_reference -q
cd ..
```

Expected: upgrade succeeds from current head data; 50-way budget gate is 33/17/¥99; same-attempt reservation/event/fail-open receipt and adjustment-group races each produce one database winner/counter mutation; policy-update/dispatch interleavings match the shared-pointer lock order; cost and meter audit formulas rebuild without drift. Use a disposable `_test` database with credentials provided by the test environment, not committed config.

- [ ] Prepare the real production price manifest from current provider contracts, source references, reviewed FX, configured aliases, exact billing schemes, operator, and change ticket; then validate/diff/publish/coverage.

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/manage_model_usage_prices.py validate --file /secure/culina/model-usage-prices-2026-07.json
PYTHONPATH=. .venv/bin/python scripts/manage_model_usage_prices.py diff --file /secure/culina/model-usage-prices-2026-07.json
PYTHONPATH=. .venv/bin/python scripts/manage_model_usage_prices.py publish \
  --file /secure/culina/model-usage-prices-2026-07.json \
  --operator culina-release-owner \
  --change-ticket CULINA-MODEL-USAGE-2026-07 \
  --confirm-checksum "$(PYTHONPATH=. .venv/bin/python scripts/manage_model_usage_prices.py validate --file /secure/culina/model-usage-prices-2026-07.json --checksum-only)"
PYTHONPATH=. .venv/bin/python scripts/manage_model_usage_prices.py coverage --json
cd ..
```

Expected: publish is atomic and coverage reports `covered` for all enabled variants in all seven capabilities. The secure manifest is not added to Git unless it contains only public non-secret rates and has been explicitly approved for publication.

- [ ] Run seven minimal real-provider smoke calls, then re-run health/counter audit/rollup and inspect personal/family API output.

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/smoke_model_usage_providers.py \
  --family-id family-model-usage-smoke \
  --user-id user-model-usage-smoke \
  --acknowledge-provider-cost \
  --output .artifacts/model-usage-provider-smoke.json
PYTHONPATH=. .venv/bin/python scripts/maintain_model_usage.py audit --verify-only --json > .artifacts/model-usage-audit.json
PYTHONPATH=. .venv/bin/python scripts/maintain_model_usage.py rollup --family family-model-usage-smoke --json > .artifacts/model-usage-rollup.json
PYTHONPATH=. .venv/bin/python scripts/maintain_model_usage.py health --json > .artifacts/model-usage-health.json
cd ..
```

Expected: exactly seven capability smoke groups succeed; no counter drift; rollup checksum is stable; no unpriced/missing coverage unless the tested provider truthfully returned unsupported usage, in which case launch remains blocked until the catalog/adapter is corrected.

- [ ] Perform manual visual/accessibility review at all seven viewports, 200% text zoom, keyboard-only, VoiceOver/screen-reader labels, reduced motion, offline/restore, long model names, and safe areas. Save screenshots/notes under `.artifacts/model-usage-visual-review/`; do not commit generated media unless project policy requires it.

- [ ] Generate a factual launch report from actual artifacts and refuse to hand-edit a failed gate into passing.

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/generate_model_usage_launch_report.py \
  --provider-smoke .artifacts/model-usage-provider-smoke.json \
  --audit .artifacts/model-usage-audit.json \
  --rollup .artifacts/model-usage-rollup.json \
  --health .artifacts/model-usage-health.json \
  --visual-review .artifacts/model-usage-visual-review \
  --verification-evidence .artifacts/model-usage-required-verification.json \
  --output ../docs/plans/model-usage-first-launch-report.md
cd ..
```

`model-usage-required-verification.json` is a content-free release evidence summary with schema version `model_usage_launch_verification.v1`. For every fixed command ID — `focusedModelUsageTests`, `backendQuality`, `frontendQuality`, `frontendBuild`, `frontendStyleTokens`, `frontendSmoke`, `frontendE2EP0`, `dockerBuild`, `mysqlMigrationConcurrency`, and `dispatchPolicyInterleaving` — it records the current git commit, an allowlisted environment summary, integer exit code, and non-empty all-true key assertions. The report normalizes that summary to fixed public categories and rejects unknown keys or unrecognized values. Missing command records, commit mismatches, absent environment, non-zero exits, or false assertions are first-launch blockers. Never copy raw command output, credentials, Provider content, or arbitrary environment variables into this artifact.

The generated report must contain actual timestamps, git commit, Alembic head, verified idempotency unique keys, configured variants/guardrail meter coverage, recovery modes, dispatch-policy interleaving result, counter-kind audit result, command exit codes, viewport evidence, unresolved P0/P1 count, and a machine-derived `ready_for_first_open` decision.

- [ ] Review `git status`, ensure no `.env`, key, secure manifest, provider content, logs, database dump, or `.artifacts` file is staged, then commit only code/tests/report.

```bash
git status --short
git diff --check
git add backend/app/services/model_usage/provider_registry.py backend/scripts/check_model_usage_adapter_coverage.py backend/scripts/smoke_model_usage_providers.py backend/scripts/generate_model_usage_launch_report.py backend/tests/model_usage backend/tests/conftest.py frontend/e2e/fixtures/apiMocks.mjs frontend/e2e/model-usage-governance.spec.mjs frontend/playwright.config.mjs frontend/package.json package.json docs/plans/model-usage-first-launch-report.md
git diff --cached --check
git commit -m "test(model-usage): enforce first launch gates"
```

---

## Specification Coverage Audit

| Approved specification area | Implemented by |
| --- | --- |
| Guarantees, unknown execution, no false exactly-once claim | Tasks 1, 6, 7 |
| Controlled capabilities/meters, guardrail eligibility, and billable overlap | Tasks 1, 3, 5, 22 |
| Price, subject, policy, counter, reservation/event attempt uniques, adjustment group/line, rollup, alert, incident schema | Tasks 2–4 |
| Decimal/rounding/full-precision budget decisions | Tasks 1, 5, 6 |
| Reserve/dispatch/settle/uncertain, policy-dispatch linearization, bounded fail-open proof, and independent transactions | Tasks 5–7 |
| Database-idempotent adjustment groups, negative adjustment, and alert revision rules | Task 8 |
| Current/historical aggregation and 13-month closure boundary | Tasks 9–10 |
| LLM/vision, embedding, rerank, STT, TTS, realtime per-lease terminalization/watermark conservation, image generation | Tasks 11–16 |
| Personal/Owner APIs, privacy, OCC, alert receipts | Task 17 |
| Query keys, state model, responsive UI, settings, notifications | Tasks 18–21 |
| MySQL unique-claim/policy-dispatch concurrency, counter-kind audit, crash, privacy, performance, migration, E2E, real smoke | Task 22 |

## Final Plan Self-Review Checklist

Before starting implementation, the executing agent must verify this plan itself:

- [ ] Run the exact unresolved-marker scan listed in the plan-verification handoff; it must return no matches before Task 1 begins.
- [ ] Verify every Create/Modify/Test path still exists or is intentionally new against the current repository; if main has moved, update the plan paths before code changes.
- [ ] Verify the current Alembic head is still `1c2d3e4f5a6b`; if not, rebase the four planned revision `down_revision` values in dependency order without editing old migrations.
- [ ] Verify every cross-task symbol in “Locked Cross-Task Interfaces” has one producer and all consumers use the same name/type.
- [ ] Verify ORM and migration both expose reservation/event `(family_id, attempt_key)` and adjustment-group `(family_id, idempotency_key)` uniques, and that every loser path returns before counter/line/alert mutation.
- [ ] Verify policy update and first dispatch use the same pointer-first lock order, and that fail-open proof TTL/single-use tests state rather than hide the post-read race.
- [ ] Verify every capability meter exposed to policy is `guardrail_eligible` across all active variants and counter audit dispatches quantity formulas separately from cost formulas.
- [ ] Verify realtime renewal cannot dispatch lease N+1 until lease N has a terminal event; the 65-second test must prove three events, zero active reservations, disjoint server/provider deltas, conserved totals, and no send after blocked/pending renewal.
- [ ] Verify all current remote send points match Task 22 inventory before implementing adapters; add newly discovered sends to the inventory and an adapter task rather than exempting them.
- [ ] Confirm real price publication and provider smoke will use a designated test family and a reviewed cost acknowledgement.
- [ ] Confirm the repository is clean or record unrelated user-owned changes that must remain untouched.

## Execution Handoff

The plan is intentionally one dependency-ordered document because schema, core, seven adapters, worker/API, notifications, and UI share locked contracts. Execute one Task/commit at a time. After each Task, stop on a red test or contract drift, update this plan/spec with the concrete finding, and obtain review before continuing past a changed guarantee.

- Recommended: use `superpowers:subagent-driven-development`, dispatching one fresh implementation worker per Task and applying two-stage review before the next commit.
- Alternative: use `superpowers:executing-plans` in the active session, executing dependency-ordered batches with explicit review checkpoints.

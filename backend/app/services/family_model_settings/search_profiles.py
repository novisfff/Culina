"""Durable lifecycle for immutable family search profiles.

The canonical ``search_documents`` table owns text, while every immutable
embedding identity owns an independent profile/document lifecycle and Qdrant
collection.  This module deliberately contains no provider send: resource
operations create collections and enqueue profile jobs after the creation
transaction has committed.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.enums import (
    ActivityAction,
    FamilyModelConfigRevisionStatus,
    FamilyModelPricePurpose,
    FamilyModelProviderStatus,
    FamilyModelSearchProfileStatus,
    FamilyModelSecretStatus,
    ModelUsageCapability,
    ModelUsageMeter,
    ModelUsageMeterRole,
)
from app.core.utils import create_id, utcnow
from app.models.domain import SearchDocument, SearchIndexJob
from app.models.model_usage import ModelUsageEvent
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelConfigRevision,
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
    FamilyModelSettings,
    FamilySearchProfile,
    FamilySearchProfileDocument,
)
from app.models.model_usage import ModelUsagePriceRate, ModelUsagePriceVersion
from app.repos.family_model_settings.configurations import (
    get_capability_binding,
    get_config_revision,
    get_family_price_version,
)
from app.repos.family_model_settings.idempotency import claim_operation, complete_operation
from app.repos.family_model_settings.profiles import (
    get_current_provider_profile_version,
    get_current_provider_secret_version,
    get_provider_profile,
    lock_family_model_settings,
    require_settings_version,
)
from app.repos.family_model_settings.resource_operations import insert_ensure_collection_operation
from app.repos.family_model_settings.search_profiles import (
    get_search_profile,
    list_profile_documents,
    profile_document_counts,
    refresh_profile_progress,
    require_search_profile,
    upsert_profile_document_snapshot,
)
from app.repos.model_usage.catalog import next_price_version_number
from app.schemas.family_model_settings import FamilyModelPriceRateRequest
from app.services.activity import log_activity
from app.services.family_model_settings.adapter_registry import (
    require_adapter_endpoint_contract,
    require_adapter_support,
)
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    operation_request_fingerprint,
    verify_owner_password,
)
from app.services.family_model_settings.errors import (
    FamilyModelDraftInvalid,
    FamilyModelOperationInProgress,
    FamilyModelProviderProfileNotFound,
    FamilyModelSecretUnavailable,
    FamilyModelSettingsError,
    FamilyModelSettingsVersionConflict,
)
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.publishing import PublishedFamilyModelConfiguration
from app.services.search.embeddings import estimate_embedding_tokens
from app.services.search.jobs import enqueue_search_profile_document_job


SEARCH_DOCUMENT_BUILDER_VERSION = "family-model-search-v1"
_COLLECTION_PREFIX_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
_EMBEDDING_RATE_METERS = frozenset({ModelUsageMeter.EMBEDDING_TOKENS})
_LIVE_REBUILD_STATUSES = frozenset(
    {
        FamilyModelSearchProfileStatus.PROVISIONING,
        FamilyModelSearchProfileStatus.FAILED,
    }
)
_SAFE_PROGRESS_TEXT_RE = re.compile(
    r"(?i)(?:bearer\s+|api[_ -]?key\s*[:=]\s*|token\s*[:=]\s*|secret\s*[:=]\s*|password\s*[:=]\s*)[^\s,;]+"
)
_SAFE_PROGRESS_URL_RE = re.compile(r"https?://[^\s,;]+", re.IGNORECASE)
_SAFE_PROGRESS_SECRET_VALUE_RE = re.compile(
    r"(?i)\b(?:sk|rk|pk|api)[-_][A-Za-z0-9_-]{8,}\b"
)
_SAFE_PROGRESS_COLLECTION_RE = re.compile(r"\bculina_fsp_[A-Za-z0-9_-]+\b")
_SAFE_PROGRESS_REQUEST_RE = re.compile(
    r"(?i)(?:\"?(?:input|prompt|messages|text)\"?\s*[:=]\s*)"
    r"(?:\[[^\]]*\]|\{[^}]*\}|\"[^\"]*\"|[^,;]+)"
)
_SAFE_PROGRESS_CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$")


@dataclass(frozen=True, slots=True)
class SearchReplacementRate:
    """One candidate Embedding rate supplied by the Owner.

    The public API uses ``FamilyModelPriceRateRequest``.  This small immutable
    form prevents the replacement service from accidentally accepting any
    non-Embedding meter during a future schema expansion.
    """

    meter: ModelUsageMeter
    unit_quantity: Decimal
    unit_price: Decimal
    source_currency: str
    fx_to_cny: Decimal
    reported_model_aliases: tuple[str, ...]

    @property
    def unit_price_cny(self) -> Decimal:
        return (self.unit_price * self.fx_to_cny).quantize(
            Decimal("0.000000000001"), rounding=ROUND_HALF_UP
        )

    def checksum_record(self) -> dict[str, object]:
        return {
            "meter": self.meter.value,
            "unit_quantity": str(self.unit_quantity),
            "unit_price": str(self.unit_price),
            "source_currency": self.source_currency,
            "fx_to_cny": str(self.fx_to_cny),
            "reported_model_aliases": list(self.reported_model_aliases),
        }


@dataclass(frozen=True, slots=True)
class SearchReplacementEmbedding:
    provider_profile: FamilyModelProviderProfile
    provider_profile_version: FamilyModelProviderProfileVersion
    requested_model: str
    dimensions: int
    identity_checksum: str


@dataclass(frozen=True, slots=True)
class SearchReplacementPreview:
    document_count: int
    minimum_estimated_tokens: int
    conservative_estimated_tokens: int
    minimum_estimated_cost_cny: Decimal
    conservative_estimated_cost_cny: Decimal
    confirmation_checksum: str

    def response_record(self) -> dict[str, object]:
        return {
            "document_count": self.document_count,
            "minimum_estimated_tokens": self.minimum_estimated_tokens,
            "conservative_estimated_tokens": self.conservative_estimated_tokens,
            "minimum_estimated_cost_cny": str(self.minimum_estimated_cost_cny),
            "conservative_estimated_cost_cny": str(self.conservative_estimated_cost_cny),
            "confirmation_checksum": self.confirmation_checksum,
        }


@dataclass(frozen=True, slots=True)
class CreateSearchReplacementCommand:
    family_id: str
    actor_user_id: str
    current_password: str
    base_settings_version_number: int
    base_search_profile_id: str
    provider_profile_id: str
    requested_model: str
    dimensions: int
    rates: Sequence[FamilyModelPriceRateRequest | Mapping[str, object]]
    confirm_checksum: str
    idempotency_key: str


@dataclass(frozen=True, slots=True)
class SearchReplacementMutationCommand:
    family_id: str
    actor_user_id: str
    profile_id: str
    base_settings_version_number: int
    idempotency_key: str


@dataclass(frozen=True, slots=True)
class SearchReplacementFailure:
    """Owner-safe summary of the most recent failed replacement job."""

    code: str
    detail: str
    provider_http_status: int | None = None
    provider_error_code: str | None = None
    provider_error_message: str | None = None
    request_sent: bool | None = None
    execution_certainty: str | None = None

    def response_record(self) -> dict[str, object]:
        return {
            "code": self.code,
            "detail": self.detail,
            "provider_http_status": self.provider_http_status,
            "provider_error_code": self.provider_error_code,
            "provider_error_message": self.provider_error_message,
            "request_sent": self.request_sent,
            "execution_certainty": self.execution_certainty,
        }


@dataclass(frozen=True, slots=True)
class SearchReplacementProgress:
    profile_id: str
    status: str
    total_documents: int
    indexed_documents: int
    failed_documents: int
    budget_blocked_documents: int
    retryable: bool
    created_at: datetime
    activated_at: datetime | None
    failure: SearchReplacementFailure | None = None

    def response_record(self) -> dict[str, object]:
        return {
            "profile_id": self.profile_id,
            "status": self.status,
            "total_documents": self.total_documents,
            "indexed_documents": self.indexed_documents,
            "failed_documents": self.failed_documents,
            "budget_blocked_documents": self.budget_blocked_documents,
            "retryable": self.retryable,
            # The same record is stored in the idempotency receipt.  Keep the
            # timestamp wire representation JSON-safe rather than relying on
            # FastAPI's response encoder, which is not involved in a replay.
            "created_at": _response_datetime(self.created_at),
            "activated_at": _response_datetime(self.activated_at) if self.activated_at else None,
            "failure": self.failure.response_record() if self.failure is not None else None,
        }


def _response_datetime(value: datetime) -> str:
    """Serialize database timestamps as one stable UTC wire representation.

    MySQL/SQLite both commonly return a naive ``datetime`` for a
    ``DateTime(timezone=True)`` column.  The application only writes UTC
    timestamps, so attach UTC on read instead of allowing an idempotent replay
    to silently change an earlier ``Z`` response into a timezone-less value.
    """

    instant = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return instant.isoformat()


@dataclass(frozen=True, slots=True)
class SearchReplacementResult:
    profile_id: str
    candidate_price_version_id: str | None
    progress: SearchReplacementProgress

    def response_record(self) -> dict[str, object]:
        return {
            "profile_id": self.profile_id,
            "candidate_price_version_id": self.candidate_price_version_id,
            "progress": self.progress.response_record(),
        }


def _canonical_digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    ).hexdigest()


def normalize_qdrant_collection_prefix(value: object) -> str:
    prefix = str(value or "").strip().lower()
    if not _COLLECTION_PREFIX_RE.fullmatch(prefix):
        raise ValueError("family_model_qdrant_collection_prefix_invalid")
    return prefix


def search_profile_collection_name(
    *,
    family_id: str,
    search_profile_id: str,
    prefix: str | None = None,
) -> str:
    """Return a Qdrant-safe opaque collection name without Provider metadata."""

    resolved_prefix = normalize_qdrant_collection_prefix(
        prefix
        if prefix is not None
        else getattr(get_settings(), "family_model_qdrant_collection_prefix", "culina_fsp")
    )
    token = hashlib.sha256(f"{family_id}\x1f{search_profile_id}".encode("utf-8")).hexdigest()
    return f"{resolved_prefix}_{token[:48]}"


def _normalized_replacement_rates(
    raw_rates: Sequence[FamilyModelPriceRateRequest | Mapping[str, object]],
) -> tuple[SearchReplacementRate, ...]:
    try:
        rates = tuple(
            item
            if isinstance(item, FamilyModelPriceRateRequest)
            else FamilyModelPriceRateRequest.model_validate(item)
            for item in raw_rates
        )
    except Exception as exc:
        raise FamilyModelDraftInvalid("family_search_replacement_price_invalid") from exc
    if not rates:
        raise FamilyModelDraftInvalid("family_search_replacement_price_invalid")
    if any(
        rate.capability != "embedding"
        or rate.variant_key != "search"
        or rate.meter not in _EMBEDDING_RATE_METERS
        for rate in rates
    ):
        raise FamilyModelDraftInvalid("family_search_replacement_price_invalid")
    if {rate.meter for rate in rates} != _EMBEDDING_RATE_METERS:
        raise FamilyModelDraftInvalid("family_search_replacement_price_invalid")
    return tuple(
        SearchReplacementRate(
            meter=rate.meter,
            unit_quantity=rate.unit_quantity,
            unit_price=rate.unit_price,
            source_currency=rate.source_currency,
            fx_to_cny=rate.fx_to_cny,
            reported_model_aliases=tuple(rate.reported_model_aliases),
        )
        for rate in sorted(rates, key=lambda value: value.meter.value)
    )


def _search_identity(
    *,
    provider_profile: FamilyModelProviderProfile,
    provider_version: FamilyModelProviderProfileVersion,
    requested_model: str,
    dimensions: int,
) -> str:
    return _canonical_digest(
        {
            "provider_profile_id": provider_profile.id,
            "provider_profile_version_id": provider_version.id,
            "adapter_kind": provider_version.adapter_kind,
            "endpoint_fingerprint": provider_version.endpoint_fingerprint,
            "embedding_model": requested_model,
            "dimensions": dimensions,
            "distance": "Cosine",
            "document_builder_version": SEARCH_DOCUMENT_BUILDER_VERSION,
        }
    )


def _validated_replacement_embedding(
    db: Session,
    *,
    family_id: str,
    provider_profile_id: str,
    requested_model: str,
    dimensions: int,
    network_policy: ProviderNetworkPolicy,
) -> SearchReplacementEmbedding:
    model = requested_model.strip()
    if not model or isinstance(dimensions, bool) or not isinstance(dimensions, int) or not 1 <= dimensions <= 65536:
        raise FamilyModelDraftInvalid("family_model_embedding_dimensions_required")
    profile = get_provider_profile(db, family_id=family_id, profile_id=provider_profile_id)
    if profile is None:
        raise FamilyModelProviderProfileNotFound()
    if profile.status is not FamilyModelProviderStatus.ACTIVE:
        raise FamilyModelDraftInvalid("family_model_provider_disabled")
    version = get_current_provider_profile_version(db, family_id=family_id, profile=profile)
    if version is None or version.credential_scope_checksum != profile.credential_scope_checksum:
        raise FamilyModelDraftInvalid("family_model_provider_scope_change_requires_new_profile")
    endpoint = network_policy.authorize(version.api_base_url, protocol="http")
    require_adapter_endpoint_contract(
        kind=version.adapter_kind,
        auth_mode=version.auth_mode,
        endpoint=endpoint,
    )
    require_adapter_support(
        kind=version.adapter_kind,
        capability="embedding",
        auth_mode=version.auth_mode,
        billing_scheme_key="embedding-token-v1",
    )
    if version.auth_mode == "api_key":
        secret = get_current_provider_secret_version(db, family_id=family_id, profile=profile)
        if (
            secret is None
            or secret.status is not FamilyModelSecretStatus.ACTIVE
            or secret.nonce is None
            or secret.ciphertext is None
            or secret.auth_tag is None
        ):
            raise FamilyModelSecretUnavailable()
    elif version.auth_mode != "no_auth":
        raise FamilyModelDraftInvalid("family_model_provider_protocol_unsupported")
    return SearchReplacementEmbedding(
        provider_profile=profile,
        provider_profile_version=version,
        requested_model=model,
        dimensions=dimensions,
        identity_checksum=_search_identity(
            provider_profile=profile,
            provider_version=version,
            requested_model=model,
            dimensions=dimensions,
        ),
    )


def _estimate_profile_documents(
    db: Session,
    *,
    family_id: str,
) -> tuple[int, int, int]:
    documents = tuple(
        db.scalars(
            select(SearchDocument.semantic_text).where(SearchDocument.family_id == family_id)
        )
    )
    minimum = sum(max(1, estimate_embedding_tokens(str(text or ""))) for text in documents)
    # UTF-8 byte framing is intentionally more conservative than the local
    # token estimate, but remains content-free after this method returns.
    conservative = sum(
        max(1, len(str(text or "").encode("utf-8")) + 16) for text in documents
    )
    return len(documents), minimum, max(minimum, conservative)


def _replacement_preview(
    db: Session,
    *,
    command: CreateSearchReplacementCommand,
    embedding: SearchReplacementEmbedding,
    rates: tuple[SearchReplacementRate, ...],
) -> SearchReplacementPreview:
    document_count, minimum_tokens, conservative_tokens = _estimate_profile_documents(
        db, family_id=command.family_id
    )
    def estimated_cost(tokens: int) -> Decimal:
        return sum(
            (
                (Decimal(tokens) / rate.unit_quantity * rate.unit_price_cny).quantize(
                    Decimal("0.000000000001"), rounding=ROUND_HALF_UP
                )
                for rate in rates
            ),
            Decimal("0"),
        )

    minimum_cost = estimated_cost(minimum_tokens)
    conservative_cost = estimated_cost(conservative_tokens)
    checksum = _canonical_digest(
        {
            "family_id": command.family_id,
            "base_settings_version_number": command.base_settings_version_number,
            "base_search_profile_id": command.base_search_profile_id,
            "embedding_identity": embedding.identity_checksum,
            "document_count": document_count,
            "minimum_estimated_tokens": minimum_tokens,
            "conservative_estimated_tokens": conservative_tokens,
            "minimum_estimated_cost_cny": str(minimum_cost),
            "conservative_estimated_cost_cny": str(conservative_cost),
            "rates": [rate.checksum_record() for rate in rates],
        }
    )
    return SearchReplacementPreview(
        document_count=document_count,
        minimum_estimated_tokens=minimum_tokens,
        conservative_estimated_tokens=conservative_tokens,
        minimum_estimated_cost_cny=minimum_cost,
        conservative_estimated_cost_cny=conservative_cost,
        confirmation_checksum=checksum,
    )


def preview_search_replacement(
    db: Session,
    command: CreateSearchReplacementCommand,
    *,
    network_policy: ProviderNetworkPolicy,
) -> SearchReplacementPreview:
    """Calculate the server-owned cost/count confirmation for a replacement."""

    embedding = _validated_replacement_embedding(
        db,
        family_id=command.family_id,
        provider_profile_id=command.provider_profile_id,
        requested_model=command.requested_model,
        dimensions=command.dimensions,
        network_policy=network_policy,
    )
    return _replacement_preview(
        db,
        command=command,
        embedding=embedding,
        rates=_normalized_replacement_rates(command.rates),
    )


def _profile_progress(
    db: Session,
    *,
    profile: FamilySearchProfile,
) -> SearchReplacementProgress:
    # Reads must not update progress timestamps or turn a status poll into a
    # hidden write transaction.  Workers/state transitions explicitly refresh
    # the denormalized counters after changing document state.
    counts = profile_document_counts(
        db,
        family_id=profile.family_id,
        search_profile_id=profile.id,
    )
    profile_status = profile.status.value
    retryable = profile.status in {
        FamilyModelSearchProfileStatus.PROVISIONING,
        FamilyModelSearchProfileStatus.FAILED,
    } and (counts.failed > 0 or counts.budget_blocked > 0 or profile.status is FamilyModelSearchProfileStatus.FAILED)
    return SearchReplacementProgress(
        profile_id=profile.id,
        status=profile_status,
        total_documents=counts.total,
        indexed_documents=counts.indexed,
        failed_documents=counts.failed,
        budget_blocked_documents=counts.budget_blocked,
        retryable=retryable,
        created_at=profile.created_at,
        activated_at=profile.activated_at,
        failure=_latest_profile_failure(db, profile=profile),
    )


def _safe_progress_text(
    value: object,
    *,
    fallback: str,
    sensitive_values: Sequence[str] = (),
) -> str:
    if not isinstance(value, str):
        return fallback
    text = " ".join(value.replace("\r", " ").replace("\n", " ").split())
    text = _SAFE_PROGRESS_TEXT_RE.sub("[redacted]", text)
    text = _SAFE_PROGRESS_URL_RE.sub("[provider-url]", text)
    text = _SAFE_PROGRESS_SECRET_VALUE_RE.sub("[redacted]", text)
    text = _SAFE_PROGRESS_COLLECTION_RE.sub("[collection]", text)
    text = _SAFE_PROGRESS_REQUEST_RE.sub("request=[redacted]", text)
    for sensitive in sensitive_values:
        if sensitive:
            text = text.replace(sensitive, "[redacted]")
    return text[:240] or fallback


def _safe_progress_code(value: object, *, fallback: str | None = None) -> str | None:
    if not isinstance(value, str):
        return fallback
    value = value.strip()
    if not _SAFE_PROGRESS_CODE_RE.fullmatch(value):
        return fallback
    if _SAFE_PROGRESS_SECRET_VALUE_RE.fullmatch(value):
        return fallback
    return value


def _profile_failure_detail(job: SearchIndexJob) -> str:
    if job.status == "budget_blocked":
        return "模型用量受当前家庭预算限制，条件允许后可重试。"
    if job.error_code == "search_embedding_provider_rejected":
        if isinstance(job.provider_http_status, int):
            return f"嵌入服务拒绝了请求（HTTP {job.provider_http_status}），现有索引未被替换。"
        return "嵌入服务拒绝了请求，现有索引未被替换。"
    if job.error_code == "search_embedding_transport_uncertain":
        return "嵌入服务连接中断，执行结果暂时无法确认，现有索引未被替换。"
    if job.error_code == "search_embedding_response_invalid":
        return "嵌入服务返回了无法解析的响应，现有索引未被替换。"
    if job.error_code == "family_model_secret_unavailable":
        return "当前嵌入服务的凭据不可用，现有索引未被替换。"
    return "搜索索引建立失败，现有可用索引没有被替换。请检查向量模型配置后重试。"


def _latest_profile_failure(
    db: Session,
    *,
    profile: FamilySearchProfile,
) -> SearchReplacementFailure | None:
    """Project the newest failed job into an Owner-safe replacement summary."""

    job = db.scalar(
        select(SearchIndexJob)
        .where(
            SearchIndexJob.family_id == profile.family_id,
            SearchIndexJob.search_profile_id == profile.id,
            SearchIndexJob.status.in_(("failed", "budget_blocked")),
        )
        .order_by(SearchIndexJob.updated_at.desc(), SearchIndexJob.id.desc())
        .limit(1)
    )
    if job is None:
        if profile.status is not FamilyModelSearchProfileStatus.FAILED:
            return None
        return SearchReplacementFailure(
            code="search_rebuild_failed",
            detail="搜索索引建立失败，现有可用索引没有被替换。请检查向量模型配置后重试。",
        )

    code = _safe_progress_code(job.error_code, fallback="search_rebuild_failed")
    detail = _profile_failure_detail(job)
    provider_http_status = getattr(job, "provider_http_status", None)
    provider_error_code = getattr(job, "provider_error_code", None)
    provider_error_message = getattr(job, "provider_error_message", None)
    request_sent = getattr(job, "request_sent", None)
    execution_certainty = getattr(job, "execution_certainty", None)

    # Rows created before the diagnostic columns/migration can still be
    # rendered safely.  The usage event is the authoritative fallback for the
    # execution certainty; it never exposes its provider/model identities.
    event = None
    if job.usage_event_id:
        event = db.get(ModelUsageEvent, job.usage_event_id)
    if event is None and job.usage_attempt_key:
        event = db.scalar(
            select(ModelUsageEvent)
            .where(
                ModelUsageEvent.family_id == profile.family_id,
                ModelUsageEvent.attempt_key == job.usage_attempt_key,
            )
            .order_by(ModelUsageEvent.completed_at.desc(), ModelUsageEvent.id.desc())
            .limit(1)
        )
    if execution_certainty not in {
        "confirmed_executed",
        "confirmed_not_executed",
        "unknown",
    } and event is not None:
        execution_certainty = event.execution_certainty.value
    if request_sent is not True and request_sent is not False and event is not None:
        # An event exists only after the dispatch boundary.  A confirmed
        # no-send credential failure is represented by a null request id and
        # remains deliberately unknown here rather than being over-claimed.
        request_sent = True if event.provider_request_id else None

    return SearchReplacementFailure(
        code=code or "search_rebuild_failed",
        detail=detail,
        provider_http_status=(
            provider_http_status
            if isinstance(provider_http_status, int) and not isinstance(provider_http_status, bool)
            else None
        ),
        provider_error_code=(
            _safe_progress_code(provider_error_code)
        ),
        provider_error_message=(
            _safe_progress_text(
                provider_error_message,
                fallback="",
                sensitive_values=(profile.qdrant_collection, job.target_name),
            )
            if isinstance(provider_error_message, str) and provider_error_message
            else None
        ),
        request_sent=request_sent if isinstance(request_sent, bool) else None,
        execution_certainty=(
            execution_certainty
            if execution_certainty in {"confirmed_executed", "confirmed_not_executed", "unknown"}
            else None
        ),
    )


def search_replacement_progress(
    db: Session,
    *,
    family_id: str,
    profile_id: str,
) -> SearchReplacementProgress:
    profile = require_search_profile(
        db, family_id=family_id, search_profile_id=profile_id
    )
    return _profile_progress(db, profile=profile)


def current_search_replacement_progress(
    db: Session,
    *,
    family_id: str,
) -> SearchReplacementProgress | None:
    """Return the latest visible search profile for a family.

    The UI can be refreshed or reopened while a replacement is running.  Its
    profile id is not reliable client state, so resolve the live or failed
    candidate on the server.  Active, cancelled and historical profiles are
    not replacement work and are intentionally hidden.
    """

    profile = db.scalar(
        select(FamilySearchProfile)
        .where(
            FamilySearchProfile.family_id == family_id,
            FamilySearchProfile.status.in_(
                (
                    FamilyModelSearchProfileStatus.PROVISIONING,
                    FamilyModelSearchProfileStatus.FAILED,
                )
            ),
        )
        .order_by(FamilySearchProfile.created_at.desc(), FamilySearchProfile.id.desc())
        .limit(1)
    )
    return _profile_progress(db, profile=profile) if profile is not None else None


def _result_for_profile(db: Session, *, profile: FamilySearchProfile) -> SearchReplacementResult:
    return SearchReplacementResult(
        profile_id=profile.id,
        candidate_price_version_id=profile.candidate_price_version_id,
        progress=_profile_progress(db, profile=profile),
    )


def _replayed_result(
    db: Session,
    *,
    family_id: str,
    result_id: str | None,
) -> SearchReplacementResult:
    if not result_id:
        raise FamilyModelOperationInProgress()
    profile = get_search_profile(
        db, family_id=family_id, search_profile_id=result_id
    )
    if profile is None:
        raise FamilyModelOperationInProgress()
    return _result_for_profile(db, profile=profile)


def _ensure_no_live_replacement(
    db: Session,
    *,
    family_id: str,
    base_search_profile_id: str,
) -> None:
    existing = db.scalar(
        select(FamilySearchProfile.id).where(
            FamilySearchProfile.family_id == family_id,
            FamilySearchProfile.base_search_profile_id == base_search_profile_id,
            FamilySearchProfile.status.in_(_LIVE_REBUILD_STATUSES),
        )
    )
    if existing is not None:
        raise FamilyModelSettingsError("family_search_rebuild_in_progress")


def _insert_candidate_price(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    profile: FamilySearchProfile,
    rates: tuple[SearchReplacementRate, ...],
) -> ModelUsagePriceVersion:
    checksum = _canonical_digest(
        {
            "family_id": family_id,
            "search_profile_id": profile.id,
            "embedding_model": profile.embedding_model,
            "provider_profile_id": profile.provider_profile_id,
            "rates": [rate.checksum_record() for rate in rates],
        }
    )
    now = utcnow()
    version = ModelUsagePriceVersion(
        id=create_id("family-model-search-price"),
        family_id=family_id,
        config_revision_id=None,
        search_profile_id=profile.id,
        base_price_version_id=None,
        purpose=FamilyModelPricePurpose.SEARCH_REBUILD_CANDIDATE,
        published_by=actor_user_id,
        version_number=next_price_version_number(db),
        status="published",
        effective_from=now,
        reviewed_at=now,
        source_ref="family-search-rebuild",
        change_note="家庭搜索索引重建候选价格",
        operator=actor_user_id,
        change_ticket=None,
        manifest_checksum=checksum,
        model_aliases_json={
            f"{profile.provider_profile_id}:{alias}": profile.embedding_model
            for rate in rates
            for alias in rate.reported_model_aliases
        },
        fx_rates_json={
            "CNY": "1",
            **{rate.source_currency: str(rate.fx_to_cny) for rate in rates},
        },
    )
    db.add(version)
    db.flush()
    for rate in rates:
        db.add(
            ModelUsagePriceRate(
                id=create_id("model-usage-rate"),
                price_version_id=version.id,
                provider=profile.provider_profile_id,
                billing_model=profile.embedding_model,
                capability=ModelUsageCapability.EMBEDDING,
                variant_key="search",
                billing_scheme_key="embedding-token-v1",
                meter=rate.meter,
                meter_role=ModelUsageMeterRole.BILLABLE,
                unit_quantity=rate.unit_quantity,
                unit_price=rate.unit_price,
                source_currency=rate.source_currency,
                fx_to_cny=rate.fx_to_cny,
                unit_price_cny=rate.unit_price_cny,
                reported_model_aliases=list(rate.reported_model_aliases),
            )
        )
    db.flush()
    profile.candidate_price_version_id = version.id
    return version


def _seed_profile_document_rows(
    db: Session,
    *,
    profile: FamilySearchProfile,
) -> tuple[FamilySearchProfileDocument, ...]:
    documents = tuple(
        db.scalars(
            select(SearchDocument)
            .where(SearchDocument.family_id == profile.family_id)
            .order_by(SearchDocument.created_at.asc(), SearchDocument.id.asc())
        )
    )
    rows = tuple(
        upsert_profile_document_snapshot(db, profile=profile, document=document)
        for document in documents
    )
    refresh_profile_progress(db, profile=profile)
    return rows


def _profile_job_snapshot(
    db: Session,
    *,
    profile: FamilySearchProfile,
    settings: FamilyModelSettings,
) -> tuple[str | None, str] | None:
    is_initial = (
        profile.base_search_profile_id is None
        and profile.candidate_price_version_id is None
        and settings.active_search_profile_id is None
    )
    is_active = settings.active_search_profile_id == profile.id
    if is_initial or is_active:
        if settings.active_config_revision_id is None or settings.active_price_version_id is None:
            return None
        return settings.active_config_revision_id, settings.active_price_version_id
    if profile.candidate_price_version_id:
        return None, profile.candidate_price_version_id
    return None


def seed_search_profile_documents(
    db: Session,
    *,
    family_id: str,
    profile_id: str,
    user_id: str = "search-profile-provisioning",
    enqueue_jobs: bool = True,
) -> tuple[SearchIndexJob, ...]:
    """Create missing profile snapshots and, after collection ensure, jobs.

    The resource-operation worker calls this only after Qdrant reports the
    collection ready.  It is idempotent so a crash after an external ensure
    cannot lose or duplicate work.
    """

    # Preserve the project-wide settings -> profile lock order. It also
    # linearizes first-provisioning jobs against a concurrent price publish.
    settings = lock_family_model_settings(db, family_id=family_id)
    profile = require_search_profile(
        db, family_id=family_id, search_profile_id=profile_id, for_update=True
    )
    if profile.status not in {
        FamilyModelSearchProfileStatus.PROVISIONING,
        FamilyModelSearchProfileStatus.ACTIVE,
    }:
        return ()
    rows = _seed_profile_document_rows(db, profile=profile)
    if not enqueue_jobs:
        return ()
    snapshot = _profile_job_snapshot(db, profile=profile, settings=settings)
    if snapshot is None:
        return ()
    config_revision_id, price_version_id = snapshot
    jobs: list[SearchIndexJob] = []
    for row in rows:
        document = db.get(SearchDocument, row.search_document_id)
        if document is None or document.family_id != family_id:
            continue
        if row.status == "indexed" and row.content_hash == document.content_hash:
            continue
        jobs.append(
            enqueue_search_profile_document_job(
                db,
                profile=profile,
                profile_document=row,
                config_revision_id=config_revision_id,
                price_version_id=price_version_id,
                user_id=user_id,
                target_name=document.title_text,
            )
        )
    refresh_profile_progress(db, profile=profile)
    return tuple(jobs)


def create_search_replacement(
    db: Session,
    command: CreateSearchReplacementCommand,
    *,
    cipher: FamilyModelCredentialCipher,
    network_policy: ProviderNetworkPolicy,
    collection_prefix: str | None = None,
) -> SearchReplacementResult:
    """Create exactly one immutable candidate profile and candidate price.

    The transaction writes only database state and an ensure outbox item.  It
    does not touch Qdrant or perform any provider request.
    """

    verify_owner_password(
        db,
        family_id=command.family_id,
        actor_user_id=command.actor_user_id,
        current_password=command.current_password,
    )
    rates = _normalized_replacement_rates(command.rates)
    fingerprint_for_key_id = lambda key_id: operation_request_fingerprint(
        cipher.keyring,
        key_id=key_id,
        operation="create_family_search_replacement",
        public_fields={
            "family_id": command.family_id,
            "base_settings_version_number": command.base_settings_version_number,
            "base_search_profile_id": command.base_search_profile_id,
            "provider_profile_id": command.provider_profile_id,
            "requested_model": command.requested_model,
            "dimensions": command.dimensions,
            "rates": [rate.checksum_record() for rate in rates],
            "confirm_checksum": command.confirm_checksum,
        },
        secret_fields={"current_password": command.current_password},
    )
    claim = claim_operation(
        db,
        family_id=command.family_id,
        operation="create_family_search_replacement",
        idempotency_key=command.idempotency_key,
        active_fingerprint_key_id=cipher.active_key_id,
        fingerprint_for_key_id=fingerprint_for_key_id,
    )
    if claim.completed:
        return _replayed_result(
            db, family_id=command.family_id, result_id=claim.receipt.result_id
        )
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()

    settings = lock_family_model_settings(db, family_id=command.family_id)
    require_settings_version(settings, command.base_settings_version_number)
    if settings.active_search_profile_id != command.base_search_profile_id:
        raise FamilyModelSettingsVersionConflict("family_search_profile_locked")
    active = require_search_profile(
        db,
        family_id=command.family_id,
        search_profile_id=command.base_search_profile_id,
        for_update=True,
    )
    if active.status is not FamilyModelSearchProfileStatus.ACTIVE:
        raise FamilyModelSettingsVersionConflict("family_search_profile_locked")
    _ensure_no_live_replacement(
        db,
        family_id=command.family_id,
        base_search_profile_id=active.id,
    )
    embedding = _validated_replacement_embedding(
        db,
        family_id=command.family_id,
        provider_profile_id=command.provider_profile_id,
        requested_model=command.requested_model,
        dimensions=command.dimensions,
        network_policy=network_policy,
    )
    if hmac.compare_digest(embedding.identity_checksum, active.index_identity_checksum):
        raise FamilyModelDraftInvalid("family_search_profile_locked")
    preview = _replacement_preview(
        db,
        command=command,
        embedding=embedding,
        rates=rates,
    )
    if not hmac.compare_digest(preview.confirmation_checksum, command.confirm_checksum):
        raise FamilyModelDraftInvalid("family_search_replacement_checksum_mismatch")

    profile_id = create_id("family-search-profile")
    profile = FamilySearchProfile(
        id=profile_id,
        family_id=command.family_id,
        base_search_profile_id=active.id,
        provider_profile_id=embedding.provider_profile.id,
        provider_profile_version_id=embedding.provider_profile_version.id,
        adapter_kind=embedding.provider_profile_version.adapter_kind,
        embedding_model=embedding.requested_model,
        dimensions=embedding.dimensions,
        distance="Cosine",
        document_builder_version=SEARCH_DOCUMENT_BUILDER_VERSION,
        index_identity_checksum=embedding.identity_checksum,
        qdrant_collection=search_profile_collection_name(
            family_id=command.family_id,
            search_profile_id=profile_id,
            prefix=collection_prefix,
        ),
        status=FamilyModelSearchProfileStatus.PROVISIONING,
        created_by=command.actor_user_id,
    )
    db.add(profile)
    db.flush()
    candidate_price = _insert_candidate_price(
        db,
        family_id=command.family_id,
        actor_user_id=command.actor_user_id,
        profile=profile,
        rates=rates,
    )
    _seed_profile_document_rows(db, profile=profile)
    insert_ensure_collection_operation(db, search_profile=profile)
    settings.version_number += 1
    settings.updated_by = command.actor_user_id
    settings.updated_at = utcnow()
    # Repository sessions use ``autoflush=False``.  Make the new document rows
    # visible to the progress recount returned by this same request.
    db.flush()
    result = _result_for_profile(db, profile=profile)
    complete_operation(
        claim,
        result_id=profile.id,
        response_json=result.response_record(),
    )
    log_activity(
        db,
        family_id=command.family_id,
        actor_id=command.actor_user_id,
        action=ActivityAction.UPDATE,
        entity_type="FamilySearchProfile",
        entity_id=profile.id,
        summary="开始重建家庭搜索索引",
    )
    db.flush()
    # Retain the local variable to make the candidate ownership visible to
    # static readers; the pointer is also persisted on ``profile``.
    assert candidate_price.id == profile.candidate_price_version_id
    return result


def _mutation_claim(
    db: Session,
    *,
    command: SearchReplacementMutationCommand,
    operation: str,
    cipher: FamilyModelCredentialCipher,
):
    return claim_operation(
        db,
        family_id=command.family_id,
        operation=operation,
        idempotency_key=command.idempotency_key,
        active_fingerprint_key_id=cipher.active_key_id,
        fingerprint_for_key_id=lambda key_id: operation_request_fingerprint(
            cipher.keyring,
            key_id=key_id,
            operation=operation,
            public_fields={
                "family_id": command.family_id,
                "profile_id": command.profile_id,
                "base_settings_version_number": command.base_settings_version_number,
            },
            secret_fields={},
        ),
    )


def _retryable_profile(profile: FamilySearchProfile) -> bool:
    return profile.status in {
        FamilyModelSearchProfileStatus.PROVISIONING,
        FamilyModelSearchProfileStatus.FAILED,
    }


def retry_search_replacement(
    db: Session,
    command: SearchReplacementMutationCommand,
    *,
    cipher: FamilyModelCredentialCipher,
) -> SearchReplacementResult:
    claim = _mutation_claim(
        db,
        command=command,
        operation="retry_family_search_replacement",
        cipher=cipher,
    )
    if claim.completed:
        return _replayed_result(db, family_id=command.family_id, result_id=claim.receipt.result_id)
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()
    settings = lock_family_model_settings(db, family_id=command.family_id)
    require_settings_version(settings, command.base_settings_version_number)
    profile = require_search_profile(
        db,
        family_id=command.family_id,
        search_profile_id=command.profile_id,
        for_update=True,
    )
    if not _retryable_profile(profile) or settings.active_search_profile_id == profile.id:
        raise FamilyModelSettingsError("family_search_rebuild_failed")
    profile.status = FamilyModelSearchProfileStatus.PROVISIONING
    profile.cancelled_at = None
    for row in list_profile_documents(
        db,
        family_id=command.family_id,
        search_profile_id=profile.id,
        statuses=("failed", "budget_blocked"),
        for_update=True,
    ):
        row.status = "pending"
        row.vector_json = None
        row.vector_dimensions = None
        row.error_code = None
        row.attempt_count = 0
        row.last_attempt_at = None
    jobs = tuple(
        db.scalars(
            select(SearchIndexJob)
            .where(
                SearchIndexJob.family_id == command.family_id,
                SearchIndexJob.search_profile_id == profile.id,
                SearchIndexJob.status.in_(("failed", "budget_blocked", "cancelled")),
            )
            .with_for_update()
        )
    )
    for job in jobs:
        job.status = "queued"
        job.vector_status = "pending"
        job.error = None
        job.error_code = None
        job.attempt_count = 0
        for field in (
            "provider_http_status",
            "provider_error_code",
            "provider_error_message",
            "request_sent",
            "execution_certainty",
        ):
            if hasattr(job, field):
                setattr(job, field, None)
        job.locked_at = None
        job.started_at = None
        job.completed_at = None
        job.budget_blocked_period_start = None
        job.budget_blocked_policy_version_id = None
    insert_ensure_collection_operation(db, search_profile=profile)
    settings.version_number += 1
    settings.updated_by = command.actor_user_id
    settings.updated_at = utcnow()
    # Make the reset document/job states visible to the progress recount in
    # this response before the transaction is committed by the API boundary.
    db.flush()
    result = _result_for_profile(db, profile=profile)
    complete_operation(claim, result_id=profile.id, response_json=result.response_record())
    log_activity(
        db,
        family_id=command.family_id,
        actor_id=command.actor_user_id,
        action=ActivityAction.UPDATE,
        entity_type="FamilySearchProfile",
        entity_id=profile.id,
        summary="重试家庭搜索索引重建",
    )
    db.flush()
    return result


def cancel_search_replacement(
    db: Session,
    command: SearchReplacementMutationCommand,
    *,
    cipher: FamilyModelCredentialCipher,
) -> SearchReplacementResult:
    claim = _mutation_claim(
        db,
        command=command,
        operation="cancel_family_search_replacement",
        cipher=cipher,
    )
    if claim.completed:
        return _replayed_result(db, family_id=command.family_id, result_id=claim.receipt.result_id)
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()
    settings = lock_family_model_settings(db, family_id=command.family_id)
    require_settings_version(settings, command.base_settings_version_number)
    profile = require_search_profile(
        db,
        family_id=command.family_id,
        search_profile_id=command.profile_id,
        for_update=True,
    )
    if profile.base_search_profile_id is None or settings.active_search_profile_id == profile.id:
        raise FamilyModelSettingsVersionConflict("family_search_profile_locked")
    if profile.status not in _LIVE_REBUILD_STATUSES:
        raise FamilyModelSettingsError("family_search_rebuild_failed")
    profile.status = FamilyModelSearchProfileStatus.CANCELLED
    profile.cancelled_at = utcnow()
    for job in tuple(
        db.scalars(
            select(SearchIndexJob)
            .where(
                SearchIndexJob.family_id == command.family_id,
                SearchIndexJob.search_profile_id == profile.id,
                SearchIndexJob.status.in_(("queued", "failed", "budget_blocked")),
            )
            .with_for_update()
        )
    ):
        job.status = "cancelled"
        job.locked_at = None
        job.completed_at = utcnow()
        job.updated_at = utcnow()
    settings.version_number += 1
    settings.updated_by = command.actor_user_id
    settings.updated_at = utcnow()
    result = _result_for_profile(db, profile=profile)
    complete_operation(claim, result_id=profile.id, response_json=result.response_record())
    log_activity(
        db,
        family_id=command.family_id,
        actor_id=command.actor_user_id,
        action=ActivityAction.UPDATE,
        entity_type="FamilySearchProfile",
        entity_id=profile.id,
        summary="取消家庭搜索索引重建",
    )
    db.flush()
    return result


def _profile_is_ready(db: Session, *, profile: FamilySearchProfile) -> bool:
    counts = profile_document_counts(
        db, family_id=profile.family_id, search_profile_id=profile.id
    )
    return counts.ready


def _binding_identity_checksum(
    *,
    capability: ModelUsageCapability,
    variant_key: str,
    provider_profile_id: str | None,
    provider_profile_version_id: str | None,
    requested_model: str,
    billing_scheme_key: str,
    options: Mapping[str, object],
) -> str:
    return _canonical_digest(
        {
            "capability": capability.value,
            "variant_key": variant_key,
            "provider_profile_id": provider_profile_id,
            "provider_profile_version_id": provider_profile_version_id,
            "requested_model": requested_model,
            "billing_scheme_key": billing_scheme_key,
            "options": dict(options),
        }
    )


def _revision_checksum(
    *,
    bindings: Sequence[FamilyModelCapabilityBinding],
    search_profile_id: str,
) -> str:
    return _canonical_digest(
        {
            "bindings": [
                {
                    "capability": binding.capability.value,
                    "variant_key": binding.variant_key,
                    "enabled": binding.enabled,
                    "provider_profile_id": binding.provider_profile_id,
                    "provider_profile_version_id": binding.provider_profile_version_id,
                    "requested_model": binding.requested_model,
                    "billing_scheme_key": binding.billing_scheme_key,
                    "options": dict(binding.options_json or {}),
                    "identity_checksum": binding.identity_checksum,
                }
                for binding in sorted(
                    bindings, key=lambda item: (item.capability.value, item.variant_key)
                )
            ],
            "search_profile_id": search_profile_id,
        }
    )


def _clone_revision_replacing_embedding(
    db: Session,
    *,
    current: FamilyModelConfigRevision,
    candidate: FamilySearchProfile,
    actor_user_id: str,
) -> FamilyModelConfigRevision:
    source_bindings = tuple(
        db.scalars(
            select(FamilyModelCapabilityBinding)
            .where(
                FamilyModelCapabilityBinding.family_id == current.family_id,
                FamilyModelCapabilityBinding.config_revision_id == current.id,
            )
            .order_by(
                FamilyModelCapabilityBinding.capability,
                FamilyModelCapabilityBinding.variant_key,
            )
        )
    )
    if not source_bindings:
        raise FamilyModelSettingsError("family_model_configuration_not_found")
    cloned: list[FamilyModelCapabilityBinding] = []
    embedding_replaced = False
    for source in source_bindings:
        if (
            source.capability is ModelUsageCapability.EMBEDDING
            and source.variant_key == "search"
        ):
            options: dict[str, object] = {"dimensions": candidate.dimensions}
            cloned.append(
                FamilyModelCapabilityBinding(
                    id=create_id("family-model-binding"),
                    family_id=current.family_id,
                    config_revision_id="",
                    capability=ModelUsageCapability.EMBEDDING,
                    variant_key="search",
                    enabled=True,
                    provider_profile_id=candidate.provider_profile_id,
                    provider_profile_version_id=candidate.provider_profile_version_id,
                    requested_model=candidate.embedding_model,
                    options_json=options,
                    billing_scheme_key="embedding-token-v1",
                    identity_checksum=_binding_identity_checksum(
                        capability=ModelUsageCapability.EMBEDDING,
                        variant_key="search",
                        provider_profile_id=candidate.provider_profile_id,
                        provider_profile_version_id=candidate.provider_profile_version_id,
                        requested_model=candidate.embedding_model,
                        billing_scheme_key="embedding-token-v1",
                        options=options,
                    ),
                )
            )
            embedding_replaced = True
            continue
        cloned.append(
            FamilyModelCapabilityBinding(
                id=create_id("family-model-binding"),
                family_id=current.family_id,
                config_revision_id="",
                capability=source.capability,
                variant_key=source.variant_key,
                enabled=source.enabled,
                provider_profile_id=source.provider_profile_id,
                provider_profile_version_id=source.provider_profile_version_id,
                requested_model=source.requested_model,
                options_json=dict(source.options_json or {}),
                billing_scheme_key=source.billing_scheme_key,
                identity_checksum=source.identity_checksum,
            )
        )
    if not embedding_replaced:
        raise FamilyModelSettingsError("family_search_profile_locked")
    checksum = _revision_checksum(bindings=cloned, search_profile_id=candidate.id)
    if db.scalar(
        select(FamilyModelConfigRevision.id).where(
            FamilyModelConfigRevision.family_id == current.family_id,
            FamilyModelConfigRevision.config_checksum == checksum,
        )
    ):
        raise FamilyModelSettingsError("family_search_profile_locked")
    revision = FamilyModelConfigRevision(
        id=create_id("family-model-revision"),
        family_id=current.family_id,
        version_number=(
            int(
                db.scalar(
                    select(func.max(FamilyModelConfigRevision.version_number)).where(
                        FamilyModelConfigRevision.family_id == current.family_id
                    )
                )
                or 0
            )
            + 1
        ),
        base_revision_id=current.id,
        config_checksum=checksum,
        status=FamilyModelConfigRevisionStatus.PUBLISHED,
        search_profile_id=candidate.id,
        change_note="切换家庭搜索索引",
        published_by=actor_user_id,
    )
    db.add(revision)
    db.flush()
    for binding in cloned:
        binding.config_revision_id = revision.id
        db.add(binding)
    db.flush()
    return revision


def _rate_checksum_record(rate: ModelUsagePriceRate) -> dict[str, object]:
    return {
        "provider": rate.provider,
        "billing_model": rate.billing_model,
        "capability": rate.capability.value,
        "variant_key": rate.variant_key,
        "billing_scheme_key": rate.billing_scheme_key,
        "meter": rate.meter.value,
        "unit_quantity": str(rate.unit_quantity),
        "unit_price": str(rate.unit_price),
        "source_currency": rate.source_currency,
        "fx_to_cny": str(rate.fx_to_cny),
        "unit_price_cny": str(rate.unit_price_cny),
        "reported_model_aliases": list(rate.reported_model_aliases or []),
    }


def _clone_price_replacing_embedding(
    db: Session,
    *,
    current: ModelUsagePriceVersion,
    candidate_price: ModelUsagePriceVersion,
    revision: FamilyModelConfigRevision,
    actor_user_id: str,
) -> ModelUsagePriceVersion:
    current_rates = tuple(
        db.scalars(
            select(ModelUsagePriceRate)
            .where(ModelUsagePriceRate.price_version_id == current.id)
            .order_by(
                ModelUsagePriceRate.capability,
                ModelUsagePriceRate.variant_key,
                ModelUsagePriceRate.meter,
            )
        )
    )
    candidate_rates = tuple(
        db.scalars(
            select(ModelUsagePriceRate)
            .where(ModelUsagePriceRate.price_version_id == candidate_price.id)
            .order_by(ModelUsagePriceRate.meter)
        )
    )
    if (
        not candidate_rates
        or any(
            rate.capability is not ModelUsageCapability.EMBEDDING
            or rate.variant_key != "search"
            for rate in candidate_rates
        )
    ):
        raise FamilyModelSettingsError("family_model_price_pointer_invalid")
    copied_rates = [
        rate for rate in current_rates if rate.capability is not ModelUsageCapability.EMBEDDING
    ] + list(candidate_rates)
    checksum = _canonical_digest(
        [
            _rate_checksum_record(rate)
            for rate in sorted(
                copied_rates,
                key=lambda item: (
                    item.capability.value,
                    item.variant_key,
                    item.meter.value,
                    item.provider,
                    item.billing_model,
                ),
            )
        ]
    )
    now = utcnow()
    price = ModelUsagePriceVersion(
        id=create_id("family-model-price"),
        family_id=current.family_id,
        config_revision_id=revision.id,
        search_profile_id=None,
        base_price_version_id=current.id,
        purpose=FamilyModelPricePurpose.ACTIVE,
        published_by=actor_user_id,
        version_number=next_price_version_number(db),
        status="published",
        effective_from=now,
        reviewed_at=now,
        source_ref="family-search-activation",
        change_note="切换家庭搜索索引",
        operator=actor_user_id,
        change_ticket=None,
        manifest_checksum=checksum,
        model_aliases_json={
            f"{rate.provider}:{alias}": rate.billing_model
            for rate in copied_rates
            for alias in (rate.reported_model_aliases or [])
        },
        fx_rates_json={
            "CNY": "1",
            **{rate.source_currency: str(rate.fx_to_cny) for rate in copied_rates},
        },
    )
    db.add(price)
    db.flush()
    for rate in copied_rates:
        db.add(
            ModelUsagePriceRate(
                id=create_id("model-usage-rate"),
                price_version_id=price.id,
                provider=rate.provider,
                billing_model=rate.billing_model,
                capability=rate.capability,
                variant_key=rate.variant_key,
                billing_scheme_key=rate.billing_scheme_key,
                meter=rate.meter,
                meter_role=rate.meter_role,
                unit_quantity=rate.unit_quantity,
                unit_price=rate.unit_price,
                source_currency=rate.source_currency,
                fx_to_cny=rate.fx_to_cny,
                unit_price_cny=rate.unit_price_cny,
                reported_model_aliases=list(rate.reported_model_aliases or []),
            )
        )
    db.flush()
    return price


def _initial_profile_matches_current_revision(
    db: Session,
    *,
    revision: FamilyModelConfigRevision,
    profile: FamilySearchProfile,
) -> bool:
    if revision.search_profile_id != profile.id:
        return False
    binding = get_capability_binding(
        db,
        family_id=profile.family_id,
        config_revision_id=revision.id,
        capability="embedding",
        variant_key="search",
    )
    if binding is None:
        return False
    dimensions = (binding.options_json or {}).get("dimensions")
    return (
        binding.enabled
        and binding.provider_profile_id == profile.provider_profile_id
        and binding.provider_profile_version_id == profile.provider_profile_version_id
        and binding.requested_model == profile.embedding_model
        and dimensions == profile.dimensions
        and binding.billing_scheme_key == "embedding-token-v1"
    )


def activate_ready_search_profile(
    db: Session,
    *,
    family_id: str,
    profile_id: str,
    actor_user_id: str = "search-profile-worker",
) -> PublishedFamilyModelConfiguration:
    """Atomically make a fully indexed profile eligible for semantic query.

    Initial provisioning only flips the search pointer. Replacements create a
    new revision and complete active price table from the *switch-time*
    configuration, so concurrent LLM/Rerank/price edits are never restored.
    """

    settings = lock_family_model_settings(db, family_id=family_id)
    profile = require_search_profile(
        db, family_id=family_id, search_profile_id=profile_id, for_update=True
    )
    if profile.status is not FamilyModelSearchProfileStatus.PROVISIONING or not _profile_is_ready(
        db, profile=profile
    ):
        raise FamilyModelSettingsError("family_search_rebuild_failed")
    if settings.active_search_profile_id != profile.base_search_profile_id:
        raise FamilyModelSettingsVersionConflict("family_search_profile_locked")
    if settings.active_config_revision_id is None or settings.active_price_version_id is None:
        raise FamilyModelSettingsError("family_model_settings_not_configured")
    current_revision = get_config_revision(
        db,
        family_id=family_id,
        config_revision_id=settings.active_config_revision_id,
        for_update=True,
    )
    current_price = get_family_price_version(
        db,
        family_id=family_id,
        price_version_id=settings.active_price_version_id,
        for_update=True,
    )
    if current_revision is None or current_price is None:
        raise FamilyModelSettingsError("family_model_price_pointer_invalid")

    if profile.base_search_profile_id is None:
        if not _initial_profile_matches_current_revision(
            db, revision=current_revision, profile=profile
        ):
            raise FamilyModelSettingsVersionConflict("family_search_profile_locked")
        new_revision = current_revision
        new_price = current_price
    else:
        candidate_price = (
            get_family_price_version(
                db,
                family_id=family_id,
                price_version_id=profile.candidate_price_version_id,
                for_update=True,
            )
            if profile.candidate_price_version_id
            else None
        )
        if (
            candidate_price is None
            or candidate_price.purpose is not FamilyModelPricePurpose.SEARCH_REBUILD_CANDIDATE
            or candidate_price.search_profile_id != profile.id
        ):
            raise FamilyModelSettingsError("family_model_price_pointer_invalid")
        new_revision = _clone_revision_replacing_embedding(
            db,
            current=current_revision,
            candidate=profile,
            actor_user_id=actor_user_id,
        )
        new_price = _clone_price_replacing_embedding(
            db,
            current=current_price,
            candidate_price=candidate_price,
            revision=new_revision,
            actor_user_id=actor_user_id,
        )
        current_revision.status = FamilyModelConfigRevisionStatus.SUPERSEDED
        old_profile = require_search_profile(
            db,
            family_id=family_id,
            search_profile_id=profile.base_search_profile_id,
            for_update=True,
        )
        old_profile.status = FamilyModelSearchProfileStatus.SUPERSEDED

    settings.active_config_revision_id = new_revision.id
    settings.active_price_version_id = new_price.id
    settings.active_search_profile_id = profile.id
    settings.version_number += 1
    settings.updated_by = actor_user_id
    settings.updated_at = utcnow()
    profile.status = FamilyModelSearchProfileStatus.ACTIVE
    profile.activated_at = utcnow()
    result = PublishedFamilyModelConfiguration(
        family_id=family_id,
        config_revision_id=new_revision.id,
        price_version_id=new_price.id,
        settings_version_number=settings.version_number,
        config_checksum=new_revision.config_checksum,
        price_checksum=new_price.manifest_checksum,
        search_profile_id=profile.id,
    )
    log_activity(
        db,
        family_id=family_id,
        actor_id=actor_user_id,
        action=ActivityAction.UPDATE,
        entity_type="FamilySearchProfile",
        entity_id=profile.id,
        summary="切换了家庭搜索索引",
    )
    db.flush()
    return result

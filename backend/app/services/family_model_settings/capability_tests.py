"""Billable, Owner-initiated probes for family model capabilities.

The probes are intentionally a closed registry.  They are not arbitrary
provider requests: the active family binding supplies every endpoint, model,
credential scope and pricing identity, while the registry supplies only a
small, fixed protocol payload for each capability.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageOperationSource,
    ModelUsageProviderOutcome,
)
from app.core.utils import utcnow
from app.db.session import SessionLocal
from app.repos.family_model_settings.idempotency import claim_operation, complete_operation
from app.services.ai_audio.config import realtime_endpoint_url
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    operation_request_fingerprint,
)
from app.services.family_model_settings.errors import (
    FamilyModelDraftInvalid,
    FamilyModelOperationInProgress,
    FamilyModelProviderProtocolUnsupported,
    FamilyModelProviderTransportError,
    FamilyModelSecretUnavailable,
)
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.resolver import FamilyModelConfigurationResolver
from app.services.family_model_settings.transport import ProviderResponse, ProviderTransport
from app.services.family_model_settings.types import (
    DispatchCredential,
    FamilyModelCapability,
    ResolvedCapabilityBinding,
)
from app.services.model_usage.adapters.base import MeteredProviderAdapter
from app.services.model_usage.errors import ModelUsageBlocked, ModelUsageError
from app.services.model_usage.estimators import (
    estimate_embedding,
    estimate_image_generation,
    estimate_llm,
    estimate_realtime_audio,
    estimate_rerank,
    estimate_stt,
    estimate_tts,
)
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.preflight import decode_receipt_integrity_keyring
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.types import (
    DispatchPermit,
    ProviderUsageReceipt,
    UsageAttribution,
    UsageContext,
    UsageEstimate,
    receipt_identity_from_permit,
)


CapabilityTestStatus = Literal["succeeded", "failed", "blocked"]


@dataclass(frozen=True, slots=True)
class CapabilityTestCommand:
    family_id: str
    actor_user_id: str
    capability: FamilyModelCapability
    variant_key: str
    confirm_billable: bool
    idempotency_key: str


@dataclass(frozen=True, slots=True)
class CapabilityTestResult:
    capability: FamilyModelCapability
    variant_key: str
    status: CapabilityTestStatus
    detail: str
    checked_at: datetime

    def response_record(self) -> dict[str, object]:
        return {
            "capability": self.capability,
            "variant_key": self.variant_key,
            "status": self.status,
            "detail": self.detail,
            "checked_at": self.checked_at.isoformat(),
        }

    @classmethod
    def from_response_record(cls, payload: object) -> "CapabilityTestResult":
        if not isinstance(payload, Mapping):
            raise FamilyModelOperationInProgress()
        try:
            capability = str(payload["capability"])
            variant_key = str(payload["variant_key"])
            status = str(payload["status"])
            detail = str(payload["detail"])
            checked_at = datetime.fromisoformat(
                str(payload["checked_at"]).replace("Z", "+00:00")
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise FamilyModelOperationInProgress() from exc
        if (
            capability not in _ALLOWED_VARIANTS
            or variant_key not in _ALLOWED_VARIANTS[capability]
            or status not in {"succeeded", "failed", "blocked"}
            or not detail
        ):
            raise FamilyModelOperationInProgress()
        return cls(
            capability=capability,  # type: ignore[arg-type]
            variant_key=variant_key,
            status=status,  # type: ignore[arg-type]
            detail=detail,
            checked_at=checked_at,
        )


@dataclass(frozen=True, slots=True)
class CapabilityTestDependencies:
    cipher: FamilyModelCredentialCipher
    network_policy: ProviderNetworkPolicy
    transport: ProviderTransport
    usage_facade: ModelUsageFacade
    signer: ProviderUsageReceiptSigner
    session_factory: Callable[[], Session] = SessionLocal
    now: Callable[[], datetime] = utcnow


_ALLOWED_VARIANTS: Mapping[str, frozenset[str]] = {
    "llm": frozenset({"primary", "fallback"}),
    "image_generation": frozenset({"text", "reference"}),
    "stt": frozenset({"default"}),
    "tts": frozenset({"default"}),
    "realtime_audio": frozenset({"default"}),
    "embedding": frozenset({"search"}),
    "rerank": frozenset({"search"}),
}


def _binding_url(binding: ResolvedCapabilityBinding, suffix: str) -> str:
    """Append a registry-owned path without accepting a caller URL."""

    parsed = urlsplit(binding.endpoint.normalized_url)
    path = "/".join(
        part.strip("/") for part in (parsed.path, suffix) if part.strip("/")
    )
    return urlunsplit((parsed.scheme, parsed.netloc, f"/{path}", "", ""))


def _headers(
    binding: ResolvedCapabilityBinding,
    credential: DispatchCredential,
    *,
    permit: DispatchPermit | None = None,
) -> dict[str, str]:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if binding.auth_mode == "api_key":
        if not credential.api_key:
            raise FamilyModelSecretUnavailable()
        headers["Authorization"] = f"Bearer {credential.api_key}"
    if permit is not None and permit.provider_idempotency_key:
        headers["Idempotency-Key"] = permit.provider_idempotency_key
    return headers


def _openai_http_probe_request(binding: ResolvedCapabilityBinding) -> tuple[str, dict[str, object]]:
    """Return a minimal provider-owned operation for one HTTP capability.

    The request bodies are deliberately fixed and contain no household data.
    Both currently supported HTTP adapters accept a model identifier from the
    published binding; future adapters must be explicitly added here rather
    than inheriting a generic fallback.
    """

    if binding.capability == "llm":
        return "chat/completions", {
            "model": binding.requested_model,
            "messages": [{"role": "user", "content": "请回复：已完成能力测试。"}],
            "max_tokens": 1,
        }
    if binding.capability == "image_generation":
        return "images/generations", {
            "model": binding.requested_model,
            "prompt": "一颗番茄，白色背景，测试图。",
            "n": 1,
            "size": "256x256",
        }
    if binding.capability == "stt":
        # The normal adapter owns production multipart encoding.  This fixed
        # capability probe intentionally contains only a short silent WAV
        # marker and is never derived from user media.
        return "audio/transcriptions", {
            "model": binding.requested_model,
            "file": "capability-test-silence.wav",
        }
    if binding.capability == "tts":
        return "audio/speech", {
            "model": binding.requested_model,
            "voice": "alloy",
            "input": "能力测试。",
        }
    if binding.capability == "embedding":
        return "embeddings", {"model": binding.requested_model, "input": ["能力测试"]}
    if binding.capability == "rerank":
        return "rerank", {
            "model": binding.requested_model,
            "query": "番茄",
            "documents": ["番茄"],
            "top_n": 1,
        }
    raise FamilyModelProviderProtocolUnsupported()


def _dashscope_stt_probe_payload(model: str) -> dict[str, object]:
    """Build the same native DashScope STT envelope as the audio runtime.

    The content is a fixed, tiny WAV data URL rather than caller or household
    media.  Keeping this shape aligned with ``DashScopeAudioProvider`` means
    an Owner capability probe tests the protocol they will actually use.
    """

    silence_data_url = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
    if model.startswith("qwen3-asr-flash"):
        return {
            "model": model,
            "input": {
                "messages": [
                    {"role": "system", "content": [{"text": ""}]},
                    {"role": "user", "content": [{"audio": silence_data_url}]},
                ]
            },
            "parameters": {
                "asr_options": {"enable_itn": False},
                "format": "wav",
                "sample_rate": "16000",
            },
        }
    return {
        "model": model,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {"data": silence_data_url},
                        }
                    ],
                }
            ]
        },
        "parameters": {"format": "wav", "sample_rate": "16000"},
    }


def _dashscope_http_probe_request(binding: ResolvedCapabilityBinding) -> tuple[str, dict[str, object]]:
    """Return a native DashScope probe instead of assuming OpenAI wire paths."""

    model = binding.requested_model
    if binding.capability == "llm":
        return "services/aigc/text-generation/generation", {
            "model": model,
            "input": {"messages": [{"role": "user", "content": "请回复：已完成能力测试。"}]},
            "parameters": {"result_format": "message", "max_tokens": 1},
        }
    if binding.capability == "image_generation":
        return "services/aigc/text2image/image-synthesis", {
            "model": model,
            "input": {"prompt": "一颗番茄，白色背景，测试图。"},
            "parameters": {"n": 1, "size": "1024*1024"},
        }
    if binding.capability == "stt":
        return "services/aigc/multimodal-generation/generation", _dashscope_stt_probe_payload(model)
    if binding.capability == "tts":
        return "services/aigc/multimodal-generation/generation", {
            "model": model,
            "input": {
                "text": "能力测试。",
                "voice": "Cherry",
                "language_type": "Chinese",
            },
            "parameters": {"format": "mp3", "sample_rate": 24000},
        }
    if binding.capability == "embedding":
        return "services/embeddings/text-embedding/text-embedding", {
            "model": model,
            "input": {"texts": ["能力测试"]},
            "parameters": {"text_type": "query"},
        }
    if binding.capability == "rerank":
        return "services/rerank/text-rerank/text-rerank", {
            "model": model,
            "input": {"query": "番茄", "documents": ["番茄"]},
            "parameters": {"top_n": 1},
        }
    raise FamilyModelProviderProtocolUnsupported()


def _http_probe_request(binding: ResolvedCapabilityBinding) -> tuple[str, dict[str, object]]:
    """Select a fixed probe that matches the resolved adapter protocol."""

    if binding.adapter_kind == "openai_compatible_http":
        return _openai_http_probe_request(binding)
    if binding.adapter_kind == "dashscope_http":
        return _dashscope_http_probe_request(binding)
    raise FamilyModelProviderProtocolUnsupported()


def _estimate(binding: ResolvedCapabilityBinding) -> UsageEstimate:
    if binding.capability == "llm":
        return estimate_llm(input_tokens=8, cached_input_tokens=0, max_output_tokens=1)
    if binding.capability == "image_generation":
        return estimate_image_generation(image_count=1)
    if binding.capability == "stt":
        return estimate_stt(duration_seconds=Decimal("1"))
    if binding.capability == "tts":
        return estimate_tts(character_count=5)
    if binding.capability == "embedding":
        return estimate_embedding(token_count=4)
    if binding.capability == "rerank":
        return estimate_rerank(input_tokens=4)
    if binding.capability == "realtime_audio":
        return estimate_realtime_audio(
            billable_meters=frozenset({
                # The published realtime billing scheme is fixed by the
                # adapter registry and price validator.
                ModelUsageMeter.AUDIO_INPUT_SECONDS,
                ModelUsageMeter.TTS_CHARACTERS,
            }),
            lease_seconds=Decimal("1"),
            input_tokens_per_second_cap=None,
            output_tokens_per_second_cap=None,
            tts_characters_per_lease_cap=1,
        )
    raise FamilyModelProviderProtocolUnsupported()


def _usage_context(
    command: CapabilityTestCommand,
    *,
    binding: ResolvedCapabilityBinding,
    receipt_id: str,
) -> UsageContext:
    return UsageContext(
        attribution=UsageAttribution(
            family_id=command.family_id,
            attribution_kind=ModelUsageAttributionKind.USER,
            actor_user_id=command.actor_user_id,
            operation_source=ModelUsageOperationSource.INTERACTIVE,
            logical_operation_id=f"family-model-capability-test:{receipt_id}",
        ),
        capability=ModelUsageCapability(binding.capability),
        provider=binding.provider_profile_id,
        requested_model=binding.requested_model,
        billing_model=binding.billing_model,
        variant_key=binding.variant_key,
        operation_kind="family_model_capability_test",
        attempt_key=(
            f"family-model-capability-test:{receipt_id}:{binding.capability}:{binding.variant_key}"
        ),
        client_attempt_id=f"family-model-capability-test:{receipt_id}",
        config_revision_id=binding.config_revision_id,
        provider_profile_id=binding.provider_profile_id,
        provider_profile_version_id=binding.provider_profile_version_id,
    )


def _receipt(
    permit: DispatchPermit,
    *,
    signer: ProviderUsageReceiptSigner,
    outcome: ModelUsageProviderOutcome,
    certainty: ModelUsageExecutionCertainty,
    completed_at: datetime,
) -> ProviderUsageReceipt:
    return signer.sign(
        ProviderUsageReceipt(
            reservation_id=permit.reservation_id,
            family_id=permit.family_id,
            subject_key=permit.subject_key,
            capability=permit.capability,
            provider=permit.provider,
            requested_model=permit.requested_model,
            reported_model=(permit.requested_model if outcome is ModelUsageProviderOutcome.SUCCEEDED else None),
            billing_model=permit.billing_model,
            variant_key=permit.variant_key,
            billing_scheme_key=permit.billing_scheme_key,
            attempt_key=permit.attempt_key,
            fingerprint=permit.fingerprint,
            client_attempt_id=permit.client_attempt_id,
            policy_version_id=permit.policy_version_id,
            dispatch_policy_version_id=permit.dispatch_policy_version_id,
            provider_request_id=None,
            provider_outcome=outcome,
            execution_certainty=certainty,
            measurement_status=ModelUsageMeasurementStatus.ESTIMATED,
            pricing_status=permit.pricing_status,
            period=permit.period,
            meters=permit.required_meters,
            meter_watermarks=(),
            dispatched_at=permit.dispatched_at,
            completed_at=completed_at,
            price_version_id=permit.price_version_id,
            price_snapshot=permit.price_snapshot,
            price_snapshot_checksum=permit.price_snapshot_checksum,
            fail_open_proof_id=permit.fail_open_proof_id,
            integrity_key_id="",
            integrity_hmac="",
            required_meters=permit.required_meters,
            **receipt_identity_from_permit(permit),
        )
    )


def _run_http_probe(
    *,
    binding: ResolvedCapabilityBinding,
    permit: DispatchPermit,
    credential: DispatchCredential,
    transport: ProviderTransport,
) -> ProviderResponse:
    suffix, payload = _http_probe_request(binding)
    return transport.request(
        "POST",
        _binding_url(binding, suffix),
        headers=_headers(binding, credential, permit=permit),
        json=payload,
    )


def _run_realtime_probe(
    *,
    binding: ResolvedCapabilityBinding,
    credential: DispatchCredential,
    transport: ProviderTransport,
) -> None:
    connection = transport.connect_websocket(
        realtime_endpoint_url(binding),
        headers={
            **_headers(binding, credential),
            "OpenAI-Beta": "realtime=v1",
        },
    )
    try:
        send = getattr(connection, "send", None)
        if callable(send):
            send(json.dumps({"type": "session.update", "session": {"modalities": ["text"]}}))
    finally:
        close = getattr(connection, "close", None)
        if callable(close):
            close()


def _safe_result(
    command: CapabilityTestCommand,
    *,
    status: CapabilityTestStatus,
    now: datetime,
) -> CapabilityTestResult:
    detail = {
        "succeeded": "能力测试已完成。",
        "failed": "服务已响应，但未完成本次能力测试。",
        "blocked": "本次测试受家庭用量额度限制，未发起服务调用。",
    }[status]
    return CapabilityTestResult(
        capability=command.capability,
        variant_key=command.variant_key,
        status=status,
        detail=detail,
        checked_at=now,
    )


def _complete_result(
    db: Session,
    *,
    claim,
    result: CapabilityTestResult,
    result_id: str | None,
) -> CapabilityTestResult:
    complete_operation(claim, result_id=result_id, response_json=result.response_record())
    db.commit()
    return result


def run_family_capability_test(
    db: Session,
    command: CapabilityTestCommand,
    *,
    dependencies: CapabilityTestDependencies,
) -> CapabilityTestResult:
    """Run one confirmed billable test without exposing provider identity.

    The idempotency receipt is committed before the use-reservation reaches
    ``dispatching`` and before any external transport call.  Consequently a
    process crash after that point leaves a durable in-progress marker rather
    than allowing a same-key replay to send a second request.
    """

    if not command.confirm_billable:
        raise FamilyModelDraftInvalid("family_model_billable_test_confirmation_required")
    if (
        command.capability not in _ALLOWED_VARIANTS
        or command.variant_key not in _ALLOWED_VARIANTS[command.capability]
    ):
        raise FamilyModelDraftInvalid("family_model_capability_variant_invalid")

    resolver = FamilyModelConfigurationResolver(
        db,
        cipher=dependencies.cipher,
        network_policy=dependencies.network_policy,
    )
    binding = resolver.resolve_active(
        command.family_id,
        command.capability,
        command.variant_key,
    )
    fingerprint_for_key_id = lambda key_id: operation_request_fingerprint(
        dependencies.cipher.keyring,
        key_id=key_id,
        operation="family_model_capability_test",
        public_fields={
            "family_id": command.family_id,
            "capability": command.capability,
            "variant_key": command.variant_key,
            "config_revision_id": binding.config_revision_id,
            "provider_profile_id": binding.provider_profile_id,
            "provider_profile_version_id": binding.provider_profile_version_id,
        },
        secret_fields={},
    )
    claim = claim_operation(
        db,
        family_id=command.family_id,
        operation="family_model_capability_test",
        idempotency_key=command.idempotency_key,
        active_fingerprint_key_id=dependencies.cipher.active_key_id,
        fingerprint_for_key_id=fingerprint_for_key_id,
    )
    if claim.completed:
        return CapabilityTestResult.from_response_record(claim.receipt.response_json)
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()

    # This commit is the no-resend boundary.  Do not move it into the route's
    # normal final commit: remote provider work must never race an uncommitted
    # idempotency claim.
    db.commit()
    now = dependencies.now()
    adapter = MeteredProviderAdapter(
        usage_facade=dependencies.usage_facade,
        session_factory=dependencies.session_factory,
        signer=dependencies.signer,
        clock=dependencies.now,
    )
    try:
        attempt = adapter.start_attempt(
            _usage_context(command, binding=binding, receipt_id=claim.receipt.id),
            _estimate(binding),
            fingerprint=dependencies.signer.request_fingerprint(
                f"{claim.receipt.id}:{binding.capability}:{binding.variant_key}".encode("utf-8")
            ),
            at=now,
        )
    except ModelUsageBlocked:
        result = _safe_result(command, status="blocked", now=now)
        return _complete_result(db, claim=claim, result=result, result_id=None)
    except ModelUsageError as exc:
        raise FamilyModelProviderTransportError("family_model_capability_test_ledger_failed") from exc

    permit = attempt.prepare_dispatch(at=now)
    credential: DispatchCredential | None = None
    try:
        credential = resolver.resolve_dispatch_credential(
            binding,
            permit.credential_secret_version_id,
        )
        runner = CAPABILITY_TEST_RUNNERS[binding.capability]
        if binding.capability == "realtime_audio":
            runner(binding=binding, credential=credential, transport=dependencies.transport)
            response_status = 200
        else:
            response_status = runner(
                binding=binding,
                permit=permit,
                credential=credential,
                transport=dependencies.transport,
            ).status_code
    except (FamilyModelSecretUnavailable, FamilyModelProviderProtocolUnsupported):
        attempt.settle(
            _receipt(
                permit,
                signer=dependencies.signer,
                outcome=ModelUsageProviderOutcome.NOT_BILLED,
                certainty=ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED,
                completed_at=dependencies.now(),
            )
        )
        result = _safe_result(command, status="failed", now=dependencies.now())
        return _complete_result(db, claim=claim, result=result, result_id=None)
    except Exception as exc:
        # Network outcomes after dispatch are ambiguous.  Preserve the
        # reservation as uncertain and keep the operation pending so a replay
        # cannot silently transmit the same billable test twice.
        attempt.mark_uncertain("family_model_capability_test_result_unknown")
        raise FamilyModelProviderTransportError(
            "family_model_capability_test_transport_failed"
        ) from exc
    finally:
        credential = None

    if not 200 <= response_status < 300:
        settlement = attempt.settle(
            _receipt(
                permit,
                signer=dependencies.signer,
                outcome=ModelUsageProviderOutcome.NOT_BILLED,
                certainty=ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED,
                completed_at=dependencies.now(),
            )
        )
        result = _safe_result(command, status="failed", now=dependencies.now())
        return _complete_result(db, claim=claim, result=result, result_id=settlement.event_id)

    settlement = attempt.settle(
        _receipt(
            permit,
            signer=dependencies.signer,
            outcome=ModelUsageProviderOutcome.SUCCEEDED,
            certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
            completed_at=dependencies.now(),
        )
    )
    result = _safe_result(command, status="succeeded", now=dependencies.now())
    return _complete_result(db, claim=claim, result=result, result_id=settlement.event_id)


# A named registry keeps capability additions reviewable.  Its values are the
# dispatch functions selected by ``run_family_capability_test``; callers never
# supply a function name, URL or payload.
CAPABILITY_TEST_RUNNERS: Mapping[FamilyModelCapability, Callable[..., object]] = {
    "llm": _run_http_probe,
    "image_generation": _run_http_probe,
    "stt": _run_http_probe,
    "tts": _run_http_probe,
    "realtime_audio": _run_realtime_probe,
    "embedding": _run_http_probe,
    "rerank": _run_http_probe,
}

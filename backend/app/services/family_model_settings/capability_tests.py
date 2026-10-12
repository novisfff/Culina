"""Billable, Owner-initiated probes for family model capabilities.

The probes are intentionally a closed registry.  They are not arbitrary
provider requests: a family-owned immutable binding snapshot supplies every
endpoint, model, credential scope and pricing identity, while the registry
supplies only a small, fixed protocol payload for each capability.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from decimal import Decimal
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.enums import (
    FamilyModelConfigRevisionStatus,
    FamilyModelPricePurpose,
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageOperationSource,
    ModelUsageProviderOutcome,
)
from app.core.utils import create_id, utcnow
from app.db.session import SessionLocal
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelConfigRevision,
)
from app.models.model_usage import ModelUsagePriceVersion
from app.repos.family_model_settings.configurations import (
    get_config_draft,
    get_config_revision,
    require_draft_version,
)
from app.repos.family_model_settings.idempotency import claim_operation, complete_operation
from app.repos.family_model_settings.profiles import (
    get_family_model_settings,
    lock_family_model_settings,
)
from app.repos.model_usage.catalog import next_price_version_number
from app.services.ai_audio.config import realtime_endpoint_url
from app.services.ai_audio import cosyvoice, dashscope_realtime
from app.services.ai_audio.dashscope_protocols import audio_binding_issue, is_cosyvoice_model, tts_output_format
from app.services.family_model_settings.probe_contracts import (audio_preview, image_probe, llm_probe, probe_response_detail, silence_wav, speech_probe_matches)
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    operation_request_fingerprint,
)
from app.services.family_model_settings.drafts import _safe_payload_from_raw
from app.services.family_model_settings.errors import (
    FamilyModelDraftInvalid,
    FamilyModelOperationInProgress,
    FamilyModelProviderProtocolUnsupported,
    FamilyModelProviderTransportError,
    FamilyModelSecretUnavailable,
)
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.publishing import insert_family_price_rates
from app.services.family_model_settings.resolver import FamilyModelConfigurationResolver
from app.services.family_model_settings.transport import ProviderResponse, ProviderTransport
from app.services.family_model_settings.multipart import provider_multipart_form
from app.services.family_model_settings.types import (
    DispatchCredential,
    FamilyModelCapability,
    ResolvedCapabilityBinding,
)
from app.schemas.family_model_settings import FamilyModelConfigDraftPayload
from app.services.family_model_settings.validation import (
    ValidatedCapabilityBinding,
    ValidatedFamilyPriceRate,
    price_checksum,
    validate_family_model_capability,
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
    base_draft_version_number: int | None = None
    provider_profile_id: str | None = None
    requested_model: str | None = None
    dimensions: int | None = None


@dataclass(frozen=True, slots=True)
class CapabilityTestResult:
    capability: FamilyModelCapability
    variant_key: str
    status: CapabilityTestStatus
    detail: str
    checked_at: datetime
    # Ephemeral sample: excluded from the durable idempotency record. Replays do not resend.
    audio_preview_data_url: str | None = None

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
        return llm_probe(binding)
    if binding.capability == "image_generation":
        return image_probe(binding)
    if binding.capability == "stt":
        fields = {"model": binding.requested_model}
        language = binding.options.get("language_hint")
        if language and language != "auto":
            fields["language"] = str(language)
        return "audio/transcriptions", fields
    if binding.capability == "tts":
        return "audio/speech", {
            "model": binding.requested_model,
            "voice": binding.options.get("voice") or "alloy",
            "response_format": binding.options.get("output_format") or "mp3",
            "input": "能力测试。",
        }
    if binding.capability == "embedding":
        return "embeddings", {"model": binding.requested_model, "input": ["能力测试"], "dimensions": binding.options["dimensions"]}
    if binding.capability == "rerank":
        return "rerank", {
            "model": binding.requested_model,
            "query": "番茄",
            "documents": ["番茄"],
            "top_n": 1,
        }
    raise FamilyModelProviderProtocolUnsupported()


def _dashscope_probe_request(binding: ResolvedCapabilityBinding) -> tuple[str, dict[str, object]]:
    """Return a native DashScope probe instead of assuming OpenAI wire paths."""

    model = binding.requested_model
    if binding.capability == "llm":
        return llm_probe(binding)
    if binding.capability == "image_generation":
        return image_probe(binding)
    if binding.capability == "stt":
        from app.services.ai_audio.dashscope_audio import _dashscope_stt_payload
        payload = _dashscope_stt_payload(model=model, audio_data_url="data:audio/wav;base64," + base64.b64encode(silence_wav()).decode(), content_type="audio/wav", sample_rate=16000)
        if binding.options.get("language_hint") and binding.options["language_hint"] != "auto":
            payload["parameters"]["language"] = binding.options["language_hint"]
        if binding.options.get("hotwords"):
            payload["parameters"]["hotwords"] = list(binding.options["hotwords"])
        return "services/aigc/multimodal-generation/generation", payload
    if binding.capability == "tts":
        if is_cosyvoice_model(model):
            # CosyVoice is selected by the runner before HTTP construction.
            raise FamilyModelProviderProtocolUnsupported()
        return "services/aigc/multimodal-generation/generation", {
            "model": model,
            "input": {
                "text": "能力测试。",
                "voice": binding.options.get("voice") or "Cherry",
                "language_type": "Chinese",
            },
            "parameters": {"format": tts_output_format(model, binding.options.get("output_format")), "sample_rate": 24000},
        }
    if binding.capability == "embedding":
        return "services/embeddings/text-embedding/text-embedding", {
            "model": model,
            "input": {"texts": ["能力测试"]},
            "parameters": {"text_type": "query", "dimension": binding.options["dimensions"]},
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
    if binding.adapter_kind == "dashscope":
        return _dashscope_probe_request(binding)
    raise FamilyModelProviderProtocolUnsupported()


def _estimate(binding: ResolvedCapabilityBinding) -> UsageEstimate:
    if binding.capability == "llm":
        return estimate_llm(input_tokens=1024 if binding.options.get("supports_vision") else 256, cached_input_tokens=0, max_output_tokens=int(binding.options.get("max_output_tokens", 256)))
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
    if binding.adapter_kind == 'dashscope' and binding.capability == 'tts' and is_cosyvoice_model(binding.requested_model):
        return cosyvoice.synthesize(
            binding, transport=transport, headers=_headers(binding, credential, permit=permit),
            text='能力测试。', voice=binding.options.get('voice'),
            output_format=binding.options.get('output_format') or 'mp3',
            timeout_seconds=20, max_audio_bytes=512 * 1024,
        )
    suffix, payload = _http_probe_request(binding)
    headers = _headers(binding, credential, permit=permit)
    url = _binding_url(binding, suffix)
    if binding.adapter_kind == "dashscope" and binding.capability == "llm":
        url = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    if binding.capability == "stt" and binding.adapter_kind == "openai_compatible_http":
        from app.services.ai_audio.openai_audio import _multipart_form
        body, content_type = _multipart_form(payload, filename="capability-test-silence.wav", payload=silence_wav(), media_type="audio/wav")
        headers["Content-Type"] = content_type
        return transport.request("POST", url, headers=headers, body=body)
    if (binding.capability == "image_generation" and binding.variant_key == "reference"
            and binding.adapter_kind == "openai_compatible_http"):
        from app.services.family_model_settings.probe_contracts import REFERENCE_IMAGE
        body, content_type = provider_multipart_form(
            {key: str(value) for key, value in payload.items()},
            filename="capability-reference.png", payload=base64.b64decode(REFERENCE_IMAGE.split(",", 1)[1]),
            media_type="image/png", file_field="image[]",
        )
        headers["Content-Type"] = content_type
        return transport.request("POST", url, headers=headers, body=body)
    return transport.request("POST", url, headers=headers, json=payload)


def _run_realtime_probe(
    *,
    binding: ResolvedCapabilityBinding,
    credential: DispatchCredential,
    transport: ProviderTransport,
) -> None:
    from time import monotonic
    from app.services.ai_audio import openai_realtime
    from app.services.ai_audio.dashscope_audio import (
        _audio_append_event, _audio_commit_event, _event_audio,
    )

    is_openai = binding.adapter_kind == "openai_realtime"
    if not is_openai and binding.adapter_kind != "dashscope":
        raise FamilyModelProviderProtocolUnsupported()
    if not is_openai:
        issue = audio_binding_issue(binding.capability, binding.requested_model, binding.options)
        if issue:
            raise FamilyModelProviderProtocolUnsupported(issue)
    # Match the runtime's separate ASR/TTS connections, including actual
    # audio exchange. A session.updated acknowledgement alone is insufficient.
    for transcription in (True, False):
        connection = transport.connect_websocket(realtime_endpoint_url(binding), headers=_headers(binding, credential))
        try:
            deadline = monotonic() + 20

            def send(event: dict[str, object]) -> None:
                connection.send(json.dumps(event))

            def receive() -> dict[str, object]:
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise ValueError("realtime_probe_timeout")
                raw = connection.recv(timeout=remaining)
                if isinstance(raw, bytes) and not is_openai:
                    return {"type": "response.audio.delta", "_audio": raw}
                event = json.loads(raw)
                if not isinstance(event, dict) or event.get("type") in {"error", "conversation.item.input_audio_transcription.failed"}:
                    raise ValueError("realtime_probe_rejected")
                return event

            voice = binding.options.get("voice")
            language = binding.options.get("language_hint")
            if is_openai:
                session = openai_realtime.session_update_event(model=binding.requested_model, voice=voice,
                    transcription=transcription, language=language)
            else:
                session = dashscope_realtime.session_update_event(voice=voice, transcription=transcription, language=language)
            send(session)
            for _ in range(32):
                if receive().get("type") == "session.updated":
                    break
            else:
                raise ValueError("realtime_session_not_confirmed")

            if transcription:
                send(_audio_append_event(b"\x00\x00" * (24000 if is_openai else 16000)))
                send(_audio_commit_event())
                for _ in range(128):
                    event = receive()
                    if event.get("type") == "conversation.item.input_audio_transcription.completed":
                        if not isinstance(event.get("transcript"), str):
                            raise ValueError("realtime_transcription_invalid")
                        break
                else:
                    raise ValueError("realtime_transcription_not_confirmed")
            else:
                speech_text = '能力测试。'
                if is_openai:
                    event = openai_realtime.speech_event("测")
                    event["response"]["max_output_tokens"] = 128
                    send(event)
                else:
                    for event in dashscope_realtime.speech_events(speech_text):
                        send(event)
                audio_size = 0
                transcript = None
                for _ in range(128):
                    event = receive()
                    if not is_openai and event.get('type') == 'response.audio_transcript.done':
                        transcript = event.get('transcript')
                    audio = openai_realtime.audio_delta(event) if is_openai else _event_audio(event)
                    if audio is not None:
                        if not audio or len(audio) % 2:
                            raise ValueError("realtime_audio_invalid")
                        audio_size += len(audio)
                        if audio_size > 512 * 1024:
                            raise ValueError("realtime_probe_audio_too_large")
                    finished = openai_realtime.response_done(event) if is_openai else dashscope_realtime.response_done(event)
                    if finished:
                        if not audio_size:
                            raise ValueError("realtime_audio_missing")
                        if not is_openai and not speech_probe_matches(speech_text, transcript):
                            raise ValueError('realtime_speech_text_mismatch')
                        break
                else:
                    raise ValueError("realtime_audio_not_confirmed")
        finally:
            connection.close()


def _safe_result(
    command: CapabilityTestCommand,
    *,
    status: CapabilityTestStatus,
    now: datetime,
    detail: str | None = None,
) -> CapabilityTestResult:
    default_detail = {
        "succeeded": "能力测试已完成。",
        "failed": "服务已响应，但未完成本次能力测试。",
        "blocked": "本次测试受家庭用量额度限制，未发起服务调用。",
    }[status]
    return CapabilityTestResult(
        capability=command.capability,
        variant_key=command.variant_key,
        status=status,
        detail=detail or default_detail,
        checked_at=now,
    )


_SAFE_DIAGNOSTIC_CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$")
_DIAGNOSTIC_SECRET_RE = re.compile(
    r"(?i)(?:bearer\s+|api[_ -]?key\s*[:=]\s*|token\s*[:=]\s*|secret\s*[:=]\s*|password\s*[:=]\s*)[^\s,;]+"
)
_DIAGNOSTIC_URL_RE = re.compile(r"https?://[^\s,;]+", re.IGNORECASE)
_DIAGNOSTIC_REQUEST_RE = re.compile(
    r'(?i)(?:"?(?:input|prompt|messages|text)"?\s*[:=])'
    r'(?:\[[^\]]*\]|\{[^}]*\}|"[^"]*"|[^,;]+)'
)
_DIAGNOSTIC_SECRET_VALUE_RE = re.compile(r"(?i)^(?:sk|rk|pk|api)[-_][A-Za-z0-9_-]{8,}$")


def _safe_diagnostic_code(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not _SAFE_DIAGNOSTIC_CODE_RE.fullmatch(value):
        return None
    return None if _DIAGNOSTIC_SECRET_VALUE_RE.fullmatch(value) else value


def _safe_diagnostic_text(
    value: object,
    *,
    max_length: int = 240,
    sensitive_values: Sequence[str] = (),
) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.replace("\r", " ").replace("\n", " ").split())
    text = _DIAGNOSTIC_SECRET_RE.sub("[redacted]", text)
    text = _DIAGNOSTIC_URL_RE.sub("[provider-url]", text)
    text = _DIAGNOSTIC_REQUEST_RE.sub("request=[redacted]", text)
    for sensitive in sensitive_values:
        if sensitive:
            text = text.replace(sensitive, "[request-content]")
    return text[:max_length] or None


def _provider_failure_detail(response: ProviderResponse) -> str:
    """Project an allow-listed, bounded provider error into the Owner UI."""

    detail = f"模型服务拒绝了请求（HTTP {response.status_code}）"
    try:
        body = response.json()
    except Exception:
        body = None
    candidates: list[Mapping[str, object]] = []
    if isinstance(body, Mapping):
        candidates.append(body)
        nested = body.get("error")
        if isinstance(nested, Mapping):
            candidates.insert(0, nested)
    code: str | None = None
    message: str | None = None
    for candidate in candidates:
        if code is None:
            for key in ("code", "type", "error_code"):
                code = _safe_diagnostic_code(candidate.get(key))
                if code:
                    break
        if message is None:
            for key in ("message", "detail", "error_message"):
                message = _safe_diagnostic_text(candidate.get(key))
                if message:
                    break
        if code and message:
            break
    if code:
        detail += f"：{code}"
    if message:
        detail += f"，{message}"
    return _safe_diagnostic_text(detail) or "模型服务拒绝了请求，请检查模型配置。"


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


def _draft_test_snapshot_checksum(
    binding: ValidatedCapabilityBinding,
    rates: tuple[ValidatedFamilyPriceRate, ...],
) -> str:
    payload = {
        "purpose": "family-model-draft-capability-test-v1",
        "binding": binding.checksum_record(),
        "rates": [
            rate.checksum_record()
            for rate in sorted(rates, key=lambda item: item.meter.value)
        ],
    }
    return hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def _next_test_revision_number(db: Session, *, family_id: str) -> int:
    current = db.scalar(
        select(func.max(FamilyModelConfigRevision.version_number)).where(
            FamilyModelConfigRevision.family_id == family_id
        )
    )
    return int(current or 0) + 1


def _active_llm_primary_is_enabled(
    db: Session,
    *,
    family_id: str,
    config_revision_id: str | None,
) -> bool:
    if config_revision_id is None:
        return False
    row = db.scalar(
        select(FamilyModelCapabilityBinding).where(
            FamilyModelCapabilityBinding.family_id == family_id,
            FamilyModelCapabilityBinding.config_revision_id == config_revision_id,
            FamilyModelCapabilityBinding.capability == ModelUsageCapability.LLM,
            FamilyModelCapabilityBinding.variant_key == "primary",
            FamilyModelCapabilityBinding.enabled.is_(True),
        )
    )
    return row is not None


def _draft_llm_fallback_has_primary(
    db: Session,
    *,
    family_id: str,
    settings,
    payload: FamilyModelConfigDraftPayload,
    network_policy: ProviderNetworkPolicy,
) -> bool:
    """Resolve the fallback dependency without letting a bad edit erase a live primary."""

    active_primary = _active_llm_primary_is_enabled(
        db,
        family_id=family_id,
        config_revision_id=settings.active_config_revision_id,
    )
    incoming_primary = next(
        (
            binding
            for binding in payload.bindings
            if binding.capability == "llm" and binding.variant_key == "primary"
        ),
        None,
    )
    if incoming_primary is None:
        return active_primary
    if not incoming_primary.enabled:
        return False
    primary_rates = [
        rate
        for rate in payload.price_rates
        if rate.capability == "llm" and rate.variant_key == "primary"
    ]
    primary_validation = validate_family_model_capability(
        db,
        family_id=family_id,
        settings=settings,
        payload=payload.model_copy(
            update={
                "bindings": [incoming_primary],
                "price_rates": primary_rates,
            }
        ),
        capability="llm",
        network_policy=network_policy,
        validate_fallback_graph=False,
    )
    return primary_validation.valid or active_primary


def _materialize_draft_test_binding(
    db: Session,
    command: CapabilityTestCommand,
    *,
    dependencies: CapabilityTestDependencies,
) -> ResolvedCapabilityBinding:
    assert command.base_draft_version_number is not None
    # A capability probe is scoped to one binding.  The old implementation
    # ran the complete-draft validator here, so an unrelated broken Embedding
    # (or price row) prevented an otherwise valid LLM/image/audio probe.  Read
    # the draft under the normal settings -> draft lock order, then validate
    # only the requested capability/variant without mutating global draft
    # validation state.
    settings = lock_family_model_settings(db, family_id=command.family_id)
    draft = get_config_draft(db, family_id=command.family_id, for_update=True)
    if draft is None:
        raise FamilyModelDraftInvalid("family_model_capability_test_binding_incomplete")
    require_draft_version(draft, command.base_draft_version_number)
    payload, _payload_issues = _safe_payload_from_raw(draft.payload_json)

    target_binding = next(
        (
            binding
            for binding in payload.bindings
            if binding.capability == command.capability
            and binding.variant_key == command.variant_key
        ),
        None,
    )
    if target_binding is not None:
        override: dict[str, object] = {}
        if command.provider_profile_id is not None:
            override["provider_profile_id"] = command.provider_profile_id
        if command.requested_model is not None:
            override["requested_model"] = command.requested_model
        if command.dimensions is not None and command.capability == "embedding":
            override["dimensions"] = command.dimensions
        if override:
            # Replacement probes intentionally test the candidate even when
            # the persisted draft still has the active binding locked or
            # disabled while the rebuild form is open.
            override["enabled"] = True
        if override:
            target_binding = target_binding.model_copy(update=override)
    if (
        command.capability == "llm"
        and command.variant_key == "fallback"
        and target_binding is not None
        and target_binding.enabled
        and not _draft_llm_fallback_has_primary(
            db,
            family_id=command.family_id,
            settings=settings,
            payload=payload,
            network_policy=dependencies.network_policy,
        )
    ):
        raise FamilyModelDraftInvalid("family_model_llm_fallback_requires_primary")

    target_bindings = (target_binding,) if target_binding is not None else ()
    target_rates = tuple(
        rate
        for rate in payload.price_rates
        if rate.capability == command.capability
        and rate.variant_key == command.variant_key
    )
    scoped_payload = payload.model_copy(
        update={
            "bindings": list(target_bindings),
            "price_rates": list(target_rates),
        }
    )
    validation = validate_family_model_capability(
        db,
        family_id=command.family_id,
        settings=settings,
        payload=scoped_payload,
        capability=command.capability,
        network_policy=dependencies.network_policy,
        draft_version_number=command.base_draft_version_number,
        validate_fallback_graph=False,
        enforce_search_identity=not any(
            value is not None
            for value in (
                command.provider_profile_id,
                command.requested_model,
                command.dimensions,
            )
        ),
    )
    if validation.errors:
        # Do not expose provider details; the first stable domain code is
        # enough for the Owner to repair this one card.
        raise FamilyModelDraftInvalid(validation.errors[0].code)
    binding = next(
        (
            item
            for item in validation.bindings
            if item.capability.value == command.capability
            and item.variant_key == command.variant_key
            and item.enabled
            and item.provider_profile_id is not None
            and item.provider_profile_version_id is not None
            and item.requested_model
        ),
        None,
    )
    if binding is None:
        raise FamilyModelDraftInvalid(
            "family_model_capability_test_binding_incomplete"
        )

    rates = tuple(
        rate
        for rate in validation.price_rates
        if rate.capability is binding.capability
        and rate.variant_key == binding.variant_key
    )
    snapshot_checksum = _draft_test_snapshot_checksum(binding, rates)
    revision = db.scalar(
        select(FamilyModelConfigRevision).where(
            FamilyModelConfigRevision.family_id == command.family_id,
            FamilyModelConfigRevision.config_checksum == snapshot_checksum,
        )
    )
    if revision is None:
        # The draft may carry a legacy/stale base revision pointer.  Test
        # snapshots are disposable and must never copy that foreign ID into a
        # restrictive self-FK; prefer a verified family-owned active revision
        # and otherwise leave the parent unset.
        base_revision_id = validation.payload.base_config_revision_id
        if isinstance(base_revision_id, str):
            verified_base = get_config_revision(
                db,
                family_id=command.family_id,
                config_revision_id=base_revision_id,
            )
            base_revision_id = verified_base.id if verified_base is not None else None
        else:
            base_revision_id = None
        revision = FamilyModelConfigRevision(
            id=create_id("family-model-test-revision"),
            family_id=command.family_id,
            version_number=_next_test_revision_number(
                db, family_id=command.family_id
            ),
            base_revision_id=base_revision_id,
            config_checksum=snapshot_checksum,
            status=FamilyModelConfigRevisionStatus.SUPERSEDED,
            search_profile_id=None,
            change_note="能力测试配置快照",
            published_by=command.actor_user_id,
        )
        db.add(revision)
        db.flush()
        db.add(
            FamilyModelCapabilityBinding(
                id=create_id("family-model-test-binding"),
                family_id=command.family_id,
                config_revision_id=revision.id,
                capability=binding.capability,
                variant_key=binding.variant_key,
                enabled=True,
                provider_profile_id=binding.provider_profile_id,
                provider_profile_version_id=binding.provider_profile_version_id,
                requested_model=binding.requested_model,
                options_json=dict(binding.options),
                billing_scheme_key=binding.billing_scheme_key,
                identity_checksum=binding.identity_checksum,
            )
        )
        db.flush()

        supplied_meters = {rate.meter for rate in rates}
        if (
            supplied_meters == binding.billable_meters
            and len(rates) == len(binding.billable_meters)
        ):
            rate_checksum = price_checksum(rates)
            now = dependencies.now()
            price = ModelUsagePriceVersion(
                id=create_id("family-model-test-price"),
                family_id=command.family_id,
                config_revision_id=revision.id,
                base_price_version_id=None,
                purpose=FamilyModelPricePurpose.ACTIVE,
                published_by=command.actor_user_id,
                version_number=next_price_version_number(db),
                status="published",
                effective_from=now,
                reviewed_at=now,
                source_ref="family-model-draft-capability-test",
                change_note="能力测试价格快照",
                operator=command.actor_user_id,
                change_ticket=None,
                manifest_checksum=rate_checksum,
                model_aliases_json={
                    f"{rate.provider}:{alias}": rate.billing_model
                    for rate in rates
                    for alias in rate.reported_model_aliases
                },
                fx_rates_json={
                    "CNY": "1",
                    **{
                        rate.source_currency: str(rate.fx_to_cny)
                        for rate in rates
                    },
                },
            )
            db.add(price)
            db.flush()
            insert_family_price_rates(
                db,
                price_version=price,
                rates=rates,
            )

    resolver = FamilyModelConfigurationResolver(
        db,
        cipher=dependencies.cipher,
        network_policy=dependencies.network_policy,
    )
    return resolver.resolve_revision(
        command.family_id,
        revision.id,
        command.capability,
        command.variant_key,
    )


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

    if command.base_draft_version_number is None and (
        command.capability == "llm" and command.variant_key == "fallback"
    ):
        # Check the dependency before resolving the fallback itself.  Without
        # a primary, resolver.resolve_active() would return the generic
        # "capability disabled" error and the Owner would never learn the
        # actionable fallback-specific reason.
        settings = get_family_model_settings(db, family_id=command.family_id)
        if settings is None or not _active_llm_primary_is_enabled(
            db,
            family_id=command.family_id,
            config_revision_id=(settings.active_config_revision_id if settings else None),
        ):
            raise FamilyModelDraftInvalid("family_model_llm_fallback_requires_primary")

    resolver = FamilyModelConfigurationResolver(
        db,
        cipher=dependencies.cipher,
        network_policy=dependencies.network_policy,
    )
    binding = (
        resolver.resolve_active(
            command.family_id,
            command.capability,
            command.variant_key,
        )
        if command.base_draft_version_number is None
        else _materialize_draft_test_binding(
            db,
            command,
            dependencies=dependencies,
        )
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
    provider_response: ProviderResponse | None = None
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
            provider_response = runner(
                binding=binding,
                permit=permit,
                credential=credential,
                transport=dependencies.transport,
            )
            response_status = provider_response.status_code
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

    if not 200 <= response_status < 300 and response_status not in {400, 401, 403, 404, 405, 406, 413, 415, 422, 429}:
        attempt.mark_uncertain("family_model_capability_test_result_unknown")
        raise FamilyModelProviderTransportError("family_model_capability_test_transport_failed")

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
        result = _safe_result(
            command,
            status="failed",
            now=dependencies.now(),
            detail=_provider_failure_detail(provider_response)
            if provider_response is not None
            else None,
        )
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
    # A 2xx request may have been billed even when its content is unusable.
    # Keep the settled event, but never label that capability test successful.
    try:
        preview = None
        if binding.capability == "tts" and provider_response is not None:
            preview = audio_preview(binding, provider_response, dependencies.transport)
        detail = ("已收到当前音色的音频数据。" if preview else
                  probe_response_detail(binding, provider_response, dependencies.transport) if provider_response is not None
                  else "音频上传、转写响应与音频合成协议通过；静音样本不验证识别准确率。")
        result = replace(_safe_result(command, status="succeeded", now=dependencies.now(), detail=detail), audio_preview_data_url=preview)
    except Exception:
        result = _safe_result(command, status="failed", now=dependencies.now(),
                              detail="服务已响应，但返回内容与功能配置不符。请检查模型能力、协议或向量维度；本次请求可能已计费。")
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

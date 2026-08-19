from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageLimitKind,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageQuantitySource,
)
from app.models.model_usage import ModelUsageEvent
from app.services.ai_audio.config import resolved_audio_provider_config
from app.services.ai_audio.openai_audio import OpenAIAudioProvider
from app.services.ai_audio.providers import AudioProviderDependencies
from app.services.ai_audio.schemas import SpeechRequest, TranscriptionRequest
from app.services.family_model_settings.transport import ProviderResponse
from app.services.family_model_settings.types import (
    DispatchCredential,
    ResolvedCapabilityBinding,
    ResolvedProviderEndpoint,
)
from app.services.model_usage.adapters.audio import AudioUsageAdapter
from app.services.model_usage.errors import ModelUsageBlocked, ModelUsageContractError
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.policies import CapabilityLimitCommand
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from tests.model_usage.test_price_manifest import configured_test_variants
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_reservations import NOW, set_policy


pytest_plugins = ("tests.model_usage.test_reservations",)


@pytest.fixture()
def receipt_signer() -> ProviderUsageReceiptSigner:
    return ProviderUsageReceiptSigner(
        active_key_id="audio-test-key",
        keys={"audio-test-key": b"audio-test-secret"},
    )


def _adapter(
    model_usage_db: Session,
    receipt_signer: ProviderUsageReceiptSigner,
    *,
    capability: ModelUsageCapability,
    model: str,
    variant_key: str,
    provider: str = "openai",
) -> AudioUsageAdapter:
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)
    return AudioUsageAdapter(
        provider=provider,
        model=model,
        capability=capability,
        variant_key=variant_key,
        usage_facade=ModelUsageFacade(session_factory=factory, clock=lambda: NOW),
        session_factory=factory,
        signer=receipt_signer,
        clock=lambda: NOW,
    )


def _binding(
    *,
    family_id: str,
    capability: str,
    model: str,
    provider_profile_id: str,
    variant_key: str,
    adapter_kind: str = "openai_compatible_http",
) -> ResolvedCapabilityBinding:
    endpoint = ResolvedProviderEndpoint(
        normalized_url="https://audio.example/v1",
        scheme="https",
        host="audio.example",
        port=443,
        base_path="/v1",
        resolved_addresses=("93.184.216.34",),
        private_target=False,
    )
    return ResolvedCapabilityBinding(
        family_id=family_id,
        config_revision_id=f"revision-{family_id}",
        provider_profile_id=provider_profile_id,
        provider_profile_version_id=f"profile-version-{provider_profile_id}",
        adapter_kind=adapter_kind,  # type: ignore[arg-type]
        auth_mode="api_key",
        endpoint=endpoint,
        websocket_endpoint=None,
        requested_model=model,
        billing_model=model,
        capability=capability,  # type: ignore[arg-type]
        variant_key=variant_key,
        billing_scheme_key=(
            "stt-seconds-v1" if capability == "stt" else "tts-characters-v1"
        ),
        options={},
    )


def _transcription_request(reservation_context) -> TranscriptionRequest:
    return TranscriptionRequest(
        audio_bytes=b"server-measured-audio",
        filename="voice.webm",
        content_type="audio/webm",
        surface="main_ai",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        operation_id="stt-operation-1",
    )


def _speech_request(reservation_context, *, text: str = "做好啦！") -> SpeechRequest:
    return SpeechRequest(
        text=text,
        surface="recipe_cook_page",
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "user-test",
        operation_id="tts-operation-1",
    )


def test_stt_uses_server_measured_seconds_and_content_free_receipt(
    model_usage_db: Session,
    receipt_signer: ProviderUsageReceiptSigner,
    reservation_context,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _adapter(
        model_usage_db,
        receipt_signer,
        capability=ModelUsageCapability.STT,
        model="stt-test",
        variant_key="format=webm",
    )
    request = _transcription_request(reservation_context)

    attempt = adapter.begin_stt(
        request,
        duration_seconds=Decimal("2.500000"),
        fingerprint="hmac:stt-request",
    )

    assert attempt.estimate.quantity(ModelUsageMeter.AUDIO_INPUT_SECONDS) == Decimal("2.500000")
    permit = attempt.prepare_dispatch()
    receipt = adapter.stt_receipt(
        permit,
        duration_seconds=Decimal("2.500000"),
        reported_model="stt-test-2026-07-01",
        provider_request_id="stt-provider-request",
        completed_at=NOW + timedelta(seconds=1),
    )

    assert receipt.measurement_status is ModelUsageMeasurementStatus.EXACT
    assert receipt.meters[0].quantity_source is ModelUsageQuantitySource.SERVER_MEASURED
    assert "server-measured-audio" not in repr(receipt)

    settlement = attempt.settle(receipt)
    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    assert event is not None
    assert event.capability is ModelUsageCapability.STT
    assert event.reported_model == "stt-test-2026-07-01"


def test_tts_counts_only_sanitized_text(
    model_usage_db: Session,
    receipt_signer: ProviderUsageReceiptSigner,
    reservation_context,
) -> None:
    adapter = _adapter(
        model_usage_db,
        receipt_signer,
        capability=ModelUsageCapability.TTS,
        model="tts-test",
        variant_key="voice=default",
    )
    request = _speech_request(reservation_context)

    attempt = adapter.begin_tts(
        request,
        sanitized_text="做好啦！",
        fingerprint="hmac:tts-request",
    )

    assert attempt.estimate.quantity(ModelUsageMeter.TTS_CHARACTERS) == Decimal("4")


def test_dashscope_tts_uses_provider_billable_character_rules(
    model_usage_db: Session,
    receipt_signer: ProviderUsageReceiptSigner,
    reservation_context,
) -> None:
    binding = _binding(
        family_id=reservation_context.attribution.family_id,
        capability="tts",
        model="qwen3-tts-flash",
        provider_profile_id="dashscope",
        variant_key="voice=default",
        adapter_kind="dashscope_http",
    )
    adapter = AudioUsageAdapter(
        capability=ModelUsageCapability.TTS,
        binding=binding,
        usage_facade=ModelUsageFacade(
            session_factory=sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False),
            clock=lambda: NOW,
        ),
        session_factory=sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False),
        signer=receipt_signer,
        clock=lambda: NOW,
    )

    assert adapter._tts_character_count("你好 A。") == 7  # noqa: SLF001 - binding contract


def test_tts_empty_sanitized_text_creates_no_reservation(
    model_usage_db: Session,
    receipt_signer: ProviderUsageReceiptSigner,
    reservation_context,
) -> None:
    adapter = _adapter(
        model_usage_db,
        receipt_signer,
        capability=ModelUsageCapability.TTS,
        model="tts-test",
        variant_key="voice=default",
    )

    with pytest.raises(ModelUsageContractError, match="audio_tts_text_empty"):
        adapter.begin_tts(
            _speech_request(reservation_context, text=""),
            sanitized_text="",
            fingerprint="hmac:tts-empty",
        )

    assert model_usage_db.query(ModelUsageEvent).count() == 0


def test_tts_budget_block_happens_before_dispatch(
    model_usage_db: Session,
    receipt_signer: ProviderUsageReceiptSigner,
    reservation_context,
) -> None:
    publish(model_usage_db, raw_manifest())
    set_policy(
        model_usage_db,
        reservation_context,
        budget=Decimal("100"),
        hard=True,
        limits=(
            CapabilityLimitCommand(
                capability=ModelUsageCapability.TTS,
                limit_kind=ModelUsageLimitKind.METER,
                meter=ModelUsageMeter.TTS_CHARACTERS,
                limit_value=Decimal("1"),
            ),
        ),
        active_variants=(configured_test_variants()[4],),
    )
    adapter = _adapter(
        model_usage_db,
        receipt_signer,
        capability=ModelUsageCapability.TTS,
        model="tts-test",
        variant_key="voice=default",
    )

    with pytest.raises(ModelUsageBlocked, match="model_usage_capability_limit_exceeded"):
        adapter.begin_tts(
            _speech_request(reservation_context),
            sanitized_text="做好啦！",
            fingerprint="hmac:tts-blocked",
        )


def test_stt_settles_before_response_parsing_and_explicit_retry_uses_new_attempt_key(
    reservation_context,
) -> None:
    calls: list[tuple[str, str]] = []
    timeline: list[str] = []

    class Transport:
        def request(
            self,
            method: str,
            url: str,
            *,
            headers: dict[str, str],
            json: object | None = None,
            body: bytes | None = None,
        ) -> ProviderResponse:
            del headers, json, body
            calls.append((method, url))
            if len(calls) == 1:
                return ProviderResponse(
                    200,
                    {"content-type": "application/json", "x-request-id": "stt-1"},
                    b"not-json",
                )
            return ProviderResponse(
                200,
                {"content-type": "application/json", "x-request-id": "stt-2"},
                b'{"text":"\xe4\xb8\x8b\xe4\xb8\x80\xe6\xad\xa5","language":"zh"}',
            )

    binding = _binding(
        family_id=reservation_context.attribution.family_id,
        capability="stt",
        model="stt-test",
        provider_profile_id="openai",
        variant_key="format=webm",
    )

    def resolve_credential(
        resolved: ResolvedCapabilityBinding,
        secret_id: str | None,
    ) -> DispatchCredential:
        assert resolved == binding
        assert secret_id is not None
        return DispatchCredential(
            family_id=binding.family_id,
            provider_profile_id=binding.provider_profile_id,
            secret_version_id=secret_id,
            api_key="test-key",
        )

    class Attempt:
        def prepare_dispatch(self):
            timeline.append("dispatch")
            return type(
                "Permit",
                (),
                {
                    "credential_secret_version_id": "secret-a",
                    "provider_idempotency_key": "attempt-a",
                },
            )()

        def settle(self, receipt: object) -> None:
            assert receipt == "receipt"
            timeline.append("settle")

        def mark_uncertain(self, code: str) -> None:
            timeline.append(f"uncertain:{code}")

    class Adapter:
        def __init__(self, resolved_binding: ResolvedCapabilityBinding) -> None:
            self.binding = resolved_binding

        def request_fingerprint(self, _payload: object) -> str:
            return "fingerprint"

        def begin_stt(self, request: TranscriptionRequest, **kwargs: object) -> Attempt:
            assert kwargs["binding"] == binding
            timeline.append(f"begin:{request.operation_id}")
            return Attempt()

        def stt_receipt(self, *_args: object, **_kwargs: object) -> str:
            timeline.append("receipt")
            return "receipt"

        def confirmed_not_executed_receipt(self, *_args: object, **_kwargs: object) -> str:
            return "receipt"

    provider = OpenAIAudioProvider(
        resolved_audio_provider_config(binding),
        dependencies=AudioProviderDependencies(
            transport=Transport(),  # type: ignore[arg-type]
            resolve_dispatch_credential=resolve_credential,
        ),
        usage_adapter=Adapter(binding),  # type: ignore[arg-type]
    )
    request = replace(
        _transcription_request(reservation_context),
        measured_duration_seconds=Decimal("2.500000"),
    )

    with pytest.raises(Exception) as exc_info:
        provider.transcribe(request)

    assert getattr(exc_info.value, "status_code", None) == 502
    assert len(calls) == 1
    assert timeline == [
        "begin:stt-operation-1",
        "dispatch",
        "receipt",
        "settle",
    ]

    retry = replace(request, operation_id="stt-operation-2")
    result = provider.transcribe(retry)

    assert result.text == "下一步"
    assert len(calls) == 2
    assert timeline == [
        "begin:stt-operation-1",
        "dispatch",
        "receipt",
        "settle",
        "begin:stt-operation-2",
        "dispatch",
        "receipt",
        "settle",
    ]

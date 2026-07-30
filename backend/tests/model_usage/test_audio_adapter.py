from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import httpx
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
from app.services.ai_audio.openai_audio import OpenAIAudioProvider
from app.services.ai_audio.schemas import SpeechRequest, TranscriptionRequest
from app.services.model_usage.adapters.audio import AudioUsageAdapter
from app.services.model_usage.errors import ModelUsageBlocked, ModelUsageContractError
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.policies import CapabilityLimitCommand
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
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
) -> AudioUsageAdapter:
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)
    return AudioUsageAdapter(
        provider="openai",
        model=model,
        capability=capability,
        variant_key=variant_key,
        usage_facade=ModelUsageFacade(session_factory=factory, clock=lambda: NOW),
        session_factory=factory,
        signer=receipt_signer,
        clock=lambda: NOW,
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


def _openai_stt_settings() -> SimpleNamespace:
    return SimpleNamespace(
        ai_api_key="",
        ai_api_base="https://audio.example/v1",
        ai_stt_api_key="test-key",
        ai_stt_api_base="https://audio.example/v1",
        ai_stt_model="stt-test",
        ai_stt_timeout_seconds=5,
    )


def test_stt_settles_before_response_parsing_and_explicit_retry_uses_new_attempt_key(
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
    calls: list[httpx.Request] = []

    def provider_response(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(200, content=b"not-json", headers={"x-request-id": "stt-1"})
        return httpx.Response(200, json={"text": "下一步", "language": "zh"}, headers={"x-request-id": "stt-2"})

    provider = OpenAIAudioProvider(
        _openai_stt_settings(),
        capability="stt",
        usage_adapter=adapter,
        model_usage_required=True,
        transport=httpx.MockTransport(provider_response),
    )
    request = replace(
        _transcription_request(reservation_context),
        measured_duration_seconds=Decimal("2.500000"),
    )

    with pytest.raises(Exception) as exc_info:
        provider.transcribe(request)

    assert getattr(exc_info.value, "status_code", None) == 502
    assert len(calls) == 1
    assert model_usage_db.query(ModelUsageEvent).count() == 1

    retry = replace(request, operation_id="stt-operation-2")
    result = provider.transcribe(retry)

    assert result.text == "下一步"
    assert len(calls) == 2
    assert model_usage_db.query(ModelUsageEvent).count() == 2

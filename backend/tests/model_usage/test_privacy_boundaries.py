from __future__ import annotations

import inspect
import json
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageMeter,
    ModelUsageOperationSource,
)
from app.models.domain import Base
from app.services.ai_audio.schemas import SpeechRequest, TranscriptionRequest
from app.services.model_usage.adapters.audio import AudioUsageAdapter
from app.services.model_usage.adapters.embedding import EmbeddingUsageAdapter
from app.services.model_usage.adapters.image_generation import ImageGenerationUsageAdapter
from app.services.model_usage.adapters.llm import LLMUsageAdapter
from app.services.model_usage.adapters.realtime_audio import RealtimeAudioUsageAdapter
from app.services.model_usage.adapters.rerank import RerankUsageAdapter
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.receipts import (
    PROVIDER_USAGE_RECEIPT_LOG_FIELDS,
    ProviderUsageReceiptQueue,
    ProviderUsageReceiptSigner,
    all_model_usage_log_keys,
    model_usage_metric_label_keys,
    provider_usage_receipt_from_log_payload,
    receipt_log_payload,
)
from app.services.model_usage.types import UsageAttribution
from app.services.search.rerank import fingerprint_rerank_request
from tests.model_usage.test_price_manifest import configured_test_variants
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_receipts import receipt as sample_receipt
from tests.model_usage.test_reservations import NOW


pytest_plugins = (
    "tests.model_usage.test_reservations",
    "tests.model_usage._usage_api_support",
)


MARKER = "CULINA_USAGE_SECRET_7f3a9d"
FORBIDDEN_LOG_KEYS = {
    "user_id",
    "prompt",
    "response",
    "query",
    "media_url",
    "authorization",
    "api_key",
}
FORBIDDEN_METRIC_LABEL_KEYS = {"family_id", "event_id", "attempt_key"}


def _adapter_dependencies(
    db: Session,
) -> tuple[sessionmaker[Session], ProviderUsageReceiptSigner]:
    return (
        sessionmaker(bind=db.get_bind(), expire_on_commit=False),
        ProviderUsageReceiptSigner(
            active_key_id="privacy-test-key",
            keys={"privacy-test-key": b"privacy-test-secret"},
        ),
    )


def _dump_model_usage_tables(db: Session) -> str:
    rows: dict[str, list[dict[str, object]]] = {}
    for name in sorted(
        table_name
        for table_name in Base.metadata.tables
        if table_name.startswith("model_usage_")
    ):
        rows[name] = [
            dict(item)
            for item in db.execute(text(f'SELECT * FROM "{name}"')).mappings()
        ]
    return json.dumps(rows, ensure_ascii=False, default=str, sort_keys=True)


def _run_all_fake_adapters(
    db: Session,
    *,
    family_id: str,
    user_id: str,
) -> list[object]:
    session_factory, signer = _adapter_dependencies(db)
    facade = ModelUsageFacade(session_factory=session_factory, clock=lambda: NOW)
    user_attribution = UsageAttribution(
        family_id=family_id,
        attribution_kind=ModelUsageAttributionKind.USER,
        actor_user_id=user_id,
        operation_source=ModelUsageOperationSource.INTERACTIVE,
        logical_operation_id="privacy-adapter-operation",
    )
    image_attribution = UsageAttribution(
        family_id=family_id,
        attribution_kind=ModelUsageAttributionKind.USER,
        actor_user_id=user_id,
        operation_source=ModelUsageOperationSource.IMAGE_JOB,
        logical_operation_id="privacy-image-operation",
    )
    receipts: list[object] = []

    llm = LLMUsageAdapter(
        provider="openai",
        usage_facade=facade,
        session_factory=session_factory,
        signer=signer,
        clock=lambda: NOW,
    )
    llm_attempt = llm.start_round(
        user_attribution,
        provider_round=1,
        attempt_index=1,
        model="gpt-test",
        input_estimate=1,
        output_cap=1,
        fingerprint=llm.request_fingerprint({"prompt": MARKER, "response": MARKER}),
    )
    llm_receipt = llm.receipt_from_openai_usage(
        llm_attempt.prepare_dispatch(),
        raw_usage={"input_tokens": 1, "output_tokens": 1},
        reported_model="gpt-test",
        provider_request_id="privacy-llm-request",
        completed_at=NOW + timedelta(seconds=1),
    )
    llm_attempt.settle(llm_receipt)
    receipts.append(llm_receipt)

    embedding = EmbeddingUsageAdapter(
        provider="openai",
        model="embedding-test",
        dimensions=1536,
        usage_facade=facade,
        session_factory=session_factory,
        signer=signer,
        clock=lambda: NOW,
    )
    embedding_attempt = embedding.begin_embedding_batch(
        attribution=user_attribution,
        attempt_key="privacy:embedding",
        text_token_estimates=[1],
        fingerprint=embedding.request_fingerprint(texts=[MARKER]),
    )
    embedding_receipt = embedding.receipt_from_openai_response(
        embedding_attempt.prepare_dispatch(),
        raw_usage={"input_tokens": 1},
        reported_model="embedding-test",
        provider_request_id="privacy-embedding-request",
        completed_at=NOW + timedelta(seconds=2),
    )
    embedding_attempt.settle(embedding_receipt)
    receipts.append(embedding_receipt)

    rerank = RerankUsageAdapter(
        provider="dashscope",
        model="rerank-test",
        candidate_limit=20,
        usage_facade=facade,
        session_factory=session_factory,
        signer=signer,
        clock=lambda: NOW,
    )
    rerank_attempt = rerank.begin(
        attribution=user_attribution,
        attempt_key="privacy:rerank",
        document_count=1,
        fingerprint=fingerprint_rerank_request(
            signer=signer,
            model="rerank-test",
            query=MARKER,
            documents=[MARKER],
            top_n=1,
            instruct=MARKER,
        ),
    )
    rerank_receipt = rerank.receipt_from_response(
        rerank_attempt.prepare_dispatch(),
        reported_model="rerank-test",
        provider_request_id="privacy-rerank-request",
        completed_at=NOW + timedelta(seconds=3),
    )
    rerank_attempt.settle(rerank_receipt)
    receipts.append(rerank_receipt)

    stt = AudioUsageAdapter(
        provider="openai",
        model="stt-test",
        capability=ModelUsageCapability.STT,
        variant_key="format=webm",
        usage_facade=facade,
        session_factory=session_factory,
        signer=signer,
        clock=lambda: NOW,
    )
    stt_request = TranscriptionRequest(
        audio_bytes=MARKER.encode("utf-8"),
        filename="privacy.webm",
        content_type="audio/webm",
        surface="main_ai",
        family_id=family_id,
        user_id=user_id,
        operation_id="privacy-stt-operation",
    )
    stt_attempt = stt.begin_stt(
        stt_request,
        duration_seconds=Decimal("1.000000"),
        fingerprint=stt.request_fingerprint(stt_request.audio_bytes),
    )
    stt_receipt = stt.stt_receipt(
        stt_attempt.prepare_dispatch(),
        duration_seconds=Decimal("1.000000"),
        reported_model="stt-test",
        provider_request_id="privacy-stt-request",
        completed_at=NOW + timedelta(seconds=4),
    )
    stt_attempt.settle(stt_receipt)
    receipts.append(stt_receipt)

    tts = AudioUsageAdapter(
        provider="openai",
        model="tts-test",
        capability=ModelUsageCapability.TTS,
        variant_key="voice=default",
        usage_facade=facade,
        session_factory=session_factory,
        signer=signer,
        clock=lambda: NOW,
    )
    tts_request = SpeechRequest(
        text=MARKER,
        surface="main_ai",
        family_id=family_id,
        user_id=user_id,
        operation_id="privacy-tts-operation",
    )
    tts_attempt = tts.begin_tts(
        tts_request,
        sanitized_text=MARKER,
        fingerprint=tts.request_fingerprint({"tts_text": MARKER}),
    )
    tts_receipt = tts.tts_receipt(
        tts_attempt.prepare_dispatch(),
        sanitized_text=MARKER,
        reported_model="tts-test",
        provider_request_id="privacy-tts-request",
        completed_at=NOW + timedelta(seconds=5),
    )
    tts_attempt.settle(tts_receipt)
    receipts.append(tts_receipt)

    realtime = RealtimeAudioUsageAdapter(
        billing_variant=configured_test_variants()[5],
        usage_facade=facade,
        session_factory=session_factory,
        signer=signer,
        clock=lambda: NOW,
    )
    lease = realtime.begin_lease(
        family_id=family_id,
        user_id=user_id,
        session_id="privacy-realtime-session",
        turn_id="privacy-realtime-turn",
        segment="duplex",
        lease_sequence=1,
        at=NOW,
        server_input_total=Decimal("0"),
        server_output_total=Decimal("0"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("0"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("0"),
        },
        previous_provider_watermarks={},
    )
    realtime.finish_lease(
        lease,
        server_input_total=Decimal("1"),
        server_output_total=Decimal("1"),
        provider_cumulative={
            ModelUsageMeter.AUDIO_INPUT_TOKENS: Decimal("1"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: Decimal("1"),
        },
        completed_at=NOW + timedelta(seconds=6),
    )
    assert lease.terminal_receipt is not None
    receipts.append(lease.terminal_receipt)

    image = ImageGenerationUsageAdapter(
        provider="dashscope",
        model="image-test",
        usage_facade=facade,
        session_factory=session_factory,
        signer=signer,
        clock=lambda: NOW,
    )
    image_attempt = image.begin(
        attribution=image_attribution,
        attempt_key="privacy:image",
        mode="text",
        image_count=1,
        size="1024*1024",
        quality="standard",
        fingerprint=image.request_fingerprint(
            {"image_prompt": MARKER, "reference_media_url": MARKER}
        ),
    )
    image_receipt = image.receipt_from_provider_success(
        image_attempt.prepare_dispatch(),
        reported_model="image-test",
        provider_request_id="privacy-image-request",
        completed_at=NOW + timedelta(seconds=7),
    )
    image_attempt.settle(image_receipt)
    receipts.append(image_receipt)
    return receipts


def test_secret_marker_never_crosses_usage_boundaries(
    model_usage_db: Session,
    reservation_context,
    caplog: pytest.LogCaptureFixture,
) -> None:
    publish(model_usage_db, raw_manifest())
    receipts = _run_all_fake_adapters(
        model_usage_db,
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "privacy-user",
    )

    assert len(receipts) == len(ModelUsageCapability)
    assert MARKER not in _dump_model_usage_tables(model_usage_db)
    assert MARKER not in json.dumps(
        [receipt_log_payload(receipt) for receipt in receipts],
        ensure_ascii=False,
        default=str,
    )
    queue = ProviderUsageReceiptQueue(max_size=1)
    for receipt in receipts:
        queue.enqueue(receipt)
    assert MARKER not in caplog.text
    assert {
        "audio_bytes",
        "prompt",
        "response",
        "text",
        "transcript",
        "media_url",
    }.isdisjoint(inspect.signature(RealtimeAudioUsageAdapter.begin_lease).parameters)


def test_receipt_allowlist_rejects_content_fields() -> None:
    payload = receipt_log_payload(sample_receipt())
    payload["prompt"] = MARKER

    with pytest.raises(Exception, match="receipt_log_schema_invalid"):
        provider_usage_receipt_from_log_payload(payload)


def test_usage_observability_contract_is_content_free_and_low_cardinality() -> None:
    assert FORBIDDEN_LOG_KEYS.isdisjoint(all_model_usage_log_keys())
    assert FORBIDDEN_METRIC_LABEL_KEYS.isdisjoint(model_usage_metric_label_keys())
    assert PROVIDER_USAGE_RECEIPT_LOG_FIELDS <= all_model_usage_log_keys()


def test_owner_usage_api_does_not_expose_an_internal_subject_marker(usage_api_context) -> None:
    for path in (
        f"/api/model-usage/family/overview?period={usage_api_context.period}",
        f"/api/model-usage/family/breakdown?period={usage_api_context.period}&group_by=subject",
        f"/api/model-usage/me/overview?period={usage_api_context.period}",
    ):
        response = usage_api_context.client.get(path)
        assert response.status_code == 200, response.text
        assert usage_api_context.secret_subject_key not in response.text

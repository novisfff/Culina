from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy.orm import Session, sessionmaker

from app.ai.images.generation import ImageGenerationRequest, ImageGenerationResult
from app.ai.images.jobs import (
    enqueue_image_generation,
    process_image_generation_job,
    retry_failed_image_generation_job,
)
from app.core.enums import (
    ImageGenerationMode,
    MediaEntityType,
    MediaSource,
    ModelUsageReservationStatus,
)
from app.core.utils import create_id, utcnow
from app.models.domain import AIImageGenerationJob, Base, MediaAsset
from app.models.model_usage import ModelUsageEvent, ModelUsageReservation
from app.services.model_usage.adapters.image_generation import ImageGenerationUsageAdapter
from app.services.model_usage.adapters.base import MeteredProviderAttempt
from app.services.model_usage.errors import ModelUsageBlocked
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.types import UsageAttribution
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_reservations import NOW


pytest_plugins = ("tests.model_usage.test_reservations",)


class BlockingImageUsageAdapter:
    def request_fingerprint(self, _payload: object) -> str:
        return "hmac:image-job-blocked"

    def begin(self, **_kwargs: object):
        raise ModelUsageBlocked("model_usage_budget_exceeded")


class CountingMeteredImageClient:
    def __init__(self) -> None:
        self.calls = 0

    def generate(
        self,
        request: ImageGenerationRequest,
        *,
        usage_attempt,
        usage_adapter: ImageGenerationUsageAdapter,
    ) -> SimpleNamespace:
        self.calls += 1
        permit = getattr(usage_attempt, "dispatch_permit", None) or usage_attempt.prepare_dispatch()
        settlement = usage_attempt.settle(
            usage_adapter.receipt_from_provider_success(
                permit,
                reported_model="image-test-2026-07-30",
                provider_request_id=f"image-request-{self.calls}",
            )
        )
        return SimpleNamespace(
            image=ImageGenerationResult(
                prompt="provider prompt is not persisted on the usage receipt",
                svg_markup='<svg width="1" height="1" xmlns="http://www.w3.org/2000/svg"></svg>',
                file_extension=".svg",
                mime_type="image/svg+xml",
            ),
            usage_event_id=settlement.event_id,
        )


class UnsettledMeteredImageClient:
    """Simulates a faulty provider boundary that returns an image without settlement."""

    def __init__(self) -> None:
        self.calls = 0

    def generate(
        self,
        request: ImageGenerationRequest,
        *,
        usage_attempt,
        usage_adapter: ImageGenerationUsageAdapter,
    ) -> ImageGenerationResult:
        del request, usage_attempt, usage_adapter
        self.calls += 1
        return ImageGenerationResult(
            prompt="provider result without a settled usage event",
            svg_markup='<svg width="1" height="1" xmlns="http://www.w3.org/2000/svg"></svg>',
            file_extension=".svg",
            mime_type="image/svg+xml",
        )


def _adapter(model_usage_db: Session) -> ImageGenerationUsageAdapter:
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)
    signer = ProviderUsageReceiptSigner(
        active_key_id="image-job-test-key",
        keys={"image-job-test-key": b"image-job-test-secret"},
    )
    return ImageGenerationUsageAdapter(
        provider="dashscope",
        model="image-test",
        usage_facade=ModelUsageFacade(session_factory=factory, clock=lambda: NOW),
        session_factory=factory,
        signer=signer,
        clock=lambda: NOW,
    )


def _session_factory(model_usage_db: Session):
    return sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)


def _enqueue_job(model_usage_db: Session, reservation_context) -> AIImageGenerationJob:
    request = ImageGenerationRequest(
        entity_type=MediaEntityType.FOOD,
        mode=ImageGenerationMode.TEXT,
        title="番茄炒蛋",
        size="1536*1152",
    )
    job = enqueue_image_generation(
        model_usage_db,
        family_id=reservation_context.attribution.family_id,
        user_id=reservation_context.attribution.actor_user_id or "owner-reserve",
        request=request,
    )
    model_usage_db.commit()
    return job


def _persist_generated_asset(
    db: Session,
    *,
    job: AIImageGenerationJob,
    request: ImageGenerationRequest,
    result: ImageGenerationResult,
) -> MediaAsset:
    del request, result
    asset = MediaAsset(
        id=create_id("photo"),
        family_id=job.family_id,
        name="generated.svg",
        url="/media/family-reserve/generated.svg",
        file_path="family-reserve/generated.svg",
        source=MediaSource.AI,
        alt="generated",
        created_by=job.user_id,
    )
    db.add(asset)
    db.flush()
    return asset


def test_image_job_usage_references_are_diagnostic_not_retention_blocking() -> None:
    columns = Base.metadata.tables["ai_image_generation_jobs"].c
    assert {
        "usage_attempt_key",
        "usage_reservation_id",
        "usage_event_id",
        "provider_execution_status",
        "provider_completed_at",
        "error_code",
    } <= set(columns.keys())
    assert list(columns.usage_reservation_id.foreign_keys) == []
    assert list(columns.usage_event_id.foreign_keys) == []


def test_budget_block_does_not_increment_image_provider_attempt(
    model_usage_db: Session,
    reservation_context,
) -> None:
    job = _enqueue_job(model_usage_db, reservation_context)
    client = CountingMeteredImageClient()

    process_image_generation_job(
        job.id,
        session_factory=_session_factory(model_usage_db),
        client_factory=lambda: client,
        usage_adapter_factory=lambda _request: BlockingImageUsageAdapter(),
    )

    model_usage_db.expire_all()
    refreshed = model_usage_db.get(AIImageGenerationJob, job.id)
    assert refreshed is not None
    assert refreshed.status == "failed"
    assert refreshed.attempt_count == 0
    assert refreshed.provider_execution_status == "not_started"
    assert refreshed.error_code == "model_usage_budget_exceeded"
    assert client.calls == 0


def test_provider_success_followed_by_persistence_failure_never_regenerates(
    model_usage_db: Session,
    reservation_context,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    publish(model_usage_db, raw_manifest())
    job = _enqueue_job(model_usage_db, reservation_context)
    adapter = _adapter(model_usage_db)
    client = CountingMeteredImageClient()
    monkeypatch.setattr(
        "app.ai.images.jobs._save_render_result",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("minio unavailable")),
    )

    process_image_generation_job(
        job.id,
        session_factory=_session_factory(model_usage_db),
        client_factory=lambda: client,
        usage_adapter_factory=lambda _request: adapter,
    )

    model_usage_db.expire_all()
    refreshed = model_usage_db.get(AIImageGenerationJob, job.id)
    assert refreshed is not None
    assert refreshed.status == "failed"
    assert refreshed.provider_execution_status == "confirmed"
    assert refreshed.usage_event_id is not None
    assert refreshed.error_code == "image_post_provider_persistence_failed"
    assert client.calls == 1
    assert model_usage_db.query(ModelUsageEvent).count() == 1

    with pytest.raises(ValueError, match="cannot safely"):
        retry_failed_image_generation_job(
            model_usage_db,
            family_id=refreshed.family_id,
            job_id=refreshed.id,
        )


def test_image_usage_dispatch_precedes_attempt_count_increment(
    model_usage_db: Session,
    reservation_context,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    publish(model_usage_db, raw_manifest())
    job = _enqueue_job(model_usage_db, reservation_context)
    adapter = _adapter(model_usage_db)
    client = CountingMeteredImageClient()
    session_factory = _session_factory(model_usage_db)
    observed_attempt_counts: list[int] = []
    real_prepare_dispatch = MeteredProviderAttempt.prepare_dispatch

    def observe_prepare_dispatch(self, *args, **kwargs):
        with session_factory() as db:
            current = db.get(AIImageGenerationJob, job.id)
            assert current is not None
            observed_attempt_counts.append(current.attempt_count)
        return real_prepare_dispatch(self, *args, **kwargs)

    monkeypatch.setattr(MeteredProviderAttempt, "prepare_dispatch", observe_prepare_dispatch)

    process_image_generation_job(
        job.id,
        session_factory=session_factory,
        client_factory=lambda: client,
        usage_adapter_factory=lambda _request: adapter,
    )

    assert observed_attempt_counts == [0]
    assert client.calls == 1


def test_metered_image_job_refuses_provider_success_without_a_settled_usage_event(
    model_usage_db: Session,
    reservation_context,
) -> None:
    publish(model_usage_db, raw_manifest())
    job = _enqueue_job(model_usage_db, reservation_context)
    adapter = _adapter(model_usage_db)
    client = UnsettledMeteredImageClient()

    process_image_generation_job(
        job.id,
        session_factory=_session_factory(model_usage_db),
        client_factory=lambda: client,
        usage_adapter_factory=lambda _request: adapter,
    )

    model_usage_db.expire_all()
    refreshed = model_usage_db.get(AIImageGenerationJob, job.id)
    assert refreshed is not None
    assert refreshed.status == "failed"
    assert refreshed.error_code == "image_usage_settlement_failed"
    assert refreshed.provider_execution_status == "uncertain"
    assert refreshed.usage_event_id is None
    assert refreshed.generated_media_id is None
    assert client.calls == 1
    assert model_usage_db.query(ModelUsageEvent).count() == 0

    reservation = model_usage_db.get(ModelUsageReservation, refreshed.usage_reservation_id)
    assert reservation is not None
    assert reservation.status is ModelUsageReservationStatus.UNCERTAIN


def test_local_image_request_failure_does_not_mark_provider_completed(
    model_usage_db: Session,
    reservation_context,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job = _enqueue_job(model_usage_db, reservation_context)

    def raise_local_request_error(*_args: object, **_kwargs: object) -> ImageGenerationRequest:
        raise ValueError("reference asset disappeared")

    monkeypatch.setattr(
        "app.ai.images.jobs._request_from_payload",
        raise_local_request_error,
    )

    process_image_generation_job(
        job.id,
        session_factory=_session_factory(model_usage_db),
    )

    model_usage_db.expire_all()
    refreshed = model_usage_db.get(AIImageGenerationJob, job.id)
    assert refreshed is not None
    assert refreshed.status == "failed"
    assert refreshed.error_code == "image_request_unavailable"
    assert refreshed.provider_execution_status == "confirmed_not_executed"
    assert refreshed.provider_completed_at is None
    assert refreshed.attempt_count == 0


def test_bind_retry_reuses_persisted_generated_asset_without_second_provider_call(
    model_usage_db: Session,
    reservation_context,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    publish(model_usage_db, raw_manifest())
    job = _enqueue_job(model_usage_db, reservation_context)
    adapter = _adapter(model_usage_db)
    client = CountingMeteredImageClient()
    bind_calls = 0

    def fail_first_bind(_db: Session, _job: AIImageGenerationJob, *, bump_parent: bool = True) -> str:
        nonlocal bind_calls
        del bump_parent
        bind_calls += 1
        if bind_calls == 1:
            raise RuntimeError("bind failed")
        return "bound"

    monkeypatch.setattr("app.ai.images.jobs._save_render_result", _persist_generated_asset)
    monkeypatch.setattr("app.ai.images.jobs._bind_generated_asset_to_target", fail_first_bind)

    process_image_generation_job(
        job.id,
        session_factory=_session_factory(model_usage_db),
        client_factory=lambda: client,
        usage_adapter_factory=lambda _request: adapter,
    )

    model_usage_db.expire_all()
    failed = model_usage_db.get(AIImageGenerationJob, job.id)
    assert failed is not None
    assert failed.status == "failed"
    assert failed.generated_media_id is not None
    assert failed.provider_execution_status == "confirmed"
    assert failed.error_code == "image_bind_failed"
    assert client.calls == 1

    retried = retry_failed_image_generation_job(
        model_usage_db,
        family_id=failed.family_id,
        job_id=failed.id,
    )
    assert retried is not None
    model_usage_db.commit()

    process_image_generation_job(
        failed.id,
        session_factory=_session_factory(model_usage_db),
        client_factory=lambda: client,
        usage_adapter_factory=lambda _request: adapter,
    )

    model_usage_db.expire_all()
    succeeded = model_usage_db.get(AIImageGenerationJob, job.id)
    assert succeeded is not None
    assert succeeded.status == "succeeded"
    assert succeeded.bind_status == "bound"
    assert client.calls == 1
    assert model_usage_db.query(ModelUsageEvent).count() == 1

from __future__ import annotations

import json

import pytest
from sqlalchemy import select

from app.api import family_model_settings as family_model_settings_api
from app.main import app
from app.models.model_usage import ModelUsageEvent, ModelUsageReservation
from app.services.family_model_settings.capability_tests import CapabilityTestDependencies
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.receipts import ProviderUsageReceiptSigner

from tests.family_model_settings.fake_provider import FakeFamilyModelProvider
from tests.family_model_settings._support import (
    SECRET_MARKER,
    FamilyModelApiContext,
    family_model_api,
)
from tests.family_model_settings.test_capability_tests import (
    _publish_all_capabilities,
    _publish_llm,
)


@pytest.fixture()
def fake_provider(family_model_api: FamilyModelApiContext) -> FakeFamilyModelProvider:
    """Route the Owner capability API through the protocol-faithful fake."""

    provider = FakeFamilyModelProvider()
    app.dependency_overrides[
        family_model_settings_api.get_family_model_capability_test_dependencies
    ] = lambda: CapabilityTestDependencies(
        cipher=family_model_api.cipher,
        network_policy=family_model_api.policy,
        transport=provider,  # type: ignore[arg-type]
        usage_facade=ModelUsageFacade(session_factory=family_model_api.session_factory),
        signer=ProviderUsageReceiptSigner(
            active_key_id="protocol-acceptance",
            keys={"protocol-acceptance": b"family-model-protocol-acceptance-key"},
        ),
        session_factory=family_model_api.session_factory,
    )
    return provider


def _assert_snapshot(
    context: FamilyModelApiContext,
    *,
    capability: str,
    variant: str,
) -> ModelUsageReservation:
    with context.session_factory() as db:
        reservations = list(
            db.scalars(
                select(ModelUsageReservation).where(
                    ModelUsageReservation.family_id == "family-a",
                    ModelUsageReservation.capability == capability,
                    ModelUsageReservation.variant_key == variant,
                )
            )
        )
        assert len(reservations) == 1
        reservation = reservations[0]
        assert reservation.config_revision_id
        assert reservation.provider_profile_id
        assert reservation.provider_profile_version_id
        assert reservation.credential_secret_version_id
        assert reservation.price_version_id
        assert reservation.price_snapshot_checksum
        event = db.scalar(
            select(ModelUsageEvent).where(ModelUsageEvent.reservation_id == reservation.id)
        )
        assert event is not None
        assert event.config_revision_id == reservation.config_revision_id
        assert event.provider_profile_id == reservation.provider_profile_id
        assert event.provider_profile_version_id == reservation.provider_profile_version_id
        assert event.price_version_id == reservation.price_version_id
        assert event.price_snapshot_checksum == reservation.price_snapshot_checksum
        return reservation


def test_fake_provider_records_only_test_local_secret_markers() -> None:
    provider = FakeFamilyModelProvider()

    assert provider.requests_for("not-sent") == []


@pytest.mark.parametrize(
    ("capability", "variant", "model", "path"),
    (
        ("llm", "primary", "capability-test-llm", "/v1/chat/completions"),
        ("image_generation", "text", "capability-test-image", "/v1/images/generations"),
        ("stt", "default", "capability-test-stt", "/v1/audio/transcriptions"),
        ("tts", "default", "capability-test-tts", "/v1/audio/speech"),
        ("realtime_audio", "default", "capability-test-realtime", "/realtime"),
        ("embedding", "search", "capability-test-embedding", "/v1/embeddings"),
        ("rerank", "search", "capability-test-rerank", "/v1/rerank"),
    ),
)
def test_published_family_dispatches_each_capability_through_its_snapshot(
    family_model_api: FamilyModelApiContext,
    fake_provider: FakeFamilyModelProvider,
    capability: str,
    variant: str,
    model: str,
    path: str,
) -> None:
    _publish_all_capabilities(family_model_api)

    response = family_model_api.client.post(
        f"/api/family/model-settings/capabilities/{capability}/test",
        json={
            "variant_key": variant,
            "confirm_billable": True,
            "idempotency_key": f"protocol-acceptance-{capability}",
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "succeeded"
    assert SECRET_MARKER not in response.text
    reservation = _assert_snapshot(
        family_model_api,
        capability=capability,
        variant=variant,
    )
    requests = fake_provider.requests_for(SECRET_MARKER)
    if capability == "realtime_audio":
        handshakes = [request for request in requests if request.protocol == "websocket"]
        frames = [request for request in requests if request.protocol == "websocket_frame"]
        assert len(handshakes) == 1
        assert len(frames) == 1
        assert handshakes[0].path == path
        assert handshakes[0].model == model
        assert frames[0].body == {"type": "session.update", "session": {"modalities": ["text"]}}
    else:
        assert len(requests) == 1
        request = requests[0]
        assert request.protocol == "http"
        assert request.path == path
        assert request.model == model
        assert isinstance(request.body, dict)
        assert request.body["model"] == model
    assert reservation.requested_model == model


def test_capability_test_replay_never_sends_twice_and_rejects_key_reuse(
    family_model_api: FamilyModelApiContext,
    fake_provider: FakeFamilyModelProvider,
) -> None:
    _publish_all_capabilities(family_model_api)
    payload = {
        "variant_key": "primary",
        "confirm_billable": True,
        "idempotency_key": "protocol-replay-llm",
    }

    first = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test", json=payload
    )
    replay = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test", json=payload
    )
    conflict = family_model_api.client.post(
        "/api/family/model-settings/capabilities/image_generation/test",
        json=payload | {"variant_key": "text"},
    )

    assert first.status_code == 200, first.text
    assert replay.status_code == 200, replay.text
    assert replay.json() == first.json()
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["detail"]["code"] == "family_model_operation_idempotency_conflict"
    assert len([item for item in fake_provider.requests_for(SECRET_MARKER) if item.protocol == "http"]) == 1
    _assert_snapshot(family_model_api, capability="llm", variant="primary")


def test_rotation_uses_new_secret_only_for_new_dispatch_and_preserves_old_snapshot(
    family_model_api: FamilyModelApiContext,
    fake_provider: FakeFamilyModelProvider,
) -> None:
    _publish_llm(family_model_api)
    profile = family_model_api.client.get("/api/family/model-settings").json()["provider_profiles"][0]
    first = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "idempotency_key": "protocol-rotation-before",
        },
    )
    assert first.status_code == 200, first.text
    old_reservation = _assert_snapshot(family_model_api, capability="llm", variant="primary")
    settings_before_rotation = family_model_api.client.get("/api/family/model-settings").json()
    rotated_marker = "sk-protocol-rotated-marker"
    rotate = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/rotate-key",
        json={
            "current_password": "OwnerPass123",
            "new_api_key": rotated_marker,
            "base_settings_version_number": settings_before_rotation["version_number"],
            "idempotency_key": "protocol-rotate-key",
        },
    )
    assert rotate.status_code == 200, rotate.text
    assert rotated_marker not in rotate.text
    settings_after_rotation = family_model_api.client.get("/api/family/model-settings").json()
    assert settings_after_rotation["provider_profiles"][0]["api_base_url"] == profile["api_base_url"]
    second = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "idempotency_key": "protocol-rotation-after",
        },
    )
    assert second.status_code == 200, second.text

    with family_model_api.session_factory() as db:
        reservations = list(
            db.scalars(
                select(ModelUsageReservation)
                .where(
                    ModelUsageReservation.family_id == "family-a",
                    ModelUsageReservation.capability == "llm",
                )
                .order_by(ModelUsageReservation.reserved_at)
            )
        )
    assert len(reservations) == 2
    assert reservations[0].credential_secret_version_id == old_reservation.credential_secret_version_id
    assert reservations[1].credential_secret_version_id != old_reservation.credential_secret_version_id
    assert len([request for request in fake_provider.requests_for(SECRET_MARKER) if request.protocol == "http"]) == 1
    assert len([request for request in fake_provider.requests_for(rotated_marker) if request.protocol == "http"]) == 1
    all_test_records = [*fake_provider.requests_for(SECRET_MARKER), *fake_provider.requests_for(rotated_marker)]
    assert rotated_marker not in json.dumps([request.body for request in all_test_records], ensure_ascii=False)

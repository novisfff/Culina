from __future__ import annotations

import json
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest

from app.ai.images.generation import (
    ImageGenerationClient,
    ImageGenerationRequest,
    ImageProviderDependencies,
)
from app.ai.images.jobs import enqueue_image_generation, image_binding_for_job
from app.core.enums import ImageGenerationMode, MediaEntityType
from app.models.domain import AIImageGenerationJob
from app.services.family_model_settings.resolver import FamilyModelConfigurationResolver
from app.services.family_model_settings.transport import ProviderMedia, ProviderResponse
from app.services.family_model_settings.types import (
    DispatchCredential,
    ResolvedCapabilityBinding,
    ResolvedProviderEndpoint,
)
from app.services.model_usage.errors import ModelUsageContractError

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


def _image_payload(profile_id: str, *, model: str) -> dict[str, object]:
    return {
        "bindings": [
            {
                "capability": "image_generation",
                "variant_key": variant,
                "enabled": True,
                "provider_profile_id": profile_id,
                "requested_model": model,
                "image_size": "1536x1024",
                "response_format": "url",
            }
            for variant in ("text", "reference")
        ],
        "price_rates": [
            {
                "capability": "image_generation",
                "variant_key": variant,
                "meter": "generated_images",
                "unit_quantity": "1",
                "unit_price": "0.01",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            }
            for variant in ("text", "reference")
        ],
        "change_note": "image runtime snapshot test",
    }


def _publish_images(
    context: FamilyModelApiContext,
    *,
    family_id: str,
    model: str,
    profile_id: str | None = None,
) -> dict[str, object]:
    context.use_owner(family_id)
    if profile_id is None:
        profile = context.create_profile(
            display_name=f"{family_id} image provider",
            api_key=f"key-{family_id}-{model}",
            idempotency_key=f"image-profile-{family_id}-{model}",
        )
        profile_id = str(profile["id"])
    else:
        profile = {"id": profile_id}
    draft_state = context.client.get("/api/family/model-settings/draft")
    assert draft_state.status_code == 200, draft_state.text
    saved = context.client.put(
        "/api/family/model-settings/draft",
        json=_image_payload(profile_id, model=model)
        | {
            "base_config_revision_id": draft_state.json().get("base_config_revision_id"),
            "base_draft_version_number": draft_state.json()["draft_version_number"],
            "idempotency_key": f"image-draft-{family_id}-{model}",
        },
    )
    assert saved.status_code == 200, saved.text
    settings = context.client.get("/api/family/model-settings")
    assert settings.status_code == 200, settings.text
    active = settings.json()
    assert active["active_config_revision_id"] is not None
    assert active["active_price_version_id"] is not None
    return {
        "profile": profile,
        "published": {
            "config_revision_id": active["active_config_revision_id"],
            "price_version_id": active["active_price_version_id"],
            "settings_version_number": active["version_number"],
        },
    }


@pytest.mark.parametrize(
    ("mode", "variant"),
    ((ImageGenerationMode.TEXT, "text"), (ImageGenerationMode.REFERENCE, "reference")),
)
def test_image_job_snapshots_family_revision(
    family_model_api: FamilyModelApiContext,
    mode: ImageGenerationMode,
    variant: str,
) -> None:
    published = _publish_images(
        family_model_api,
        family_id="family-a",
        model="old-image-model",
    )
    with family_model_api.session_factory() as db:
        resolver = FamilyModelConfigurationResolver(
            db,
            network_policy=family_model_api.policy,
            cipher=family_model_api.cipher,
        )
        job = enqueue_image_generation(
            db,
            family_id="family-a",
            user_id="owner-a",
            request=ImageGenerationRequest(
                entity_type=MediaEntityType.FOOD,
                mode=mode,
                title="番茄炒蛋",
            ),
            resolver=resolver,
        )
        job_id = job.id
        assert job.config_revision_id == published["published"]["config_revision_id"]
        binding = image_binding_for_job(db, job=job, resolver=resolver)
        assert binding.variant_key == variant
        db.commit()

    _publish_images(
        family_model_api,
        family_id="family-a",
        model="new-image-model",
        profile_id=str(published["profile"]["id"]),
    )
    with family_model_api.session_factory() as db:
        job = db.get(AIImageGenerationJob, job_id)
        assert job is not None
        binding = image_binding_for_job(
            db,
            job=job,
            resolver=FamilyModelConfigurationResolver(
                db,
                network_policy=family_model_api.policy,
                cipher=family_model_api.cipher,
            ),
        )
    assert binding.config_revision_id == published["published"]["config_revision_id"]
    assert binding.requested_model == "old-image-model"


def _binding(*, family_id: str, variant: str = "text", model: str = "image-model") -> ResolvedCapabilityBinding:
    return ResolvedCapabilityBinding(
        family_id=family_id,
        config_revision_id=f"revision-{family_id}",
        provider_profile_id=f"profile-{family_id}",
        provider_profile_version_id=f"profile-version-{family_id}",
        adapter_kind="openai_compatible_http",
        auth_mode="api_key",
        endpoint=ResolvedProviderEndpoint(
            normalized_url=f"https://{family_id}.provider.example/v1",
            scheme="https",
            host=f"{family_id}.provider.example",
            port=443,
            base_path="/v1",
            resolved_addresses=("93.184.216.34",),
            private_target=False,
        ),
        websocket_endpoint=None,
        requested_model=model,
        billing_model=model,
        capability="image_generation",
        variant_key=variant,
        billing_scheme_key="image-count-v1",
        options={},
    )


def test_image_client_dispatches_then_decrypts_and_downloads_through_transport() -> None:
    binding = _binding(family_id="family-a")
    timeline: list[str] = []

    class Transport:
        def request(self, method: str, url: str, *, headers: dict[str, str], json: object | None = None) -> ProviderResponse:
            assert method == "POST"
            assert url == "https://family-a.provider.example/v1/images/generations"
            assert headers["Authorization"] == "Bearer rotated-key"
            assert headers["Idempotency-Key"] == "image-attempt-a"
            assert isinstance(json, dict) and json["model"] == "image-model"
            timeline.append("transport")
            return ProviderResponse(
                status_code=200,
                headers={"x-request-id": "provider-image-a"},
                content=json_module({"data": [{"url": "https://family-a.provider.example/media/image.png"}]}),
            )

        def download_media(self, url: str, *, source: ResolvedProviderEndpoint, adapter_kind: str) -> ProviderMedia:
            assert url == "https://family-a.provider.example/media/image.png"
            assert source is binding.endpoint
            assert adapter_kind == "openai_compatible_http"
            timeline.append("download")
            return ProviderMedia(content=b"image-bytes", content_type="image/png", endpoint=source)

    def credential_loader(resolved: ResolvedCapabilityBinding, secret_id: str | None) -> DispatchCredential:
        assert resolved is binding
        assert secret_id == "rotated-secret"
        timeline.append("decrypt")
        return DispatchCredential(
            family_id="family-a",
            provider_profile_id="profile-family-a",
            secret_version_id=secret_id,
            api_key="rotated-key",
        )

    @dataclass
    class Attempt:
        dispatch_permit: Any = None

        def prepare_dispatch(self) -> Any:
            timeline.append("dispatch")
            self.dispatch_permit = SimpleNamespace(
                credential_secret_version_id="rotated-secret",
                provider_idempotency_key="image-attempt-a",
            )
            return self.dispatch_permit

        def settle(self, receipt: object) -> Any:
            assert receipt == "signed-receipt"
            timeline.append("settle")
            return SimpleNamespace(event_id="usage-event-a")

        def mark_uncertain(self, error_code: str) -> None:
            timeline.append(f"uncertain:{error_code}")

    class Adapter:
        model = "image-model"

        def receipt_from_provider_success(self, _permit: object, **kwargs: object) -> str:
            assert kwargs["reported_model"] == "image-model"
            assert kwargs["provider_request_id"] == "provider-image-a"
            timeline.append("receipt")
            return "signed-receipt"

    client = ImageGenerationClient.for_binding(
        binding,
        dependencies=ImageProviderDependencies(
            transport=Transport(),  # type: ignore[arg-type]
            resolve_dispatch_credential=credential_loader,
        ),
    )
    request = ImageGenerationRequest(
        entity_type=MediaEntityType.FOOD,
        mode=ImageGenerationMode.TEXT,
        title="番茄炒蛋",
    )

    with pytest.raises(ModelUsageContractError, match="image_dispatch_permit_required"):
        client.generate_from_text(request)
    assert timeline == []

    result = client.generate(request, usage_attempt=Attempt(), usage_adapter=Adapter())
    assert result.usage_event_id == "usage-event-a"
    assert result.image.binary_content == b"image-bytes"
    assert timeline == ["dispatch", "decrypt", "transport", "download", "receipt", "settle"]


def json_module(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False).encode("utf-8")

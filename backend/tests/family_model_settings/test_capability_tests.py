from __future__ import annotations

from typing import Literal

import pytest
from sqlalchemy import func, select

from app.models.model_usage import ModelUsageEvent
from app.models.family_model_settings import FamilyModelConfigDraft
from app.services.family_model_settings.capability_tests import (
    CAPABILITY_TEST_RUNNERS,
    _http_probe_request,
)
from app.services.family_model_settings.transport import ProviderResponse
from app.services.family_model_settings.types import (
    ResolvedCapabilityBinding,
    ResolvedProviderEndpoint,
)
from app.services.model_usage.policies import ensure_family_model_usage_defaults
from app.services.model_usage.subjects import ensure_user_subject

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


def _save_active_llm(context: FamilyModelApiContext) -> None:
    profile = context.create_profile(idempotency_key="capability-test-profile-1")
    payload = {
        "bindings": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "enabled": True,
                "provider_profile_id": profile["id"],
                "requested_model": "capability-test-model",
                "max_output_tokens": 64,
            }
        ],
        "price_rates": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "meter": meter,
                "unit_quantity": "1000",
                "unit_price": "0.01",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            }
            for meter in (
                "uncached_input_tokens",
                "cached_input_tokens",
                "output_tokens",
            )
        ],
        "change_note": "能力测试配置",
        "base_draft_version_number": 0,
        "idempotency_key": "capability-test-draft-1",
    }
    draft_response = context.client.put("/api/family/model-settings/draft", json=payload)
    assert draft_response.status_code == 200, draft_response.text
    assert draft_response.json()["validation_status"] == "valid"
    settings_response = context.client.get("/api/family/model-settings")
    assert settings_response.status_code == 200, settings_response.text
    assert settings_response.json()["active_config_revision_id"] is not None
    assert settings_response.json()["active_price_version_id"] is not None

    with context.session_factory() as db:
        subject = ensure_user_subject(db, family_id="family-a", user_id="owner-a")
        ensure_family_model_usage_defaults(
            db,
            family_id="family-a",
            creator_subject_id=subject.id,
        )
        db.commit()


def _usage_event_count(context: FamilyModelApiContext) -> int:
    with context.session_factory() as db:
        return int(
            db.scalar(
                select(func.count()).select_from(ModelUsageEvent).where(
                    ModelUsageEvent.family_id == "family-a"
                )
            )
            or 0
        )


def _usage_event_count_for_capability(
    context: FamilyModelApiContext,
    capability: str,
) -> int:
    with context.session_factory() as db:
        return int(
            db.scalar(
                select(func.count()).select_from(ModelUsageEvent).where(
                    ModelUsageEvent.family_id == "family-a",
                    ModelUsageEvent.capability == capability,
                )
            )
            or 0
        )


def _save_all_active_capabilities(context: FamilyModelApiContext) -> None:
    http_profile = context.create_profile(
        display_name="能力测试 HTTP 服务",
        idempotency_key="capability-test-all-http-profile-1",
    )
    realtime_profile = context.create_profile(
        display_name="能力测试实时语音服务",
        adapter_kind="openai_realtime",
        api_base_url="wss://provider.example/realtime",
        idempotency_key="capability-test-all-realtime-profile-1",
    )
    http_profile_id = str(http_profile["id"])
    realtime_profile_id = str(realtime_profile["id"])
    bindings = [
        {
            "capability": "llm",
            "variant_key": "primary",
            "enabled": True,
            "provider_profile_id": http_profile_id,
            "requested_model": "capability-test-llm",
            "max_output_tokens": 64,
        },
        {
            "capability": "image_generation",
            "variant_key": "text",
            "enabled": True,
            "provider_profile_id": http_profile_id,
            "requested_model": "capability-test-image",
            "image_size": "1024x1024",
            "response_format": "b64_json",
        },
        {
            "capability": "stt",
            "variant_key": "default",
            "enabled": True,
            "provider_profile_id": http_profile_id,
            "requested_model": "capability-test-stt",
        },
        {
            "capability": "tts",
            "variant_key": "default",
            "enabled": True,
            "provider_profile_id": http_profile_id,
            "requested_model": "capability-test-tts",
            "voice": "alloy",
            "output_format": "mp3",
        },
        {
            "capability": "realtime_audio",
            "variant_key": "default",
            "enabled": True,
            "provider_profile_id": realtime_profile_id,
            "requested_model": "capability-test-realtime",
            "voice": "alloy",
            "language_hint": "zh",
        },
        {
            "capability": "embedding",
            "variant_key": "search",
            "enabled": True,
            "provider_profile_id": http_profile_id,
            "requested_model": "capability-test-embedding",
            "dimensions": 2,
        },
        {
            "capability": "rerank",
            "variant_key": "search",
            "enabled": True,
            "provider_profile_id": http_profile_id,
            "requested_model": "capability-test-rerank",
            "top_n": 1,
        },
    ]

    def rate(capability: str, variant_key: str, meter: str) -> dict[str, str]:
        return {
            "capability": capability,
            "variant_key": variant_key,
            "meter": meter,
            "unit_quantity": "1000" if "token" in meter else "1",
            "unit_price": "0.01",
            "source_currency": "CNY",
            "fx_to_cny": "1",
        }

    price_rates = [
        *(rate("llm", "primary", meter) for meter in (
            "uncached_input_tokens",
            "cached_input_tokens",
            "output_tokens",
        )),
        rate("image_generation", "text", "generated_images"),
        rate("stt", "default", "audio_input_seconds"),
        rate("tts", "default", "tts_characters"),
        *(rate("realtime_audio", "default", meter) for meter in (
            "audio_input_seconds",
            "tts_characters",
        )),
        rate("embedding", "search", "embedding_tokens"),
        rate("rerank", "search", "input_tokens"),
    ]
    saved = context.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": bindings,
            "price_rates": price_rates,
            "change_note": "完整能力测试配置",
            "base_draft_version_number": 0,
            "idempotency_key": "capability-test-all-draft-1",
            "confirm_initial_search_index": True,
        },
    )
    assert saved.status_code == 200, saved.text
    settings_response = context.client.get("/api/family/model-settings")
    assert settings_response.status_code == 200, settings_response.text
    assert settings_response.json()["active_config_revision_id"] is not None
    assert settings_response.json()["active_price_version_id"] is not None
    with context.session_factory() as db:
        subject = ensure_user_subject(db, family_id="family-a", user_id="owner-a")
        ensure_family_model_usage_defaults(
            db,
            family_id="family-a",
            creator_subject_id=subject.id,
        )
        db.commit()


def test_capability_test_registry_is_closed_and_covers_all_runtime_capabilities() -> None:
    assert set(CAPABILITY_TEST_RUNNERS) == {
        "llm",
        "image_generation",
        "stt",
        "tts",
        "realtime_audio",
        "embedding",
        "rerank",
    }


def test_owner_capability_test_requires_billable_confirmation_before_reserve_or_send(
    family_model_api: FamilyModelApiContext,
) -> None:
    _save_active_llm(family_model_api)

    response = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": False,
            "idempotency_key": "capability-test-confirmation-1",
        },
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "family_model_billable_test_confirmation_required"
    assert _usage_event_count(family_model_api) == 0
    assert family_model_api.transport.calls == []


def test_owner_can_test_a_complete_saved_configuration_without_a_publish_step(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(
        idempotency_key="capability-test-draft-profile-1"
    )
    saved = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "enabled": True,
                    "provider_profile_id": profile["id"],
                    "requested_model": "draft-only-model",
                    "max_output_tokens": 64,
                }
            ],
            "price_rates": [],
            "change_note": "保存后能力测试",
            "base_draft_version_number": 0,
            "idempotency_key": "capability-test-draft-save-1",
        },
    )
    assert saved.status_code == 200, saved.text
    draft_version = saved.json()["draft_version_number"]
    with family_model_api.session_factory() as db:
        subject = ensure_user_subject(db, family_id="family-a", user_id="owner-a")
        ensure_family_model_usage_defaults(
            db,
            family_id="family-a",
            creator_subject_id=subject.id,
        )
        db.commit()

    tested = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "base_draft_version_number": draft_version,
            "idempotency_key": "capability-test-saved-draft-1",
        },
    )

    assert tested.status_code == 200, tested.text
    assert tested.json()["status"] == "succeeded"
    settings = family_model_api.client.get("/api/family/model-settings").json()
    assert settings.get("active_config_revision_id") is not None
    assert settings.get("active_price_version_id") is not None
    assert _usage_event_count(family_model_api) == 1
    assert len(family_model_api.transport.calls) == 1
    assert family_model_api.transport.calls[0][3]["model"] == "draft-only-model"

    tested_override = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "base_draft_version_number": draft_version,
            "provider_profile_id": profile["id"],
            "requested_model": "replacement-candidate-model",
            "idempotency_key": "capability-test-saved-draft-override-1",
        },
    )

    assert tested_override.status_code == 200, tested_override.text
    assert tested_override.json()["status"] == "succeeded"
    assert len(family_model_api.transport.calls) == 2
    assert family_model_api.transport.calls[1][3]["model"] == "replacement-candidate-model"


def test_owner_capability_test_ignores_an_unrelated_invalid_draft_binding(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(
        idempotency_key="capability-test-independent-profile-1"
    )
    saved = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "enabled": True,
                    "provider_profile_id": profile["id"],
                    "requested_model": "independent-llm-model",
                    "max_output_tokens": 64,
                },
                {
                    "capability": "embedding",
                    "variant_key": "search",
                    "enabled": True,
                    "provider_profile_id": profile["id"],
                    "requested_model": "",
                    "dimensions": 1536,
                },
            ],
            "price_rates": [],
            "change_note": "能力测试互不影响",
            "base_draft_version_number": 0,
            "idempotency_key": "capability-test-independent-draft-1",
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["validation_status"] == "invalid"

    with family_model_api.session_factory() as db:
        subject = ensure_user_subject(db, family_id="family-a", user_id="owner-a")
        ensure_family_model_usage_defaults(
            db,
            family_id="family-a",
            creator_subject_id=subject.id,
        )
        db.commit()

    tested = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "base_draft_version_number": saved.json()["draft_version_number"],
            "idempotency_key": "capability-test-independent-run-1",
        },
    )

    assert tested.status_code == 200, tested.text
    assert tested.json()["status"] == "succeeded"
    assert family_model_api.transport.calls[0][3]["model"] == "independent-llm-model"


def test_owner_can_probe_an_unsaved_embedding_replacement_candidate(
    family_model_api: FamilyModelApiContext,
) -> None:
    _save_all_active_capabilities(family_model_api)
    settings = family_model_api.client.get("/api/family/model-settings").json()
    profile_id = next(
        profile["id"]
        for profile in settings["provider_profiles"]
        if profile["display_name"] == "能力测试 HTTP 服务"
    )
    draft_version = family_model_api.client.get("/api/family/model-settings/draft").json()[
        "draft_version_number"
    ]

    response = family_model_api.client.post(
        "/api/family/model-settings/capabilities/embedding/test",
        json={
            "variant_key": "search",
            "confirm_billable": True,
            "base_draft_version_number": draft_version,
            "provider_profile_id": profile_id,
            "requested_model": "replacement-embedding-model",
            "dimensions": 3,
            "idempotency_key": "capability-test-embedding-replacement-1",
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "succeeded"
    assert family_model_api.transport.calls[0][3]["model"] == "replacement-embedding-model"


def test_owner_capability_test_ignores_structurally_corrupt_unrelated_draft_rows(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(
        idempotency_key="capability-test-structural-profile-1"
    )
    saved = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "enabled": True,
                    "provider_profile_id": profile["id"],
                    "requested_model": "structural-independent-model",
                    "max_output_tokens": 64,
                }
            ],
            "price_rates": [],
            "base_draft_version_number": 0,
            "idempotency_key": "capability-test-structural-draft-1",
        },
    )
    assert saved.status_code == 200, saved.text
    draft_version = saved.json()["draft_version_number"]
    with family_model_api.session_factory() as db:
        draft = db.get(FamilyModelConfigDraft, "family-a")
        assert draft is not None
        raw = dict(draft.payload_json)
        raw["bindings"] = [
            *raw["bindings"],
            {"capability": "embedding", "variant_key": "removed-legacy"},
        ]
        raw["price_rates"] = [{"not": "a-rate"}]
        draft.payload_json = raw
        db.commit()

    with family_model_api.session_factory() as db:
        subject = ensure_user_subject(db, family_id="family-a", user_id="owner-a")
        ensure_family_model_usage_defaults(
            db,
            family_id="family-a",
            creator_subject_id=subject.id,
        )
        db.commit()

    tested = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "base_draft_version_number": draft_version,
            "idempotency_key": "capability-test-structural-run-1",
        },
    )

    assert tested.status_code == 200, tested.text
    assert tested.json()["status"] == "succeeded"
    assert family_model_api.transport.calls[0][3]["model"] == "structural-independent-model"


def test_owner_cannot_test_an_llm_fallback_without_a_primary(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(
        idempotency_key="capability-test-fallback-without-primary-profile-1"
    )
    saved = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "fallback",
                    "enabled": True,
                    "provider_profile_id": profile["id"],
                    "requested_model": "fallback-only-model",
                    "max_output_tokens": 64,
                }
            ],
            "price_rates": [
                {
                    "capability": "llm",
                    "variant_key": "fallback",
                    "meter": meter,
                    "unit_quantity": "1000",
                    "unit_price": "0.01",
                    "source_currency": "CNY",
                    "fx_to_cny": "1",
                }
                for meter in (
                    "uncached_input_tokens",
                    "cached_input_tokens",
                    "output_tokens",
                )
            ],
            "base_draft_version_number": 0,
            "idempotency_key": "capability-test-fallback-without-primary-draft-1",
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["validation_status"] == "invalid"

    tested = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "fallback",
            "confirm_billable": True,
            "base_draft_version_number": saved.json()["draft_version_number"],
            "idempotency_key": "capability-test-fallback-without-primary-run-1",
        },
    )

    assert tested.status_code == 422, tested.text
    assert tested.json()["detail"]["code"] == "family_model_llm_fallback_requires_primary"
    assert family_model_api.transport.calls == []


def test_owner_capability_test_uses_one_ledger_event_and_replays_safe_result(
    family_model_api: FamilyModelApiContext,
) -> None:
    _save_active_llm(family_model_api)
    payload = {
        "variant_key": "primary",
        "confirm_billable": True,
        "idempotency_key": "capability-test-real-1",
    }

    first = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json=payload,
    )
    second = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json=payload,
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json() == second.json()
    assert first.json()["status"] == "succeeded"
    assert _usage_event_count(family_model_api) == 1
    assert len(family_model_api.transport.calls) == 1
    forbidden = {"provider", "model", "base_url", "credential", "request_id"}
    assert forbidden.isdisjoint(first.json())
    assert "capability-test-model" not in first.text


def test_owner_capability_test_returns_provider_failure_reason(
    family_model_api: FamilyModelApiContext,
) -> None:
    _save_active_llm(family_model_api)
    family_model_api.transport.responses.append(
        ProviderResponse(
            status_code=400,
            headers={"content-type": "application/json"},
            content='{"error":{"code":"invalid_model","message":"模型不存在或不可用"}}'.encode(),
        )
    )

    response = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "idempotency_key": "capability-test-provider-failure-1",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "failed"
    assert "HTTP 400" in body["detail"]
    assert "invalid_model" in body["detail"]
    assert "模型不存在或不可用" in body["detail"]


@pytest.mark.parametrize(
    ("capability", "variant", "expected_path"),
    (
        ("llm", "primary", "/chat/completions"),
        ("image_generation", "text", "/images/generations"),
        ("stt", "default", "/audio/transcriptions"),
        ("tts", "default", "/audio/speech"),
        ("realtime_audio", "default", "/realtime"),
        ("embedding", "search", "/embeddings"),
        ("rerank", "search", "/rerank"),
    ),
)
def test_owner_real_capability_test_uses_normal_ledger_for_every_capability(
    family_model_api: FamilyModelApiContext,
    capability: str,
    variant: str,
    expected_path: str,
) -> None:
    _save_all_active_capabilities(family_model_api)

    response = family_model_api.client.post(
        f"/api/family/model-settings/capabilities/{capability}/test",
        json={
            "variant_key": variant,
            "confirm_billable": True,
            "idempotency_key": f"capability-test-all-{capability}",
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "succeeded"
    assert _usage_event_count_for_capability(family_model_api, capability) == 1
    if capability == "realtime_audio":
        assert len(family_model_api.transport.websocket_calls) == 1
        assert expected_path in family_model_api.transport.websocket_calls[0][0]
    else:
        assert len(family_model_api.transport.calls) == 1
        method, url, headers, _ = family_model_api.transport.calls[0]
        assert method == "POST"
        assert url.endswith(expected_path)
        assert headers["Authorization"] == "Bearer sk-family-model-secret-marker"


@pytest.mark.parametrize(
    ("capability", "model"),
    (("stt", "qwen3-asr-flash"), ("tts", "cosyvoice-v3-plus")),
)
def test_dashscope_audio_capability_probe_uses_the_native_audio_contract(
    capability: Literal["stt", "tts"],
    model: str,
) -> None:
    binding = ResolvedCapabilityBinding(
        family_id="family-a",
        config_revision_id="revision-a",
        provider_profile_id="profile-a",
        provider_profile_version_id="profile-version-a",
        adapter_kind="dashscope",
        auth_mode="api_key",
        endpoint=ResolvedProviderEndpoint(
            normalized_url="https://dashscope.example/api/v1",
            scheme="https",
            host="dashscope.example",
            port=443,
            base_path="/api/v1",
            resolved_addresses=("93.184.216.34",),
            private_target=False,
        ),
        websocket_endpoint=None,
        requested_model=model,
        billing_model=model,
        capability=capability,
        variant_key="default",
        billing_scheme_key=("stt-seconds-v1" if capability == "stt" else "tts-characters-v1"),
        options={},
    )

    path, payload = _http_probe_request(binding)

    assert path == "services/aigc/multimodal-generation/generation"
    assert payload["model"] == model
    if capability == "stt":
        assert payload["parameters"] == {
            "asr_options": {"enable_itn": False},
            "format": "wav",
            "sample_rate": "16000",
        }
        assert "input_audio" not in str(payload)
        assert payload["input"]["messages"][1]["content"][0]["audio"].startswith("data:audio/wav;base64,")
    else:
        assert payload["input"] == {
            "text": "能力测试。",
            "voice": "Cherry",
            "language_type": "Chinese",
        }
        assert payload["parameters"] == {"format": "mp3", "sample_rate": 24000}


def test_member_cannot_run_owner_capability_tests(
    family_model_api: FamilyModelApiContext,
) -> None:
    family_model_api.use_member()

    response = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "idempotency_key": "capability-test-member-1",
        },
    )

    assert response.status_code == 403

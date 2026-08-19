from __future__ import annotations

from collections.abc import Mapping

from app.core.enums import FamilyModelConfigRevisionStatus, ModelUsageCapability
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelConfigRevision,
    FamilyModelSettings,
)

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


def _recursive_strings(value: object) -> set[str]:
    if isinstance(value, Mapping):
        values = {str(key) for key in value}
        for nested in value.values():
            values.update(_recursive_strings(nested))
        return values
    if isinstance(value, list):
        return {item for nested in value for item in _recursive_strings(nested)}
    return {str(value)}


def _activate_vision_llm(context: FamilyModelApiContext) -> None:
    with context.session_factory() as db:
        revision = FamilyModelConfigRevision(
            id="member-status-revision",
            family_id="family-a",
            version_number=1,
            config_checksum="a" * 64,
            status=FamilyModelConfigRevisionStatus.PUBLISHED,
            change_note="成员状态测试",
            published_by="owner-a",
        )
        db.add(revision)
        db.flush()
        db.add(
            FamilyModelCapabilityBinding(
                id="member-status-llm-binding",
                family_id="family-a",
                config_revision_id=revision.id,
                capability=ModelUsageCapability.LLM,
                variant_key="primary",
                enabled=True,
                requested_model="never-expose-member-model",
                options_json={"supports_vision": True},
                billing_scheme_key="llm-split-v1",
                identity_checksum="b" * 64,
            )
        )
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        settings.active_config_revision_id = revision.id
        db.commit()


def test_member_ai_status_contains_only_safe_capability_state(
    family_model_api: FamilyModelApiContext,
) -> None:
    _activate_vision_llm(family_model_api)
    family_model_api.use_member()

    response = family_model_api.client.get("/api/ai/status")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload == {
        "configured": True,
        "enabled": True,
        "supports_vision": True,
        "status": "ready",
        "detail": "家庭 AI 服务已就绪。",
        "capabilities": {
            "llm": "available",
            "image_generation": "unavailable",
            "stt": "unavailable",
            "tts": "unavailable",
            "realtime_audio": "unavailable",
            "embedding": "unavailable",
            "rerank": "unavailable",
        },
    } | {"recipe_cook_contracts": payload["recipe_cook_contracts"]}
    forbidden = {
        "provider",
        "model",
        "base_url",
        "profile_id",
        "price",
        "credential",
        "never-expose-member-model",
    }
    assert forbidden.isdisjoint(_recursive_strings(payload))

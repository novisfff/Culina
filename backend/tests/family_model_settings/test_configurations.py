from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.core.enums import ModelUsageCapability
from app.models.domain import Family
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelConfigDraft,
    FamilyModelConfigRevision,
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
    FamilyModelSettings,
    FamilySearchProfile,
)
from app.models.model_usage import ModelUsagePriceVersion
from app.repos.family_model_settings.configurations import (
    get_capability_binding,
    get_config_draft,
    get_config_revision,
    get_family_price_version,
    get_search_profile,
    list_capability_bindings,
)
from app.repos.family_model_settings.profiles import get_provider_profile


def test_family_scoped_configuration_repositories_never_cross_family(
    model_usage_db: Session,
) -> None:
    db = model_usage_db
    now = datetime(2026, 8, 18, tzinfo=timezone.utc)
    db.add_all(
        [
            Family(id="family-config-a", name="A", motto="", location=""),
            Family(id="family-config-b", name="B", motto="", location=""),
            FamilyModelSettings(family_id="family-config-a"),
            FamilyModelSettings(family_id="family-config-b"),
            FamilyModelProviderProfile(
                id="profile-config-a",
                family_id="family-config-a",
                display_name="A",
                credential_scope_checksum="scope-a",
            ),
            FamilyModelProviderProfile(
                id="profile-config-b",
                family_id="family-config-b",
                display_name="B",
                credential_scope_checksum="scope-b",
            ),
            FamilyModelConfigDraft(
                family_id="family-config-a",
                draft_version_number=1,
                payload_json={},
            ),
            FamilyModelConfigDraft(
                family_id="family-config-b",
                draft_version_number=2,
                payload_json={},
            ),
            FamilyModelConfigRevision(
                id="revision-config-a",
                family_id="family-config-a",
                version_number=1,
                config_checksum="a" * 64,
                change_note="",
            ),
            FamilyModelConfigRevision(
                id="revision-config-b",
                family_id="family-config-b",
                version_number=1,
                config_checksum="b" * 64,
                change_note="",
            ),
            ModelUsagePriceVersion(
                id="price-config-a",
                family_id="family-config-a",
                config_revision_id="revision-config-a",
                purpose="active",
                version_number=1001,
                status="published",
                effective_from=now,
                reviewed_at=now,
                source_ref="test",
                change_note="test",
                operator="test",
                manifest_checksum="c" * 64,
                model_aliases_json={},
                fx_rates_json={"CNY": "1"},
            ),
            ModelUsagePriceVersion(
                id="price-config-b",
                family_id="family-config-b",
                config_revision_id="revision-config-b",
                purpose="active",
                version_number=1002,
                status="published",
                effective_from=now,
                reviewed_at=now,
                source_ref="test",
                change_note="test",
                operator="test",
                manifest_checksum="d" * 64,
                model_aliases_json={},
                fx_rates_json={"CNY": "1"},
            ),
        ]
    )
    db.flush()
    version = FamilyModelProviderProfileVersion(
        id="profile-version-config-a",
        family_id="family-config-a",
        profile_id="profile-config-a",
        version_number=1,
        adapter_kind="openai_compatible_http",
        auth_mode="no_auth",
        api_base_url="https://provider.example/v1",
        options_json={},
        credential_scope_checksum="scope-a",
        endpoint_fingerprint="endpoint-a",
    )
    db.add(version)
    db.add_all(
        [
            FamilyModelCapabilityBinding(
                id="binding-config-a",
                family_id="family-config-a",
                config_revision_id="revision-config-a",
                capability=ModelUsageCapability.LLM,
                variant_key="primary",
                enabled=True,
                provider_profile_id="profile-config-a",
                provider_profile_version_id=version.id,
                requested_model="model-a",
                options_json={},
                billing_scheme_key="llm-split-v1",
                identity_checksum="identity-a",
            ),
            FamilySearchProfile(
                id="search-config-a",
                family_id="family-config-a",
                provider_profile_id="profile-config-a",
                provider_profile_version_id=version.id,
                adapter_kind="openai_compatible_http",
                embedding_model="embed-a",
                dimensions=1024,
                document_builder_version="v1",
                index_identity_checksum="index-a",
                qdrant_collection="family_config_a",
            ),
        ]
    )
    db.flush()

    assert get_provider_profile(
        db, family_id="family-config-b", profile_id="profile-config-a"
    ) is None
    assert get_config_draft(db, family_id="family-config-b").draft_version_number == 2  # type: ignore[union-attr]
    assert get_config_revision(
        db,
        family_id="family-config-b",
        config_revision_id="revision-config-a",
    ) is None
    assert get_capability_binding(
        db,
        family_id="family-config-b",
        config_revision_id="revision-config-a",
        capability="llm",
        variant_key="primary",
    ) is None
    assert list_capability_bindings(
        db, family_id="family-config-b", config_revision_id="revision-config-a"
    ) == ()
    assert get_family_price_version(
        db, family_id="family-config-b", price_version_id="price-config-a"
    ) is None
    assert get_search_profile(
        db, family_id="family-config-b", search_profile_id="search-config-a"
    ) is None

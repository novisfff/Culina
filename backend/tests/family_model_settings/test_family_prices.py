from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.core.enums import FamilyModelPricePurpose, ModelUsageCapability
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelProviderProfileVersion,
    FamilySearchProfile,
)
from app.models.model_usage import ModelUsagePriceVersion
from app.repos.family_model_settings.profiles import get_family_model_settings
from app.repos.model_usage.catalog import next_price_version_number
from app.services.model_usage.errors import ModelUsageContractError
from app.services.model_usage.pricing import (
    family_price_version_for_context,
    lock_active_model_price_snapshot,
)
from app.services.model_usage.types import UsageAttribution, UsageContext
from app.core.enums import ModelUsageAttributionKind, ModelUsageOperationSource

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api
from tests.model_usage.test_family_price_linearization import _publish_initial


def test_active_snapshot_and_candidate_price_scope_are_family_bound(
    family_model_api: FamilyModelApiContext,
) -> None:
    initial = _publish_initial(family_model_api)
    now = datetime(2026, 8, 18, 11, 0, tzinfo=timezone.utc)

    with family_model_api.session_factory() as db:
        settings = get_family_model_settings(db, family_id="family-a")
        assert settings is not None
        assert settings.active_config_revision_id == initial["config_revision_id"]
        assert settings.active_price_version_id == initial["price_version_id"]
        active = lock_active_model_price_snapshot(db, family_id="family-a")
        binding = db.scalar(
            select(FamilyModelCapabilityBinding).where(
                FamilyModelCapabilityBinding.family_id == "family-a",
                FamilyModelCapabilityBinding.config_revision_id == active.config_revision_id,
                FamilyModelCapabilityBinding.capability == ModelUsageCapability.LLM,
            )
        )
        assert binding is not None
        assert binding.provider_profile_id is not None
        assert binding.provider_profile_version_id is not None
        profile_version = db.get(
            FamilyModelProviderProfileVersion,
            binding.provider_profile_version_id,
        )
        assert profile_version is not None
        candidate_profile = FamilySearchProfile(
            id="family-price-candidate-profile",
            family_id="family-a",
            provider_profile_id=binding.provider_profile_id,
            provider_profile_version_id=binding.provider_profile_version_id,
            adapter_kind=profile_version.adapter_kind,
            embedding_model="candidate-embedding-model",
            dimensions=4,
            distance="Cosine",
            document_builder_version="family-model-search-v1",
            index_identity_checksum="a" * 64,
            qdrant_collection="family_price_candidate_collection",
        )
        db.add(candidate_profile)
        db.flush()
        candidate = ModelUsagePriceVersion(
            id="family-price-candidate-version",
            family_id="family-a",
            config_revision_id=None,
            search_profile_id=candidate_profile.id,
            base_price_version_id=None,
            purpose=FamilyModelPricePurpose.SEARCH_REBUILD_CANDIDATE,
            published_by="owner-a",
            version_number=next_price_version_number(db),
            status="published",
            effective_from=now,
            reviewed_at=now,
            source_ref="family-managed-model-settings",
            change_note="候选搜索价格",
            operator="owner-a",
            change_ticket=None,
            manifest_checksum="b" * 64,
            model_aliases_json={},
            fx_rates_json={"CNY": "1"},
        )
        db.add(candidate)
        db.flush()
        candidate_context = UsageContext(
            attribution=UsageAttribution(
                family_id="family-a",
                attribution_kind=ModelUsageAttributionKind.SYSTEM,
                actor_user_id=None,
                operation_source=ModelUsageOperationSource.BACKGROUND_INDEX,
                logical_operation_id="candidate-search-index",
            ),
            capability=ModelUsageCapability.EMBEDDING,
            provider=binding.provider_profile_id,
            requested_model="candidate-embedding-model",
            billing_model="candidate-embedding-model",
            variant_key="search",
            operation_kind="candidate_search_index",
            attempt_key="candidate-search-attempt",
            client_attempt_id="mua_candidate_search",
            config_revision_id=None,
            provider_profile_id=binding.provider_profile_id,
            provider_profile_version_id=binding.provider_profile_version_id,
            search_profile_id=candidate_profile.id,
            explicit_price_version_id=candidate.id,
        )
        selected = family_price_version_for_context(db, candidate_context)
        db.commit()

    assert active.config_revision_id == initial["config_revision_id"]
    assert active.price_version_id == initial["price_version_id"]
    assert selected is not None and selected.id == "family-price-candidate-version"
    with family_model_api.session_factory() as db:
        with pytest.raises(ModelUsageContractError, match="candidate_price_scope_mismatch"):
            family_price_version_for_context(
                db,
                candidate_context.for_capability(ModelUsageCapability.LLM),
            )

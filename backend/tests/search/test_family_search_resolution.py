from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select

from app.core.enums import (
    FamilyModelSearchProfileStatus,
    IngredientExpiryMode,
)
from app.models.domain import Ingredient
from app.models.family_model_settings import FamilyModelSettings, FamilySearchProfile
from app.models.model_usage import ModelUsagePriceRate
from app.repos.family_model_settings.search_profiles import list_profile_documents
from app.services.family_model_settings.errors import FamilyModelSettingsError
from app.services.family_model_settings.prices import (
    PublishFamilyPriceVersionCommand,
    publish_family_price_version,
    validate_complete_family_price_rates,
)
from app.services.family_model_settings.resolver import FamilyModelConfigurationResolver
from app.services.family_model_settings.search_profiles import (
    activate_ready_search_profile,
    seed_search_profile_documents,
)
from app.services.family_model_settings.validation import price_checksum
from app.services.search import hybrid as hybrid_module
from app.services.search.documents import SearchDocumentPayload
from app.services.search.hybrid import hybrid_search, resolve_family_search_runtime
from app.services.search.indexing import upsert_search_document
from tests.family_model_settings._support import FamilyModelApiContext, family_model_api
from tests.search._support import (
    DisabledFakeRerankClient,
    ExplodingEmbeddingClient,
    FakeVectorStore,
    search_settings,
)


def _rates(*, embedding_price: str = "0.02") -> list[dict[str, str]]:
    return [
        {
            "capability": "llm",
            "variant_key": "primary",
            "meter": meter,
            "unit_quantity": "1000",
            "unit_price": "0.01",
            "source_currency": "CNY",
            "fx_to_cny": "1",
        }
        for meter in ("uncached_input_tokens", "cached_input_tokens", "output_tokens")
    ] + [
        {
            "capability": "embedding",
            "variant_key": "search",
            "meter": "embedding_tokens",
            "unit_quantity": "1000",
            "unit_price": embedding_price,
            "source_currency": "CNY",
            "fx_to_cny": "1",
        }
    ]


def _publish_initial_configuration(
    context: FamilyModelApiContext,
    *,
    profile_id: str,
    id_suffix: str,
) -> dict[str, Any]:
    settings = context.client.get("/api/family/model-settings")
    assert settings.status_code == 200, settings.text
    draft = context.client.get("/api/family/model-settings/draft")
    base_draft_version = (
        draft.json()["draft_version_number"] if draft.status_code == 200 else 0
    )
    saved = context.client.put(
        "/api/family/model-settings/draft",
        json={
            "base_config_revision_id": settings.json().get("active_config_revision_id"),
            "base_draft_version_number": base_draft_version,
            "idempotency_key": f"family-search-draft-{id_suffix}",
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "enabled": True,
                    "provider_profile_id": profile_id,
                    "requested_model": "family-llm",
                    "max_output_tokens": 256,
                },
                {
                    "capability": "embedding",
                    "variant_key": "search",
                    "enabled": True,
                    "provider_profile_id": profile_id,
                    "requested_model": "family-embedding",
                    "dimensions": 2,
                },
            ],
            "price_rates": _rates(),
            "change_note": "family search runtime test",
            "confirm_initial_search_index": True,
        },
    )
    assert saved.status_code == 200, saved.text
    saved_payload = saved.json()["payload"]
    assert saved_payload["search_profile_id"] is not None
    return {"search_profile_id": saved_payload["search_profile_id"]}


def _resolver(context: FamilyModelApiContext, db) -> FamilyModelConfigurationResolver:
    return FamilyModelConfigurationResolver(
        db,
        network_policy=context.policy,
        cipher=context.cipher,
    )


def _activate_profile(context: FamilyModelApiContext, *, profile_id: str) -> None:
    with context.session_factory() as db:
        seed_search_profile_documents(
            db,
            family_id="family-a",
            profile_id=profile_id,
            enqueue_jobs=False,
        )
        for row in list_profile_documents(
            db,
            family_id="family-a",
            search_profile_id=profile_id,
            for_update=True,
        ):
            row.status = "indexed"
        db.flush()
        activate_ready_search_profile(
            db,
            family_id="family-a",
            profile_id=profile_id,
            actor_user_id="owner-a",
        )
        db.commit()


def _publish_price_only_change(context: FamilyModelApiContext) -> str:
    with context.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        assert settings.active_config_revision_id is not None
        assert settings.active_price_version_id is not None
        rates = []
        for rate in db.scalars(
            select(ModelUsagePriceRate)
            .where(ModelUsagePriceRate.price_version_id == settings.active_price_version_id)
            .order_by(
                ModelUsagePriceRate.capability,
                ModelUsagePriceRate.variant_key,
                ModelUsagePriceRate.meter,
            )
        ):
            rates.append(
                {
                    "capability": rate.capability.value,
                    "variant_key": rate.variant_key,
                    "meter": rate.meter.value,
                    "unit_quantity": str(rate.unit_quantity),
                    "unit_price": (
                        "0.031"
                        if rate.capability.value == "embedding"
                        else str(rate.unit_price)
                    ),
                    "source_currency": str(rate.source_currency),
                    "fx_to_cny": str(rate.fx_to_cny),
                    "reported_model_aliases": list(rate.reported_model_aliases),
                }
            )
        validated = validate_complete_family_price_rates(
            db,
            family_id="family-a",
            config_revision_id=settings.active_config_revision_id,
            rates=rates,
        )
        result = publish_family_price_version(
            db,
            PublishFamilyPriceVersionCommand(
                family_id="family-a",
                actor_user_id="owner-a",
                base_settings_version_number=settings.version_number,
                base_price_version_id=settings.active_price_version_id,
                idempotency_key="family-search-price-change",
                confirm_checksum=price_checksum(validated),
                change_note="search query price snapshot test",
                rates=rates,
            ),
            cipher=context.cipher,
        )
        db.commit()
        return result.price_version_id


def _seed_keyword_document(context: FamilyModelApiContext) -> None:
    with context.session_factory() as db:
        ingredient = Ingredient(
            id="ingredient-family-search",
            family_id="family-a",
            name="番茄",
            category="蔬菜",
            default_unit="个",
            unit_conversions=[],
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        db.add(ingredient)
        db.flush()
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-a",
                entity_type="ingredient",
                entity_id=ingredient.id,
                title_text="番茄",
                keyword_text="番茄 蔬菜",
                detail_text="",
                semantic_text="食材：番茄",
                metadata_json={"name": "番茄"},
                content_hash="family-search-tomato",
            ),
        )
        db.commit()


def test_unconfigured_family_search_is_keyword_only_without_a_legacy_runtime(
    family_model_api: FamilyModelApiContext,
) -> None:
    with family_model_api.session_factory() as db:
        runtime, resolver = hybrid_module._resolve_hybrid_search_runtime(
            db,
            family_id="family-without-model-settings",
            resolver=None,
        )

    assert resolver is None
    assert runtime.family_managed is True
    assert runtime.embedding is None
    assert runtime.rerank is None
    assert runtime.embedding_degradation_code == "search_embedding_not_configured"


def test_provisioning_profile_forces_keyword_search_without_legacy_provider(
    family_model_api: FamilyModelApiContext,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = family_model_api.create_profile(idempotency_key="family-search-provider")
    published = _publish_initial_configuration(
        family_model_api,
        profile_id=str(provider["id"]),
        id_suffix="provisioning",
    )
    profile_id = str(published["search_profile_id"])
    _seed_keyword_document(family_model_api)

    with family_model_api.session_factory() as db:
        runtime = resolve_family_search_runtime(
            db,
            family_id="family-a",
            resolver=_resolver(family_model_api, db),
        )
        profile = db.get(FamilySearchProfile, profile_id)
        assert profile is not None
        assert profile.status is FamilyModelSearchProfileStatus.PROVISIONING
        assert runtime.embedding is None
        assert runtime.rerank is None
        assert runtime.embedding_degradation_code == "search_embedding_provisioning"

    monkeypatch.setattr(hybrid_module, "get_settings", lambda: search_settings())
    disabled_rerank = DisabledFakeRerankClient()
    with family_model_api.session_factory() as db:
        response = hybrid_search(
            db,
            family_id="family-a",
            query="番茄",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=ExplodingEmbeddingClient(),
            vector_store=FakeVectorStore([]),
            rerank_client=disabled_rerank,
            family_resolver=_resolver(family_model_api, db),
        )

    assert response.search_mode == "keyword"
    assert response.degraded is True
    assert response.degradation_code == "search_embedding_provisioning"
    assert [item.entity_id for item in response.items] == ["ingredient-family-search"]
    assert disabled_rerank.documents == []


def test_active_family_search_snapshot_isolated_from_price_changes_and_other_families(
    family_model_api: FamilyModelApiContext,
) -> None:
    provider = family_model_api.create_profile(idempotency_key="family-search-active-provider")
    published = _publish_initial_configuration(
        family_model_api,
        profile_id=str(provider["id"]),
        id_suffix="active",
    )
    profile_id = str(published["search_profile_id"])
    _seed_keyword_document(family_model_api)
    _activate_profile(family_model_api, profile_id=profile_id)

    with family_model_api.session_factory() as db:
        runtime_before = resolve_family_search_runtime(
            db,
            family_id="family-a",
            resolver=_resolver(family_model_api, db),
        )
        assert runtime_before.embedding is not None
        assert runtime_before.embedding.search_profile_id == profile_id
        assert runtime_before.embedding.qdrant_collection.startswith("culina_fsp_")
        assert runtime_before.embedding_usage_snapshot is not None
        assert runtime_before.rerank is None
        before_price_version_id = runtime_before.embedding_usage_snapshot.price_version_id

        with pytest.raises(FamilyModelSettingsError, match="family_search_profile_not_found"):
            _resolver(family_model_api, db).resolve_search_profile("family-b", profile_id)

    new_price_version_id = _publish_price_only_change(family_model_api)

    with family_model_api.session_factory() as db:
        runtime_after = resolve_family_search_runtime(
            db,
            family_id="family-a",
            resolver=_resolver(family_model_api, db),
        )

    assert runtime_before.embedding_usage_snapshot is not None
    assert runtime_before.embedding_usage_snapshot.price_version_id == before_price_version_id
    assert runtime_after.embedding is not None
    assert runtime_after.embedding.search_profile_id == profile_id
    assert runtime_after.embedding_usage_snapshot is not None
    assert runtime_after.embedding_usage_snapshot.price_version_id == new_price_version_id
    assert runtime_after.embedding_usage_snapshot.price_version_id != before_price_version_id

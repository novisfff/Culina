from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.core.enums import FamilyModelPricePurpose, FamilyModelSearchProfileStatus
from app.models.domain import SearchDocument
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelConfigRevision,
    FamilyModelSettings,
    FamilySearchProfile,
)
from app.models.model_usage import ModelUsagePriceRate, ModelUsagePriceVersion
from app.repos.family_model_settings.resource_operations import get_resource_operation
from app.repos.family_model_settings.search_profiles import list_profile_documents
from app.services.family_model_settings.search_profiles import (
    CreateSearchReplacementCommand,
    SearchReplacementMutationCommand,
    activate_ready_search_profile,
    cancel_search_replacement,
    create_search_replacement,
    preview_search_replacement,
    retry_search_replacement,
    seed_search_profile_documents,
)
from app.services.search.jobs import _activate_profile_if_ready

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


def _rates(*, llm_price: str = "0.01", embedding_price: str = "0.02") -> list[dict[str, str]]:
    return [
        {
            "capability": "llm",
            "variant_key": "primary",
            "meter": meter,
            "unit_quantity": "1000",
            "unit_price": llm_price,
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


def _payload(profile_id: str, *, llm_model: str = "family-llm") -> dict[str, object]:
    return {
        "bindings": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "enabled": True,
                "provider_profile_id": profile_id,
                "requested_model": llm_model,
                "max_output_tokens": 256,
            },
            {
                "capability": "embedding",
                "variant_key": "search",
                "enabled": True,
                "provider_profile_id": profile_id,
                "requested_model": "family-embedding-a",
                "dimensions": 2,
            },
        ],
        "price_rates": _rates(),
        "change_note": "search replacement test",
    }


def _publish(
    context: FamilyModelApiContext,
    *,
    profile_id: str,
    llm_model: str = "family-llm",
    id_suffix: str,
) -> dict[str, Any]:
    settings = context.client.get("/api/family/model-settings")
    assert settings.status_code == 200, settings.text
    current_draft = context.client.get("/api/family/model-settings/draft")
    base_draft = current_draft.json()["draft_version_number"] if current_draft.status_code == 200 else 0
    saved = context.client.put(
        "/api/family/model-settings/draft",
        json=_payload(profile_id, llm_model=llm_model)
        | {
            "base_config_revision_id": settings.json().get("active_config_revision_id"),
            "base_draft_version_number": base_draft,
            "idempotency_key": f"search-rebuild-draft-{id_suffix}",
            "confirm_initial_search_index": True,
        },
    )
    assert saved.status_code == 200, saved.text
    return {"search_profile_id": saved.json()["payload"]["search_profile_id"]}


def _activate_initial(context: FamilyModelApiContext, profile_id: str) -> None:
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
        db.commit()
    _activate_profile_if_ready(
        family_id="family-a",
        profile_id=profile_id,
        session_factory=context.session_factory,
    )


def _replacement_command(
    *,
    settings_version: int,
    base_profile_id: str,
    provider_profile_id: str,
    checksum: str = "",
    key: str = "search-replacement-create",
) -> CreateSearchReplacementCommand:
    return CreateSearchReplacementCommand(
        family_id="family-a",
        actor_user_id="owner-a",
        current_password="OwnerPass123",
        base_settings_version_number=settings_version,
        base_search_profile_id=base_profile_id,
        provider_profile_id=provider_profile_id,
        requested_model="family-embedding-b",
        dimensions=3,
        rates=[
            {
                "capability": "embedding",
                "variant_key": "search",
                "meter": "embedding_tokens",
                "unit_quantity": "1000",
                "unit_price": "0.03",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            }
        ],
        confirm_checksum=checksum,
        idempotency_key=key,
    )


def test_initial_profile_remains_keyword_only_until_activation(
    family_model_api: FamilyModelApiContext,
) -> None:
    provider = family_model_api.create_profile(idempotency_key="search-initial-provider")
    published = _publish(
        family_model_api,
        profile_id=str(provider["id"]),
        id_suffix="initial",
    )
    profile_id = str(published["search_profile_id"])

    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        profile = db.get(FamilySearchProfile, profile_id)
        assert settings is not None and profile is not None
        assert settings.active_search_profile_id is None
        assert profile.status is FamilyModelSearchProfileStatus.PROVISIONING

    _activate_initial(family_model_api, profile_id)

    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        profile = db.get(FamilySearchProfile, profile_id)
        assert settings is not None and profile is not None
        assert settings.active_search_profile_id == profile_id
        assert profile.status is FamilyModelSearchProfileStatus.ACTIVE


def test_replacement_creates_one_candidate_collection_price_and_outbox(
    family_model_api: FamilyModelApiContext,
) -> None:
    first_provider = family_model_api.create_profile(idempotency_key="search-a-provider")
    initial = _publish(
        family_model_api,
        profile_id=str(first_provider["id"]),
        id_suffix="replacement-initial",
    )
    _activate_initial(family_model_api, str(initial["search_profile_id"]))
    second_provider = family_model_api.create_profile(
        display_name="家庭 Embedding B",
        idempotency_key="search-b-provider",
    )

    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_search_profile_id is not None
        command = _replacement_command(
            settings_version=settings.version_number,
            base_profile_id=settings.active_search_profile_id,
            provider_profile_id=str(second_provider["id"]),
        )
        preview = preview_search_replacement(db, command, network_policy=family_model_api.policy)
        command = _replacement_command(
            settings_version=settings.version_number,
            base_profile_id=settings.active_search_profile_id,
            provider_profile_id=str(second_provider["id"]),
            checksum=preview.confirmation_checksum,
        )
        created = create_search_replacement(
            db,
            command,
            cipher=family_model_api.cipher,
            network_policy=family_model_api.policy,
        )
        db.commit()

    with family_model_api.session_factory() as db:
        profile = db.get(FamilySearchProfile, created.profile_id)
        assert profile is not None
        assert profile.status is FamilyModelSearchProfileStatus.PROVISIONING
        assert profile.base_search_profile_id == str(initial["search_profile_id"])
        assert profile.qdrant_collection.startswith("culina_fsp_")
        price = db.get(ModelUsagePriceVersion, created.candidate_price_version_id)
        assert price is not None
        assert price.purpose is FamilyModelPricePurpose.SEARCH_REBUILD_CANDIDATE
        assert price.search_profile_id == profile.id
        assert {
            value.capability.value
            for value in db.scalars(
                select(ModelUsagePriceRate).where(ModelUsagePriceRate.price_version_id == price.id)
            )
        } == {"embedding"}
        operation = get_resource_operation(
            db,
            family_id="family-a",
            operation_type="ensure_search_profile_collection",
            resource_key=f"ensure-search-profile:{profile.id}",
        )
        assert operation is not None
        assert operation.qdrant_collection_snapshot == profile.qdrant_collection

        replay = create_search_replacement(
            db,
            command,
            cipher=family_model_api.cipher,
            network_policy=family_model_api.policy,
        )
        assert replay.profile_id == created.profile_id


def test_activation_merges_candidate_embedding_without_restoring_old_llm(
    family_model_api: FamilyModelApiContext,
) -> None:
    first_provider = family_model_api.create_profile(idempotency_key="search-activation-a")
    initial = _publish(
        family_model_api,
        profile_id=str(first_provider["id"]),
        llm_model="old-llm",
        id_suffix="activation-initial",
    )
    _activate_initial(family_model_api, str(initial["search_profile_id"]))
    second_provider = family_model_api.create_profile(
        display_name="家庭 Embedding replacement",
        idempotency_key="search-activation-b",
    )

    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_search_profile_id is not None
        raw_command = _replacement_command(
            settings_version=settings.version_number,
            base_profile_id=settings.active_search_profile_id,
            provider_profile_id=str(second_provider["id"]),
        )
        preview = preview_search_replacement(
            db, raw_command, network_policy=family_model_api.policy
        )
        candidate = create_search_replacement(
            db,
            _replacement_command(
                settings_version=settings.version_number,
                base_profile_id=settings.active_search_profile_id,
                provider_profile_id=str(second_provider["id"]),
                checksum=preview.confirmation_checksum,
                key="search-activation-create",
            ),
            cipher=family_model_api.cipher,
            network_policy=family_model_api.policy,
        )
        db.commit()

    _publish(
        family_model_api,
        profile_id=str(first_provider["id"]),
        llm_model="new-llm",
        id_suffix="activation-concurrent-config",
    )

    with family_model_api.session_factory() as db:
        seed_search_profile_documents(
            db,
            family_id="family-a",
            profile_id=candidate.profile_id,
            enqueue_jobs=False,
        )
        for row in list_profile_documents(
            db,
            family_id="family-a",
            search_profile_id=candidate.profile_id,
            for_update=True,
        ):
            row.status = "indexed"
        activated = activate_ready_search_profile(
            db,
            family_id="family-a",
            profile_id=candidate.profile_id,
            actor_user_id="owner-a",
        )
        db.commit()

    with family_model_api.session_factory() as db:
        revision = db.get(FamilyModelConfigRevision, activated.config_revision_id)
        assert revision is not None
        bindings = {
            (binding.capability.value, binding.variant_key): binding
            for binding in db.scalars(
                select(FamilyModelCapabilityBinding).where(
                    FamilyModelCapabilityBinding.config_revision_id == revision.id
                )
            )
        }
        assert bindings[("llm", "primary")].requested_model == "new-llm"
        assert bindings[("embedding", "search")].requested_model == "family-embedding-b"
        active_price = db.get(ModelUsagePriceVersion, activated.price_version_id)
        assert active_price is not None
        assert active_price.purpose is FamilyModelPricePurpose.ACTIVE
        assert active_price.search_profile_id is None


def test_retry_and_cancel_reuse_candidate_profile_without_overwriting_active(
    family_model_api: FamilyModelApiContext,
) -> None:
    first_provider = family_model_api.create_profile(idempotency_key="search-retry-a")
    initial = _publish(
        family_model_api,
        profile_id=str(first_provider["id"]),
        id_suffix="retry-initial",
    )
    _activate_initial(family_model_api, str(initial["search_profile_id"]))
    second_provider = family_model_api.create_profile(
        display_name="家庭 Embedding retry",
        idempotency_key="search-retry-b",
    )

    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_search_profile_id is not None
        draft = _replacement_command(
            settings_version=settings.version_number,
            base_profile_id=settings.active_search_profile_id,
            provider_profile_id=str(second_provider["id"]),
        )
        preview = preview_search_replacement(db, draft, network_policy=family_model_api.policy)
        candidate = create_search_replacement(
            db,
            _replacement_command(
                settings_version=settings.version_number,
                base_profile_id=settings.active_search_profile_id,
                provider_profile_id=str(second_provider["id"]),
                checksum=preview.confirmation_checksum,
                key="search-retry-create",
            ),
            cipher=family_model_api.cipher,
            network_policy=family_model_api.policy,
        )
        profile = db.get(FamilySearchProfile, candidate.profile_id)
        assert profile is not None
        collection = profile.qdrant_collection
        profile.status = FamilyModelSearchProfileStatus.FAILED
        db.commit()

    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        retried = retry_search_replacement(
            db,
            SearchReplacementMutationCommand(
                family_id="family-a",
                actor_user_id="owner-a",
                profile_id=candidate.profile_id,
                base_settings_version_number=settings.version_number,
                idempotency_key="search-retry-action",
            ),
            cipher=family_model_api.cipher,
        )
        db.commit()
        assert retried.profile_id == candidate.profile_id

    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        profile = db.get(FamilySearchProfile, candidate.profile_id)
        assert settings is not None and profile is not None
        assert profile.qdrant_collection == collection
        assert profile.status is FamilyModelSearchProfileStatus.PROVISIONING
        cancelled = cancel_search_replacement(
            db,
            SearchReplacementMutationCommand(
                family_id="family-a",
                actor_user_id="owner-a",
                profile_id=candidate.profile_id,
                base_settings_version_number=settings.version_number,
                idempotency_key="search-cancel-action",
            ),
            cipher=family_model_api.cipher,
        )
        db.commit()
        assert cancelled.progress.status == "cancelled"
        refreshed = db.get(FamilyModelSettings, "family-a")
        assert refreshed is not None
        assert refreshed.active_search_profile_id == str(initial["search_profile_id"])

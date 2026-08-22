from __future__ import annotations

from collections.abc import Mapping

from app.api import family_model_settings as family_model_settings_api
from app.main import app
from app.services.family_model_settings.capability_tests import CapabilityTestDependencies
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.search.hybrid import resolve_family_search_runtime

from tests.family_model_settings._support import (
    SECRET_MARKER,
    FamilyModelApiContext,
    family_model_api,
)
from tests.family_model_settings.fake_provider import FakeFamilyModelProvider
from tests.family_model_settings.test_capability_tests import _publish_llm


def _install_fake_provider(
    context: FamilyModelApiContext,
    provider: FakeFamilyModelProvider,
) -> None:
    app.dependency_overrides[
        family_model_settings_api.get_family_model_capability_test_dependencies
    ] = lambda: CapabilityTestDependencies(
        cipher=context.cipher,
        network_policy=context.policy,
        transport=provider,  # type: ignore[arg-type]
        usage_facade=ModelUsageFacade(session_factory=context.session_factory),
        signer=ProviderUsageReceiptSigner(
            active_key_id="cutover-acceptance",
            keys={"cutover-acceptance": b"family-model-cutover-acceptance-key"},
        ),
        session_factory=context.session_factory,
    )


def _recursive_strings(value: object) -> set[str]:
    if isinstance(value, Mapping):
        values = {str(key) for key in value}
        for nested in value.values():
            values.update(_recursive_strings(nested))
        return values
    if isinstance(value, list):
        return {item for nested in value for item in _recursive_strings(nested)}
    return {str(value)}


def test_unconfigured_family_fails_closed_without_a_provider_send(
    family_model_api: FamilyModelApiContext,
) -> None:
    provider = FakeFamilyModelProvider()
    _install_fake_provider(family_model_api, provider)

    status = family_model_api.client.get("/api/ai/status")
    capability = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "idempotency_key": "cutover-unconfigured-llm",
        },
    )
    with family_model_api.session_factory() as db:
        search_runtime = resolve_family_search_runtime(db, family_id="family-a")

    assert status.status_code == 200, status.text
    assert status.json()["status"] == "not_configured"
    assert status.json()["configured"] is False
    assert capability.status_code == 422, capability.text
    assert capability.json()["detail"]["code"] == "family_model_settings_not_configured"
    assert search_runtime.embedding is None
    assert search_runtime.rerank is None
    assert search_runtime.embedding_degradation_code == "search_embedding_not_configured"
    assert provider.request_count == 0


def test_owner_configuration_never_crosses_family_boundary_or_member_privacy_boundary(
    family_model_api: FamilyModelApiContext,
) -> None:
    provider = FakeFamilyModelProvider()
    _install_fake_provider(family_model_api, provider)
    _publish_llm(family_model_api)
    owner_test = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "idempotency_key": "cutover-family-a-llm",
        },
    )
    assert owner_test.status_code == 200, owner_test.text
    assert len(provider.requests_for(SECRET_MARKER)) == 1

    family_model_api.use_owner("family-b")
    other_family = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "idempotency_key": "cutover-family-b-llm",
        },
    )
    assert other_family.status_code == 422, other_family.text
    assert other_family.json()["detail"]["code"] == "family_model_settings_not_configured"
    assert provider.request_count == 1

    family_model_api.use_member()
    owner_reads = (
        family_model_api.client.get("/api/family/model-settings"),
        family_model_api.client.get("/api/family/model-settings/draft"),
        family_model_api.client.get("/api/family/model-settings/prices"),
    )
    owner_write = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "idempotency_key": "cutover-member-no-test",
        },
    )
    member_status = family_model_api.client.get("/api/ai/status")

    assert all(response.status_code == 403 for response in owner_reads)
    assert owner_write.status_code == 403
    assert provider.request_count == 1
    assert member_status.status_code == 200, member_status.text
    member_strings = _recursive_strings(member_status.json())
    forbidden = {
        "provider",
        "model",
        "base_url",
        "profile",
        "price",
        "credential",
        SECRET_MARKER,
        "capability-test-model",
        "https://provider.example/v1",
    }
    assert forbidden.isdisjoint(member_strings)

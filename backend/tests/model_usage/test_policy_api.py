from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy import select

from app.core.enums import ActivityAction, ModelUsageCapability, ModelUsageMeter
from app.models.domain import ActivityLog
from app.services.model_usage.configured_variants import ConfiguredUsageVariant
from app.services.model_usage.pricing import PriceCoverageReport


pytest_plugins = ("tests.model_usage._usage_api_support",)


def policy_payload(
    *,
    base_version_number: int = 1,
    monthly_budget_cny: str | None = "80.005000000000",
    alerts_enabled: bool = True,
    hard_limit_enabled: bool = False,
    capability_limits: list[dict[str, object]] | None = None,
    confirm_missing_price_impact: bool = False,
) -> dict[str, object]:
    return {
        "base_version_number": base_version_number,
        "monthly_budget_cny": monthly_budget_cny,
        "alerts_enabled": alerts_enabled,
        "hard_limit_enabled": hard_limit_enabled,
        "capability_limits": capability_limits or [],
        "confirm_missing_price_impact": confirm_missing_price_impact,
    }


def test_owner_gets_the_complete_current_immutable_policy(usage_api_context) -> None:
    response = usage_api_context.client.get("/api/model-usage/family/policy")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload == {
        "version_number": 1,
        "monthly_budget_cny": None,
        "alerts_enabled": True,
        "hard_limit_enabled": False,
        "budget_alert_revision": 1,
        "capability_limits": [],
        "effective_at": payload["effective_at"],
    }
    assert payload["effective_at"].endswith("Z")
    assert {"id", "family_id", "created_by_subject_id", "policy_checksum"}.isdisjoint(
        payload
    )


def test_owner_policy_put_preserves_decimal_strings_and_writes_amount_free_activity(
    usage_api_context,
    monkeypatch,
) -> None:
    import app.api.model_usage as model_usage_api

    active_llm = ConfiguredUsageVariant(
        provider="profile-test",
        billing_model="model-test",
        capability=ModelUsageCapability.LLM,
        variant_key="primary",
        billing_scheme_key="llm-split-v1",
        billable_meters=frozenset(
            {
                ModelUsageMeter.UNCACHED_INPUT_TOKENS,
                ModelUsageMeter.CACHED_INPUT_TOKENS,
                ModelUsageMeter.OUTPUT_TOKENS,
            }
        ),
        produced_meters=frozenset(
            {
                ModelUsageMeter.UNCACHED_INPUT_TOKENS,
                ModelUsageMeter.CACHED_INPUT_TOKENS,
                ModelUsageMeter.OUTPUT_TOKENS,
            }
        ),
    )
    monkeypatch.setattr(
        model_usage_api,
        "get_family_model_settings",
        lambda *_args, **_kwargs: SimpleNamespace(
            active_config_revision_id="revision-test",
            active_price_version_id="price-test",
        ),
    )
    monkeypatch.setattr(
        model_usage_api,
        "configured_usage_variants",
        lambda *_args, **_kwargs: (active_llm,),
    )
    response = usage_api_context.client.put(
        "/api/model-usage/family/policy",
        json=policy_payload(
            capability_limits=[
                {
                    "capability": "llm",
                    "limit_kind": "cost",
                    "meter": None,
                    "limit_value": "10.005000000000",
                    "enabled": True,
                }
            ]
        ),
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["version_number"] == 2
    assert payload["monthly_budget_cny"] == "80.005000000000"
    assert payload["capability_limits"] == [
        {
            "capability": "llm",
            "limit_kind": "cost",
            "meter": None,
            "limit_value": "10.005000000000",
            "enabled": True,
        }
    ]

    with usage_api_context.SessionLocal() as db:
        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == usage_api_context.family_a_id,
                ActivityLog.actor_id == usage_api_context.owner_a_id,
                ActivityLog.action == ActivityAction.UPDATE,
                ActivityLog.entity_type == "ModelUsagePolicy",
            )
        )
        assert log is not None
        assert log.summary == "更新了模型预算设置"
        assert "80" not in log.summary
        assert "10" not in log.summary


def test_stale_policy_put_returns_current_policy_with_machine_readable_recovery(
    usage_api_context,
) -> None:
    first = usage_api_context.client.put(
        "/api/model-usage/family/policy",
        json=policy_payload(),
    )
    assert first.status_code == 200, first.text

    response = usage_api_context.client.put(
        "/api/model-usage/family/policy",
        json=policy_payload(monthly_budget_cny="99.000000000000"),
    )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "model_usage_policy_conflict"
    assert detail["current_version_number"] == 2
    assert detail["recovery_hint"] == "review_current_policy_and_reapply"
    assert detail["current_policy"]["version_number"] == 2
    assert detail["current_policy"]["monthly_budget_cny"] == "80.005000000000"


def test_policy_request_rejects_client_supplied_actor_or_family_identity(
    usage_api_context,
) -> None:
    payload = policy_payload()
    payload["actor_subject_id"] = "other-family-subject"
    payload["family_id"] = usage_api_context.family_b_id

    response = usage_api_context.client.put(
        "/api/model-usage/family/policy",
        json=payload,
    )

    assert response.status_code == 422, response.text


def test_policy_rejects_invalid_budget_without_creating_a_new_version(
    usage_api_context,
) -> None:
    response = usage_api_context.client.put(
        "/api/model-usage/family/policy",
        json=policy_payload(monthly_budget_cny="0"),
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {
        "code": "positive_monthly_budget_required"
    }
    current = usage_api_context.client.get("/api/model-usage/family/policy")
    assert current.json()["version_number"] == 1


def test_policy_requires_explicit_confirmation_before_enabling_hard_limit_with_missing_prices(
    usage_api_context,
    monkeypatch,
) -> None:
    import app.api.model_usage as model_usage_api

    missing_variant = ConfiguredUsageVariant(
        provider="test-provider",
        billing_model="test-model",
        capability=ModelUsageCapability.LLM,
        variant_key="default",
        billing_scheme_key="test",
        billable_meters=frozenset({ModelUsageMeter.TOTAL_TOKENS}),
        produced_meters=frozenset({ModelUsageMeter.TOTAL_TOKENS}),
    )
    monkeypatch.setattr(
        model_usage_api,
        "get_family_model_settings",
        lambda *_args, **_kwargs: SimpleNamespace(
            active_config_revision_id="revision-test",
            active_price_version_id="price-test",
        ),
    )
    monkeypatch.setattr(
        model_usage_api,
        "configured_usage_variants",
        lambda *_args, **_kwargs: (missing_variant,),
    )
    monkeypatch.setattr(
        model_usage_api,
        "family_price_coverage",
        lambda *_args, **_kwargs: PriceCoverageReport(
            price_version_id=None,
            rows=(),
        ),
    )
    payload = policy_payload(hard_limit_enabled=True)

    blocked = usage_api_context.client.put(
        "/api/model-usage/family/policy",
        json=payload,
    )

    assert blocked.status_code == 422, blocked.text
    assert blocked.json()["detail"] == {
        "code": "model_usage_missing_price_confirmation_required"
    }

    confirmed = usage_api_context.client.put(
        "/api/model-usage/family/policy",
        json={**payload, "confirm_missing_price_impact": True},
    )
    assert confirmed.status_code == 200, confirmed.text

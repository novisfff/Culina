from __future__ import annotations

from zoneinfo import ZoneInfo

from app.models.domain import Membership
from tests.model_usage._usage_api_support import NOW


pytest_plugins = ("tests.model_usage._usage_api_support",)


def test_member_is_forbidden_from_every_family_usage_read_and_receives_no_amounts(
    usage_api_context,
) -> None:
    usage_api_context.use_auth(
        usage_api_context.member_a_id,
        usage_api_context.member_a_membership_id,
    )

    family_overview = usage_api_context.client.get(
        "/api/model-usage/family/overview",
        params={"period": usage_api_context.period},
    )
    family_breakdown = usage_api_context.client.get(
        "/api/model-usage/family/breakdown",
        params={"period": usage_api_context.period, "group_by": "subject"},
    )
    personal = usage_api_context.client.get(
        "/api/model-usage/me/overview",
        params={"period": usage_api_context.period},
    )
    policy = usage_api_context.client.get("/api/model-usage/family/policy")
    policy_update = usage_api_context.client.put(
        "/api/model-usage/family/policy",
        json={
            "base_version_number": 1,
            "monthly_budget_cny": "80",
            "alerts_enabled": True,
            "hard_limit_enabled": False,
            "capability_limits": [],
            "confirm_missing_price_impact": False,
        },
    )
    alerts = usage_api_context.client.get("/api/model-usage/alerts")

    assert family_overview.status_code == 403
    assert family_breakdown.status_code == 403
    assert policy.status_code == 403
    assert policy_update.status_code == 403
    assert alerts.status_code == 403
    assert personal.status_code == 200, personal.text
    payload = personal.json()
    assert payload["known_priced_cost_cny"] == "0.001000000000"
    assert payload["scope"] == "me"
    assert {
        "monthly_budget_cny",
        "effective_spend_cny",
        "reserved_cost_cny",
        "hard_limit_enabled",
        "capability_limits",
        "members",
        "system_usage",
    }.isdisjoint(payload)


def test_request_logs_use_a_date_range_without_exposing_family_data_to_members(
    usage_api_context,
) -> None:
    local_day = NOW.astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat()
    usage_api_context.use_auth(
        usage_api_context.member_a_id,
        usage_api_context.member_a_membership_id,
    )

    personal = usage_api_context.client.get(
        "/api/model-usage/me/requests",
        params={"date_from": local_day, "date_to": local_day},
    )
    family = usage_api_context.client.get(
        "/api/model-usage/family/requests",
        params={"date_from": local_day, "date_to": local_day},
    )

    assert personal.status_code == 200, personal.text
    assert personal.json()["date_from"] == local_day
    assert personal.json()["date_to"] == local_day
    assert personal.json()["scope"] == "me"
    assert family.status_code == 403


def test_request_logs_reject_an_inverted_or_missing_date_range(
    usage_api_context,
) -> None:
    inverted = usage_api_context.client.get(
        "/api/model-usage/family/requests",
        params={"date_from": "2026-08-10", "date_to": "2026-08-01"},
    )
    missing = usage_api_context.client.get(
        "/api/model-usage/family/requests",
        params={"date_from": "2026-08-01"},
    )

    assert inverted.status_code == 422
    assert inverted.json()["detail"]["code"] == "model_usage_invalid_date_range"
    assert missing.status_code == 422


def test_owner_scope_is_derived_from_membership_and_cannot_select_another_family(
    usage_api_context,
) -> None:
    usage_api_context.use_auth(
        usage_api_context.owner_b_id,
        usage_api_context.owner_b_membership_id,
    )

    response = usage_api_context.client.get(
        "/api/model-usage/family/overview",
        params={"period": usage_api_context.period, "family_id": usage_api_context.family_a_id},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["family_id"] == usage_api_context.family_b_id
    assert payload["known_priced_cost_cny"] == "99.000000000000"
    assert usage_api_context.family_a_id not in response.text


def test_personal_breakdown_rejects_owner_only_subject_grouping(
    usage_api_context,
) -> None:
    usage_api_context.use_auth(
        usage_api_context.member_a_id,
        usage_api_context.member_a_membership_id,
    )

    response = usage_api_context.client.get(
        "/api/model-usage/me/breakdown",
        params={"period": usage_api_context.period, "group_by": "subject"},
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "model_usage_personal_group_by_not_allowed"
    assert usage_api_context.secret_subject_key not in response.text


def test_personal_request_log_rejects_provider_model_filters_and_omits_diagnostics(
    usage_api_context,
) -> None:
    usage_api_context.use_auth(
        usage_api_context.member_a_id,
        usage_api_context.member_a_membership_id,
    )
    params = {
        "date_from": "2026-08-01",
        "date_to": "2026-08-31",
        "provider": "provider-secret",
        "model": "model-secret",
    }

    rejected = usage_api_context.client.get("/api/model-usage/me/requests", params=params)

    assert rejected.status_code == 422, rejected.text
    assert rejected.json()["detail"]["code"] == "model_usage_personal_filter_not_allowed"
    assert "provider-secret" not in rejected.text
    assert "model-secret" not in rejected.text

    response = usage_api_context.client.get(
        "/api/model-usage/me/requests",
        params={"date_from": "2026-08-01", "date_to": "2026-08-31"},
    )

    assert response.status_code == 200, response.text
    forbidden = {
        "provider",
        "requested_model",
        "billing_model",
        "provider_request_id",
        "subject_label",
        "cost_cny",
    }
    for item in response.json()["items"]:
        assert forbidden.isdisjoint(item)


def test_owner_subject_breakdown_hides_a_former_members_profile_name(
    usage_api_context,
) -> None:
    with usage_api_context.SessionLocal() as db:
        former_membership = db.get(
            Membership,
            usage_api_context.member_a_membership_id,
        )
        assert former_membership is not None
        db.delete(former_membership)
        db.commit()

    response = usage_api_context.client.get(
        "/api/model-usage/family/breakdown",
        params={"period": usage_api_context.period, "group_by": "subject"},
    )

    assert response.status_code == 200, response.text
    labels = {item["label"] for item in response.json()["items"]}
    assert "已退出成员" in labels
    assert "A 家庭成员" not in labels

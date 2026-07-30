from __future__ import annotations

from app.models.domain import Membership


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


def test_personal_subject_breakdown_uses_a_public_self_label_not_an_internal_key(
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

    assert response.status_code == 200, response.text
    assert [item["label"] for item in response.json()["items"]] == ["我"]
    assert usage_api_context.secret_subject_key not in response.text


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

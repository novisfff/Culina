from __future__ import annotations

pytest_plugins = ("tests.model_usage._usage_api_support",)


def _create_usage_alert(*args, **kwargs):
    from tests.model_usage._usage_api_support import create_usage_alert

    return create_usage_alert(*args, **kwargs)


def test_alert_list_is_owner_only_and_exposes_only_the_current_owner_receipt(
    usage_api_context,
) -> None:
    alert_id = _create_usage_alert(usage_api_context)

    owner_response = usage_api_context.client.get("/api/model-usage/alerts")
    assert owner_response.status_code == 200, owner_response.text
    assert [item["id"] for item in owner_response.json()] == [alert_id]
    assert "policy_version_id" not in owner_response.json()[0]
    assert "user_id" not in owner_response.json()[0]

    usage_api_context.use_auth(
        usage_api_context.member_a_id,
        usage_api_context.member_a_membership_id,
    )
    member_response = usage_api_context.client.get("/api/model-usage/alerts")
    assert member_response.status_code == 403


def test_alert_receipts_are_independent_for_each_owner_and_dismissal_filters_only_self(
    usage_api_context,
) -> None:
    alert_id = _create_usage_alert(usage_api_context)

    dismissed = usage_api_context.client.post(
        f"/api/model-usage/alerts/{alert_id}/dismiss"
    )
    assert dismissed.status_code == 200, dismissed.text
    assert dismissed.json()["alert_id"] == alert_id
    assert dismissed.json()["dismissed_at"] is not None
    assert usage_api_context.client.get("/api/model-usage/alerts").json() == []

    usage_api_context.use_auth(
        usage_api_context.owner_a2_id,
        usage_api_context.owner_a2_membership_id,
    )
    other_owner = usage_api_context.client.get("/api/model-usage/alerts")
    assert other_owner.status_code == 200, other_owner.text
    assert [item["id"] for item in other_owner.json()] == [alert_id]
    assert other_owner.json()[0]["dismissed_at"] is None


def test_alert_seen_and_dismiss_are_idempotent_with_stable_timestamps(
    usage_api_context,
) -> None:
    alert_id = _create_usage_alert(usage_api_context)

    first_seen = usage_api_context.client.post(
        f"/api/model-usage/alerts/{alert_id}/seen"
    )
    second_seen = usage_api_context.client.post(
        f"/api/model-usage/alerts/{alert_id}/seen"
    )
    assert first_seen.status_code == second_seen.status_code == 200
    assert first_seen.json()["seen_at"] == second_seen.json()["seen_at"]
    assert first_seen.json()["dismissed_at"] is None

    first_dismiss = usage_api_context.client.post(
        f"/api/model-usage/alerts/{alert_id}/dismiss"
    )
    second_dismiss = usage_api_context.client.post(
        f"/api/model-usage/alerts/{alert_id}/dismiss"
    )
    assert first_dismiss.status_code == second_dismiss.status_code == 200
    assert first_dismiss.json()["dismissed_at"] == second_dismiss.json()["dismissed_at"]
    assert first_dismiss.json()["seen_at"] == first_seen.json()["seen_at"]


def test_alert_mutation_rejects_cross_family_ids_without_disclosing_them(
    usage_api_context,
) -> None:
    other_alert_id = _create_usage_alert(
        usage_api_context,
        alert_id="usage-alert-b",
        family_id=usage_api_context.family_b_id,
        owner_ids=(usage_api_context.owner_b_id,),
    )

    response = usage_api_context.client.post(
        f"/api/model-usage/alerts/{other_alert_id}/dismiss"
    )

    assert response.status_code == 404
    assert response.json()["detail"] == {"code": "model_usage_alert_not_found"}

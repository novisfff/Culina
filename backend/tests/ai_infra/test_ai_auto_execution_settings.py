from ._support import *

from sqlalchemy.exc import IntegrityError


class AIAutoExecutionSettingsTestCase(AIAgentInfraTestCase):
    def test_defaults_are_off_and_catalog_limits_are_server_owned(self) -> None:
        response = self.client.get("/api/ai/auto-execution/settings")

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["catalog_version"], "auto-execution.v1")
        self.assertEqual(body["consent_notice"], {
            "version": "auto-execution-consent.v1",
            "acknowledged": False,
        })
        self.assertEqual({row["action_key"] for row in body["member_preferences"]}, {
            "food.set_favorite",
            "meal_log.rate_food",
            "shopping_list.safe_write",
            "meal_log.simple_create",
            "meal_plan.simple_create",
        })
        self.assertTrue(all(not row["enabled"] for row in body["member_preferences"]))
        self.assertTrue(all(not row["effective_enabled"] for row in body["member_preferences"]))
        self.assertTrue(all(row["row_version"] == 0 for row in body["member_preferences"]))
        self.assertEqual(body["family_policies"], [{
            "action_key": "shopping_list.safe_write",
            "enabled": False,
            "effective_enabled": False,
            "row_version": 0,
            "consent_notice_version": None,
            "requires_reconsent": False,
        }])
        self.assertEqual(body["limits"]["shopping_list.safe_write"]["add_or_restore_items"], 5)
        self.assertEqual(body["limits"]["shopping_list.safe_write"]["update_items"], 1)
        self.assertNotIn("food.set_favorite", body["limits"])

    def test_enable_requires_current_notice_and_expected_version(self) -> None:
        response = self.client.put(
            "/api/ai/auto-execution/preferences/food.set_favorite",
            json={
                "enabled": True,
                "expected_row_version": 0,
                "consent_notice_version": "auto-execution-consent.v1",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        favorite = next(
            row for row in body["member_preferences"]
            if row["action_key"] == "food.set_favorite"
        )
        self.assertTrue(favorite["enabled"])
        self.assertTrue(favorite["effective_enabled"])
        self.assertEqual(favorite["row_version"], 1)
        self.assertEqual(body["catalog_version"], "auto-execution.v1")
        self.assertEqual(body["consent_notice"]["acknowledged"], True)

        stale = self.client.put(
            "/api/ai/auto-execution/preferences/food.set_favorite",
            json={"enabled": False, "expected_row_version": 0},
        )
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(stale.json()["detail"]["code"], "auto_execution_settings_stale")

    def test_enabling_with_old_notice_is_a_structured_conflict(self) -> None:
        response = self.client.put(
            "/api/ai/auto-execution/preferences/meal_log.rate_food",
            json={
                "enabled": True,
                "expected_row_version": 0,
                "consent_notice_version": "auto-execution-consent.v0",
            },
        )

        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "auto_execution_consent_notice_stale")

    def test_family_policy_is_owner_only_and_member_reads_its_projection(self) -> None:
        member, member_membership = self.create_family_member()
        self.authenticate_as(member.id, member_membership.id)

        read = self.client.get("/api/ai/auto-execution/settings")
        self.assertEqual(read.status_code, 200, read.text)
        self.assertEqual(read.json()["family_policies"][0]["action_key"], "shopping_list.safe_write")
        self.assertFalse(read.json()["family_policies"][0]["effective_enabled"])

        forbidden = self.client.put(
            "/api/ai/auto-execution/family-policies/shopping_list.safe_write",
            json={
                "enabled": True,
                "expected_row_version": 0,
                "consent_notice_version": "auto-execution-consent.v1",
            },
        )
        self.assertEqual(forbidden.status_code, 403, forbidden.text)

    def test_owner_can_enable_the_shopping_family_policy(self) -> None:
        response = self.client.put(
            "/api/ai/auto-execution/family-policies/shopping_list.safe_write",
            json={
                "enabled": True,
                "expected_row_version": 0,
                "consent_notice_version": "auto-execution-consent.v1",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        policy = response.json()["family_policies"][0]
        self.assertTrue(policy["enabled"])
        self.assertTrue(policy["effective_enabled"])
        self.assertEqual(policy["row_version"], 1)
        self.assertTrue(response.json()["consent_notice"]["acknowledged"])

        member, member_membership = self.create_family_member()
        self.authenticate_as(member.id, member_membership.id)
        member_read = self.client.get("/api/ai/auto-execution/settings")
        self.assertEqual(member_read.status_code, 200, member_read.text)
        self.assertTrue(member_read.json()["family_policies"][0]["effective_enabled"])
        self.assertFalse(member_read.json()["consent_notice"]["acknowledged"])

    def test_request_cannot_supply_family_or_user_and_unknown_actions_are_not_found(self) -> None:
        invalid_body = self.client.put(
            "/api/ai/auto-execution/preferences/food.set_favorite",
            json={
                "enabled": False,
                "expected_row_version": 0,
                "family_id": self.other_family.id,
                "user_id": "attacker",
                "role": "OWNER",
            },
        )
        self.assertEqual(invalid_body.status_code, 422, invalid_body.text)

        unknown = self.client.put(
            "/api/ai/auto-execution/preferences/not-a-catalog-action",
            json={"enabled": False, "expected_row_version": 0},
        )
        self.assertEqual(unknown.status_code, 404, unknown.text)
        self.assertEqual(unknown.json()["detail"]["code"], "auto_execution_action_not_found")

    def test_unique_insert_race_maps_to_a_settings_conflict(self) -> None:
        with patch(
            "app.api.ai_auto_execution.commit_session",
            side_effect=IntegrityError("INSERT", {}, Exception("duplicate key")),
        ):
            response = self.client.put(
                "/api/ai/auto-execution/preferences/food.set_favorite",
                json={
                    "enabled": True,
                    "expected_row_version": 0,
                    "consent_notice_version": "auto-execution-consent.v1",
                },
            )

        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "auto_execution_settings_stale")

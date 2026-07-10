from ._support import *


class AIWorkspacePhaseFlowsTestCase(AIAgentInfraTestCase):
        def test_ai_workspace_phase2_routes_meal_plan_without_mode_and_records_tools(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "用快过期食材安排三天晚餐"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["agent_key"], "workspace_orchestrator")
            self.assertEqual(data["run"]["intent"], "meal_plan")
            cards = data["included"]["result_cards"]
            self.assertEqual(cards, [])
            self.assertEqual(data["included"]["drafts"][0]["draft_type"], "meal_plan")
            self.assertGreaterEqual(len(data["included"]["drafts"][0]["payload"]["items"]), 3)
            self.assertIn("番茄", str(data["included"]["drafts"][0]["payload"]))

            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                tool_names = [item["name"] for item in run.tool_calls]
                self.assertIn("inventory.read_expiring_items", tool_names)
                self.assertIn("meal_plan.create_draft", tool_names)
                self.assertEqual(run.context_summary["routing"]["skills"], ["meal_plan"])

        def test_takeout_dinner_plan_creates_food_profile_before_meal_plan(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "把棒约翰意面安排为今天晚餐"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["agent_key"], "workspace_orchestrator")
            self.assertEqual([draft["draft_type"] for draft in data["included"]["drafts"]], ["food_profile"])
            self.assertEqual([approval["approval_type"] for approval in data["included"]["approvals"]], ["food_profile.create"])
            food_draft = data["included"]["drafts"][0]["payload"]
            self.assertEqual(food_draft["name"], "棒约翰意面")
            self.assertEqual(food_draft["type"], "takeout")
            self.assertEqual(food_draft["category"], "外卖")
            self.assertEqual(food_draft["suitable_meal_types"], ["dinner"])

            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, data["run"]["id"])
                draft = db.get(AITaskDraft, data["included"]["drafts"][0]["id"])
                self.assertIsNotNone(run)
                self.assertIsNotNone(draft)
                assert run is not None and draft is not None
                self.assertEqual(run.context_summary["routing"]["skills"], ["meal_plan", "food_profile"])
                continuation = draft.ai_metadata["continuation"]
                self.assertEqual(continuation["reasonCode"], "missing_food")
                self.assertEqual(continuation["nextSkillKey"], "food_profile")
                self.assertEqual(continuation["resumeSkillKey"], "meal_plan")
                self.assertEqual(continuation["stateSchema"], "meal_missing_food.v1")
                self.assertIn("餐食计划", continuation["state"]["instruction"])

            food_approval = data["included"]["approvals"][0]
            with self.client.stream(
                "POST",
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{food_approval['id']}/decision/stream",
                json={
                    "decision": "approved",
                    "draft_version": food_approval["draft_version"],
                    "values": food_approval["initial_values"],
                },
            ) as stream_response:
                self.assertEqual(stream_response.status_code, 200)
                stream_body = "".join(stream_response.iter_text())
            self.assertIn("meal_plan.create", stream_body)

            pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
            self.assertEqual(pending_response.status_code, 200, pending_response.text)
            pending = pending_response.json()
            self.assertEqual([approval["approval_type"] for approval in pending], ["meal_plan.create"])
            plan_values = pending[0]["initial_values"]["draft"]
            self.assertEqual(plan_values["items"][0]["title"], "棒约翰意面")
            self.assertTrue(plan_values["items"][0]["foodId"])

        def test_takeout_dinner_plan_and_record_preserves_meal_log_followup(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "把棒约翰意面安排为今天晚餐并记录已吃"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual([draft["draft_type"] for draft in data["included"]["drafts"]], ["food_profile"])
            food_draft = data["included"]["drafts"][0]["payload"]
            self.assertEqual(food_draft["name"], "棒约翰意面")
            self.assertEqual(food_draft["type"], "takeout")
            self.assertEqual(food_draft["category"], "外卖")

            with self.SessionLocal() as db:
                draft = db.get(AITaskDraft, data["included"]["drafts"][0]["id"])
                self.assertIsNotNone(draft)
                assert draft is not None
                continuation = draft.ai_metadata["continuation"]
                self.assertEqual(continuation["nextSkillKey"], "food_profile")
                self.assertEqual(continuation["resumeSkillKey"], "meal_plan")
                self.assertIn("餐食计划", continuation["state"]["instruction"])
                self.assertIn("用餐记录", continuation["state"]["instruction"])

            food_approval = data["included"]["approvals"][0]
            with self.client.stream(
                "POST",
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{food_approval['id']}/decision/stream",
                json={
                    "decision": "approved",
                    "draft_version": food_approval["draft_version"],
                    "values": food_approval["initial_values"],
                },
            ) as stream_response:
                self.assertEqual(stream_response.status_code, 200)
                food_stream_body = "".join(stream_response.iter_text())
            self.assertIn("meal_plan.create", food_stream_body)

            pending_plan_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
            self.assertEqual(pending_plan_response.status_code, 200, pending_plan_response.text)
            pending_plan = pending_plan_response.json()
            self.assertEqual([approval["approval_type"] for approval in pending_plan], ["meal_plan.create"])
            meal_plan_approval = pending_plan[0]
            self.assertEqual(meal_plan_approval["initial_values"]["draft"]["items"][0]["title"], "棒约翰意面")

            with self.client.stream(
                "POST",
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{meal_plan_approval['id']}/decision/stream",
                json={
                    "decision": "approved",
                    "draft_version": meal_plan_approval["draft_version"],
                    "values": meal_plan_approval["initial_values"],
                },
            ) as stream_response:
                self.assertEqual(stream_response.status_code, 200)
                plan_stream_body = "".join(stream_response.iter_text())
            self.assertIn("meal_log.create", plan_stream_body)

            with self.SessionLocal() as db:
                plan_item = db.scalar(
                    select(FoodPlanItem)
                    .join(FoodPlanItem.food)
                    .where(FoodPlanItem.family_id == self.family.id, Food.name == "棒约翰意面")
                )
                self.assertIsNotNone(plan_item)
                assert plan_item is not None
                plan_item_id = plan_item.id
                planned_food_id = plan_item.food_id

            pending_log_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
            self.assertEqual(pending_log_response.status_code, 200, pending_log_response.text)
            pending_log = pending_log_response.json()
            self.assertEqual([approval["approval_type"] for approval in pending_log], ["meal_log.create"])
            meal_log_approval = pending_log[0]
            meal_log_draft = meal_log_approval["initial_values"]["draft"]
            self.assertEqual(meal_log_draft["planItemId"], plan_item_id)
            self.assertEqual(meal_log_draft["foods"][0]["foodId"], planned_food_id)

            meal_log_decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{meal_log_approval['id']}/decision",
                json={
                    "decision": "approved",
                    "draft_version": meal_log_approval["draft_version"],
                    "values": meal_log_approval["initial_values"],
                },
            )
            self.assertEqual(meal_log_decision_response.status_code, 200, meal_log_decision_response.text)
            self.assertEqual(meal_log_decision_response.json()["operation"]["business_entity_type"], "MealLog")

            with self.SessionLocal() as db:
                refreshed_plan = db.get(FoodPlanItem, plan_item_id)
                self.assertIsNotNone(refreshed_plan)
                assert refreshed_plan is not None
                self.assertEqual(refreshed_plan.status, "cooked")
                self.assertTrue(refreshed_plan.meal_log_id)

        def test_ai_workspace_phase_a_runs_composite_meal_plan_and_shopping_skills(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "用快过期食材安排三天晚餐，顺便生成购物清单"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["agent_key"], "workspace_orchestrator")
            self.assertEqual(data["run"]["intent"], "multi_skill")
            self.assertEqual([draft["draft_type"] for draft in data["included"]["drafts"]], ["meal_plan"])
            self.assertEqual([approval["approval_type"] for approval in data["included"]["approvals"]], ["meal_plan.create"])
            self.assertEqual(data["included"]["result_cards"], [])
            self.assertEqual(data["run"]["status"], "waiting_approval")

            meal_plan_approval = data["included"]["approvals"][0]
            decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{meal_plan_approval['id']}/decision",
                json={
                    "decision": "approved",
                    "draft_version": meal_plan_approval["draft_version"],
                    "values": meal_plan_approval["initial_values"],
                },
            )
            self.assertEqual(decision_response.status_code, 200, decision_response.text)
            self.assertEqual(decision_response.json()["operation"]["business_entity_type"], "FoodPlanItem")

            pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
            self.assertEqual(pending_response.status_code, 200, pending_response.text)
            self.assertEqual(pending_response.json(), [])

            with self.client.stream(
                "POST",
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{meal_plan_approval['id']}/decision/stream",
                json={
                    "decision": "approved",
                    "draft_version": meal_plan_approval["draft_version"],
                    "values": meal_plan_approval["initial_values"],
                },
            ) as stream_response:
                self.assertEqual(stream_response.status_code, 200)
                stream_body = "".join(stream_response.iter_text())
            self.assertIn("shopping_list.create", stream_body)

            pending_after_stream_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
            self.assertEqual(pending_after_stream_response.status_code, 200, pending_after_stream_response.text)
            pending = pending_after_stream_response.json()
            self.assertEqual([approval["approval_type"] for approval in pending], ["shopping_list.create"])
            shopping_approval = pending[0]

            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                self.assertEqual(run.context_summary["routing"]["skills"], ["meal_plan", "shopping_list"])
                tool_names = [item["name"] for item in run.tool_calls]
                self.assertIn("meal_plan.create_draft", tool_names)
                self.assertIn("shopping.create_draft", tool_names)
                assistant_messages = list(
                    db.scalars(
                        select(AIMessage)
                        .where(AIMessage.run_id == data["run"]["id"], AIMessage.role == "assistant")
                        .order_by(AIMessage.created_at.asc())
                    )
                )
                self.assertEqual(len(assistant_messages), 1)
                assistant_message = assistant_messages[0]
                approval_types = [
                    part["approval"]["approval_type"]
                    for part in assistant_message.parts
                    if isinstance(part, dict) and part.get("type") == "approval_request"
                ]
                self.assertEqual(approval_types, ["meal_plan.create", "shopping_list.create"])
                metadata_artifacts = [
                    artifact
                    for artifact in (assistant_message.message_metadata or {}).get("artifacts", [])
                    if isinstance(artifact, dict)
                ]
                self.assertTrue(any(str(artifact.get("id") or "").startswith("entity:") for artifact in metadata_artifacts))
                self.assertTrue(any(artifact.get("type") == "meal_plan" and artifact.get("kind") == "business_entity" for artifact in metadata_artifacts))
                card_types = [
                    part["card"]["type"]
                    for part in assistant_message.parts
                    if isinstance(part, dict) and part.get("type") == "result_card"
                ]
                self.assertEqual(card_types, ["operation_result"])
                from app.ai.workflows.runner import WorkspaceGraphRunner

                response_after_second_skill = WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))._chat_response(
                    data["conversation_id"], data["run"]["id"]
                )
                self.assertEqual([draft["draft_type"] for draft in response_after_second_skill["included"]["drafts"]], ["meal_plan", "shopping_list"])
                self.assertEqual(
                    [approval["approval_type"] for approval in response_after_second_skill["included"]["approvals"]],
                    ["meal_plan.create", "shopping_list.create"],
                )
                self.assertEqual(
                    [card["type"] for card in response_after_second_skill["included"]["result_cards"]],
                    ["operation_result"],
                )

            shopping_decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{shopping_approval['id']}/decision",
                json={
                    "decision": "approved",
                    "draft_version": shopping_approval["draft_version"],
                    "values": shopping_approval["initial_values"],
                },
            )
            self.assertEqual(shopping_decision_response.status_code, 200, shopping_decision_response.text)
            self.assertEqual(shopping_decision_response.json()["operation"]["business_entity_type"], "ShoppingListItem")

            with self.SessionLocal() as db:
                self.assertGreaterEqual(db.query(FoodPlanItem).count(), 3)
                self.assertGreaterEqual(db.query(ShoppingListItem).count(), 1)

        def test_ai_workspace_composite_rejection_waits_for_agent_continuation(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐，顺便生成购物清单"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval = data["included"]["approvals"][0]

            decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={
                    "decision": "rejected",
                    "draft_version": approval["draft_version"],
                    "values": {},
                },
            )
            self.assertEqual(decision_response.status_code, 200, decision_response.text)
            self.assertEqual(decision_response.json()["approval"]["status"], "rejected")
            pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
            self.assertEqual(pending_response.status_code, 200, pending_response.text)
            self.assertEqual(pending_response.json(), [])

            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                self.assertEqual(run.status, "running")
                self.assertNotIn("shopping.create_draft", [item["name"] for item in run.tool_calls])

        def test_ai_workspace_single_draft_approval_returns_to_agent_without_duplicate_draft(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval = data["included"]["approvals"][0]

            decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={
                    "decision": "approved",
                    "draft_version": approval["draft_version"],
                    "values": approval["initial_values"],
                },
            )
            self.assertEqual(decision_response.status_code, 200, decision_response.text)
            self.assertEqual(decision_response.json()["approval"]["status"], "approved")

            pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
            self.assertEqual(pending_response.status_code, 200, pending_response.text)
            self.assertEqual(pending_response.json(), [])

            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                self.assertEqual(run.status, "running")
                tool_names = [item["name"] for item in run.tool_calls]
                self.assertEqual(tool_names.count("meal_plan.create_draft"), 1)

        def test_ai_workspace_approval_rejection_stream_returns_result_to_model(self) -> None:
            provider = FakeChatProvider("模型看到 HumanInLoop 结果后继续回复。")
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval = data["included"]["approvals"][0]
            original_message_id = data["message"]["id"]

            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                with self.client.stream(
                    "POST",
                    f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision/stream",
                    json={
                        "decision": "rejected",
                        "draft_version": approval["draft_version"],
                        "values": {},
                    },
                ) as stream_response:
                    self.assertEqual(stream_response.status_code, 200)
                    body = "".join(stream_response.iter_text())

            self.assertIn("event: message_delta", body)
            self.assertIn("模型看到 HumanInLoop 结果后继续回复。", body)
            self.assertIn("event: response", body)
            self.assertIn(original_message_id, body)

            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, data["run"]["id"])
                message = db.get(AIMessage, original_message_id)
                self.assertIsNotNone(run)
                self.assertIsNotNone(message)
                assert run is not None and message is not None
                self.assertEqual(run.status, "completed")
                self.assertEqual(message.run_id, data["run"]["id"])
                self.assertEqual(message.role, "assistant")
                self.assertIn("模型看到 HumanInLoop 结果后继续回复。", message.content)
                part_types = [part.get("type") for part in message.parts if isinstance(part, dict)]
                self.assertEqual(part_types[-2:], ["approval_request", "text"])

        def test_ai_workspace_approval_decision_stream_resumes_downstream_skill(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐，顺便生成购物清单"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            meal_plan_approval = data["included"]["approvals"][0]

            with self.client.stream(
                "POST",
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{meal_plan_approval['id']}/decision/stream",
                json={
                    "decision": "approved",
                    "draft_version": meal_plan_approval["draft_version"],
                    "values": meal_plan_approval["initial_values"],
                },
            ) as stream_response:
                self.assertEqual(stream_response.status_code, 200)
                body = "".join(stream_response.iter_text())

            self.assertIn("event: progress", body)
            self.assertIn("event: response", body)
            self.assertIn("shopping_list.create", body)
            self.assertIn("生成「购物清单确认表单」", body)
            self.assertLess(body.index("生成「购物清单确认表单」"), body.index("event: response"))

            pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
            self.assertEqual(pending_response.status_code, 200, pending_response.text)
            pending = pending_response.json()
            self.assertEqual([approval["approval_type"] for approval in pending], ["shopping_list.create"])

            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                self.assertEqual(run.status, "waiting_approval")
                tool_names = [item["name"] for item in run.tool_calls]
                self.assertIn("meal_plan.create_draft", tool_names)
                self.assertIn("shopping.create_draft", tool_names)

        def test_ai_workspace_waiting_approval_run_can_be_cancelled(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["status"], "waiting_approval")
            approval = data["included"]["approvals"][0]
            draft = data["included"]["drafts"][0]

            cancel_response = self.client.post(f"/api/ai/runs/{data['run']['id']}/cancel")
            self.assertEqual(cancel_response.status_code, 200, cancel_response.text)
            cancel_data = cancel_response.json()
            self.assertEqual(cancel_data["run"]["status"], "cancelled")

            pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
            self.assertEqual(pending_response.status_code, 200, pending_response.text)
            self.assertEqual(pending_response.json(), [])

            with self.SessionLocal() as db:
                stored_approval = db.get(AIApprovalRequest, approval["id"])
                stored_draft = db.get(AITaskDraft, draft["id"])
                self.assertIsNotNone(stored_approval)
                self.assertIsNotNone(stored_draft)
                assert stored_approval is not None and stored_draft is not None
                self.assertEqual(stored_approval.status, "cancelled")
                self.assertEqual(stored_draft.status, "rejected")

        def test_ai_workspace_phase2_uses_current_plan_for_shopping_draft(self) -> None:
            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-tomato-egg",
                    family_id=self.family.id,
                    title="番茄鸡蛋面",
                    servings=2,
                    prep_minutes=20,
                    difficulty=Difficulty.EASY,
                    tips="少油少盐",
                    scene_tags=["晚餐", "家常菜"],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                recipe_food = Food(
                    id="food-tomato-egg",
                    family_id=self.family.id,
                    name="番茄鸡蛋面",
                    type=FoodType.SELF_MADE,
                    category="家常菜",
                    flavor_tags=["清淡"],
                    scene_tags=["晚餐"],
                    suitable_meal_types=["dinner"],
                    source_name="自家菜谱",
                    purchase_source="",
                    scene="晚餐",
                    notes="",
                    routine_note="适合用临期番茄。",
                    recipe_id=recipe.id,
                )
                db.add_all(
                    [
                        recipe,
                        recipe_food,
                        RecipeIngredient(
                            id="recipe-ingredient-tomato",
                            recipe_id=recipe.id,
                            ingredient_id="ingredient-tomato",
                            ingredient_name="番茄",
                            quantity=2,
                            unit="个",
                            note="切块",
                            sort_order=0,
                        ),
                        RecipeIngredient(
                            id="recipe-ingredient-egg",
                            recipe_id=recipe.id,
                            ingredient_id=None,
                            ingredient_name="鸡蛋",
                            quantity=2,
                            unit="个",
                            note="打散",
                            sort_order=1,
                        ),
                    ]
                )
                db.commit()

            plan_response = self.client.post("/api/ai/chat", json={"message": "用快过期食材安排三天晚餐"})
            self.assertEqual(plan_response.status_code, 200, plan_response.text)
            conversation_id = plan_response.json()["conversation_id"]

            shopping_response = self.client.post(
                "/api/ai/chat",
                json={"conversation_id": conversation_id, "message": "基于这个计划生成购物清单"},
            )
            self.assertEqual(shopping_response.status_code, 200, shopping_response.text)
            data = shopping_response.json()
            self.assertEqual(data["run"]["agent_key"], "workspace_orchestrator")
            self.assertEqual(data["run"]["intent"], "shopping")
            self.assertEqual(data["included"]["result_cards"], [])
            shopping_items = data["included"]["drafts"][0]["payload"]["items"]
            self.assertTrue(shopping_items)
            self.assertTrue(all(item["ingredient_id"] for item in shopping_items), shopping_items)
            self.assertFalse(any(item["title"] == "鸡蛋" for item in shopping_items), shopping_items)
            self.assertTrue(any(item["title"] == "番茄" for item in shopping_items), shopping_items)
            tomato_item = next(item for item in shopping_items if item["title"] == "番茄")
            self.assertEqual(tomato_item["ingredient_id"], "ingredient-tomato")
            self.assertIn("用于", tomato_item["reason"])
            self.assertNotEqual(tomato_item["title"], "通用配菜")
            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                conversation = run.input["conversation"]
                self.assertTrue(
                    any(
                        artifact["type"] == "meal_plan"
                        for message in conversation
                        for artifact in message.get("artifacts", [])
                    )
                )
                self.assertIn("shopping.create_draft", [item["name"] for item in run.tool_calls])

        def test_ai_workspace_phase2_modifies_existing_meal_plan_draft(self) -> None:
            plan_response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
            self.assertEqual(plan_response.status_code, 200, plan_response.text)
            conversation_id = plan_response.json()["conversation_id"]

            modify_response = self.client.post(
                "/api/ai/chat",
                json={"conversation_id": conversation_id, "message": "第二天不要吃鸡肉，整体清淡一点"},
            )
            self.assertEqual(modify_response.status_code, 200, modify_response.text)
            data = modify_response.json()
            self.assertEqual(data["run"]["agent_key"], "workspace_orchestrator")
            self.assertEqual(data["included"]["result_cards"], [])
            self.assertIn("清淡", str(data["included"]["drafts"][0]["payload"]))

        def test_ai_workspace_modifies_plan_after_deriving_shopping_list(self) -> None:
            plan_response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
            self.assertEqual(plan_response.status_code, 200, plan_response.text)
            conversation_id = plan_response.json()["conversation_id"]

            shopping_response = self.client.post(
                "/api/ai/chat",
                json={"conversation_id": conversation_id, "message": "基于这个计划生成购物清单"},
            )
            self.assertEqual(shopping_response.status_code, 200, shopping_response.text)
            self.assertEqual(shopping_response.json()["run"]["agent_key"], "workspace_orchestrator")

            modify_response = self.client.post(
                "/api/ai/chat",
                json={
                    "conversation_id": conversation_id,
                    "message": "第二天不要吃鸡蛋，换成更适合孩子吃的，整体还是清淡",
                },
            )
            self.assertEqual(modify_response.status_code, 200, modify_response.text)
            data = modify_response.json()
            self.assertEqual(data["run"]["agent_key"], "workspace_orchestrator")
            self.assertEqual(data["run"]["intent"], "meal_plan")
            self.assertEqual(data["included"]["result_cards"], [])
            self.assertEqual(data["included"]["drafts"][0]["draft_type"], "meal_plan")

            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                artifact_types = [
                    artifact["type"]
                    for message in run.input["conversation"]
                    for artifact in message.get("artifacts", [])
                ]
                self.assertIn("meal_plan", artifact_types)
                self.assertIn("shopping_list", artifact_types)
                routing = run.context_summary["routing"]
                self.assertEqual(routing["skills"], ["meal_plan"])
                self.assertIn("meal_plan.create_draft", [item["name"] for item in run.tool_calls])

        def test_ai_workspace_phase2_asks_clarifying_question_for_underspecified_plan(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "帮我做菜单"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["intent"], "meal_plan")
            self.assertEqual(data["run"]["agent_key"], "workspace_orchestrator")
            self.assertIn("几天", data["message"]["content"])

        def test_ai_workspace_phase3_confirms_shopping_list_draft(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "帮我生成补货清单", "quick_task": "shopping"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval = data["included"]["approvals"][0]
            self.assertEqual(approval["approval_type"], "shopping_list.create")

            decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={"decision": "approved", "draft_version": approval["draft_version"], "values": approval["initial_values"]},
            )
            self.assertEqual(decision_response.status_code, 200, decision_response.text)
            decision_data = decision_response.json()
            self.assertEqual(decision_data["operation"]["status"], "succeeded")
            self.assertEqual(decision_data["draft"]["status"], "confirmed")

            with self.SessionLocal() as db:
                self.assertEqual(db.query(ShoppingListItem).count(), len(approval["initial_values"]["draft"]["items"]))
                duplicate_response = self.client.post(
                    f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                    json={"decision": "approved", "draft_version": approval["draft_version"], "values": approval["initial_values"]},
                )
                self.assertEqual(duplicate_response.status_code, 409)
                self.assertEqual(db.query(AIOperation).count(), 1)

        def test_ai_workspace_phase3_confirms_meal_plan_draft(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval = data["included"]["approvals"][0]
            self.assertEqual(approval["approval_type"], "meal_plan.create")

            decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={"decision": "approved", "draft_version": approval["draft_version"], "values": approval["initial_values"]},
            )
            self.assertEqual(decision_response.status_code, 200, decision_response.text)
            decision_data = decision_response.json()
            self.assertEqual(decision_data["operation"]["business_entity_type"], "FoodPlanItem")
            self.assertGreaterEqual(len(decision_data["operation"]["business_entity_ids"]), 3)

            with self.SessionLocal() as db:
                self.assertGreaterEqual(db.query(FoodPlanItem).count(), 3)
                self.assertGreaterEqual(db.query(Food).count(), 1)

        def test_ai_workspace_phase3_confirms_meal_log_draft(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "今晚吃了番茄小炒", "quick_task": "meal_log"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval = data["included"]["approvals"][0]
            self.assertEqual(approval["approval_type"], "meal_log.create")

            decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={"decision": "approved", "draft_version": approval["draft_version"], "values": approval["initial_values"]},
            )
            self.assertEqual(decision_response.status_code, 200, decision_response.text)
            decision_data = decision_response.json()
            self.assertEqual(decision_data["operation"]["business_entity_type"], "MealLog")

            with self.SessionLocal() as db:
                self.assertEqual(db.query(MealLog).count(), 1)
                self.assertEqual(db.query(MealLogFood).count(), 1)
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                tool_names = [item["name"] for item in run.tool_calls]
                self.assertIn("food.search", tool_names)
                self.assertIn("meal_log.read_recent", tool_names)
                self.assertIn("meal_log.create_draft", tool_names)

        def test_ai_workspace_phase3_confirms_food_profile_draft(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "整理食物资料 蓝莓酸奶", "quick_task": "food_profile"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval = data["included"]["approvals"][0]
            self.assertEqual(approval["approval_type"], "food_profile.create")
            self.assertEqual(data["included"]["result_cards"], [])
            self.assertEqual(data["included"]["drafts"][0]["draft_type"], "food_profile")

            decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={"decision": "approved", "draft_version": approval["draft_version"], "values": approval["initial_values"]},
            )
            self.assertEqual(decision_response.status_code, 200, decision_response.text)
            decision_data = decision_response.json()
            self.assertEqual(decision_data["operation"]["business_entity_type"], "Food")

            with self.SessionLocal() as db:
                self.assertEqual(db.query(Food).filter(Food.name == "蓝莓酸奶").count(), 1)
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                tool_names = [item["name"] for item in run.tool_calls]
                self.assertIn("food.search", tool_names)
                self.assertIn("food_profile.create_draft", tool_names)

        def test_ai_workspace_phase3_confirms_ingredient_profile_draft(self) -> None:
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "新增鸡胸肉食材档案", "quick_task": "ingredient_profile"},
            )
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval = data["included"]["approvals"][0]
            self.assertEqual(approval["approval_type"], "ingredient.create")
            self.assertEqual(data["included"]["result_cards"], [])
            self.assertEqual(data["included"]["drafts"][0]["draft_type"], "ingredient_profile")

            decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={"decision": "approved", "draft_version": approval["draft_version"], "values": approval["initial_values"]},
            )
            self.assertEqual(decision_response.status_code, 200, decision_response.text)
            decision_data = decision_response.json()
            self.assertEqual(decision_data["operation"]["business_entity_type"], "Ingredient")

            with self.SessionLocal() as db:
                self.assertEqual(db.query(Ingredient).filter(Ingredient.name == "鸡胸肉").count(), 1)
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                tool_names = [item["name"] for item in run.tool_calls]
                self.assertIn("ingredient.search", tool_names)
                self.assertIn("ingredient_profile.create_draft", tool_names)

        def test_ai_workspace_phase3_rejects_cross_family_food_in_meal_plan(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval = data["included"]["approvals"][0]
            values = approval["initial_values"]
            values["draft"]["items"][0]["foodId"] = "food-other"
            with self.SessionLocal() as db:
                db.add(
                    Food(
                        id="food-other",
                        family_id=self.other_family.id,
                        name="其他家庭菜",
                        type=FoodType.SELF_MADE,
                        category="家常菜",
                        flavor_tags=[],
                        scene="",
                        notes="",
                    )
                )
                db.commit()

            decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={"decision": "approved", "draft_version": approval["draft_version"], "values": values},
            )
            self.assertEqual(decision_response.status_code, 409)
            self.assertIn("当前家庭", decision_response.text)

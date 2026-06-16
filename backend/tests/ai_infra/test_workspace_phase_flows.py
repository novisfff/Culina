from ._support import *


class AIWorkspacePhaseFlowsTestCase(AIAgentInfraTestCase):
        def test_ai_workspace_phase2_routes_meal_plan_without_mode_and_records_tools(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "用快过期食材安排三天晚餐"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["agent_key"], "meal_plan_agent")
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

        def test_ai_workspace_phase_a_runs_composite_meal_plan_and_shopping_skills(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "用快过期食材安排三天晚餐，顺便生成购物清单"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["agent_key"], "workspace_planner")
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
            pending = pending_response.json()
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

        def test_ai_workspace_composite_rejection_stops_downstream_skills(self) -> None:
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
                self.assertEqual(run.status, "cancelled")
                self.assertNotIn("shopping.create_draft", [item["name"] for item in run.tool_calls])

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
                self.assertEqual(run.status, "cancelled")
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
            self.assertEqual(data["run"]["agent_key"], "shopping_agent")
            self.assertEqual(data["run"]["intent"], "shopping")
            self.assertEqual(data["included"]["result_cards"], [])
            shopping_items = data["included"]["drafts"][0]["payload"]["items"]
            self.assertTrue(any(item["title"] == "鸡蛋" for item in shopping_items), shopping_items)
            egg_item = next(item for item in shopping_items if item["title"] == "鸡蛋")
            self.assertEqual(egg_item["unit"], "个")
            self.assertIn("用于", egg_item["reason"])
            self.assertNotEqual(egg_item["title"], "通用配菜")
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
            self.assertEqual(data["run"]["agent_key"], "meal_plan_agent")
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
            self.assertEqual(shopping_response.json()["run"]["agent_key"], "shopping_agent")

            modify_response = self.client.post(
                "/api/ai/chat",
                json={
                    "conversation_id": conversation_id,
                    "message": "第二天不要吃鸡蛋，换成更适合孩子吃的，整体还是清淡",
                },
            )
            self.assertEqual(modify_response.status_code, 200, modify_response.text)
            data = modify_response.json()
            self.assertEqual(data["run"]["agent_key"], "meal_plan_agent")
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
                self.assertEqual(run.context_summary["skillExecutions"][0]["operation"], "modify")

        def test_ai_workspace_phase2_asks_clarifying_question_for_underspecified_plan(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "帮我做菜单"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["intent"], "meal_plan")
            self.assertEqual(data["run"]["agent_key"], "meal_plan_agent")
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


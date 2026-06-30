from ._support import *


class CookingAssistantSkillTestCase(AIAgentInfraTestCase):
        def test_cooking_assistant_skill_registers_read_and_ui_action_tools(self) -> None:
            skill_registry = build_workspace_skill_registry()
            skill = skill_registry.get("cooking_assistant")

            self.assertEqual(skill.manifest.approval_policy, "none")
            self.assertEqual(skill.manifest.draft_types, [])
            self.assertEqual(skill.manifest.output_types, ["ui_actions"])
            self.assertIn("recipe.read_by_id", skill.manifest.tools)
            self.assertIn("inventory.read_available_items", skill.manifest.tools)
            self.assertIn("ui.propose_actions", skill.manifest.tools)
            self.assertIn("小灶", skill.instructions)
            self.assertIn("个人小助手", skill.instructions)
            self.assertIn("先判断用户是在寒暄", skill.instructions)
            self.assertIn("不要主动讲当前步骤", skill.instructions)
            self.assertIn("不要说“根据 subject.extra”", skill.instructions)
            self.assertIn("系统 AI 助手", skill.instructions)
            self.assertIn("完成烹饪", skill.instructions)

        def test_ui_propose_actions_returns_result_card_without_writing_business_data(self) -> None:
            tool = build_workspace_tool_registry().get("ui.propose_actions")
            result = tool.handler(
                ToolContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-ui-actions",
                    run_id="run-ui-actions",
                ),
                {
                    "surface": "recipe_cook_page",
                    "recipeId": "recipe-tomato",
                    "cookSessionId": "cook-session-recipe-tomato",
                    "sessionRevision": 3,
                    "actions": [{"type": "go_next_step"}],
                },
            )

            card = result["card"]
            self.assertEqual(card["type"], "ui_actions")
            self.assertEqual(card["data"]["surface"], "recipe_cook_page")
            self.assertEqual(card["data"]["actions"], [{"type": "go_next_step"}])
            self.assertNotIn("speak", card["data"])
            self.assertFalse(card["data"]["requiresConfirmation"])
            self.assertEqual(tool.side_effect, "control")

        def test_ui_propose_actions_marks_high_risk_actions_for_confirmation(self) -> None:
            tool = build_workspace_tool_registry().get("ui.propose_actions")
            result = tool.handler(
                ToolContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-ui-actions",
                    run_id="run-ui-actions",
                ),
                {
                    "surface": "recipe_cook_page",
                    "recipeId": "recipe-tomato",
                    "cookSessionId": "cook-session-recipe-tomato",
                    "sessionRevision": 3,
                    "actions": [{"type": "delete_timer", "timerId": "timer-main"}],
                },
            )

            self.assertTrue(result["card"]["data"]["requiresConfirmation"])

            shopping_result = tool.handler(
                ToolContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-ui-actions",
                    run_id="run-ui-actions",
                ),
                {
                    "surface": "recipe_cook_page",
                    "recipeId": "recipe-tomato",
                    "cookSessionId": "cook-session-recipe-tomato",
                    "sessionRevision": 3,
                    "actions": [{"type": "open_shopping_dialog"}],
                },
            )

            self.assertTrue(shopping_result["card"]["data"]["requiresConfirmation"])

        def test_ui_propose_actions_rejects_invalid_surface_and_missing_parameters(self) -> None:
            tool = build_workspace_tool_registry().get("ui.propose_actions")
            context = ToolContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-ui-actions",
                run_id="run-ui-actions",
            )

            with self.assertRaisesRegex(ValueError, "暂不支持该页面动作"):
                tool.handler(
                    context,
                    {
                        "surface": "ingredient_page",
                        "recipeId": "recipe-tomato",
                        "cookSessionId": "cook-session-recipe-tomato",
                        "sessionRevision": 3,
                        "actions": [{"type": "go_next_step"}],
                    },
                )

            with self.assertRaisesRegex(ValueError, "计时器动作需要提供 seconds"):
                tool.handler(
                    context,
                    {
                        "surface": "recipe_cook_page",
                        "recipeId": "recipe-tomato",
                        "cookSessionId": "cook-session-recipe-tomato",
                        "sessionRevision": 3,
                        "actions": [{"type": "set_timer"}],
                    },
                )

        def test_cooking_assistant_chat_can_skip_system_history_persistence(self) -> None:
            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-cooking-assistant-history",
                    family_id=self.family.id,
                    title="番茄炒蛋",
                    servings=2,
                    prep_minutes=12,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=[],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(recipe)
                db.commit()

            response = self.client.post(
                "/api/ai/chat",
                json={
                    "message": "这一步要做到什么程度？",
                    "quick_task": "cooking_assistant",
                    "persist_history": False,
                    "subject": {
                        "source": "recipe_cook_page",
                        "recipe_id": "recipe-cooking-assistant-history",
                        "extra": {"surface": "recipe_cook_page", "currentStepIndex": 0},
                    },
                },
            )

            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            conversation_id = data["conversation_id"]
            run_id = data["run"]["id"]
            with self.SessionLocal() as db:
                self.assertIsNone(db.get(AIConversation, conversation_id))
                self.assertEqual(db.query(AIMessage).filter(AIMessage.conversation_id == conversation_id).count(), 0)
                self.assertEqual(db.query(AIRunEvent).filter(AIRunEvent.run_id == run_id).count(), 0)
                run = db.get(AIAgentRun, run_id)
                self.assertIsNotNone(run)
                assert run is not None
                self.assertIsNone(run.conversation_id)
                self.assertIsNone(run.message_id)

        def test_cooking_assistant_stream_can_skip_system_history_persistence(self) -> None:
            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-cooking-assistant-stream-history",
                    family_id=self.family.id,
                    title="番茄炒蛋",
                    servings=2,
                    prep_minutes=12,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=[],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(recipe)
                db.commit()

            with self.client.stream(
                "POST",
                "/api/ai/chat/stream",
                json={
                    "message": "这一步要做到什么程度？",
                    "quick_task": "cooking_assistant",
                    "persist_history": False,
                    "subject": {
                        "source": "recipe_cook_page",
                        "recipe_id": "recipe-cooking-assistant-stream-history",
                        "extra": {"surface": "recipe_cook_page", "currentStepIndex": 0},
                    },
                },
            ) as response:
                self.assertEqual(response.status_code, 200)
                payload = "".join(response.iter_text())

            response_blocks = [block for block in payload.split("\n\n") if block.startswith("event: response")]
            self.assertEqual(len(response_blocks), 1)
            data_line = next(line for line in response_blocks[0].splitlines() if line.startswith("data:"))
            data = json.loads(data_line.removeprefix("data:").strip())
            conversation_id = data["conversation_id"]
            run_id = data["run"]["id"]

            with self.SessionLocal() as db:
                self.assertIsNone(db.get(AIConversation, conversation_id))
                self.assertEqual(db.query(AIMessage).filter(AIMessage.conversation_id == conversation_id).count(), 0)
                self.assertEqual(db.query(AIRunEvent).filter(AIRunEvent.run_id == run_id).count(), 0)
                run = db.get(AIAgentRun, run_id)
                self.assertIsNotNone(run)
                assert run is not None
                self.assertIsNone(run.conversation_id)
                self.assertIsNone(run.message_id)

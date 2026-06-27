from ._support import *
from app.services.ai_operations.approval_requests import create_ai_draft_approval
from app.services.ai_operations.messages import approval_result_card


class AIWorkspaceApprovalsTestCase(AIAgentInfraTestCase):
        def test_approval_decision_lock_timeout_returns_conflict(self) -> None:
            from sqlalchemy.exc import OperationalError

            from app.ai.errors import AIConflictError
            from app.services.ai_operations.approval_decisions import apply_ai_approval_decision

            db = MagicMock()
            db.scalar.side_effect = [
                object(),
                OperationalError(
                    "SELECT ai_approval_requests FOR UPDATE",
                    {},
                    Exception(1205, "Lock wait timeout exceeded; try restarting transaction"),
                ),
            ]

            with self.assertRaisesRegex(AIConflictError, "确认请求正在处理"):
                apply_ai_approval_decision(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-lock",
                    approval_id="approval-lock",
                    decision="approved",
                    draft_version=1,
                    values={},
                    resolve_user_id=lambda value: value,
                )

        def test_approval_decision_api_returns_conflict_for_locked_approval(self) -> None:
            from app.ai.errors import AIConflictError

            with patch(
                "app.api.ai.AIApplicationService.decide_approval",
                side_effect=AIConflictError("确认请求正在处理，请稍后刷新或重试"),
            ):
                response = self.client.post(
                    "/api/ai/conversations/conversation-lock/approvals/approval-lock/decision",
                    json={"decision": "approved", "draft_version": 1, "values": {}},
                )

            self.assertEqual(response.status_code, 409, response.text)
            self.assertIn("确认请求正在处理", response.json()["detail"])

        def test_ai_workspace_recipe_draft_approval_creates_recipe_after_decision(self) -> None:
            with self.SessionLocal() as db:
                self._add_egg_ingredient(db)
                db.add(
                    Ingredient(
                        id="ingredient-noodle",
                        family_id=self.family.id,
                        name="面条",
                        category="主食",
                        default_unit="克",
                        unit_conversions=[],
                        default_storage="常温",
                        default_expiry_mode=IngredientExpiryMode.NONE,
                        notes="",
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                db.commit()
            provider = FakeChatProvider(
                """
                {
                  "title": "番茄鸡蛋面",
                  "servings": 2,
                  "prep_minutes": 20,
                  "difficulty": "easy",
                  "ingredient_items": [
                    {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"},
                    {"ingredient_id": "ingredient-egg", "ingredient_name": "鸡蛋", "quantity": 2, "unit": "个", "note": "打散"},
                    {"ingredient_id": "ingredient-noodle", "ingredient_name": "面条", "quantity": 200, "unit": "克", "note": "提前备好"}
                  ],
                  "steps": [
                    {"title": "备菜", "text": "番茄洗净后处理 5 分钟，切成 2 厘米块，鸡蛋打到没有透明蛋清。面条提前称好，葱花和调味料放在手边，方便后续连续操作。", "icon": "bowl", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["番茄切块", "鸡蛋打散"]},
                    {"title": "炒汤底", "text": "锅中放少量油，中火加热 30 秒后倒入蛋液炒到刚凝固盛出。继续用中火炒番茄 3 分钟，看到出汁变软后加入热水煮沸。", "icon": "pan", "summary": "炒出汤底", "estimated_minutes": 8, "tip": "番茄要炒出汁。", "key_points": ["中火", "炒出汁"]},
                    {"title": "煮面收尾", "text": "汤汁沸腾后下面条煮 5 分钟，保持微沸并不时搅动防止粘连。面条变软熟透后倒回鸡蛋，加盐调味，确认汤汁冒泡后出锅。", "icon": "plate", "summary": "煮熟装盘", "estimated_minutes": 7, "tip": "出锅前尝味。", "key_points": ["煮熟", "尝味"]}
                  ],
                  "tips": "少油少盐，适合晚餐。",
                  "scene_tags": ["家常菜", "快手菜"]
                }
                """
            )
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                response = self.client.post(
                    "/api/ai/chat",
                    json={"message": "帮我生成一份番茄鸡蛋面的菜谱，2 人份。", "quick_task": "recipe_draft"},
                )
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["agent_key"], "workspace_orchestrator")
            self.assertEqual(data["run"]["intent"], "recipe_draft")
            self.assertEqual(len(data["included"]["drafts"]), 1)
            self.assertEqual(len(data["included"]["approvals"]), 1)
            approval = data["included"]["approvals"][0]
            draft = data["included"]["drafts"][0]
            self.assertEqual(approval["status"], "pending")
            self.assertEqual(draft["status"], "pending")
            self.assertIsNone(draft["payload"].get("pending_image_job_id"))

            with self.SessionLocal() as db:
                self.assertEqual(db.query(Recipe).count(), 0)
                self.assertEqual(db.query(AITaskDraft).count(), 1)
                self.assertEqual(db.query(AIApprovalRequest).count(), 1)
                self.assertEqual(db.query(AIImageGenerationJob).count(), 0)
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                self.assertIn("recipe.create_draft", [item["name"] for item in run.tool_calls])

            pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
            self.assertEqual(pending_response.status_code, 200, pending_response.text)
            self.assertEqual(pending_response.json()[0]["id"], approval["id"])

            recipe_payload = draft["payload"]
            recipe_payload["title"] = "番茄鸡蛋面（确认版）"
            decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={
                    "decision": "approved",
                    "draft_version": draft["version"],
                    "values": {"recipe": recipe_payload},
                },
            )
            self.assertEqual(decision_response.status_code, 200, decision_response.text)
            decision_data = decision_response.json()
            self.assertEqual(decision_data["approval"]["status"], "approved")
            self.assertEqual(decision_data["draft"]["status"], "confirmed")
            self.assertEqual(decision_data["operation"]["status"], "succeeded")
            self.assertEqual(decision_data["business_entity"]["title"], "番茄鸡蛋面（确认版）")

            repeat_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={
                    "decision": "approved",
                    "draft_version": draft["version"],
                    "values": {"recipe": recipe_payload},
                },
            )
            self.assertEqual(repeat_response.status_code, 409, repeat_response.text)
            with self.SessionLocal() as db:
                self.assertEqual(db.query(Recipe).count(), 1)
                self.assertEqual(db.query(AIOperation).count(), 1)
                recipe_id = decision_data["business_entity"]["id"]
                image_job = db.scalar(
                    select(AIImageGenerationJob).where(
                        AIImageGenerationJob.family_id == self.family.id,
                        AIImageGenerationJob.target_entity_type == "recipe",
                        AIImageGenerationJob.target_entity_id == recipe_id,
                    )
                )
                self.assertIsNotNone(image_job)
                assert image_job is not None
                self.assertEqual(image_job.status, "queued")
                self.assertEqual(image_job.bind_status, "pending")
                self.assertEqual(image_job.request_payload["entity_type"], "recipe")
                self.assertEqual(image_job.request_payload["title"], "番茄鸡蛋面（确认版）")
                self.assertIn("番茄", image_job.request_payload["ingredient_names"])

        def test_ai_workspace_recipe_approval_rejects_unresolved_ingredients_before_commit(self) -> None:
            payload = {
                "title": "番茄鸡蛋面",
                "servings": 2,
                "prep_minutes": 20,
                "difficulty": "easy",
                "ingredient_items": [
                    {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"},
                    {"ingredient_id": None, "ingredient_name": "面条", "quantity": 200, "unit": "克", "note": "提前备好"},
                ],
                "steps": [
                    {"title": "备菜", "text": "番茄切块，面条称好备用。", "icon": "bowl", "summary": "处理食材", "estimated_minutes": 5, "tip": "", "key_points": []},
                    {"title": "煮面", "text": "番茄炒出汁后加水煮开，下面条煮熟。", "icon": "pan", "summary": "煮熟", "estimated_minutes": 10, "tip": "", "key_points": []},
                ],
                "tips": "",
                "scene_tags": [],
            }
            with self.SessionLocal() as db:
                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="创建一份番茄鸡蛋面",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-unresolved-recipe",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                draft, approval = create_ai_draft_approval(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_type="recipe",
                    schema_version="recipe.v1",
                    payload=payload,
                    preview_summary="创建菜谱 · 番茄鸡蛋面",
                )
                db.commit()

            decision_response = self.client.post(
                f"/api/ai/conversations/{approval.conversation_id}/approvals/{approval.id}/decision",
                json={
                    "decision": "approved",
                    "draft_version": draft.version,
                    "values": {"recipe": payload},
                },
            )
            self.assertEqual(decision_response.status_code, 409, decision_response.text)
            self.assertIn("未解析的食材", decision_response.json()["detail"])
            with self.SessionLocal() as db:
                self.assertEqual(db.query(Recipe).count(), 0)

        def test_ai_workspace_approval_rejects_stale_draft_version(self) -> None:
            provider = FakeChatProvider(
                """
                {
                  "title": "番茄小炒",
                  "servings": 2,
                  "prep_minutes": 18,
                  "difficulty": "easy",
                  "ingredient_items": [{"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"}],
                  "steps": [
                    {"title": "备菜", "text": "番茄洗净后处理 5 分钟，切成均匀小块并沥干到表面没有透明水膜。调味料提前放好，这样下锅后可以连续操作，避免中途停顿导致受热不均。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "切块一致。", "key_points": ["切块"]},
                    {"title": "翻炒", "text": "锅中少油中火加热 30 秒，倒入番茄翻炒 3 分钟。看到番茄变软出汁后加入少量水，保持冒泡继续煮 5 分钟。", "icon": "pan", "summary": "炒软", "estimated_minutes": 8, "tip": "保持中火。", "key_points": ["中火"]},
                    {"title": "收尾", "text": "汤汁略微浓稠后加盐调味，再继续翻炒 1 分钟。确认番茄软烂且汤汁冒泡后关火装盘。", "icon": "plate", "summary": "装盘", "estimated_minutes": 5, "tip": "先少量盐。", "key_points": ["尝味"]}
                  ],
                  "tips": "清淡少油。",
                  "scene_tags": ["家常菜"]
                }
                """
            )
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                response = self.client.post(
                    "/api/ai/chat",
                    json={"message": "帮我生成一份番茄小炒的菜谱", "quick_task": "recipe_draft"},
                )
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval = data["included"]["approvals"][0]
            draft = data["included"]["drafts"][0]
            stale_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={
                    "decision": "approved",
                    "draft_version": draft["version"] + 1,
                    "values": {"recipe": draft["payload"]},
                },
            )
            self.assertEqual(stale_response.status_code, 409, stale_response.text)
            self.assertIn("草稿已更新", stale_response.json()["detail"])

        def test_ai_workspace_operation_failure_returns_recoverable_state(self) -> None:
            provider = FakeChatProvider(
                """
                {
                  "title": "番茄汤",
                  "servings": 2,
                  "prep_minutes": 18,
                  "difficulty": "easy",
                  "ingredient_items": [{"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"}],
                  "steps": [
                    {"title": "备菜", "text": "番茄洗净后处理 5 分钟，切成均匀小块并沥干到表面没有透明水膜。调味料提前放好，这样下锅后可以连续操作，避免中途停顿导致受热不均。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "切块一致。", "key_points": ["切块"]},
                    {"title": "煮汤", "text": "锅中少油中火加热 30 秒，倒入番茄翻炒 3 分钟。看到番茄变软出汁后加入热水，保持冒泡继续煮 8 分钟。", "icon": "pan", "summary": "煮汤", "estimated_minutes": 8, "tip": "保持中火。", "key_points": ["出汁"]},
                    {"title": "调味", "text": "汤汁沸腾且略微浓稠后加盐调味，再继续煮 1 分钟。确认番茄软烂且汤汁冒泡后关火装碗。", "icon": "plate", "summary": "装碗", "estimated_minutes": 5, "tip": "先少量盐。", "key_points": ["尝味"]}
                  ],
                  "tips": "清淡少油。",
                  "scene_tags": ["家常菜"]
                }
                """
            )
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                response = self.client.post(
                    "/api/ai/chat",
                    json={"message": "帮我生成一份番茄汤的菜谱", "quick_task": "recipe_draft"},
                )
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval = data["included"]["approvals"][0]
            draft = data["included"]["drafts"][0]

            with patch("app.services.ai_operations.recipes.ensure_food_for_recipe", side_effect=RuntimeError("sync failed")):
                decision_response = self.client.post(
                    f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                    json={
                        "decision": "approved",
                        "draft_version": draft["version"],
                        "values": {"recipe": draft["payload"]},
                    },
                )
            self.assertEqual(decision_response.status_code, 200, decision_response.text)
            decision_data = decision_response.json()
            self.assertEqual(decision_data["approval"]["status"], "pending")
            self.assertEqual(decision_data["approval"]["approval_type"], "recipe.create.retry")
            self.assertEqual(decision_data["draft"]["status"], "pending_retry")
            self.assertEqual(decision_data["operation"]["status"], "failed")
            self.assertIn("sync failed", decision_data["operation"]["error_message"])
            pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
            self.assertEqual(pending_response.status_code, 200, pending_response.text)
            self.assertEqual(pending_response.json()[0]["id"], decision_data["approval"]["id"])
            with self.SessionLocal() as db:
                self.assertEqual(db.query(Recipe).count(), 0)
                self.assertEqual(db.query(AIOperation).count(), 1)
                self.assertEqual(db.query(AIApprovalRequest).count(), 2)

        def test_ai_workspace_reject_does_not_validate_broken_recipe_payload(self) -> None:
            provider = FakeChatProvider(
                """
                {
                  "title": "番茄汤",
                  "servings": 2,
                  "prep_minutes": 18,
                  "difficulty": "easy",
                  "ingredient_items": [{"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"}],
                  "steps": [
                    {"title": "备菜", "text": "番茄洗净后处理 5 分钟，切成均匀小块并沥干到表面没有透明水膜。调味料提前放好，这样下锅后可以连续操作，避免中途停顿导致受热不均。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "切块一致。", "key_points": ["切块"]},
                    {"title": "煮汤", "text": "锅中少油中火加热 30 秒，倒入番茄翻炒 3 分钟。看到番茄变软出汁后加入热水，保持冒泡继续煮 8 分钟。", "icon": "pan", "summary": "煮汤", "estimated_minutes": 8, "tip": "保持中火。", "key_points": ["出汁"]},
                    {"title": "调味", "text": "汤汁沸腾且略微浓稠后加盐调味，再继续煮 1 分钟。确认番茄软烂且汤汁冒泡后关火装碗。", "icon": "plate", "summary": "装碗", "estimated_minutes": 5, "tip": "先少量盐。", "key_points": ["尝味"]}
                  ],
                  "tips": "清淡少油。",
                  "scene_tags": ["家常菜"]
                }
                """
            )
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                response = self.client.post(
                    "/api/ai/chat",
                    json={"message": "帮我生成一份番茄汤的菜谱", "quick_task": "recipe_draft"},
                )
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval = data["included"]["approvals"][0]
            draft = data["included"]["drafts"][0]
            reject_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={
                    "decision": "rejected",
                    "draft_version": draft["version"],
                    "values": {"recipe": {"title": ""}},
                },
            )
            self.assertEqual(reject_response.status_code, 200, reject_response.text)
            reject_data = reject_response.json()
            self.assertEqual(reject_data["approval"]["status"], "rejected")
            self.assertEqual(reject_data["draft"]["status"], "rejected")

        def test_recipe_update_operation_updates_existing_recipe(self) -> None:
            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-update-target",
                    family_id=self.family.id,
                    title="原始番茄炒蛋",
                    servings=2,
                    prep_minutes=15,
                    difficulty=Difficulty.EASY,
                    tips="原始提示",
                    scene_tags=["家常菜"],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(recipe)
                db.flush()
                db.add(
                    RecipeIngredient(
                        id="recipe-update-ingredient",
                        recipe_id=recipe.id,
                        ingredient_id="ingredient-tomato",
                        ingredient_name="番茄",
                        quantity=2,
                        unit="个",
                        note="切块",
                        sort_order=0,
                    )
                )
                db.add(
                    Food(
                        id="food-update-target",
                        family_id=self.family.id,
                        name="原始番茄炒蛋",
                        type=FoodType.SELF_MADE,
                        category="家常菜",
                        flavor_tags=[],
                        scene_tags=["家常菜"],
                        suitable_meal_types=["dinner"],
                        source_name="自家菜谱",
                        purchase_source="",
                        scene="晚餐",
                        notes="",
                        routine_note="",
                        recipe_id=recipe.id,
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                db.flush()

                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="更新番茄炒蛋菜谱",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-recipe-update",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "recipe",
                        "payload": {
                            "draftType": "recipe",
                            "schemaVersion": "recipe_operation.v1",
                            "action": "update",
                            "targetId": recipe.id,
                            "baseUpdatedAt": recipe.updated_at.isoformat(),
                            "payload": {
                                "title": "升级版番茄炒蛋",
                                "servings": 3,
                                "prep_minutes": 18,
                                "difficulty": "easy",
                                "ingredient_items": [
                                    {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 3, "unit": "个", "note": "切块"},
                                ],
                                "steps": [
                                    {"title": "备菜", "text": "番茄切块。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "", "key_points": []},
                                    {"title": "翻炒", "text": "快速翻炒。", "icon": "pan", "summary": "翻炒", "estimated_minutes": 8, "tip": "", "key_points": []},
                                ],
                                "tips": "加一点糖提鲜",
                                "scene_tags": ["家常菜", "快手菜"],
                                "media_ids": [],
                            },
                        },
                    },
                )
                self.assertEqual(approval.approval_type, "recipe.update")
                result = service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values=approval.initial_values,
                )
                self.assertEqual(result["operation"]["business_entity_type"], "Recipe")
                db.refresh(recipe)
                self.assertEqual(recipe.title, "升级版番茄炒蛋")
                self.assertEqual(recipe.servings, 3)
                self.assertEqual(recipe.tips, "加一点糖提鲜")

        def test_recipe_delete_operation_removes_recipe_and_linked_food(self) -> None:
            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-delete-target",
                    family_id=self.family.id,
                    title="待删除菜谱",
                    servings=2,
                    prep_minutes=15,
                    difficulty=Difficulty.EASY,
                    tips="原始提示",
                    scene_tags=["家常菜"],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(recipe)
                db.flush()
                food = Food(
                    id="food-delete-target",
                    family_id=self.family.id,
                    name="待删除家常菜",
                    type=FoodType.SELF_MADE,
                    category="家常菜",
                    flavor_tags=[],
                    scene_tags=["家常菜"],
                    suitable_meal_types=["dinner"],
                    source_name="自家菜谱",
                    purchase_source="",
                    scene="晚餐",
                    notes="",
                    routine_note="",
                    recipe_id=recipe.id,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(food)
                db.flush()
                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="删除待删除菜谱",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-recipe-delete",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "recipe",
                        "payload": {
                            "draftType": "recipe",
                            "schemaVersion": "recipe_operation.v1",
                            "action": "delete",
                            "targetId": recipe.id,
                            "baseUpdatedAt": recipe.updated_at.isoformat(),
                            "payload": {"reason": "不再需要"},
                        },
                    },
                )
                self.assertEqual(approval.approval_type, "recipe.delete")
                result = service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values=approval.initial_values,
                )
                self.assertTrue(result["business_entity"]["deleted"])
                self.assertIsNone(db.get(Recipe, recipe.id))
                self.assertIsNone(db.get(Food, food.id))

        def test_recipe_favorite_operation_updates_recipe_favorite(self) -> None:
            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-favorite-target",
                    family_id=self.family.id,
                    title="收藏菜谱",
                    servings=2,
                    prep_minutes=10,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=["家常菜"],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(recipe)
                db.flush()
                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="收藏菜谱",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-recipe-favorite",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "recipe",
                        "payload": {
                            "draftType": "recipe",
                            "schemaVersion": "recipe_operation.v1",
                            "action": "set_favorite",
                            "targetId": recipe.id,
                            "baseUpdatedAt": recipe.updated_at.isoformat(),
                            "payload": {"favorite": True},
                        },
                    },
                )
                self.assertEqual(approval.approval_type, "recipe.favorite")
                service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values=approval.initial_values,
                )
                favorite = db.scalar(
                    select(RecipeFavorite).where(
                        RecipeFavorite.family_id == self.family.id,
                        RecipeFavorite.user_id == self.user.id,
                        RecipeFavorite.recipe_id == recipe.id,
                    )
                )
                self.assertIsNotNone(favorite)

        def test_recipe_cook_draft_deducts_inventory_and_completes_plan(self) -> None:
            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-cook-target",
                    family_id=self.family.id,
                    title="番茄快炒",
                    servings=2,
                    prep_minutes=12,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=["家常菜"],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(recipe)
                db.flush()
                db.add(
                    RecipeIngredient(
                        id="recipe-cook-ingredient",
                        recipe_id=recipe.id,
                        ingredient_id="ingredient-tomato",
                        ingredient_name="番茄",
                        quantity=2,
                        unit="个",
                        note="切块",
                        sort_order=0,
                    )
                )
                food = Food(
                    id="food-cook-target",
                    family_id=self.family.id,
                    name="番茄快炒",
                    type=FoodType.SELF_MADE,
                    category="家常菜",
                    flavor_tags=[],
                    scene_tags=["家常菜"],
                    suitable_meal_types=["dinner"],
                    source_name="自家菜谱",
                    purchase_source="",
                    scene="晚餐",
                    notes="",
                    routine_note="",
                    recipe_id=recipe.id,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(food)
                db.flush()
                plan_item = FoodPlanItem(
                    id="plan-cook-target",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    food_id=food.id,
                    plan_date=date.today(),
                    meal_type=MealType.DINNER,
                    note="今晚做掉",
                    status="planned",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(plan_item)
                db.flush()

                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="做掉今晚这份番茄快炒",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-recipe-cook",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "recipe_cook",
                        "payload": {
                            "draftType": "recipe_cook",
                            "schemaVersion": "recipe_cook_operation.v1",
                            "recipeId": recipe.id,
                            "servings": 2,
                            "date": date.today().isoformat(),
                            "mealType": "dinner",
                            "createMealLog": True,
                            "planItemId": plan_item.id,
                            "notes": "AI 做菜测试",
                            "resultNote": "顺利完成",
                            "adjustments": "无调整",
                        },
                    },
                )
                self.assertEqual(approval.approval_type, "recipe.cook")
                result = service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values=approval.initial_values,
                )
                self.assertEqual(result["operation"]["business_entity_type"], "RecipeCookLog")
                inventory_item = db.get(InventoryItem, "inventory-tomato")
                assert inventory_item is not None
                self.assertEqual(inventory_item.consumed_quantity, Decimal("2"))
                db.refresh(plan_item)
                self.assertEqual(plan_item.status, "cooked")
                self.assertIsNotNone(plan_item.meal_log_id)
                cook_log = db.scalar(select(RecipeCookLog).where(RecipeCookLog.recipe_id == recipe.id))
                self.assertIsNotNone(cook_log)
                meal_log = db.scalar(select(MealLog).where(MealLog.id == plan_item.meal_log_id))
                self.assertIsNotNone(meal_log)

        def test_recipe_cook_tools_reject_mismatched_plan_item(self) -> None:
            from app.ai.tools.catalog.recipe import recipe_create_cook_draft, recipe_preview_cook

            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-preview-mismatch-target",
                    family_id=self.family.id,
                    title="番茄快炒",
                    servings=2,
                    prep_minutes=12,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=["家常菜"],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                other_recipe = Recipe(
                    id="recipe-preview-mismatch-other",
                    family_id=self.family.id,
                    title="盒装牛奶早餐",
                    servings=1,
                    prep_minutes=2,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=["早餐"],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add_all([recipe, other_recipe])
                db.flush()
                db.add(
                    RecipeIngredient(
                        id="recipe-preview-mismatch-ingredient",
                        recipe_id=recipe.id,
                        ingredient_id="ingredient-tomato",
                        ingredient_name="番茄",
                        quantity=2,
                        unit="个",
                        note="切块",
                        sort_order=0,
                    )
                )
                food = Food(
                    id="food-preview-mismatch-other",
                    family_id=self.family.id,
                    name="盒装牛奶",
                    type=FoodType.SELF_MADE,
                    category="早餐",
                    flavor_tags=[],
                    scene_tags=["早餐"],
                    suitable_meal_types=["breakfast"],
                    source_name="自家菜谱",
                    purchase_source="",
                    scene="早餐",
                    notes="",
                    routine_note="",
                    recipe_id=other_recipe.id,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(food)
                db.flush()
                plan_item = FoodPlanItem(
                    id="plan-preview-mismatch-other",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    food_id=food.id,
                    plan_date=date.today(),
                    meal_type=MealType.BREAKFAST,
                    note="早餐计划",
                    status="planned",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(plan_item)
                db.flush()

                context = ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id=None, run_id=None)
                preview = recipe_preview_cook(context, {"recipeId": recipe.id, "servings": 2, "planItemId": plan_item.id})
                self.assertIsNone(preview["planItem"])
                self.assertEqual(preview["planItemWarning"]["code"], "plan_item_recipe_mismatch")
                self.assertEqual(preview["planItemWarning"]["planItemId"], plan_item.id)
                self.assertEqual(preview["recipe"]["id"], recipe.id)
                with self.assertRaisesRegex(ValueError, "做菜草稿引用的计划项不存在或不匹配当前菜谱"):
                    recipe_create_cook_draft(
                        context,
                        {
                            "draft": {
                                "draftType": "recipe_cook",
                                "schemaVersion": "recipe_cook_operation.v1",
                                "recipeId": recipe.id,
                                "title": recipe.title,
                                "servings": 2,
                                "date": date.today().isoformat(),
                                "mealType": "dinner",
                                "createMealLog": True,
                                "planItemId": plan_item.id,
                                "notes": "",
                                "resultNote": "",
                                "adjustments": "",
                                "rating": None,
                                "previewItems": [],
                                "shortages": [],
                            }
                        },
                    )

        def test_meal_plan_set_status_operation_updates_existing_item(self) -> None:
            with self.SessionLocal() as db:
                food = db.scalar(select(Food).where(Food.id == "food-tomato"))
                assert food is not None
                item = FoodPlanItem(
                    id="plan-status-target",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    food_id=food.id,
                    plan_date=date.today(),
                    meal_type=MealType.DINNER,
                    note="待完成",
                    status="planned",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(item)
                db.flush()
                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="把今晚计划标记完成",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-plan-status",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "meal_plan",
                        "payload": {
                            "draftType": "meal_plan",
                            "schemaVersion": "meal_plan_operation.v1",
                            "operations": [
                                {
                                    "action": "set_status",
                                    "targetId": item.id,
                                    "baseUpdatedAt": item.updated_at.isoformat(),
                                    "payload": {"status": "cooked", "reason": "已经做完"},
                                }
                            ],
                        },
                    },
                )
                self.assertEqual(approval.approval_type, "meal_plan.apply")
                self.assertEqual(approval.request_payload["title"], "确认修改餐食计划")
                self.assertEqual(approval.request_payload["approveLabel"], "修改计划")
                self.assertTrue(draft.payload["operations"][0]["operationId"].startswith("ai_op_item-"))
                service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values=approval.initial_values,
                )
                db.refresh(item)
                self.assertEqual(item.status, "cooked")
                self.assertIsNotNone(item.completed_at)

        def test_shopping_set_done_operation_updates_existing_item(self) -> None:
            with self.SessionLocal() as db:
                item = ShoppingListItem(
                    id="shopping-done-target",
                    family_id=self.family.id,
                    title="鸡蛋",
                    quantity=Decimal("2"),
                    unit="盒",
                    reason="早餐",
                    done=False,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(item)
                db.flush()
                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="鸡蛋买到了",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-shopping-done",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "shopping_list",
                        "payload": {
                            "draftType": "shopping_list",
                            "schemaVersion": "shopping_list_operation.v1",
                            "operations": [
                                {
                                    "action": "set_done",
                                    "targetId": item.id,
                                    "baseUpdatedAt": item.updated_at.isoformat(),
                                    "payload": {"done": True, "reason": "已采购"},
                                }
                            ],
                        },
                    },
                )
                self.assertEqual(approval.approval_type, "shopping_list.apply")
                self.assertEqual(approval.request_payload["title"], "确认修改购物清单")
                self.assertEqual(approval.request_payload["approveLabel"], "修改清单")
                self.assertTrue(draft.payload["operations"][0]["operationId"].startswith("ai_op_item-"))
                service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values=approval.initial_values,
                )
                db.refresh(item)
                self.assertTrue(item.done)

        def test_ai_approval_business_writes_record_audit_fields_and_activity_logs(self) -> None:
            with self.SessionLocal() as db:
                food = db.scalar(select(Food).where(Food.id == "food-tomato"))
                assert food is not None

                def approve_case(*, suffix: str, draft_type: str, payload: dict) -> dict:
                    activity_count = db.query(ActivityLog).count()
                    approval_audit_count = db.query(AIUserApproval).count()
                    operation_count = db.query(AIOperation).count()
                    service, draft, approval = self._create_ai_approval_for_test(
                        db,
                        draft_type=draft_type,
                        payload=payload,
                        suffix=suffix,
                    )
                    result = self._approve_ai_approval_for_test(service, draft=draft, approval=approval)
                    self.assertEqual(result["operation"]["status"], "succeeded")
                    self.assertEqual(db.query(AIOperation).count(), operation_count + 1)
                    self.assertEqual(db.query(AIUserApproval).count(), approval_audit_count + 1)
                    self.assertGreater(db.query(ActivityLog).count(), activity_count)
                    approval_audit = db.scalar(
                        select(AIUserApproval).where(
                            AIUserApproval.approval_request_id == approval.id,
                            AIUserApproval.draft_id == draft.id,
                        )
                    )
                    self.assertIsNotNone(approval_audit)
                    assert approval_audit is not None
                    self.assertEqual(approval_audit.approved_by, self.user.id)
                    self.assertEqual(approval_audit.decision, "approved")
                    self.assertEqual(approval_audit.operation_summary["operationId"], result["operation"]["id"])
                    return result

                with self.subTest("ingredient_profile.create"):
                    result = approve_case(
                        suffix="ingredient-create",
                        draft_type="ingredient_profile",
                        payload={
                            "draftType": "ingredient_profile",
                            "schemaVersion": "ingredient_profile.v1",
                            "action": "create",
                            "payload": {
                                "name": "审计黄瓜",
                                "category": "蔬菜",
                                "default_unit": "根",
                                "unit_conversions": [],
                                "default_storage": "冷藏",
                                "default_expiry_mode": "none",
                                "notes": "AI 审计创建",
                                "media_ids": [],
                            },
                        },
                    )
                    ingredient = db.get(Ingredient, result["business_entity"]["id"])
                    assert ingredient is not None
                    self.assertEqual(ingredient.created_by, self.user.id)
                    self.assertEqual(ingredient.updated_by, self.user.id)
                    self.assertIsNotNone(
                        db.scalar(select(ActivityLog).where(ActivityLog.entity_type == "Ingredient", ActivityLog.entity_id == ingredient.id))
                    )

                with self.subTest("food_profile.create"):
                    result = approve_case(
                        suffix="food-create",
                        draft_type="food_profile",
                        payload={
                            "draftType": "food_profile",
                            "schemaVersion": "food_profile.v1",
                            "action": "create",
                            "payload": {
                                "name": "审计酸奶",
                                "type": "readyMade",
                                "category": "乳品",
                                "flavor_tags": ["酸甜"],
                                "scene_tags": ["早餐"],
                                "suitable_meal_types": ["breakfast"],
                                "source_name": "AI 整理",
                                "purchase_source": "超市",
                                "scene": "早餐",
                                "notes": "AI 审计创建",
                                "routine_note": "",
                                "favorite": False,
                                "recipe_id": None,
                                "media_ids": [],
                            },
                        },
                    )
                    created_food = db.get(Food, result["business_entity"]["id"])
                    assert created_food is not None
                    self.assertEqual(created_food.created_by, self.user.id)
                    self.assertEqual(created_food.updated_by, self.user.id)
                    self.assertIsNotNone(
                        db.scalar(select(ActivityLog).where(ActivityLog.entity_type == "Food", ActivityLog.entity_id == created_food.id))
                    )

                with self.subTest("recipe.create"):
                    result = approve_case(
                        suffix="recipe-create",
                        draft_type="recipe",
                        payload={
                            "draftType": "recipe",
                            "schemaVersion": "recipe.v1",
                            "title": "审计番茄汤",
                            "servings": 2,
                            "prep_minutes": 18,
                            "difficulty": "easy",
                            "ingredient_items": [
                                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 1, "unit": "个", "note": "切块"},
                            ],
                            "steps": [
                                {"title": "备菜", "text": "番茄切块。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "", "key_points": []},
                                {"title": "煮汤", "text": "加水煮开。", "icon": "pan", "summary": "煮汤", "estimated_minutes": 8, "tip": "", "key_points": []},
                            ],
                            "tips": "少盐",
                            "scene_tags": ["家常菜"],
                            "media_ids": [],
                        },
                    )
                    recipe = db.get(Recipe, result["business_entity"]["id"])
                    assert recipe is not None
                    self.assertEqual(recipe.created_by, self.user.id)
                    self.assertEqual(recipe.updated_by, self.user.id)
                    self.assertIsNotNone(
                        db.scalar(select(ActivityLog).where(ActivityLog.entity_type == "Recipe", ActivityLog.entity_id == recipe.id))
                    )

                with self.subTest("meal_plan.create"):
                    result = approve_case(
                        suffix="meal-plan-create",
                        draft_type="meal_plan",
                        payload={
                            "draftType": "meal_plan",
                            "schemaVersion": "meal_plan_operation.v1",
                            "operations": [
                                {
                                    "action": "create",
                                    "payload": {
                                        "date": date.today().isoformat(),
                                        "mealType": "dinner",
                                        "title": food.name,
                                        "foodId": food.id,
                                        "reason": "AI 审计安排",
                                    },
                                }
                            ],
                        },
                    )
                    plan_id = result["business_entity"]["operations"][0]["item"]["id"]
                    plan = db.get(FoodPlanItem, plan_id)
                    assert plan is not None
                    self.assertEqual(plan.created_by, self.user.id)
                    self.assertEqual(plan.updated_by, self.user.id)
                    self.assertIsNotNone(
                        db.scalar(select(ActivityLog).where(ActivityLog.entity_type == "FoodPlanItem", ActivityLog.entity_id == plan.id))
                    )

                with self.subTest("shopping.create"):
                    salt = Ingredient(
                        id="ingredient-shopping-approval-salt",
                        family_id=self.family.id,
                        name="盐",
                        category="调料",
                        default_unit="g",
                        unit_conversions=[],
                        quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
                        default_storage="常温",
                        default_expiry_mode=IngredientExpiryMode.NONE,
                        notes="",
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                    db.add(salt)
                    db.flush()
                    result = approve_case(
                        suffix="shopping-create",
                        draft_type="shopping_list",
                        payload={
                            "draftType": "shopping_list",
                            "schemaVersion": "shopping_list_operation.v1",
                            "operations": [
                                {
                                    "action": "create",
                                    "payload": {
                                        "ingredientId": salt.id,
                                        "title": "盐",
                                        "quantityMode": "not_track_quantity",
                                        "displayLabel": "需要补充",
                                        "reason": "调料补充",
                                    },
                                }
                            ],
                        },
                    )
                    shopping_id = result["business_entity"]["operations"][0]["item"]["id"]
                    shopping = db.get(ShoppingListItem, shopping_id)
                    assert shopping is not None
                    self.assertEqual(shopping.ingredient_id, salt.id)
                    self.assertEqual(shopping.quantity_mode, IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY)
                    self.assertEqual(shopping.display_label, "需要补充")
                    self.assertEqual(shopping.created_by, self.user.id)
                    self.assertEqual(shopping.updated_by, self.user.id)
                    self.assertIsNotNone(
                        db.scalar(select(ActivityLog).where(ActivityLog.entity_type == "ShoppingListItem", ActivityLog.entity_id == shopping.id))
                    )

                with self.subTest("meal_log.create"):
                    result = approve_case(
                        suffix="meal-log-create",
                        draft_type="meal_log",
                        payload={
                            "draftType": "meal_log",
                            "schemaVersion": "meal_log.v1",
                            "date": date.today().isoformat(),
                            "mealType": "dinner",
                            "foods": [{"foodId": food.id, "name": food.name, "servings": 1, "note": "AI 审计记录"}],
                            "participantUserIds": [self.user.id],
                            "notes": "AI 审计创建",
                            "mood": "",
                            "mediaIds": [],
                        },
                    )
                    meal_log = db.get(MealLog, result["business_entity"]["id"])
                    assert meal_log is not None
                    self.assertEqual(meal_log.created_by, self.user.id)
                    self.assertEqual(meal_log.updated_by, self.user.id)
                    self.assertIsNotNone(
                        db.scalar(select(ActivityLog).where(ActivityLog.entity_type == "MealLog", ActivityLog.entity_id == meal_log.id))
                    )

                with self.subTest("inventory_operation.restock"):
                    result = approve_case(
                        suffix="inventory-restock",
                        draft_type="inventory_operation",
                        payload={
                            "draftType": "inventory_operation",
                            "schemaVersion": "inventory_operation.v1",
                            "operations": [
                                {
                                    "action": "restock",
                                    "ingredientId": "ingredient-tomato",
                                    "quantity": 2,
                                    "unit": "个",
                                    "status": "fresh",
                                    "purchaseDate": date.today().isoformat(),
                                    "storageLocation": "冷藏",
                                    "notes": "AI 审计入库",
                                }
                            ],
                        },
                    )
                    inventory_id = result["business_entity"]["operations"][0]["inventory_item_id"]
                    inventory = db.get(InventoryItem, inventory_id)
                    assert inventory is not None
                    self.assertEqual(inventory.created_by, self.user.id)
                    self.assertEqual(inventory.updated_by, self.user.id)
                    self.assertIsNotNone(
                        db.scalar(select(ActivityLog).where(ActivityLog.entity_type == "InventoryItem", ActivityLog.entity_id == inventory.id))
                    )

                with self.subTest("recipe_cook"):
                    recipe = Recipe(
                        id="recipe-audit-cook",
                        family_id=self.family.id,
                        title="审计番茄快炒",
                        servings=1,
                        prep_minutes=10,
                        difficulty=Difficulty.EASY,
                        tips="",
                        scene_tags=["家常菜"],
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                    db.add(recipe)
                    db.flush()
                    db.add(
                        RecipeIngredient(
                            id="recipe-audit-cook-ingredient",
                            recipe_id=recipe.id,
                            ingredient_id="ingredient-tomato",
                            ingredient_name="番茄",
                            quantity=1,
                            unit="个",
                            note="切块",
                            sort_order=0,
                        )
                    )
                    result = approve_case(
                        suffix="recipe-cook",
                        draft_type="recipe_cook",
                        payload={
                            "draftType": "recipe_cook",
                            "schemaVersion": "recipe_cook_operation.v1",
                            "recipeId": recipe.id,
                            "servings": 1,
                            "date": date.today().isoformat(),
                            "mealType": "dinner",
                            "participantUserIds": [self.user.id],
                            "notes": "AI 审计做菜",
                            "createMealLog": True,
                            "resultNote": "完成",
                            "adjustments": "",
                        },
                    )
                    cook_log = db.get(RecipeCookLog, result["business_entity"]["cook_log_id"])
                    assert cook_log is not None
                    self.assertEqual(cook_log.created_by, self.user.id)
                    self.assertEqual(cook_log.updated_by, self.user.id)
                    self.assertIsNotNone(
                        db.scalar(select(ActivityLog).where(ActivityLog.entity_type == "Recipe", ActivityLog.entity_id == recipe.id))
                    )

        def test_ai_create_operations_enqueue_reference_image_generation_with_existing_media(self) -> None:
            from app.ai.images.jobs import _bind_generated_asset_to_target

            with self.SessionLocal() as db:
                def add_upload_media(media_id: str, name: str) -> MediaAsset:
                    asset = MediaAsset(
                        id=media_id,
                        family_id=self.family.id,
                        name=name,
                        url=f"/media/family-ai/{media_id}.png",
                        file_path=f"family-ai/{media_id}.png",
                        source=MediaSource.UPLOAD,
                        alt=name,
                        created_by=self.user.id,
                    )
                    db.add(asset)
                    return asset

                def approve_case(*, draft_type: str, suffix: str, payload: dict) -> dict:
                    service, draft, approval = self._create_ai_approval_for_test(
                        db,
                        draft_type=draft_type,
                        suffix=suffix,
                        payload=payload,
                    )
                    return self._approve_ai_approval_for_test(service, draft=draft, approval=approval)

                ingredient_reference = add_upload_media("media-ai-ingredient-reference", "黄瓜参考图")
                food_reference = add_upload_media("media-ai-food-reference", "酸奶参考图")
                recipe_reference = add_upload_media("media-ai-recipe-reference", "番茄汤参考图")
                db.flush()

                ingredient_result = approve_case(
                    draft_type="ingredient_profile",
                    suffix="ingredient-reference-image",
                    payload={
                        "draftType": "ingredient_profile",
                        "schemaVersion": "ingredient_profile.v1",
                        "action": "create",
                        "payload": {
                            "name": "参考黄瓜",
                            "category": "蔬菜",
                            "default_unit": "根",
                            "unit_conversions": [],
                            "default_storage": "冷藏",
                            "default_expiry_mode": "none",
                            "notes": "带参考图创建",
                            "media_ids": [ingredient_reference.id],
                        },
                    },
                )
                food_result = approve_case(
                    draft_type="food_profile",
                    suffix="food-reference-image",
                    payload={
                        "draftType": "food_profile",
                        "schemaVersion": "food_profile.v1",
                        "action": "create",
                        "payload": {
                            "name": "参考酸奶",
                            "type": "readyMade",
                            "category": "乳品",
                            "flavor_tags": ["酸甜"],
                            "scene_tags": ["早餐"],
                            "suitable_meal_types": ["breakfast"],
                            "source_name": "AI 整理",
                            "purchase_source": "超市",
                            "scene": "早餐",
                            "notes": "带参考图创建",
                            "routine_note": "",
                            "favorite": False,
                            "recipe_id": None,
                            "media_ids": [food_reference.id],
                        },
                    },
                )
                recipe_result = approve_case(
                    draft_type="recipe",
                    suffix="recipe-reference-image",
                    payload={
                        "draftType": "recipe",
                        "schemaVersion": "recipe.v1",
                        "title": "参考番茄汤",
                        "servings": 2,
                        "prep_minutes": 18,
                        "difficulty": "easy",
                        "ingredient_items": [
                            {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 1, "unit": "个", "note": "切块"},
                        ],
                        "steps": [
                            {"title": "备菜", "text": "番茄切块。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "", "key_points": []},
                            {"title": "煮汤", "text": "加水煮开。", "icon": "pan", "summary": "煮汤", "estimated_minutes": 8, "tip": "", "key_points": []},
                        ],
                        "tips": "少盐",
                        "scene_tags": ["家常菜"],
                        "media_ids": [recipe_reference.id],
                    },
                )

                cases = [
                    ("ingredient", ingredient_result["business_entity"]["id"], ingredient_reference.id),
                    ("food", food_result["business_entity"]["id"], food_reference.id),
                    ("recipe", recipe_result["business_entity"]["id"], recipe_reference.id),
                ]
                for entity_type, entity_id, reference_id in cases:
                    with self.subTest(entity_type=entity_type):
                        image_job = db.scalar(
                            select(AIImageGenerationJob).where(
                                AIImageGenerationJob.family_id == self.family.id,
                                AIImageGenerationJob.target_entity_type == entity_type,
                                AIImageGenerationJob.target_entity_id == entity_id,
                            )
                        )
                        self.assertIsNotNone(image_job)
                        assert image_job is not None
                        self.assertEqual(image_job.status, "queued")
                        self.assertEqual(image_job.bind_status, "pending")
                        self.assertEqual(image_job.reference_media_id, reference_id)
                        self.assertEqual(image_job.request_payload["mode"], "reference")
                        self.assertEqual(image_job.request_payload["bind_strategy"], "append")

                recipe_id = recipe_result["business_entity"]["id"]
                recipe_job = db.scalar(
                    select(AIImageGenerationJob).where(
                        AIImageGenerationJob.family_id == self.family.id,
                        AIImageGenerationJob.target_entity_type == "recipe",
                        AIImageGenerationJob.target_entity_id == recipe_id,
                    )
                )
                assert recipe_job is not None
                generated = MediaAsset(
                    id="media-ai-generated-recipe-reference",
                    family_id=self.family.id,
                    name="参考番茄汤 AI 图",
                    url="/media/family-ai/generated-recipe-reference.png",
                    file_path="family-ai/generated-recipe-reference.png",
                    source=MediaSource.AI,
                    generation_mode=ImageGenerationMode.REFERENCE,
                    reference_media_id=recipe_reference.id,
                    alt="参考番茄汤 AI 图",
                    created_by=self.user.id,
                )
                db.add(generated)
                db.flush()
                recipe_job.generated_media_id = generated.id
                self.assertEqual(_bind_generated_asset_to_target(db, recipe_job), "bound")
                db.flush()

                recipe_asset_ids = {
                    asset.id
                    for asset in db.scalars(
                        select(MediaAsset).where(
                            MediaAsset.family_id == self.family.id,
                            MediaAsset.entity_type == "recipe",
                            MediaAsset.entity_id == recipe_id,
                        )
                    )
                }
                self.assertIn(recipe_reference.id, recipe_asset_ids)
                self.assertIn(generated.id, recipe_asset_ids)
                synced_food = db.scalar(select(Food).where(Food.family_id == self.family.id, Food.recipe_id == recipe_id))
                assert synced_food is not None
                synced_food_assets = list(
                    db.scalars(
                        select(MediaAsset).where(
                            MediaAsset.family_id == self.family.id,
                            MediaAsset.entity_type == "food",
                            MediaAsset.entity_id == synced_food.id,
                        )
                    )
                )
                self.assertTrue(any(asset.source == MediaSource.UPLOAD for asset in synced_food_assets))
                self.assertTrue(any(asset.source == MediaSource.AI and asset.reference_media_id == recipe_reference.id for asset in synced_food_assets))

        def test_target_bound_operation_approvals_create_retry_on_stale_base_updated_at(self) -> None:
            stale_base_updated_at = "2026-01-01T00:00:00Z"
            with self.SessionLocal() as db:
                food = db.scalar(select(Food).where(Food.id == "food-tomato"))
                ingredient = db.scalar(select(Ingredient).where(Ingredient.id == "ingredient-tomato"))
                assert food is not None
                assert ingredient is not None

                recipe = Recipe(
                    id="recipe-stale-target",
                    family_id=self.family.id,
                    title="冲突菜谱",
                    servings=2,
                    prep_minutes=15,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=["家常菜"],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                plan = FoodPlanItem(
                    id="plan-stale-target",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    food_id=food.id,
                    plan_date=date.today(),
                    meal_type=MealType.DINNER,
                    status="planned",
                    note="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                shopping = ShoppingListItem(
                    id="shopping-stale-target",
                    family_id=self.family.id,
                    title="冲突鸡蛋",
                    quantity=Decimal("2"),
                    unit="盒",
                    reason="早餐",
                    done=False,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                meal_log = MealLog(
                    id="meal-log-stale-target",
                    family_id=self.family.id,
                    date=date.today(),
                    meal_type=MealType.DINNER,
                    participant_user_ids=[self.user.id],
                    notes="原记录",
                    mood="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add_all([recipe, plan, shopping, meal_log])
                db.flush()
                db.add(
                    RecipeIngredient(
                        id="recipe-stale-ingredient",
                        recipe_id=recipe.id,
                        ingredient_id=ingredient.id,
                        ingredient_name=ingredient.name,
                        quantity=1,
                        unit=ingredient.default_unit,
                        note="切块",
                        sort_order=0,
                    )
                )
                db.add(
                    MealLogFood(
                        id="meal-log-food-stale-target",
                        meal_log_id=meal_log.id,
                        food_id=food.id,
                        servings=Decimal("1"),
                        note="",
                    )
                )
                db.flush()

                cases = [
                    (
                        "ingredient-update",
                        "ingredient_profile",
                        {
                            "draftType": "ingredient_profile",
                            "schemaVersion": "ingredient_profile_operation.v1",
                            "action": "update",
                            "targetId": ingredient.id,
                            "baseUpdatedAt": stale_base_updated_at,
                            "payload": {
                                "name": ingredient.name,
                                "category": ingredient.category,
                                "default_unit": ingredient.default_unit,
                                "unit_conversions": [],
                                "default_storage": ingredient.default_storage,
                                "default_expiry_mode": "none",
                                "notes": "冲突测试",
                                "media_ids": [],
                            },
                        },
                    ),
                    (
                        "food-update",
                        "food_profile",
                        {
                            "draftType": "food_profile",
                            "schemaVersion": "food_profile_operation.v1",
                            "action": "update",
                            "targetId": food.id,
                            "baseUpdatedAt": stale_base_updated_at,
                            "payload": {
                                "name": food.name,
                                "type": "selfMade",
                                "category": food.category,
                                "flavor_tags": [],
                                "scene_tags": ["家常菜"],
                                "suitable_meal_types": ["dinner"],
                                "source_name": "",
                                "purchase_source": "",
                                "scene": "晚餐",
                                "notes": "冲突测试",
                                "routine_note": "",
                                "favorite": False,
                                "recipe_id": None,
                                "media_ids": [],
                            },
                        },
                    ),
                    (
                        "recipe-update",
                        "recipe",
                        {
                            "draftType": "recipe",
                            "schemaVersion": "recipe_operation.v1",
                            "action": "update",
                            "targetId": recipe.id,
                            "baseUpdatedAt": stale_base_updated_at,
                            "payload": {
                                "title": recipe.title,
                                "servings": 2,
                                "prep_minutes": 16,
                                "difficulty": "easy",
                                "ingredient_items": [
                                    {"ingredient_id": ingredient.id, "ingredient_name": ingredient.name, "quantity": 1, "unit": ingredient.default_unit, "note": "切块"},
                                ],
                                "steps": [
                                    {"title": "备菜", "text": "处理番茄。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "", "key_points": []},
                                    {"title": "烹饪", "text": "加热烹饪。", "icon": "pan", "summary": "烹饪", "estimated_minutes": 8, "tip": "", "key_points": []},
                                ],
                                "tips": "",
                                "scene_tags": ["家常菜"],
                                "media_ids": [],
                            },
                        },
                    ),
                    (
                        "meal-plan-status",
                        "meal_plan",
                        {
                            "draftType": "meal_plan",
                            "schemaVersion": "meal_plan_operation.v1",
                            "operations": [
                                {
                                    "action": "set_status",
                                    "targetId": plan.id,
                                    "baseUpdatedAt": stale_base_updated_at,
                                    "payload": {"status": "cooked", "reason": "冲突测试"},
                                }
                            ],
                        },
                    ),
                    (
                        "shopping-done",
                        "shopping_list",
                        {
                            "draftType": "shopping_list",
                            "schemaVersion": "shopping_list_operation.v1",
                            "operations": [
                                {
                                    "action": "set_done",
                                    "targetId": shopping.id,
                                    "baseUpdatedAt": stale_base_updated_at,
                                    "payload": {"done": True, "reason": "冲突测试"},
                                }
                            ],
                        },
                    ),
                    (
                        "meal-log-update",
                        "meal_log",
                        {
                            "draftType": "meal_log",
                            "schemaVersion": "meal_log_operation.v1",
                            "action": "update_details",
                            "targetId": meal_log.id,
                            "baseUpdatedAt": stale_base_updated_at,
                            "payload": {"notes": "冲突测试", "participantUserIds": [self.user.id], "mood": "", "mediaIds": []},
                        },
                    ),
                    (
                        "recipe-cook",
                        "recipe_cook",
                        {
                            "draftType": "recipe_cook",
                            "schemaVersion": "recipe_cook_operation.v1",
                            "recipeId": recipe.id,
                            "baseUpdatedAt": stale_base_updated_at,
                            "servings": 1,
                            "date": date.today().isoformat(),
                            "mealType": "dinner",
                            "createMealLog": False,
                        },
                    ),
                ]

                for suffix, draft_type, payload in cases:
                    with self.subTest(suffix):
                        service, draft, approval = self._create_ai_approval_for_test(
                            db,
                            draft_type=draft_type,
                            payload=payload,
                            suffix=f"stale-{suffix}",
                        )
                        result = self._approve_ai_approval_for_test(service, draft=draft, approval=approval)
                        self.assertEqual(result["operation"]["status"], "failed")
                        self.assertEqual(result["draft"]["status"], "pending_retry")
                        self.assertEqual(result["approval"]["status"], "pending")
                        self.assertTrue(result["approval"]["approval_type"].endswith(".retry"))
                        self.assertIn("更新", result["operation"]["error_message"])
                        self.assertIn("重试", result["operation"]["error_message"])

        def test_meal_plan_retry_approval_includes_failed_operation_summary(self) -> None:
            with self.SessionLocal() as db:
                food = db.scalar(select(Food).where(Food.id == "food-tomato"))
                assert food is not None
                item = FoodPlanItem(
                    id="plan-retry-target",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    food_id=food.id,
                    plan_date=date.today(),
                    meal_type=MealType.DINNER,
                    note="原计划",
                    status="planned",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(item)
                db.flush()
                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="把这条计划标记完成",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-plan-retry",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "meal_plan",
                        "payload": {
                            "draftType": "meal_plan",
                            "schemaVersion": "meal_plan_operation.v1",
                            "operations": [
                                {
                                    "action": "set_status",
                                    "targetId": item.id,
                                    "baseUpdatedAt": "2026-01-01T00:00:00Z",
                                    "payload": {"status": "cooked", "reason": "已经做完"},
                                }
                            ],
                        },
                    },
                )

                decision_data = service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values=approval.initial_values,
                )

                self.assertEqual(decision_data["approval"]["status"], "pending")
                self.assertEqual(decision_data["approval"]["approval_type"], "meal_plan.apply.retry")
                failure_summary = decision_data["approval"]["failure_summary"]
                assert isinstance(failure_summary, dict)
                self.assertEqual(len(failure_summary["failedOperationIds"]), 1)
                self.assertEqual(
                    failure_summary["failedOperationIds"][0],
                    decision_data["draft"]["payload"]["operations"][0]["operationId"],
                )
                self.assertIn("状态变更", failure_summary["failedOperationSummaries"][0]["summary"])
                self.assertEqual(
                    failure_summary["failedOperationSummaries"][0]["currentValue"]["label"],
                    "番茄小炒",
                )
                self.assertIn(
                    "planned",
                    failure_summary["failedOperationSummaries"][0]["currentValue"]["summary"],
                )
                self.assertIn(
                    "建议先核对下面的最新内容",
                    failure_summary["failedOperationSummaries"][0]["recoveryHint"],
                )

        def test_workspace_runner_records_approval_outcome_metrics(self) -> None:
            with self.SessionLocal() as db:
                service = AIApplicationService(db, provider=FakeChatProvider())
                run = AIAgentRun(
                    id="agent-run-approval-metrics",
                    family_id=self.family.id,
                    conversation_id=None,
                    message_id=None,
                    agent_key="meal_plan_agent",
                    feature_key="ai_workspace_chat",
                    intent="meal_plan",
                    input_summary="调整计划",
                    context_summary={},
                    output_summary="",
                    status="waiting_approval",
                    model="fake-model",
                    input={},
                    output={},
                    tool_calls=[],
                    duration_ms=0,
                    created_by=self.user.id,
                )
                db.add(run)
                db.flush()

                runner = WorkspaceGraphRunner(service)
                runner._record_approval_outcome(run, approval_status="approved", draft_type="meal_plan")
                runner._record_approval_outcome(run, approval_status="rejected", draft_type="meal_plan")
                db.flush()

                metrics = run.context_summary["runMetrics"]
                approval_stats = run.context_summary["approvalStats"]
                self.assertEqual(metrics["approvalApprovedCount"], 1)
                self.assertEqual(metrics["approvalRejectedCount"], 1)
                self.assertEqual(approval_stats["byDraftType"]["meal_plan"]["approved"], 1)
                self.assertEqual(approval_stats["byDraftType"]["meal_plan"]["rejected"], 1)
                self.assertEqual(approval_stats["lastDecision"]["status"], "rejected")
                self.assertEqual(approval_stats["lastDecision"]["draftType"], "meal_plan")

        def test_meal_plan_mixed_operations_use_dynamic_batch_copy(self) -> None:
            with self.SessionLocal() as db:
                food = db.scalar(select(Food).where(Food.id == "food-tomato"))
                assert food is not None
                item = FoodPlanItem(
                    id="plan-mixed-target",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    food_id=food.id,
                    plan_date=date.today(),
                    meal_type=MealType.DINNER,
                    note="旧计划",
                    status="planned",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(item)
                db.flush()
                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="批量调整计划",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-plan-mixed",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                _draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "meal_plan",
                        "payload": {
                            "draftType": "meal_plan",
                            "schemaVersion": "meal_plan_operation.v1",
                            "operations": [
                                {
                                    "action": "create",
                                    "payload": {
                                        "date": date.today().isoformat(),
                                        "mealType": "dinner",
                                        "foodId": food.id,
                                        "title": "番茄炒蛋",
                                    },
                                },
                                {
                                    "action": "delete",
                                    "targetId": item.id,
                                    "baseUpdatedAt": item.updated_at.isoformat(),
                                },
                            ],
                        },
                    },
                )
                self.assertEqual(approval.request_payload["title"], "确认应用 2 项计划调整")
                self.assertEqual(approval.request_payload["approveLabel"], "应用计划变更")

        def test_meal_log_update_details_operation_updates_existing_log(self) -> None:
            with self.SessionLocal() as db:
                food = db.scalar(select(Food).where(Food.id == "food-tomato"))
                assert food is not None
                meal_log = MealLog(
                    id="meal-log-update-target",
                    family_id=self.family.id,
                    date=date.today(),
                    meal_type=MealType.DINNER,
                    participant_user_ids=[self.user.id],
                    notes="原始备注",
                    mood="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(meal_log)
                db.flush()
                db.add(
                    MealLogFood(
                        id="meal-log-update-entry",
                        meal_log_id=meal_log.id,
                        food_id=food.id,
                        servings=Decimal("1"),
                        note="原始",
                    )
                )
                db.flush()
                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="补充昨晚那顿记录",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-meal-log-update",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "meal_log",
                        "payload": {
                            "draftType": "meal_log",
                            "schemaVersion": "meal_log_operation.v1",
                            "action": "update_details",
                            "targetId": meal_log.id,
                            "baseUpdatedAt": meal_log.updated_at.isoformat(),
                            "payload": {
                                "participantUserIds": [self.user.id, "user-friend"],
                                "notes": "补充后的备注",
                                "mood": "满足",
                                "mediaIds": [],
                            },
                        },
                    },
                )
                self.assertEqual(approval.approval_type, "meal_log.update")
                service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values=approval.initial_values,
                )
                db.refresh(meal_log)
                self.assertEqual(meal_log.notes, "补充后的备注")
                self.assertEqual(meal_log.mood, "满足")
                self.assertEqual(meal_log.participant_user_ids, [self.user.id, "user-friend"])

        def test_meal_log_rate_food_operation_updates_entry_rating(self) -> None:
            with self.SessionLocal() as db:
                food = db.scalar(select(Food).where(Food.id == "food-tomato"))
                assert food is not None
                meal_log = MealLog(
                    id="meal-log-rate-target",
                    family_id=self.family.id,
                    date=date.today(),
                    meal_type=MealType.DINNER,
                    participant_user_ids=[self.user.id],
                    notes="",
                    mood="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(meal_log)
                db.flush()
                entry = MealLogFood(
                    id="meal-log-rate-entry",
                    meal_log_id=meal_log.id,
                    food_id=food.id,
                    servings=Decimal("1"),
                    note="",
                    rating=None,
                )
                db.add(entry)
                db.flush()
                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="给这顿饭打分",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-meal-log-rate",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "meal_log",
                        "payload": {
                            "draftType": "meal_log",
                            "schemaVersion": "meal_log_operation.v1",
                            "action": "rate_food",
                            "targetId": meal_log.id,
                            "baseUpdatedAt": meal_log.updated_at.isoformat(),
                            "payload": {
                                "foodEntryRatings": [{"id": entry.id, "rating": 4.5}],
                            },
                        },
                    },
                )
                self.assertEqual(approval.approval_type, "meal_log.rate_food")
                service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values=approval.initial_values,
                )
                db.refresh(entry)
                self.assertEqual(entry.rating, Decimal("4.5"))

        def test_food_profile_update_operation_updates_existing_food(self) -> None:
            with self.SessionLocal() as db:
                food = Food(
                    id="food-yogurt",
                    family_id=self.family.id,
                    name="蓝莓酸奶",
                    type=FoodType.READY_MADE,
                    category="饮品",
                    flavor_tags=["酸"],
                    scene_tags=["早餐"],
                    suitable_meal_types=["breakfast"],
                    source_name="原品牌",
                    purchase_source="超市",
                    scene="早餐",
                    notes="旧备注",
                    routine_note="",
                    favorite=False,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(food)
                db.flush()

                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="更新蓝莓酸奶资料",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-food-update",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "food_profile",
                        "payload": {
                            "draftType": "food_profile",
                            "schemaVersion": "food_profile_operation.v1",
                            "action": "update",
                            "targetId": food.id,
                            "baseUpdatedAt": food.updated_at.isoformat(),
                            "payload": {
                                "name": "蓝莓酸奶升级版",
                                "type": "readyMade",
                                "category": "乳品",
                                "flavor_tags": ["酸甜"],
                                "scene_tags": ["早餐"],
                                "suitable_meal_types": ["breakfast"],
                                "source_name": "新品牌",
                                "purchase_source": "会员店",
                                "scene": "早餐",
                                "notes": "新备注",
                                "routine_note": "冷藏后更好喝",
                                "price": 16,
                                "rating": 5,
                                "repurchase": True,
                                "expiry_date": None,
                                "stock_quantity": 2,
                                "stock_unit": "瓶",
                                "favorite": True,
                                "recipe_id": None,
                                "media_ids": [],
                            },
                        },
                    },
                )
                self.assertEqual(approval.approval_type, "food.update")
                result = service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values=approval.initial_values,
                )
                self.assertEqual(result["operation"]["business_entity_type"], "Food")
                db.refresh(food)
                self.assertEqual(food.name, "蓝莓酸奶升级版")
                self.assertEqual(food.category, "乳品")
                self.assertTrue(food.favorite)
                self.assertEqual(food.source_name, "新品牌")

        def test_food_profile_set_favorite_operation_updates_existing_food(self) -> None:
            with self.SessionLocal() as db:
                food = Food(
                    id="food-favorite-toggle",
                    family_id=self.family.id,
                    name="盒装牛奶",
                    type=FoodType.READY_MADE,
                    category="乳品",
                    flavor_tags=[],
                    scene_tags=["早餐"],
                    suitable_meal_types=["breakfast"],
                    source_name="常买品牌",
                    purchase_source="超市",
                    scene="早餐",
                    notes="",
                    routine_note="",
                    favorite=False,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(food)
                db.flush()

                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="收藏盒装牛奶",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-food-favorite",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "food_profile",
                        "payload": {
                            "draftType": "food_profile",
                            "schemaVersion": "food_profile_operation.v1",
                            "action": "set_favorite",
                            "targetId": food.id,
                            "baseUpdatedAt": food.updated_at.isoformat(),
                            "payload": {"favorite": True},
                        },
                    },
                )
                self.assertEqual(approval.approval_type, "food.favorite")
                service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values=approval.initial_values,
                )
                db.refresh(food)
                self.assertTrue(food.favorite)

        def test_ingredient_profile_update_operation_updates_existing_ingredient(self) -> None:
            with self.SessionLocal() as db:
                ingredient = Ingredient(
                    id="ingredient-yogurt-starter",
                    family_id=self.family.id,
                    name="原味酸奶",
                    category="乳品",
                    default_unit="盒",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.DAYS,
                    default_expiry_days=7,
                    default_low_stock_threshold=1,
                    notes="旧备注",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(ingredient)
                db.flush()

                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="更新原味酸奶食材档案",
                    quick_task=None,
                )
                message = AIMessage(
                    id="ai-message-ingredient-update",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add(message)
                db.flush()
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "ingredient_profile",
                        "payload": {
                            "draftType": "ingredient_profile",
                            "schemaVersion": "ingredient_profile_operation.v1",
                            "action": "update",
                            "targetId": ingredient.id,
                            "baseUpdatedAt": ingredient.updated_at.isoformat(),
                            "payload": {
                                "name": "希腊酸奶",
                                "category": "乳品",
                                "default_unit": "盒",
                                "unit_conversions": [{"unit": "杯", "ratio_to_default": 1}],
                                "default_storage": "冷藏",
                                "default_expiry_mode": "days",
                                "default_expiry_days": 10,
                                "default_low_stock_threshold": 2,
                                "notes": "新版备注",
                                "media_ids": [],
                            },
                        },
                    },
                )
                self.assertEqual(approval.approval_type, "ingredient.update")
                result = service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values=approval.initial_values,
                )
                self.assertEqual(result["operation"]["business_entity_type"], "Ingredient")
                db.refresh(ingredient)
                self.assertEqual(ingredient.name, "希腊酸奶")
                self.assertEqual(ingredient.default_expiry_days, 10)
                self.assertEqual(ingredient.default_low_stock_threshold, 2)
                self.assertEqual(ingredient.unit_conversions[0]["unit"], "杯")

        def test_workspace_runner_builds_business_entity_artifacts_for_approved_decision(self) -> None:
            with self.SessionLocal() as db:
                service = AIApplicationService(db, provider=FakeChatProvider())
                artifacts = service._approval_decision_artifacts(
                    {
                        "approval": {"id": "approval-1", "status": "approved"},
                        "draft": {"id": "draft-1", "draft_type": "meal_plan"},
                        "operation": {
                            "id": "operation-1",
                            "status": "succeeded",
                            "business_entity_type": "FoodPlanItem",
                        },
                        "business_entity": {
                            "operations": [
                                {
                                    "operationId": "op-item-1",
                                    "action": "create",
                                    "item": {
                                        "id": "plan-1",
                                        "title": "番茄炒蛋",
                                        "updated_at": "2026-06-15T09:00:00Z",
                                        "date": "2026-06-15",
                                        "meal_type": "dinner",
                                    },
                                }
                            ]
                        },
                    }
                )

            self.assertEqual(artifacts[0]["type"], "approval_decision")
            business_artifact = artifacts[1]
            self.assertEqual(business_artifact["type"], "meal_plan")
            self.assertEqual(business_artifact["kind"], "business_entity")
            self.assertEqual(business_artifact["entityId"], "plan-1")
            self.assertEqual(business_artifact["updatedAt"], "2026-06-15T09:00:00Z")
            self.assertEqual(business_artifact["sourceDraftId"], "draft-1")
            self.assertEqual(business_artifact["sourceOperationId"], "operation-1")
            self.assertEqual(business_artifact["summary"], "番茄炒蛋")

        def test_workspace_runner_keeps_recipe_result_as_single_entity(self) -> None:
            with self.SessionLocal() as db:
                service = AIApplicationService(db, provider=FakeChatProvider())
                decision_result = {
                    "approval": {
                        "id": "approval-recipe",
                        "status": "approved",
                        "approval_type": "recipe.create",
                    },
                    "draft": {
                        "id": "draft-recipe",
                        "draft_type": "recipe",
                        "payload": {"title": "炒蛋和番茄"},
                    },
                    "operation": {
                        "id": "operation-recipe",
                        "status": "succeeded",
                        "business_entity_type": "Recipe",
                    },
                    "business_entity": {
                        "id": "recipe-1",
                        "title": "炒蛋和番茄",
                        "steps": [
                            {"summary": "处理食材"},
                            {"summary": "炒蛋和番茄"},
                            {"summary": "煮汤和下面"},
                            {"summary": "回锅调味出锅"},
                        ],
                    },
                }
                artifacts = service._approval_decision_artifacts(decision_result)
                card = approval_result_card(decision_result)

            business_artifacts = [artifact for artifact in artifacts if artifact.get("kind") == "business_entity"]
            self.assertEqual(len(business_artifacts), 1)
            self.assertEqual(business_artifacts[0]["entityId"], "recipe-1")
            self.assertEqual(business_artifacts[0]["summary"], "炒蛋和番茄")
            self.assertIsNotNone(card)
            assert card is not None
            self.assertEqual(card["title"], "已创建菜谱")
            self.assertEqual(card["data"]["entityCountLabel"], "1 个菜谱")
            self.assertEqual(card["data"]["entities"][0]["label"], "炒蛋和番茄")

        def test_workspace_runner_uses_inventory_ingredient_name_for_result_label(self) -> None:
            with self.SessionLocal() as db:
                service = AIApplicationService(db, provider=FakeChatProvider())
                decision_result = {
                    "approval": {
                        "id": "approval-inventory",
                        "status": "approved",
                        "approval_type": "inventory.operation",
                    },
                    "draft": {
                        "id": "draft-inventory",
                        "draft_type": "inventory_operation",
                        "payload": {
                            "draftType": "inventory_operation",
                            "operations": [{"action": "restock"}],
                        },
                    },
                    "operation": {
                        "id": "operation-inventory",
                        "status": "succeeded",
                        "business_entity_type": "InventoryItem",
                    },
                    "business_entity": {
                        "operations": [
                            {
                                "operationId": "op-restock-1",
                                "operation": "restock",
                                "inventory_item": {
                                    "id": "inventory-egg",
                                    "ingredient_name": "鸡蛋",
                                },
                            }
                        ]
                    },
                }
                artifacts = service._approval_decision_artifacts(decision_result)
                card = approval_result_card(decision_result)

            business_artifacts = [artifact for artifact in artifacts if artifact.get("kind") == "business_entity"]
            self.assertEqual(len(business_artifacts), 1)
            self.assertEqual(business_artifacts[0]["summary"], "鸡蛋")
            self.assertIsNotNone(card)
            assert card is not None
            self.assertEqual(card["data"]["entityCountLabel"], "1 项库存变更")
            self.assertEqual(card["data"]["entities"][0]["label"], "鸡蛋")
            self.assertEqual(card["data"]["entities"][0]["operationLabel"], "补货")

        def test_workspace_service_loads_current_value_for_failed_meal_plan_operation(self) -> None:
            with self.SessionLocal() as db:
                food = Food(
                    id="food-current-value",
                    family_id=self.family.id,
                    name="番茄炒蛋",
                    type=FoodType.SELF_MADE,
                    category="家常菜",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                item = FoodPlanItem(
                    id="plan-current-value",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    food_id=food.id,
                    food=food,
                    plan_date=date(2026, 6, 15),
                    meal_type=MealType.DINNER,
                    status="planned",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add_all([food, item])
                db.flush()

                service = AIApplicationService(db, provider=FakeChatProvider())
                current = service._operation_current_value(
                    family_id=self.family.id,
                    draft_type="meal_plan",
                    target_id=item.id,
                )

            assert current is not None
            self.assertEqual(current["id"], item.id)
            self.assertEqual(current["label"], "番茄炒蛋")
            self.assertIn("2026-06-15", current["summary"])
            self.assertEqual(current["payload"]["status"], "planned")

        def test_workspace_service_appends_operation_result_card_for_successful_approval(self) -> None:
            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id="conversation-operation-result",
                    family_id=self.family.id,
                    mode=AiMode.RECIPE_DRAFT,
                    prompt="调整计划",
                    response="",
                    created_by=self.user.id,
                )
                message = AIMessage(
                    id="message-operation-result",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="请确认计划调整。",
                    parts=[
                        {"id": "part-text-before", "type": "text", "text": "请确认计划调整。"},
                        {"id": "part-draft", "type": "draft", "draft": {"id": "draft-1"}},
                        {
                            "id": "part-approval",
                            "type": "approval_request",
                            "approval": {"id": "approval-1", "status": "pending"},
                        },
                        {"id": "part-text-after", "type": "text", "text": "我继续处理下一步。"},
                    ],
                    created_by=self.user.id,
                )
                db.add(conversation)
                db.add(message)
                db.flush()

                service = AIApplicationService(db, provider=FakeChatProvider())
                service._append_message_result_card(
                    {
                        "approval": {
                            "id": "approval-1",
                            "status": "approved",
                            "approval_type": "meal_plan.apply",
                            "message_id": message.id,
                        },
                        "draft": {
                            "id": "draft-1",
                            "draft_type": "meal_plan",
                            "payload": {
                                "draftType": "meal_plan",
                                "schemaVersion": "meal_plan_operation.v1",
                                "operations": [
                                    {
                                        "operationId": "op-item-1",
                                        "action": "set_status",
                                        "targetId": "plan-1",
                                        "payload": {"status": "cooked"},
                                    }
                                ],
                            },
                        },
                        "operation": {
                            "id": "operation-1",
                            "status": "succeeded",
                            "business_entity_type": "FoodPlanItem",
                        },
                        "business_entity": {
                            "operations": [
                                {
                                    "operationId": "op-item-1",
                                    "action": "set_status",
                                    "item": {
                                        "id": "plan-1",
                                        "title": "番茄炒蛋",
                                        "updated_at": "2026-06-15T09:00:00Z",
                                    },
                                }
                            ]
                        },
                    }
                )
                db.flush()
                db.refresh(message)

                result_cards = [
                    part["card"]
                    for part in message.parts
                    if isinstance(part, dict) and part.get("type") == "result_card" and isinstance(part.get("card"), dict)
                ]
                self.assertEqual(len(result_cards), 1)
                self.assertEqual(result_cards[0]["type"], "operation_result")
                self.assertEqual(result_cards[0]["title"], "已修改餐食计划")
                self.assertEqual(result_cards[0]["data"]["entityCountLabel"], "1 条计划")
                self.assertEqual(result_cards[0]["data"]["workspaceHint"], "可前往菜单计划查看")
                self.assertEqual(result_cards[0]["data"]["entities"][0]["label"], "番茄炒蛋")
                self.assertEqual(result_cards[0]["data"]["entities"][0]["operationLabel"], "状态变更")
                part_types = [part["type"] for part in message.parts]
                self.assertEqual(
                    part_types,
                    ["text", "draft", "approval_request", "result_card", "text"],
                )
                self.assertEqual(message.parts[3]["card"]["id"], result_cards[0]["id"])

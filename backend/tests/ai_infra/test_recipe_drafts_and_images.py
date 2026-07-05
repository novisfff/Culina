from ._support import *
from ._support import _build_provider_config


class RecipeDraftSearchThenCreateProvider(BaseChatProvider):
        model_name = "recipe-draft-search-then-create-test-model"

        def __init__(self) -> None:
            self.available_tool_names: set[str] = set()
            self.search_output: dict | None = None

        def generate_with_tools(
            self,
            *,
            system: str,
            user: str,
            tools,
            tool_handler,
            message_handler=None,
            max_rounds: int = 8,
        ) -> ChatProviderResult:
            del system, user, message_handler, max_rounds
            self.available_tool_names = {tool.name for tool in tools()}
            self.search_output = tool_handler("ingredient.search", {"query": "番茄", "limit": 5})
            draft = {
                "title": "番茄快手菜",
                "servings": 2,
                "prep_minutes": 15,
                "difficulty": "easy",
                "ingredient_items": [
                    {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"}
                ],
                "steps": [
                    {"title": "备菜", "text": "番茄洗净切块，保持大小均匀。切好后放在手边，方便后续连续操作。", "icon": "tomato", "summary": "处理番茄", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块"]},
                    {"title": "炒制", "text": "锅中少油，中火下番茄翻炒 3 分钟。看到番茄出汁变软后继续小火收 2 分钟。", "icon": "pan", "summary": "炒出汁水", "estimated_minutes": 7, "tip": "保持中火。", "key_points": ["炒出汁"]},
                    {"title": "装盘", "text": "确认番茄软烂、汤汁略浓后调味。关火装盘，趁热食用口感更好。", "icon": "plate", "summary": "调味装盘", "estimated_minutes": 3, "tip": "出锅前尝味。", "key_points": ["尝味"]}
                ],
                "tips": "缺失食材不要强行写入配料行。",
                "scene_tags": ["家常菜"],
            }
            output = tool_handler("recipe.create_draft", {"draft": draft})
            return ChatProviderResult(
                text=None,
                status="completed",
                model=self.model_name,
                tool_calls=[
                    {"name": "ingredient.search", "args": {"query": "番茄", "limit": 5}, "output": self.search_output},
                    {"name": "recipe.create_draft", "args": {"draft": draft}, "output": output},
                ],
            )


class AIRecipeDraftsAndImagesTestCase(AIAgentInfraTestCase):
        def test_recipe_draft_api_returns_failed_without_fallback_draft_when_provider_disabled(self) -> None:
            response = self.client.post(
                "/api/ai/recipes/draft",
                json={
                    "title": "番茄快手菜",
                    "prompt": "清淡一点",
                    "ingredient_ids": ["ingredient-tomato"],
                    "extra_ingredients": ["葱花"],
                    "generate_image": True,
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["status"], "failed")
            self.assertIsNone(data["draft"])
            self.assertIsNone(data["image_render_payload"])
            with self.SessionLocal() as db:
                run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == data["agent_run_id"]))
                self.assertIsNotNone(run)
                assert run is not None
                self.assertEqual(run.feature_key, "aiRecipeDraft")
                self.assertEqual(run.status, "failed")
                self.assertEqual(run.input["context"]["inventoryItemCount"], 0)
                self.assertEqual(run.input["context"]["mealLogCount"], 0)

        def test_recipe_draft_api_requires_minimum_input(self) -> None:
            response = self.client.post("/api/ai/recipes/draft", json={})
            self.assertEqual(response.status_code, 400, response.text)
            self.assertIn("菜名", response.json()["detail"])

        def test_recipe_draft_runner_preserves_family_scoped_ingredients_from_valid_json(self) -> None:
            provider = FakeChatProvider(
                """
                {
                  "title": "番茄炖蛋",
                  "servings": 2,
                  "prep_minutes": 18,
                  "difficulty": "easy",
                  "ingredient_items": [
                    {"ingredient_id": "ingredient-tomato", "ingredient_name": "错名", "quantity": 2, "unit": "斤", "note": "切块"}
                  ],
                  "steps": [
                    {"title": "备菜", "text": "番茄洗净切成 2 厘米块，鸡蛋或蛋液提前备好。保持食材大小接近，后面中火炖煮 8 分钟时更容易均匀熟透。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块一致"]},
                    {"title": "炖煮", "text": "锅中少油，中火炒番茄 3 分钟到出汁变软。加入少量水后继续炖煮 5 分钟，看到汤汁冒泡并略微浓稠。", "icon": "pan", "summary": "炒出汤汁", "estimated_minutes": 8, "tip": "保持中火。", "key_points": ["中火"]},
                    {"title": "收尾", "text": "倒入蛋液后保持小火 2 分钟，让蛋液完全凝固。确认没有透明蛋液、汤汁略收后再调味出锅。", "icon": "plate", "summary": "熟透出锅", "estimated_minutes": 5, "tip": "出锅前尝味。", "key_points": ["确认熟透"]}
                  ],
                  "tips": "少油少盐。",
                  "scene_tags": ["晚餐", "清淡"]
                }
                """
            )
            with self.SessionLocal() as db:
                result = self._generate_recipe_draft(
                    db,
                    provider,
                    prompt="清淡",
                    subject={"ingredientIds": ["ingredient-tomato"]},
                )
            draft = result["draft"]
            self.assertEqual(result["status"], "completed")
            self.assertEqual(draft["ingredient_items"][0]["ingredient_id"], "ingredient-tomato")
            self.assertEqual(draft["ingredient_items"][0]["ingredient_name"], "番茄")
            self.assertNotIn("ingredient-secret", [item["ingredient_id"] for item in draft["ingredient_items"]])
            self.assertIsInstance(draft["steps"][0], dict)

        def test_recipe_draft_runner_allows_ingredient_search_before_create_draft(self) -> None:
            provider = RecipeDraftSearchThenCreateProvider()
            with self.SessionLocal() as db:
                result = self._generate_recipe_draft(
                    db,
                    provider,
                    prompt="用西红柿做一道快手菜",
                    subject={"ingredientIds": ["ingredient-tomato"], "extraIngredients": ["西红柿"]},
                )

            self.assertEqual(result["status"], "completed")
            self.assertIn("ingredient.search", provider.available_tool_names)
            self.assertIn("recipe.create_draft", provider.available_tool_names)
            self.assertIsNotNone(provider.search_output)
            self.assertNotIn("error", provider.search_output or {})
            self.assertEqual(result["draft"]["ingredient_items"][0]["ingredient_id"], "ingredient-tomato")

        def test_recipe_draft_runner_parses_fenced_json_response(self) -> None:
            with self.SessionLocal() as db:
                self._add_egg_ingredient(db)
                db.commit()
            provider = FakeChatProvider(
                """
                ```json
                {
                  "title": "番茄炒蛋",
                  "servings": 2,
                  "prep_minutes": 15,
                  "difficulty": "easy",
                  "ingredient_items": [
                    {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "洗净切块"},
                    {"ingredient_id": "ingredient-egg", "ingredient_name": "鸡蛋", "quantity": 3, "unit": "个", "note": "打散备用"}
                  ],
                  "steps": [
                    {"title": "备菜", "text": "番茄洗净切块，鸡蛋打散备用。保持食材大小接近，方便后面均匀受热。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块一致"]},
                    {"title": "炒蛋", "text": "热锅少油，中火倒入蛋液炒到刚凝固。看到表面还有少量嫩液时盛出备用。", "icon": "pan", "summary": "先炒鸡蛋", "estimated_minutes": 4, "tip": "不要久炒。", "key_points": ["中火", "刚凝固"]},
                    {"title": "炒番茄", "text": "锅中补少量油，中火下番茄炒 3 分钟。看到番茄出汁变软后再调味。", "icon": "pan", "summary": "炒出汤汁", "estimated_minutes": 5, "tip": "番茄要炒出汁。", "key_points": ["炒出汁"]},
                    {"title": "收尾", "text": "鸡蛋回锅后加盐翻匀 1 分钟。确认鸡蛋熟透、汤汁略收后装盘。", "icon": "plate", "summary": "调味装盘", "estimated_minutes": 2, "tip": "出锅前尝味。", "key_points": ["熟透", "尝味"]}
                  ],
                  "tips": "中火快炒，保留鸡蛋嫩度。",
                  "scene_tags": ["家常菜", "快手菜"]
                }
                ```
                """
            )
            with self.SessionLocal() as db:
                result = self._generate_recipe_draft(
                    db,
                    provider,
                    prompt="番茄炒蛋",
                    subject={"ingredientIds": ["ingredient-tomato"]},
                )

            draft = result["draft"]
            self.assertEqual(result["status"], "completed")
            self.assertEqual(draft["title"], "番茄炒蛋")
            self.assertEqual(draft["ingredient_items"][0]["ingredient_id"], "ingredient-tomato")

        def test_recipe_draft_runner_rejects_merged_scene_tags_without_local_fallback(self) -> None:
            provider = FakeChatProvider(
                """
                {
                  "title": "番茄快手菜",
                  "servings": 2,
                  "prep_minutes": 15,
                  "difficulty": "easy",
                  "ingredient_items": [
                    {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "洗净切块"}
                  ],
                  "steps": [
                    {"title": "备菜", "text": "番茄洗净切成 2 厘米块，蒜末提前备好。食材大小保持接近，后面中火快炒时更容易均匀熟透。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块一致"]},
                    {"title": "翻炒", "text": "热锅少油，中火下番茄翻炒 3 到 4 分钟。看到番茄边缘变软并出汁后再调味。", "icon": "pan", "summary": "炒出汤汁", "estimated_minutes": 6, "tip": "保持中火。", "key_points": ["中火", "出汁"]},
                    {"title": "收尾", "text": "加盐后继续翻炒 1 分钟，让味道进入汤汁。确认番茄软而不碎、汤汁略收后装盘。", "icon": "plate", "summary": "调味装盘", "estimated_minutes": 3, "tip": "出锅前尝味。", "key_points": ["尝味", "装盘"]}
                  ],
                  "tips": "适合临时加一道清爽小菜。",
                  "scene_tags": ["家常菜、快手菜", "晚餐/午餐", "快手菜"]
                }
                """
            )
            with self.SessionLocal() as db:
                result = self._generate_recipe_draft(
                    db,
                    provider,
                    prompt="快手",
                    subject={"ingredientIds": ["ingredient-tomato"]},
                )

            self.assertEqual(result["status"], "failed")
            self.assertIsNone(result["draft"])
            self.assertIn("scene_tags", result["error"])

        def test_recipe_draft_runner_parses_json_surrounded_by_text(self) -> None:
            with self.SessionLocal() as db:
                db.add(
                    Ingredient(
                        id="ingredient-garlic",
                        family_id=self.family.id,
                        name="蒜",
                        category="调料",
                        default_unit="瓣",
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
                下面是生成结果：
                {
                  "title": "清炒番茄",
                  "servings": 2,
                  "prep_minutes": 12,
                  "difficulty": "easy",
                  "ingredient_items": [
                    {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"},
                    {"ingredient_id": "ingredient-garlic", "ingredient_name": "蒜", "quantity": 2, "unit": "瓣", "note": "拍碎"}
                  ],
                  "steps": [
                    {"title": "备菜", "text": "番茄洗净切块，蒜瓣拍碎备用。切块尽量均匀，方便中火快炒。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块一致"]},
                    {"title": "爆香", "text": "锅热后加少量油，小火下蒜炒 30 秒。闻到蒜香但没有焦色时加入番茄。", "icon": "pan", "summary": "炒香蒜", "estimated_minutes": 2, "tip": "蒜不要炒焦。", "key_points": ["小火"]},
                    {"title": "翻炒", "text": "转中火翻炒番茄 3 到 4 分钟。看到番茄边缘变软并出汁后再调味。", "icon": "pan", "summary": "炒软出汁", "estimated_minutes": 4, "tip": "中火更稳。", "key_points": ["出汁"]},
                    {"title": "收尾", "text": "加盐后翻匀 1 分钟，让味道进入汤汁。确认番茄软而不碎后装盘。", "icon": "plate", "summary": "调味装盘", "estimated_minutes": 1, "tip": "最后调味更容易控制咸淡。", "key_points": ["尝味", "装盘"]}
                  ],
                  "tips": "适合搭配米饭或面条。",
                  "scene_tags": ["家常菜"]
                }
                以上 JSON 可直接使用。
                """
            )
            with self.SessionLocal() as db:
                result = self._generate_recipe_draft(
                    db,
                    provider,
                    prompt="清淡",
                    subject={"ingredientIds": ["ingredient-tomato"]},
                )

            draft = result["draft"]
            self.assertEqual(result["status"], "completed")
            self.assertEqual(draft["title"], "清炒番茄")
            self.assertGreaterEqual(len(draft["steps"]), 3)

        def test_recipe_draft_runner_fails_without_fallback_on_invalid_json(self) -> None:
            with self.SessionLocal() as db:
                result = self._generate_recipe_draft(
                    db,
                    FakeChatProvider("不是 JSON"),
                    prompt="清淡",
                    subject={"ingredientIds": ["ingredient-tomato"]},
                )
            self.assertEqual(result["status"], "failed")
            self.assertIsNone(result["draft"])
            self.assertEqual(result["error"], "model did not call recipe.create_draft")
            self.assertIsNone(result["image_render_payload"])

        def test_recipe_draft_runner_rejects_low_quality_steps_without_local_fallback(self) -> None:
            with self.SessionLocal() as db:
                self._add_egg_ingredient(db)
                db.commit()
            provider = FakeChatProvider(
                """
                {
                  "title": "番茄炒蛋",
                  "servings": 2,
                  "prep_minutes": 16,
                  "difficulty": "easy",
                  "ingredient_items": [
                    {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 1, "unit": "个", "note": ""},
                    {"ingredient_id": "ingredient-egg", "ingredient_name": "鸡蛋", "quantity": 1, "unit": "个", "note": ""}
                  ],
                  "steps": [
                    {"title": "备菜", "text": "处理食材", "icon": "pan", "summary": "", "estimated_minutes": 2, "tip": "", "key_points": []},
                    {"title": "炒熟", "text": "翻炒均匀", "icon": "pan", "summary": "", "estimated_minutes": 3, "tip": "", "key_points": []}
                  ],
                  "tips": "",
                  "scene_tags": ["晚餐"]
                }
                """
            )
            with self.SessionLocal() as db:
                result = self._generate_recipe_draft(
                    db,
                    provider,
                    prompt="更细一点",
                    subject={"ingredientIds": ["ingredient-tomato"]},
                )

            self.assertEqual(result["status"], "failed")
            self.assertIsNone(result["draft"])
            self.assertIn("steps", result["error"])

        def test_recipe_draft_runner_keeps_selected_ingredient_ids_and_default_units(self) -> None:
            provider = FakeChatProvider(
                """
                {
                  "title": "番茄鸡蛋汤",
                  "servings": 3,
                  "prep_minutes": 12,
                  "difficulty": "easy",
                  "ingredient_items": [
                    {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 1, "unit": "斤", "note": "切块"}
                  ],
                  "steps": [
                    {"title": "处理", "text": "番茄切成小块，鸡蛋打散后加 1 勺清水。食材提前备好，后面中火煮 5 分钟时能更快熟透。", "icon": "tomato", "summary": "处理", "estimated_minutes": 4, "tip": "", "key_points": ["切块"]},
                    {"title": "煮汤", "text": "锅中加水煮到沸腾后下番茄，中火煮 5 分钟。看到番茄变软出汁、汤色微红后再倒蛋液。", "icon": "pan", "summary": "煮汤", "estimated_minutes": 5, "tip": "", "key_points": ["煮开"]},
                    {"title": "收尾", "text": "沿锅边倒入蛋液，小火保持 2 分钟让蛋花凝固。确认蛋液熟透、汤面重新冒泡后加盐调味出锅。", "icon": "plate", "summary": "收尾", "estimated_minutes": 3, "tip": "", "key_points": ["出锅"]}
                  ],
                  "tips": "清淡。",
                  "scene_tags": ["午餐"]
                }
                """
            )
            with self.SessionLocal() as db:
                result = self._generate_recipe_draft(
                    db,
                    provider,
                    prompt="清淡一点",
                    subject={"ingredientIds": ["ingredient-tomato"]},
                )

            draft = result["draft"]
            self.assertEqual(draft["ingredient_items"][0]["ingredient_id"], "ingredient-tomato")
            self.assertEqual(draft["ingredient_items"][0]["unit"], "个")
            self.assertNotIn("ingredient-secret", [item["ingredient_id"] for item in draft["ingredient_items"]])

        def test_recipe_draft_runner_allows_presence_only_ingredients_without_quantity(self) -> None:
            with self.SessionLocal() as db:
                db.add(
                    Ingredient(
                        id="ingredient-salt",
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
                )
                db.commit()
            provider = FakeChatProvider(
                """
                {
                  "title": "清炒番茄",
                  "servings": 2,
                  "prep_minutes": 12,
                  "difficulty": "easy",
                  "ingredient_items": [
                    {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"},
                    {"ingredient_id": "ingredient-salt", "ingredient_name": "盐", "note": "步骤中按口味少量调整"}
                  ],
                  "steps": [
                    {"title": "备菜", "text": "番茄洗净切成小块，放在盘中备用。切块大小尽量一致，后面中火翻炒时更容易均匀变软。", "icon": "tomato", "summary": "处理番茄", "estimated_minutes": 4, "tip": "切块均匀更容易出汁。", "key_points": ["切块一致"]},
                    {"title": "翻炒", "text": "热锅后倒入少量油，中火下番茄翻炒 3 到 4 分钟。看到番茄明显出汁、边缘变软后转小火准备调味。", "icon": "pan", "summary": "炒出汤汁", "estimated_minutes": 5, "tip": "保持中火，避免糊底。", "key_points": ["中火", "炒出汁"]},
                    {"title": "调味装盘", "text": "小火撒少量盐，先翻匀 30 秒后尝味。确认咸淡合适、汤汁略微浓稠后关火装盘。", "icon": "plate", "summary": "按口味调味", "estimated_minutes": 3, "tip": "盐少量多次加入。", "key_points": ["尝味", "装盘"]}
                  ],
                  "tips": "盐属于只记录有无的调料，用量写在步骤里即可。",
                  "scene_tags": ["家常菜"]
                }
                """
            )
            with self.SessionLocal() as db:
                result = self._generate_recipe_draft(
                    db,
                    provider,
                    prompt="清炒番茄，盐少量调味",
                    subject={"ingredientIds": ["ingredient-tomato", "ingredient-salt"]},
                )

            self.assertEqual(result["status"], "completed")
            salt_item = next(item for item in result["draft"]["ingredient_items"] if item["ingredient_id"] == "ingredient-salt")
            self.assertEqual(salt_item["ingredient_name"], "盐")
            self.assertEqual(salt_item["quantity"], 1)
            self.assertEqual(salt_item["unit"], "g")
            self.assertEqual(salt_item["note"], "步骤中按口味少量调整")

        def test_recipe_image_prompts_do_not_force_banner_composition(self) -> None:
            draft = {
                "title": "番茄炒蛋",
                "tips": "少油少盐。",
                "scene_tags": ["晚餐", "家常"],
                "ingredient_items": [{"ingredient_name": "番茄"}, {"ingredient_name": "鸡蛋"}],
            }
            payload = build_recipe_image_render_payload(draft)
            prompt = build_ai_image_prompt(
                ImageGenerationRequest(
                    entity_type=MediaEntityType.RECIPE,
                    mode=ImageGenerationMode.TEXT,
                    title=payload["title"],
                    category=payload["category"],
                    notes=payload["notes"],
                    tags=payload["tags"],
                    scene=payload["scene"],
                    ingredient_names=payload["ingredient_names"],
                    size=payload["size"],
                )
            )

            forbidden_terms = ["banner", "Banner", "横幅", "横向", "页面顶部", "顶部主图"]
            for term in forbidden_terms:
                with self.subTest(term=term):
                    self.assertNotIn(term, payload["notes"])
                    self.assertNotIn(term, prompt)

        def test_reference_image_prompt_prioritizes_unified_style_over_copying_source(self) -> None:
            prompt = build_ai_image_prompt(
                ImageGenerationRequest(
                    entity_type=MediaEntityType.INGREDIENT,
                    mode=ImageGenerationMode.REFERENCE,
                    title="番茄",
                    category="蔬菜",
                    notes="新鲜红番茄",
                    reference_image_bytes=b"fake",
                    reference_filename="tomato.jpg",
                )
            )

            self.assertIn("参考图只用于识别主体", prompt)
            self.assertIn("重新在 Culina 统一摄影棚里拍了一张标准主图", prompt)
            self.assertIn("与纯文字生成模式一致", prompt)
            self.assertIn("不要复制原图的拍摄角度", prompt)
            self.assertIn("参考图仅作为主体识别补充", prompt)
            self.assertIn("统一为约 4:3 卡片比例", prompt)

        def test_family_and_user_image_prompts_do_not_request_round_avatar_rendering(self) -> None:
            family_prompt = build_ai_image_prompt(
                ImageGenerationRequest(
                    entity_type=MediaEntityType.FAMILY,
                    mode=ImageGenerationMode.TEXT,
                    title="三餐四季",
                    category="上海",
                    notes="喜欢明亮温暖的厨房氛围",
                )
            )
            user_prompt = build_ai_image_prompt(
                ImageGenerationRequest(
                    entity_type=MediaEntityType.USER,
                    mode=ImageGenerationMode.TEXT,
                    title="小雨",
                    category="Owner",
                    notes="清爽、柔和、厨房感",
                )
            )

            self.assertNotIn("适合圆形裁切", family_prompt)
            self.assertNotIn("适合圆形裁切", user_prompt)
            self.assertIn("前端展示时可再做圆形遮罩", user_prompt)

        def test_image_generation_normalizes_all_modes_to_standard_card_size(self) -> None:
            calls: list[dict] = []

            class FakeHttpxClient:
                def __init__(self, *args, **kwargs) -> None:
                    pass

                def __enter__(self):
                    return self

                def __exit__(self, exc_type, exc, traceback) -> None:
                    return None

                def post(self, url: str, **kwargs):
                    calls.append({"url": url, **kwargs})
                    return httpx.Response(
                        200,
                        json={"data": [{"b64_json": base64.b64encode(b"fake-image").decode("ascii")}]},
                    )

            provider = OpenAIImageGenerationProvider(
                ImageProviderConfig(
                    provider="openai",
                    api_base="https://example.test/v1",
                    api_key="test-key",
                    model="gpt-image-2",
                )
            )
            with patch("app.ai.images.generation.httpx.Client", FakeHttpxClient):
                provider.generate_from_text(
                    ImageGenerationRequest(
                        entity_type=MediaEntityType.RECIPE,
                        mode=ImageGenerationMode.TEXT,
                        title="番茄炒蛋",
                        size="1792*1008",
                    )
                )
                provider.generate_from_reference(
                    ImageGenerationRequest(
                        entity_type=MediaEntityType.INGREDIENT,
                        mode=ImageGenerationMode.REFERENCE,
                        title="番茄",
                        size="960*1280",
                        reference_image_bytes=b"fake",
                        reference_filename="tomato.jpg",
                    )
                )

            self.assertEqual(calls[0]["json"]["size"], "1536x1024")
            self.assertEqual(calls[1]["data"]["size"], "1536x1024")

        def test_openai_image_provider_uses_configured_endpoint_and_key(self) -> None:
            calls: list[dict] = []

            class FakeHttpxClient:
                def __init__(self, *args, **kwargs) -> None:
                    pass

                def __enter__(self):
                    return self

                def __exit__(self, exc_type, exc, traceback) -> None:
                    return None

                def post(self, url: str, **kwargs):
                    calls.append({"url": url, **kwargs})
                    return httpx.Response(
                        200,
                        json={"data": [{"b64_json": base64.b64encode(b"fake-image").decode("ascii")}]},
                    )

            provider = OpenAIImageGenerationProvider(
                ImageProviderConfig(
                    provider="openai",
                    api_base="https://example.test/v1",
                    api_key="test-key",
                    model="gpt-image-2",
                )
            )
            with patch("app.ai.images.generation.httpx.Client", FakeHttpxClient):
                result = provider.generate_from_text(
                    ImageGenerationRequest(
                        entity_type=MediaEntityType.FOOD,
                        mode=ImageGenerationMode.TEXT,
                        title="番茄炒蛋",
                        size="1664*1040",
                    )
                )

            self.assertEqual(result.binary_content, b"fake-image")
            self.assertEqual(result.file_extension, ".png")
            self.assertEqual(result.mime_type, "image/png")
            self.assertEqual(calls[0]["url"], "https://example.test/v1/images/generations")
            self.assertEqual(calls[0]["headers"]["Authorization"], "Bearer test-key")
            self.assertEqual(calls[0]["json"]["model"], "gpt-image-2")
            self.assertEqual(calls[0]["json"]["size"], "1536x1024")
            self.assertEqual(calls[0]["json"]["output_format"], "png")

        def test_openai_image_provider_config_defaults_to_openai_base(self) -> None:
            class FakeSettings:
                ai_image_reference_provider = "openai"
                ai_image_reference_api_base = ""
                ai_image_reference_api_key = "reference-key"
                ai_image_reference_model = ""
                ai_image_text_provider = "openai"
                ai_image_text_api_base = ""
                ai_image_text_api_key = "text-key"
                ai_image_text_model = ""

            with patch("app.ai.images.generation.get_settings", return_value=FakeSettings()):
                text_config = _build_provider_config(ImageGenerationMode.TEXT)
                reference_config = _build_provider_config(ImageGenerationMode.REFERENCE)

            self.assertEqual(text_config.api_base, "https://api.openai.com/v1")
            self.assertEqual(text_config.model, "gpt-image-2")
            self.assertEqual(reference_config.api_base, "https://api.openai.com/v1")
            self.assertEqual(reference_config.model, "gpt-image-2")

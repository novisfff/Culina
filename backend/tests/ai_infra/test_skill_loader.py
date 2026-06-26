from ._support import *

BACKEND_DIR = Path(__file__).resolve().parents[2]


class AISkillLoaderTestCase(AIAgentInfraTestCase):
        def test_skill_catalog_scans_skill_markdown_and_enforces_platform_contracts(self) -> None:
            import yaml

            skills_dir = BACKEND_DIR / "app" / "ai" / "skills" / "catalog"
            skill_registry = build_workspace_skill_registry()
            tool_registry = build_workspace_tool_registry()
            tool_names = {tool.name for tool in tool_registry.list()}
            skill_dirs = sorted(
                path
                for path in skills_dir.iterdir()
                if path.is_dir() and not path.name.startswith("__")
            )
            records = []
            runtime_frontmatter_keys = {
                "agent_key",
                "allowed_tools",
                "approval_policy",
                "context_policy",
                "contextPolicy",
                "display_name",
                "displayName",
                "draft_types",
                "examples",
                "instruction_files",
                "intent",
                "key",
                "output_types",
                "runner",
                "script_files",
                "tools",
            }
            for skill_dir in skill_dirs:
                skill_markdown = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
                self.assertTrue(skill_markdown.startswith("---\n"))
                frontmatter = yaml.safe_load(skill_markdown.split("---\n", 2)[1])
                runtime_path = skill_dir / "skill.yaml"
                self.assertTrue(runtime_path.exists(), f"{skill_dir.name} missing skill.yaml")
                runtime = yaml.safe_load(runtime_path.read_text(encoding="utf-8"))
                self.assertEqual(runtime["version"], 2)
                slug = frontmatter["name"]
                key = runtime.get("key") or slug.replace("-", "_")
                records.append((key, runtime))
                self.assertEqual(skill_dir.name, slug)
                self.assertEqual(set(frontmatter), {"name", "description"})
                self.assertFalse(
                    set(frontmatter).intersection(runtime_frontmatter_keys),
                    f"{key} keeps Culina runtime fields in SKILL.md",
                )
                declared_tool_names = runtime.get("allowed_tools", [])
                self.assertTrue(set(declared_tool_names).issubset(tool_names), f"{key} declares unknown tools")
                declared_tools = [tool_registry.get(name) for name in declared_tool_names]
                approval_policy = runtime.get("approval_policy")
                self.assertIn(approval_policy, {"none", "draft_then_confirm"})
                if approval_policy == "none":
                    self.assertTrue(all(tool.side_effect == "read" for tool in declared_tools), f"{key} exposes non-read tools without approval")
                    self.assertEqual(runtime.get("draft_types", []), [])
                else:
                    self.assertTrue(runtime.get("draft_types", []), f"{key} requires approval but declares no draft type")
                    self.assertTrue(any(tool.side_effect == "draft" for tool in declared_tools), f"{key} requires approval but exposes no draft tool")
                    self.assertTrue(set(runtime["draft_types"]).issubset(DRAFT_APPROVAL_CONFIG), f"{key} declares unsupported draft types")
                self.assertFalse(any(tool.side_effect == "write" for tool in declared_tools), f"{key} must not expose write tools")

            keys = [key for key, _runtime in records]
            self.assertEqual(
                keys,
                ["food_profile", "ingredient_profile", "inventory_analysis", "meal_plan", "meal_log", "recipe_cook", "recipe_draft", "shopping_list"],
            )
            self.assertEqual(skill_registry.keys(), set(keys))
            self.assertEqual([manifest.key for manifest in skill_registry.list_manifests()], keys)
            self.assertNotIn("general_chat", skill_registry.keys())
            self.assertNotIn("today_recommendation", skill_registry.keys())
            self.assertIsInstance(skill_registry.get("inventory_analysis"), CatalogSkill)
            catalog_record = skill_registry.get("inventory_analysis").manifest.to_catalog_record()
            self.assertEqual(catalog_record["key"], "inventory_analysis")
            self.assertEqual(catalog_record["displayName"], "库存查看与处理")
            self.assertNotIn("slug", catalog_record)
            self.assertNotIn("name", catalog_record)
            self.assertIn("ingredient.search", skill_registry.get("shopping_list").manifest.tools)
            self.assertIn("ingredient.read_by_id", skill_registry.get("shopping_list").manifest.tools)

        def test_skill_loader_uses_unified_toolcall_runner_without_skill_python_entrypoint(self) -> None:
            skill_registry = build_workspace_skill_registry()
            self.assertEqual(skill_registry.get("meal_plan").manifest.runner, "toolcall")
            self.assertIsInstance(skill_registry.get("meal_plan"), CatalogSkill)
            self.assertFalse(any(BACKEND_DIR.glob("app/ai/skills/catalog/*/skill.py")))

        def test_skill_loader_rejects_skill_without_runtime_contract(self) -> None:
            with tempfile.TemporaryDirectory() as tmp_dir:
                catalog_dir = Path(tmp_dir)
                skill_dir = catalog_dir / "simple-skill"
                skill_dir.mkdir()
                (skill_dir / "SKILL.md").write_text(
                    "---\n"
                    "name: simple-skill\n"
                    "display_name: 简单 Skill\n"
                    "description: Markdown only.\n"
                    "approval_policy: none\n"
                    "---\n",
                    encoding="utf-8",
                )
                with self.assertRaises(FileNotFoundError):
                    SkillDirectoryLoader(catalog_dir).load()

        def test_skill_loader_ignores_root_workflow_file(self) -> None:
            with tempfile.TemporaryDirectory() as tmp_dir:
                catalog_dir = Path(tmp_dir)
                skill_dir = catalog_dir / "simple-skill"
                skill_dir.mkdir()
                (skill_dir / "SKILL.md").write_text(
                    "---\n"
                    "name: simple-skill\n"
                    "description: Markdown only.\n"
                    "---\n"
                    "# Root\n\nBody instructions.\n",
                    encoding="utf-8",
                )
                (skill_dir / "skill.yaml").write_text(
                    "version: 2\n"
                    "key: simple_skill\n"
                    "display_name: 简单 Skill\n"
                    "approval_policy: none\n"
                    "allowed_tools: []\n"
                    "draft_types: []\n",
                    encoding="utf-8",
                )
                (skill_dir / "workflows.md").write_text("workflow content", encoding="utf-8")
                skills = SkillDirectoryLoader(catalog_dir).load()
                self.assertIsInstance(skills[0], CatalogSkill)
                instructions = skills[0].instructions
                self.assertIn("Body instructions.", instructions)
                self.assertNotIn("workflow content", instructions)
                self.assertNotIn("name: simple-skill", instructions)

        def test_skill_loader_accepts_v2_skill_yaml_runtime_contract(self) -> None:
            with tempfile.TemporaryDirectory() as tmp_dir:
                catalog_dir = Path(tmp_dir)
                skill_dir = catalog_dir / "simple-skill"
                references_dir = skill_dir / "references"
                references_dir.mkdir(parents=True)
                (skill_dir / "SKILL.md").write_text(
                    "---\n"
                    "name: simple-skill\n"
                    "description: Markdown only.\n"
                    "---\n"
                    "# Root\n\nBody instructions.\n",
                    encoding="utf-8",
                )
                (skill_dir / "skill.yaml").write_text(
                    "version: 2\n"
                    "key: simple_skill\n"
                    "display_name: 简单 Skill\n"
                    "approval_policy: none\n"
                    "allowed_tools: []\n"
                    "draft_types: []\n"
                    "examples:\n"
                    "  - 简单查询。\n",
                    encoding="utf-8",
                )
                (references_dir / "workflows.md").write_text("workflow content", encoding="utf-8")
                skills = SkillDirectoryLoader(catalog_dir).load()
                self.assertEqual(skills[0].manifest.key, "simple_skill")
                self.assertEqual(skills[0].manifest.name, "简单 Skill")
                self.assertEqual(skills[0].manifest.examples, ["简单查询。"])
                self.assertIn("Body instructions.", skills[0].instructions)
                self.assertIn("workflow content", skills[0].instructions)
                self.assertNotIn("display_name: 简单 Skill", skills[0].instructions)

        def test_skill_catalog_instructions_include_operational_guardrails(self) -> None:
            skill_registry = build_workspace_skill_registry()

            self.assertIn(
                "更新 payload 不是局部补丁",
                skill_registry.get("ingredient_profile").instructions,
            )
            self.assertIn(
                "至少保留或填写 `name`、`category`、`default_unit`、`default_storage`、`default_expiry_mode`",
                skill_registry.get("ingredient_profile").instructions,
            )
            self.assertIn(
                "收藏和取消收藏使用 `action=set_favorite`，payload 只提供 `favorite=true/false`",
                skill_registry.get("food_profile").instructions,
            )
            self.assertIn(
                "payload 至少包含 `title`、`servings`、`prep_minutes`、`difficulty`、`ingredient_items` 和 `steps`",
                skill_registry.get("recipe_draft").instructions,
            )
            self.assertIn(
                "预览中有 `shortages` 时，不生成 `recipe_cook` 草稿",
                skill_registry.get("recipe_cook").instructions,
            )
            self.assertIn(
                "本 Skill 只能说明需要进入食材档案流程",
                skill_registry.get("inventory_analysis").instructions,
            )
            self.assertIn(
                '"draftType": "inventory_operation"',
                skill_registry.get("inventory_analysis").instructions,
            )
            self.assertIn(
                '"schemaVersion": "inventory_operation.v1"',
                skill_registry.get("inventory_analysis").instructions,
            )
            self.assertIn(
                "不要只提交 `draftType` / `schemaVersion` 的空壳，也不要省略 `draftType`。",
                skill_registry.get("inventory_analysis").instructions,
            )
            self.assertIn(
                "不要在本 Skill 中调用或伪造 `food_profile` 草稿",
                skill_registry.get("meal_plan").instructions,
            )
            self.assertIn(
                "`sourceDraftId` 只能来自当前运行 artifact 的 `in_run:*` ID",
                skill_registry.get("shopping_list").instructions,
            )
            self.assertIn(
                "同一会话中真实存在的持久草稿 ID",
                skill_registry.get("shopping_list").instructions,
            )

        def test_skill_loader_exposes_declared_scripts_as_model_tools(self) -> None:
            skill = build_workspace_skill_registry().get("meal_plan")
            definitions = {
                definition.name: definition
                for definition in SkillScriptExecutor(
                    skill.script_catalog,
                    SkillContext(
                        db=MagicMock(),
                        family_id="family-test",
                        user_id="user-test",
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="",
                        tool_executor=MagicMock(),
                    ),
                ).tool_definitions()
            }

            self.assertEqual(
                set(definitions),
                {"script.expand_meal_slots", "script.validate_meal_plan", "script.render_plan_preview"},
            )
            self.assertEqual(
                definitions["script.expand_meal_slots"].input_schema["required"],
                ["start_date", "days", "meal_types"],
            )
            self.assertEqual(
                definitions["script.validate_meal_plan"].input_schema["required"],
                ["plan"],
            )
            self.assertEqual(
                definitions["script.render_plan_preview"].output_schema["properties"]["result"]["type"],
                "string",
            )
            self.assertEqual(
                definitions["script.validate_meal_plan"].permission,
                "skill:script",
            )

        def test_skill_script_helpers_expand_slots_and_lint_recipe_draft(self) -> None:
            context = SkillContext(
                db=MagicMock(),
                family_id="family-test",
                user_id="user-test",
                conversation_id="conversation-test",
                run_id="run-test",
                conversation=[],
                current_message="",
                tool_executor=MagicMock(),
            )
            meal_plan = build_workspace_skill_registry().get("meal_plan")
            meal_executor = SkillScriptExecutor(meal_plan.script_catalog, context)
            expanded = meal_executor.call(
                "script.expand_meal_slots",
                {"start_date": "2026-06-18", "days": 2, "meal_types": ["dinner", "lunch"]},
            )["result"]
            self.assertTrue(expanded["valid"])
            self.assertEqual(
                expanded["slots"],
                [
                    {"date": "2026-06-18", "mealType": "dinner"},
                    {"date": "2026-06-18", "mealType": "lunch"},
                    {"date": "2026-06-19", "mealType": "dinner"},
                    {"date": "2026-06-19", "mealType": "lunch"},
                ],
            )
            validation = meal_executor.call(
                "script.validate_meal_plan",
                {
                    "plan": [
                        {"date": "2026-06-18", "mealType": "dinner", "title": "番茄小炒", "foodId": "food-tomato"},
                        {"date": "2026-06-18", "mealType": "dinner", "title": "番茄小炒", "foodId": "food-tomato"},
                        {"date": "2026-06-19", "mealType": "lunch", "title": "番茄小炒", "foodId": "food-tomato"},
                    ]
                },
            )["result"]
            self.assertFalse(validation["valid"])
            self.assertIn("同一天同餐别存在重复计划", validation["errors"][0]["message"])
            self.assertEqual(validation["warnings"][0]["field"], "foodId")

            recipe = build_workspace_skill_registry().get("recipe_draft")
            recipe_executor = SkillScriptExecutor(recipe.script_catalog, context)
            lint = recipe_executor.call(
                "script.lint_recipe_draft",
                {
                    "draft": {
                        "title": "番茄鸡蛋面",
                        "servings": 2,
                        "prep_minutes": 20,
                        "difficulty": "easy",
                        "ingredient_items": [
                            {"ingredient_name": "番茄", "quantity": 2, "unit": "个"},
                            {"ingredient_name": "鸡蛋", "quantity": 2, "unit": "个"},
                        ],
                        "steps": [{"description": "番茄切块，鸡蛋打散后炒熟，再和面条同煮。"}],
                    }
                },
            )["result"]
            self.assertTrue(lint["valid"])
            self.assertEqual(lint["errors"], [])

        def test_skill_loader_rejects_unsafe_script_imports(self) -> None:
            with tempfile.TemporaryDirectory() as tmp_dir:
                catalog_dir = Path(tmp_dir)
                skill_dir = catalog_dir / "unsafe-skill"
                scripts_dir = skill_dir / "scripts"
                scripts_dir.mkdir(parents=True)
                (skill_dir / "SKILL.md").write_text(
                    "---\n"
                    "name: unsafe-skill\n"
                    "description: Unsafe script.\n"
                    "---\n",
                    encoding="utf-8",
                )
                (skill_dir / "skill.yaml").write_text(
                    "version: 2\n"
                    "key: unsafe_skill\n"
                    "display_name: Unsafe Skill\n"
                    "approval_policy: none\n"
                    "allowed_tools: []\n"
                    "draft_types: []\n"
                    "script_files: [scripts/unsafe.py]\n",
                    encoding="utf-8",
                )
                (scripts_dir / "unsafe.py").write_text(
                    "import os\n\n"
                    "def inspect_environment() -> dict:\n"
                    "    return dict(os.environ)\n",
                    encoding="utf-8",
                )

                with self.assertRaisesRegex(ValueError, "unsupported import"):
                    SkillDirectoryLoader(catalog_dir).load()

        def test_skill_loader_rejects_script_reflection_escape(self) -> None:
            with tempfile.TemporaryDirectory() as tmp_dir:
                catalog_dir = Path(tmp_dir)
                skill_dir = catalog_dir / "unsafe-skill"
                scripts_dir = skill_dir / "scripts"
                scripts_dir.mkdir(parents=True)
                (skill_dir / "SKILL.md").write_text(
                    "---\n"
                    "name: unsafe-skill\n"
                    "description: Unsafe script.\n"
                    "---\n",
                    encoding="utf-8",
                )
                (skill_dir / "skill.yaml").write_text(
                    "version: 2\n"
                    "key: unsafe_skill\n"
                    "display_name: Unsafe Skill\n"
                    "approval_policy: none\n"
                    "allowed_tools: []\n"
                    "draft_types: []\n"
                    "script_files: [scripts/unsafe.py]\n",
                    encoding="utf-8",
                )
                (scripts_dir / "unsafe.py").write_text(
                    "def inspect_environment() -> dict:\n"
                    "    importer = getattr(__builtins__, '__import__')\n"
                    "    return {'os': str(importer('os'))}\n",
                    encoding="utf-8",
                )

                with self.assertRaisesRegex(ValueError, "forbidden call"):
                    SkillDirectoryLoader(catalog_dir).load()

        def test_skill_script_executor_times_out_and_records_failure(self) -> None:
            with tempfile.TemporaryDirectory() as tmp_dir:
                skill_dir = Path(tmp_dir) / "slow-skill"
                scripts_dir = skill_dir / "scripts"
                scripts_dir.mkdir(parents=True)
                (scripts_dir / "slow.py").write_text(
                    "def wait_forever() -> dict:\n"
                    "    while True:\n"
                    "        pass\n",
                    encoding="utf-8",
                )
                catalog = SkillScriptCatalog(skill_dir, ["scripts/slow.py"])
                executor = SkillScriptExecutor(
                    catalog,
                    SkillContext(
                        db=MagicMock(),
                        family_id="family-test",
                        user_id="user-test",
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="",
                        tool_executor=MagicMock(),
                    ),
                    timeout_seconds=0.05,
                )

                with self.assertRaisesRegex(RuntimeError, "timed out"):
                    executor.call("script.wait_forever", {})

                self.assertEqual(executor.records()[0]["status"], "failed")

        def test_skill_loader_rejects_unknown_allowed_tool_when_registry_is_available(self) -> None:
            with tempfile.TemporaryDirectory() as tmp_dir:
                catalog_dir = Path(tmp_dir)
                skill_dir = catalog_dir / "bad-skill"
                skill_dir.mkdir()
                (skill_dir / "SKILL.md").write_text(
                    "---\n"
                    "name: bad-skill\n"
                    "description: Invalid.\n"
                    "---\n",
                    encoding="utf-8",
                )
                (skill_dir / "skill.yaml").write_text(
                    "version: 2\n"
                    "key: bad_skill\n"
                    "display_name: Bad Skill\n"
                    "approval_policy: none\n"
                    "allowed_tools: [inventory.not_a_real_tool]\n"
                    "draft_types: []\n",
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(ValueError, "unknown allowed tool"):
                    SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

        def test_skill_loader_rejects_draft_tool_without_approval_when_registry_is_available(self) -> None:
            with tempfile.TemporaryDirectory() as tmp_dir:
                catalog_dir = Path(tmp_dir)
                skill_dir = catalog_dir / "bad-skill"
                skill_dir.mkdir()
                (skill_dir / "SKILL.md").write_text(
                    "---\n"
                    "name: bad-skill\n"
                    "description: Invalid.\n"
                    "---\n",
                    encoding="utf-8",
                )
                (skill_dir / "skill.yaml").write_text(
                    "version: 2\n"
                    "key: bad_skill\n"
                    "display_name: Bad Skill\n"
                    "approval_policy: none\n"
                    "allowed_tools: [shopping.create_draft]\n"
                    "draft_types: []\n",
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(ValueError, "exposes non-read tools without approval"):
                    SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

        def test_skill_loader_rejects_directory_missing_required_markdown(self) -> None:
            with tempfile.TemporaryDirectory() as tmp_dir:
                catalog_dir = Path(tmp_dir)
                skill_dir = catalog_dir / "broken_skill"
                skill_dir.mkdir()
                with self.assertRaises(FileNotFoundError):
                    SkillDirectoryLoader(catalog_dir).load()

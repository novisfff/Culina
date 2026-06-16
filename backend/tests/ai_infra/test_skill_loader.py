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
            for skill_dir in skill_dirs:
                skill_markdown = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
                self.assertTrue(skill_markdown.startswith("---\n"))
                frontmatter = yaml.safe_load(skill_markdown.split("---\n", 2)[1])
                slug = frontmatter["name"]
                key = frontmatter.get("key") or slug.replace("-", "_")
                records.append((key, frontmatter))
                self.assertEqual(skill_dir.name, slug)
                self.assertIn("description", frontmatter)
                declared_tool_names = frontmatter.get("allowed_tools", [])
                self.assertTrue(set(declared_tool_names).issubset(tool_names), f"{key} declares unknown tools")
                declared_tools = [tool_registry.get(name) for name in declared_tool_names]
                approval_policy = frontmatter.get("approval_policy")
                self.assertIn(approval_policy, {"none", "draft_then_confirm"})
                if approval_policy == "none":
                    self.assertTrue(all(tool.side_effect == "read" for tool in declared_tools), f"{key} exposes non-read tools without approval")
                    self.assertEqual(frontmatter.get("draft_types", []), [])
                else:
                    self.assertTrue(frontmatter.get("draft_types", []), f"{key} requires approval but declares no draft type")
                    self.assertTrue(any(tool.side_effect == "draft" for tool in declared_tools), f"{key} requires approval but exposes no draft tool")
                    self.assertTrue(set(frontmatter["draft_types"]).issubset(DRAFT_APPROVAL_CONFIG), f"{key} declares unsupported draft types")
                self.assertFalse(any(tool.side_effect == "write" for tool in declared_tools), f"{key} must not expose write tools")

            keys = [key for key, _frontmatter in records]
            self.assertEqual(
                keys,
                ["food_profile", "ingredient_profile", "inventory_analysis", "meal_plan", "meal_log", "recipe_cook", "recipe_draft", "shopping_list"],
            )
            self.assertEqual(skill_registry.keys(), set(keys))
            self.assertEqual([manifest.key for manifest in skill_registry.list_manifests()], keys)
            self.assertNotIn("general_chat", skill_registry.keys())
            self.assertNotIn("today_recommendation", skill_registry.keys())
            self.assertIsInstance(skill_registry.get("inventory_analysis"), ToolCallingSkill)

        def test_skill_loader_uses_unified_toolcall_runner_without_skill_python_entrypoint(self) -> None:
            skill_registry = build_workspace_skill_registry()
            self.assertEqual(skill_registry.get("meal_plan").manifest.runner, "toolcall")
            self.assertIsInstance(skill_registry.get("meal_plan"), ToolCallingSkill)
            self.assertFalse(any(BACKEND_DIR.glob("app/ai/skills/catalog/*/skill.py")))

        def test_skill_loader_accepts_markdown_only_skill_without_python_entrypoint(self) -> None:
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
                skills = SkillDirectoryLoader(catalog_dir).load()
                self.assertEqual(len(skills), 1)
                self.assertIsInstance(skills[0], ToolCallingSkill)

        def test_skill_loader_includes_conventional_workflow_without_frontmatter_noise(self) -> None:
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
                    "---\n"
                    "# Root\n\nBody instructions.\n",
                    encoding="utf-8",
                )
                (skill_dir / "workflows.md").write_text("workflow content", encoding="utf-8")
                skills = SkillDirectoryLoader(catalog_dir).load()
                self.assertIsInstance(skills[0], ToolCallingSkill)
                instructions = skills[0].instructions
                self.assertIn("Body instructions.", instructions)
                self.assertIn("workflow content", instructions)
                self.assertNotIn("name: simple-skill", instructions)

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
                {"script.validate_meal_plan", "script.render_plan_preview"},
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
                    "script_files: [scripts/unsafe.py]\n"
                    "approval_policy: none\n"
                    "---\n",
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
                    "script_files: [scripts/unsafe.py]\n"
                    "approval_policy: none\n"
                    "---\n",
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

        def test_tool_calling_skill_executes_script_through_model_tool_handler(self) -> None:
            class ScriptCallingProvider(BaseChatProvider):
                model_name = "script-calling-model"

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    raise AssertionError("tool-calling skill should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools: list,
                    tool_handler,
                    response_schema: dict | None = None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, response_schema, max_rounds
                    self.assert_script_is_exposed = "script.validate_meal_plan" in {
                        tool.name for tool in tools
                    }
                    validation = tool_handler(
                        "script.validate_meal_plan",
                        {
                            "plan": [
                                {
                                    "date": date.today().isoformat(),
                                    "mealType": "dinner",
                                    "title": "番茄小炒",
                                    "foodId": "food-tomato",
                                }
                            ]
                        },
                    )["result"]
                    return ChatProviderResult(
                        text=json.dumps(
                            {
                                "text": "计划结构检查完成。",
                                "cards": [],
                                "drafts": [],
                                "events": [],
                                "context_summary": {"scriptValidation": validation},
                                "state_patch": {},
                                "requires_clarification": False,
                                "status": "completed",
                                "error": None,
                            },
                            ensure_ascii=False,
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            provider = ScriptCallingProvider()
            progress_events: list[dict] = []
            skill = build_workspace_skill_registry().get("meal_plan")
            with self.SessionLocal() as db:
                result = skill.run(
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="检查这个餐食计划",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(
                                db=db,
                                family_id=self.family.id,
                                user_id=self.user.id,
                                conversation_id="conversation-test",
                                run_id="run-test",
                            ),
                        ),
                        provider=provider,
                        stream_writer=progress_events.append,
                    )
                )

            self.assertTrue(provider.assert_script_is_exposed)
            self.assertEqual(result.context_summary["scriptValidation"], {"valid": True, "errors": []})
            self.assertEqual(result.tool_calls[0]["name"], "script.validate_meal_plan")
            self.assertTrue(
                any(
                    event.get("data", {}).get("type") == "script"
                    for event in progress_events
                )
            )

        def test_skill_loader_rejects_unknown_allowed_tool_when_registry_is_available(self) -> None:
            with tempfile.TemporaryDirectory() as tmp_dir:
                catalog_dir = Path(tmp_dir)
                skill_dir = catalog_dir / "bad-skill"
                skill_dir.mkdir()
                (skill_dir / "SKILL.md").write_text(
                    "---\n"
                    "name: bad-skill\n"
                    "description: Invalid.\n"
                    "allowed_tools: [inventory.not_a_real_tool]\n"
                    "approval_policy: none\n"
                    "---\n",
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
                    "allowed_tools: [shopping.create_draft]\n"
                    "approval_policy: none\n"
                    "---\n",
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

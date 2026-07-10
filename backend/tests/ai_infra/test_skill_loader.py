from ._support import *
from app.services.ai_operations.registry import draft_operation_registry

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
                "completion_policy",
                "completionPolicy",
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
                self.assertEqual(runtime["version"], 3)
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
                    self.assertTrue(all(tool.side_effect in {"read", "control"} for tool in declared_tools), f"{key} exposes unsupported tools without approval")
                    self.assertEqual(runtime.get("draft_types", []), [])
                else:
                    self.assertTrue(runtime.get("draft_types", []), f"{key} requires approval but declares no draft type")
                    self.assertTrue(any(tool.side_effect == "draft" for tool in declared_tools), f"{key} requires approval but exposes no draft tool")
                    self.assertTrue(
                        all(draft_operation_registry.supports(draft_type) for draft_type in runtime["draft_types"]),
                        f"{key} declares unsupported draft types",
                    )
                self.assertFalse(any(tool.side_effect == "write" for tool in declared_tools), f"{key} must not expose write tools")

            keys = [key for key, _runtime in records]
            self.assertEqual(
                keys,
                ["cooking_assistant", "food_profile", "ingredient_profile", "inventory_analysis", "meal_plan", "meal_log", "recipe_cook", "recipe_draft", "shopping_list"],
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
            self.assertIn("food.search", skill_registry.get("shopping_list").manifest.tools)
            self.assertIn("food.read_by_id", skill_registry.get("shopping_list").manifest.tools)

        def test_skill_loader_uses_unified_toolcall_runner_without_skill_python_entrypoint(self) -> None:
            skill_registry = build_workspace_skill_registry()
            self.assertEqual(skill_registry.get("meal_plan").manifest.runner, "toolcall")
            self.assertIsInstance(skill_registry.get("meal_plan"), CatalogSkill)
            self.assertFalse(any(BACKEND_DIR.glob("app/ai/skills/catalog/*/skill.py")))

        def test_takeout_dinner_flow_instructions_chain_food_plan_and_log_skills(self) -> None:
            food_profile = (BACKEND_DIR / "app" / "ai" / "skills" / "catalog" / "food-profile" / "SKILL.md").read_text(
                encoding="utf-8"
            )
            meal_planning = (BACKEND_DIR / "app" / "ai" / "skills" / "catalog" / "meal-planning" / "SKILL.md").read_text(
                encoding="utf-8"
            )
            meal_workflows = (
                BACKEND_DIR
                / "app"
                / "ai"
                / "skills"
                / "catalog"
                / "meal-planning"
                / "references"
                / "workflows.md"
            ).read_text(encoding="utf-8")
            meal_record = (BACKEND_DIR / "app" / "ai" / "skills" / "catalog" / "meal-record" / "SKILL.md").read_text(
                encoding="utf-8"
            )

            self.assertIn("安排为今天晚餐", food_profile)
            self.assertIn("typed `continuation`", food_profile)
            self.assertIn("nextSkillKey=meal_plan", food_profile)
            self.assertIn("stateSchema=food_to_meal_plan.v1", food_profile)
            self.assertIn("安排并记录", food_profile)
            self.assertIn("meal_log", food_profile)
            self.assertIn("安排/作为今天晚餐", meal_planning)
            self.assertIn("`missing_food` handoff", meal_planning)
            self.assertIn("state 使用 `meal_missing_food.v1`", meal_planning)
            self.assertIn("不是用餐记录", meal_workflows)
            self.assertIn("安排为今天晚餐", meal_record)
            self.assertIn("未来安排交给 `meal_plan`", meal_record)

            food_profile_record = build_workspace_skill_registry().get("food_profile").manifest.to_catalog_record()
            self.assertIn("外卖安排", food_profile_record["description"])
            self.assertIn("安排外卖晚餐", food_profile_record["routeHints"])
            self.assertIn("把棒约翰意面安排为今天晚餐", food_profile_record["examples"])

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
                    "allowed_tools:\n"
                    "  - inventory.read_summary\n"
                    "  - inventory.read_available_items\n"
                    "draft_types: []\n"
                    "route_hints:\n"
                    "  - simple_quick_task\n"
                    "tool_budget:\n"
                    "  max_tool_calls: 5\n"
                    "  max_same_read_calls: 1\n"
                    "completion_policy:\n"
                    "  requires_terminal_output: true\n"
                    "  terminal_text_allowed: false\n"
                    "  followup_required_tools:\n"
                    "    inventory.read_summary: 需要输出库存摘要。\n"
                    "  terminal_tools:\n"
                    "    inventory.read_available_items: 工具输出就是终态。\n"
                    "examples:\n"
                    "  - 简单查询。\n",
                    encoding="utf-8",
                )
                (references_dir / "workflows.md").write_text("workflow content", encoding="utf-8")
                skills = SkillDirectoryLoader(catalog_dir).load()
                self.assertEqual(skills[0].manifest.key, "simple_skill")
                self.assertEqual(skills[0].manifest.name, "简单 Skill")
                self.assertEqual(skills[0].manifest.examples, ["简单查询。"])
                self.assertEqual(skills[0].manifest.route_hints, ["simple_quick_task"])
                self.assertEqual(skills[0].manifest.tool_budget, {"max_tool_calls": 5, "max_same_read_calls": 1})
                self.assertEqual(
                    skills[0].manifest.completion_policy.followup_required_tools,
                    {"inventory.read_summary": "需要输出库存摘要。"},
                )
                self.assertEqual(
                    skills[0].manifest.completion_policy.terminal_tools,
                    {"inventory.read_available_items": "工具输出就是终态。"},
                )
                self.assertTrue(skills[0].manifest.completion_policy.requires_terminal_output)
                self.assertFalse(skills[0].manifest.completion_policy.terminal_text_allowed)
                self.assertEqual(skills[0].manifest.to_catalog_record()["routeHints"], ["simple_quick_task"])
                self.assertEqual(
                    skills[0].manifest.to_catalog_record()["toolBudget"],
                    {"max_tool_calls": 5, "max_same_read_calls": 1},
                )
                self.assertEqual(
                    skills[0].manifest.to_catalog_record()["completionPolicy"],
                    {
                        "requiresTerminalOutput": True,
                        "terminalTextAllowed": False,
                        "terminalTools": {"inventory.read_available_items": "工具输出就是终态。"},
                        "followupRequiredTools": {"inventory.read_summary": "需要输出库存摘要。"},
                    },
                )
                self.assertIn("Body instructions.", skills[0].instructions)
                self.assertIn("workflow content", skills[0].instructions)
                self.assertNotIn("display_name: 简单 Skill", skills[0].instructions)

        def test_skill_loader_rejects_malformed_runtime_contract_sections(self) -> None:
            cases = [
                (
                    "tool-budget-type",
                    "tool_budget: invalid\n",
                    "tool_budget must be a mapping",
                ),
                (
                    "tool-budget-negative",
                    "tool_budget:\n"
                    "  max_tool_calls: -1\n",
                    "tool_budget.max_tool_calls must be a non-negative integer",
                ),
                (
                    "tool-budget-bool",
                    "tool_budget:\n"
                    "  max_same_read_calls: true\n",
                    "tool_budget.max_same_read_calls must be a non-negative integer",
                ),
                (
                    "completion-policy-type",
                    "completion_policy: invalid\n",
                    "completion_policy must be a mapping",
                ),
                (
                    "completion-terminal-tools-type",
                    "completion_policy:\n"
                    "  terminal_tools: inventory.read_summary\n",
                    "completion_policy.terminal_tools must be a mapping",
                ),
                (
                    "completion-requires-terminal-output-type",
                    "completion_policy:\n"
                    "  requires_terminal_output: 'yes'\n",
                    "completion_policy.requires_terminal_output must be a boolean",
                ),
                (
                    "completion-terminal-text-allowed-type",
                    "completion_policy:\n"
                    "  terminal_text_allowed: 1\n",
                    "completion_policy.terminal_text_allowed must be a boolean",
                ),
                (
                    "completion-followup-hint-empty",
                    "completion_policy:\n"
                    "  followup_required_tools:\n"
                    "    inventory.read_summary: ''\n",
                    "completion_policy.followup_required_tools.inventory.read_summary must include a hint",
                ),
                (
                    "completion-followup-hint-type",
                    "completion_policy:\n"
                    "  followup_required_tools:\n"
                    "    inventory.read_summary: true\n",
                    "completion_policy.followup_required_tools.inventory.read_summary must be a string",
                ),
                (
                    "allowed-tools-type",
                    "allowed_tools: inventory.read_summary\n",
                    "allowed_tools must be a list",
                ),
                (
                    "allowed-tools-duplicate",
                    "allowed_tools:\n"
                    "  - inventory.read_summary\n"
                    "  - inventory.read_summary\n",
                    "allowed_tools contains duplicate values: inventory.read_summary",
                ),
                (
                    "route-hints-type",
                    "route_hints:\n"
                    "  quick_task: invalid\n",
                    "route_hints must be a list",
                ),
                (
                    "examples-type",
                    "examples: invalid\n",
                    "examples must be a list",
                ),
                (
                    "draft-contract-type",
                    "draft_contract: invalid\n",
                    "draft_contract must be a mapping",
                ),
                (
                    "draft-contract-entry-type",
                    "draft_types:\n"
                    "  - meal_plan\n"
                    "draft_contract:\n"
                    "  meal_plan: invalid\n",
                    "draft_contract.meal_plan must be a mapping",
                ),
            ]
            for slug, runtime_extra, expected_error in cases:
                with self.subTest(slug=slug):
                    with tempfile.TemporaryDirectory() as tmp_dir:
                        catalog_dir = Path(tmp_dir)
                        skill_dir = catalog_dir / slug
                        skill_dir.mkdir()
                        (skill_dir / "SKILL.md").write_text(
                            "---\n"
                            f"name: {slug}\n"
                            "description: Malformed runtime config.\n"
                            "---\n"
                            "# Root\n\nBody instructions.\n",
                            encoding="utf-8",
                        )
                        approval_policy = (
                            "draft_then_confirm"
                            if "draft_contract" in runtime_extra or "draft_types:" in runtime_extra
                            else "none"
                        )
                        allowed_tool = (
                            "meal_plan.create_draft"
                            if approval_policy == "draft_then_confirm"
                            else "inventory.read_summary"
                        )
                        base_runtime = (
                            "version: 2\n"
                            f"key: {slug.replace('-', '_')}\n"
                            "display_name: Malformed Skill\n"
                            f"approval_policy: {approval_policy}\n"
                            "allowed_tools:\n"
                            f"  - {allowed_tool}\n"
                            "draft_types: []\n"
                        )
                        if approval_policy == "draft_then_confirm":
                            base_runtime = (
                                "version: 2\n"
                                f"key: {slug.replace('-', '_')}\n"
                                "display_name: Malformed Skill\n"
                                "approval_policy: draft_then_confirm\n"
                                "allowed_tools:\n"
                                "  - meal_plan.create_draft\n"
                            )
                        (skill_dir / "skill.yaml").write_text(base_runtime + runtime_extra, encoding="utf-8")

                        with self.assertRaisesRegex(ValueError, expected_error):
                            SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

        def test_skill_loader_accepts_draft_contract_for_declared_draft_type(self) -> None:
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
                    "approval_policy: draft_then_confirm\n"
                    "allowed_tools:\n"
                    "  - meal_plan.create_draft\n"
                    "draft_types:\n"
                    "  - meal_plan\n"
                    "draft_contract:\n"
                    "  meal_plan:\n"
                    "    schema_version: meal_plan.v1\n"
                    "    approval_config_key: meal_plan\n"
                    "    commit_handler_key: meal_plan\n",
                    encoding="utf-8",
                )

                skills = SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

                self.assertEqual(
                    skills[0].manifest.draft_contract,
                    {
                        "meal_plan": {
                            "schemaVersion": "meal_plan.v1",
                            "approvalConfigKey": "meal_plan",
                            "commitHandlerKey": "meal_plan",
                        }
                    },
                )
                self.assertEqual(skills[0].manifest.to_catalog_record()["draftContract"], skills[0].manifest.draft_contract)

        def test_skill_loader_rejects_draft_contract_for_undeclared_draft_type(self) -> None:
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
                    "approval_policy: draft_then_confirm\n"
                    "allowed_tools:\n"
                    "  - meal_plan.create_draft\n"
                    "draft_types:\n"
                    "  - meal_plan\n"
                    "draft_contract:\n"
                    "  shopping_list:\n"
                    "    schema_version: shopping_list.v1\n"
                    "    approval_config_key: shopping_list\n"
                    "    commit_handler_key: shopping_list\n",
                    encoding="utf-8",
                )

                with self.assertRaisesRegex(
                    ValueError,
                    "draft_contract references undeclared draft types: shopping_list",
                ):
                    SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

        def test_skill_loader_rejects_missing_draft_contract_for_declared_draft_type(self) -> None:
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
                    "approval_policy: draft_then_confirm\n"
                    "allowed_tools:\n"
                    "  - meal_plan.create_draft\n"
                    "draft_types:\n"
                    "  - meal_plan\n",
                    encoding="utf-8",
                )

                with self.assertRaisesRegex(
                    ValueError,
                    "draft_contract must cover declared draft types: meal_plan",
                ):
                    SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

        def test_skill_loader_rejects_incomplete_draft_contract_entry(self) -> None:
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
                    "approval_policy: draft_then_confirm\n"
                    "allowed_tools:\n"
                    "  - meal_plan.create_draft\n"
                    "draft_types:\n"
                    "  - meal_plan\n"
                    "draft_contract:\n"
                    "  meal_plan:\n"
                    "    schema_version: meal_plan.v1\n",
                    encoding="utf-8",
                )

                with self.assertRaisesRegex(
                    ValueError,
                    "draft_contract entries must include schemaVersion, approvalConfigKey, and commitHandlerKey: meal_plan",
                ):
                    SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

        def test_skill_loader_rejects_completion_policy_for_undeclared_tool(self) -> None:
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
                    "allowed_tools:\n"
                    "  - inventory.read_summary\n"
                    "draft_types: []\n"
                    "completion_policy:\n"
                    "  followup_required_tools:\n"
                    "    inventory.read_sumary: 拼写错误，不应静默通过。\n",
                    encoding="utf-8",
                )

                with self.assertRaisesRegex(
                    ValueError,
                    "completion_policy references undeclared tools: inventory.read_sumary",
                ):
                    SkillDirectoryLoader(catalog_dir).load()

        def test_skill_loader_rejects_business_tool_without_completion_policy(self) -> None:
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
                    "allowed_tools:\n"
                    "  - inventory.read_summary\n"
                    "output_types:\n"
                    "  - inventory_summary\n"
                    "draft_types: []\n",
                    encoding="utf-8",
                )

                with self.assertRaisesRegex(
                    ValueError,
                    "completion_policy must cover non-draft tools: inventory.read_summary",
                ):
                    SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

        def test_skill_loader_rejects_tool_output_type_not_declared_by_skill(self) -> None:
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
                    "allowed_tools:\n"
                    "  - meal_plan.recommend_today\n"
                    "output_types: []\n"
                    "draft_types: []\n"
                    "completion_policy:\n"
                    "  terminal_tools:\n"
                    "    meal_plan.recommend_today: 即时推荐卡可作为终态输出。\n",
                    encoding="utf-8",
                )

                with self.assertRaisesRegex(
                    ValueError,
                    "allowed tools produce undeclared output types: today_recommendation",
                ):
                    SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

        def test_skill_loader_rejects_tool_draft_type_not_declared_by_skill(self) -> None:
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
                    "approval_policy: draft_then_confirm\n"
                    "allowed_tools:\n"
                    "  - recipe.create_draft\n"
                    "draft_types:\n"
                    "  - meal_plan\n"
                    "draft_contract:\n"
                    "  meal_plan:\n"
                    "    schema_version: meal_plan.v1\n"
                    "    approval_config_key: meal_plan\n"
                    "    commit_handler_key: meal_plan\n",
                    encoding="utf-8",
                )

                with self.assertRaisesRegex(
                    ValueError,
                    "allowed tools produce undeclared draft types: recipe",
                ):
                    SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

        def test_skill_loader_allows_draft_tool_without_completion_policy(self) -> None:
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
                    "approval_policy: draft_then_confirm\n"
                    "allowed_tools:\n"
                    "  - meal_plan.create_draft\n"
                    "draft_types:\n"
                    "  - meal_plan\n"
                    "draft_contract:\n"
                    "  meal_plan:\n"
                    "    schema_version: meal_plan.v1\n"
                    "    approval_config_key: meal_plan\n"
                    "    commit_handler_key: meal_plan\n",
                    encoding="utf-8",
                )

                skills = SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()
                self.assertEqual(skills[0].manifest.key, "simple_skill")

        def test_skill_loader_rejects_script_tool_without_completion_policy(self) -> None:
            with tempfile.TemporaryDirectory() as tmp_dir:
                catalog_dir = Path(tmp_dir)
                skill_dir = catalog_dir / "simple-skill"
                scripts_dir = skill_dir / "scripts"
                scripts_dir.mkdir(parents=True)
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
                    "script_files:\n"
                    "  - scripts/preview.py\n",
                    encoding="utf-8",
                )
                (scripts_dir / "preview.py").write_text(
                    "def preview() -> dict:\n"
                    "    return {'ok': True}\n",
                    encoding="utf-8",
                )

                with self.assertRaisesRegex(
                    ValueError,
                    "completion_policy must cover non-draft tools: script.preview",
                ):
                    SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

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
            self.assertEqual(
                skill_registry.get("recipe_cook").manifest.completion_policy.followup_required_tools["recipe.preview_cook"],
                "预览后必须继续说明缺料、请求补充信息，或在库存充足时生成 recipe_cook 草稿。",
            )
            self.assertIn(
                "recipe.read_by_id",
                skill_registry.get("recipe_cook").manifest.completion_policy.followup_required_tools,
            )
            self.assertEqual(
                skill_registry.get("cooking_assistant").manifest.tool_budget,
                {"max_tool_calls": 8, "max_same_read_calls": 2},
            )
            self.assertEqual(
                skill_registry.get("cooking_assistant").manifest.completion_policy.terminal_tools,
                {},
            )
            self.assertEqual(
                skill_registry.get("cooking_assistant").manifest.completion_policy.followup_required_tools["ui.propose_actions"],
                "页面动作返回后必须用一句很短的自然话说明操作结果，方便语音对话播报。",
            )
            self.assertEqual(
                skill_registry.get("food_profile").manifest.tool_budget,
                {"max_tool_calls": 10, "max_same_read_calls": 2},
            )
            self.assertEqual(
                skill_registry.get("ingredient_profile").manifest.tool_budget,
                {"max_tool_calls": 18, "max_same_read_calls": 2},
            )
            self.assertEqual(
                skill_registry.get("inventory_analysis").manifest.tool_budget,
                {"max_tool_calls": 24, "max_same_read_calls": 2},
            )
            self.assertEqual(
                skill_registry.get("inventory_analysis").manifest.completion_policy.terminal_tools,
                {
                    "inventory.read_summary": "库存概览卡可作为库存查询的终态输出。",
                    "inventory.read_expiring_items": "临期库存卡可作为临期查询的终态输出。",
                    "inventory.read_expired_items": "过期库存卡可作为过期查询的终态输出。",
                    "inventory.read_low_stock_items": "低库存卡可作为补货查询的终态输出。",
                    "inventory.read_available_items": "可用库存卡可作为库存查询的终态输出。",
                    "inventory.preview_intake_candidates": "冰箱照片或小票解析出的可审阅入库候选卡可作为当前轮终态输出，卡片本身不写库存。",
                },
            )
            self.assertEqual(
                skill_registry.get("meal_log").manifest.tool_budget,
                {"max_tool_calls": 10, "max_same_read_calls": 2},
            )
            self.assertEqual(
                skill_registry.get("meal_plan").manifest.tool_budget,
                {"max_tool_calls": 28, "max_same_read_calls": 2},
            )
            self.assertEqual(
                skill_registry.get("meal_plan").manifest.completion_policy.terminal_tools,
                {"meal_plan.recommend_today": "即时餐食推荐卡可作为今日推荐模式的终态输出。"},
            )
            self.assertIn(
                "meal_plan.read_existing",
                skill_registry.get("meal_plan").manifest.completion_policy.followup_required_tools,
            )
            self.assertIn(
                "script.expand_meal_slots",
                skill_registry.get("meal_plan").manifest.completion_policy.followup_required_tools,
            )
            self.assertIn(
                "script.validate_meal_plan",
                skill_registry.get("meal_plan").manifest.completion_policy.followup_required_tools,
            )
            self.assertIn(
                "script.render_plan_preview",
                skill_registry.get("meal_plan").manifest.completion_policy.followup_required_tools,
            )
            self.assertEqual(
                skill_registry.get("recipe_draft").manifest.tool_budget,
                {"max_tool_calls": 28, "max_same_read_calls": 2},
            )
            self.assertEqual(
                skill_registry.get("recipe_draft").manifest.completion_policy.followup_required_tools[
                    "script.lint_recipe_draft"
                ],
                "菜谱草稿 lint 后必须继续修正草稿、请求补充信息，或调用 recipe.create_draft。",
            )
            self.assertIn(
                "ingredient.search",
                skill_registry.get("recipe_draft").manifest.completion_policy.followup_required_tools,
            )
            self.assertEqual(
                skill_registry.get("recipe_cook").manifest.tool_budget,
                {"max_tool_calls": 12, "max_same_read_calls": 2},
            )
            self.assertEqual(
                skill_registry.get("shopping_list").manifest.tool_budget,
                {"max_tool_calls": 24, "max_same_read_calls": 2},
            )
            self.assertIn(
                "shopping.read_pending",
                skill_registry.get("shopping_list").manifest.completion_policy.followup_required_tools,
            )
            inventory_completion = skill_registry.get("inventory_analysis").manifest.completion_policy
            for tool_name in {
                "inventory.read_available_items",
                "inventory.read_expiring_items",
                "inventory.read_expired_items",
                "inventory.read_low_stock_items",
            }:
                self.assertIn(tool_name, inventory_completion.terminal_tools)
                self.assertNotIn(tool_name, inventory_completion.followup_required_tools)
            for manifest in skill_registry.list_manifests():
                for draft_type in manifest.draft_types:
                    with self.subTest(skill=manifest.key, draft_type=draft_type):
                        self.assertIn(draft_type, manifest.draft_contract)
                        self.assertIn(draft_type, draft_operation_registry.keys())
                        self.assertEqual(manifest.draft_contract[draft_type]["approvalConfigKey"], draft_type)
                        self.assertEqual(manifest.draft_contract[draft_type]["commitHandlerKey"], draft_type)

        def test_catalog_business_tools_declare_completion_policy(self) -> None:
            skill_registry = build_workspace_skill_registry()
            tool_registry = build_workspace_tool_registry()
            for skill in skill_registry.list():
                manifest = skill.manifest
                declared_tools = set(manifest.completion_policy.terminal_tools) | set(
                    manifest.completion_policy.followup_required_tools
                )
                for tool_name in manifest.tools:
                    definition = tool_registry.get(tool_name)
                    if definition.side_effect == "draft" or tool_name == "human.request_input":
                        continue
                    with self.subTest(skill=manifest.key, tool=tool_name):
                        self.assertIn(tool_name, declared_tools)
                script_catalog = getattr(skill, "script_catalog", None)
                if script_catalog is None:
                    continue
                for function in script_catalog.functions():
                    with self.subTest(skill=manifest.key, tool=function.tool_name):
                        self.assertIn(function.tool_name, declared_tools)

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
                with self.assertRaisesRegex(ValueError, "exposes non-read/control tools without approval"):
                    SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

        def test_skill_loader_rejects_directory_missing_required_markdown(self) -> None:
            with tempfile.TemporaryDirectory() as tmp_dir:
                catalog_dir = Path(tmp_dir)
                skill_dir = catalog_dir / "broken_skill"
                skill_dir.mkdir()
                with self.assertRaises(FileNotFoundError):
                    SkillDirectoryLoader(catalog_dir).load()
